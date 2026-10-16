// shopify-catalogue-fetcher
// Runs on GitHub Actions (outside Cloudflare, whose egress Shopify throttles / soft-blocks).
// Asks the shopify-catalogue-37x Worker for work, pulls each store's public catalogue
// (products.json + meta.json + per-product barcodes), and posts the raw result back.
// All normalisation, history, R2 and D1 writes happen in the Worker.
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const UA = '37xCatalogueBot/1.0 (+https://37xventures.com; affiliate partner catalogue sync)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(cfg = {}) {
  const WORKER = (cfg.worker || process.env.WORKER_URL || '').replace(/\/$/, '');
  const KEY = cfg.key || process.env.INGEST_KEY;
  const deadline = Date.now() + (cfg.maxMinutes ?? +(process.env.MAX_MINUTES || 330)) * 60e3;
  const GAP = cfg.gapMs ?? +(process.env.GAP_MS || 1000);
  const MAX_PAGES = +(process.env.MAX_PAGES || 80);
  const log = cfg.log || console.log;
  if (!WORKER || !KEY) throw new Error('WORKER_URL and INGEST_KEY are required');

  // one global pace across every store (Shopify limits per client IP platform-wide)
  let nextAt = 0;
  async function shop(url, cookie) {
    for (let attempt = 0; ; attempt++) {
      const wait = nextAt - Date.now(); nextAt = Math.max(Date.now(), nextAt) + GAP;
      if (wait > 0) await sleep(wait);
      let r;
      try { r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...(cookie ? { cookie } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(25000) }); }
      catch (e) { if (attempt < 2) { await sleep(5000); continue; } return { status: 0, error: String(e) }; }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        const ra = Math.min(Math.max(+(r.headers.get('retry-after') || 0), 30 * (attempt + 1)), 300);
        log(`  ${r.status} ${url} — backing off ${ra}s`); await sleep(ra * 1000); nextAt = Date.now() + GAP; continue;
      }
      return r;
    }
  }
  const api = (path, init = {}) => fetch(WORKER + path, { ...init, headers: { 'x-ingest-key': KEY, ...(init.headers || {}) } });

  const stats = { stores: 0, ok: 0, other: {}, products: 0 };
  while (Date.now() < deadline - 5 * 60e3) {
    const wr = await api('/ext/work?n=10');
    if (!wr.ok) throw new Error(`work ${wr.status} ${await wr.text()}`);
    const { date, work, barcode_cap: cap } = await wr.json();
    if (!work.length) { log('no work left for', date); break; }
    for (const w of work) {
      if (Date.now() > deadline - 2 * 60e3) break;
      const res = await fetchStore(w, cap, { shop, MAX_PAGES, log, deadline });
      const payload = { date, host: w.host, ...res };
      const pr = await api('/ext/ingest', { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: gzipSync(Buffer.from(JSON.stringify(payload))) });
      const out = pr.ok ? await pr.json() : { status: 'ingest_failed', error: await pr.text() };
      stats.stores++; stats.products += out.products || 0;
      if (out.status === 'ok') stats.ok++; else stats.other[out.status] = (stats.other[out.status] || 0) + 1;
      log(`${w.host}: ${out.status} products=${out.products || 0} gtins=${out.gtins || 0}${out.error ? ' ' + out.error : ''}`);
    }
  }
  log('done', JSON.stringify(stats));
  return stats;
}

export async function fetchStore(w, cap, { shop, MAX_PAGES = 80, log = () => {}, deadline = Infinity }) {
  let origin = `https://${w.host}`, currency = w.currency || null, country = null, published = null;
  const m = await shop(`${origin}/meta.json`);
  if (m.status === 200) {
    try { const mj = await m.json(); currency = mj.currency || currency; country = mj.country || null; published = mj.published_products_count ?? null; } catch {}
    try { origin = new URL(m.url).origin; } catch {}
  }
  const cookie = country && currency ? `localization=${country}; cart_currency=${currency}` : undefined;
  const products = []; let page = 1, http = null;
  for (; page <= MAX_PAGES; page++) {
    const r = await shop(`${origin}/products.json?limit=250&page=${page}`, cookie);
    http = r.status;
    if (r.status === 429 || r.status >= 500 || r.status === 0) return { status: 'retry', http, pages: page - 1, error: `HTTP ${r.status} on page ${page}`, currency, country };
    if (r.status >= 400) { if (page === 1) return { status: 'blocked', http, error: `HTTP ${r.status}`, currency, country }; break; }
    let body = null;
    try { body = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null; } catch {}
    if (!body || !Array.isArray(body.products)) { if (page === 1) return { status: 'not_json', http, error: 'not JSON', currency, country }; break; }
    products.push(...body.products);
    if (body.products.length < 250 || Date.now() > deadline - 60e3) break;
  }
  if (!products.length) {
    // Shopify sometimes serves an empty list to suspected bots; meta.json tells us the truth.
    if (published > 0) return { status: 'soft_block', http, pages: page, error: `0 returned, meta says ${published}`, currency, country };
    return { status: 'empty', http, pages: page, currency, country };
  }
  // barcodes: only variants not already cached, capped per store per night
  const have = new Set((w.have_barcodes || []).map(String));
  const barcodes = {}; let fetched = 0;
  for (const p of products) {
    if (fetched >= cap || Date.now() > deadline - 60e3) break;
    if (!p?.handle || (p.variants || []).every((v) => have.has(String(v.id)))) continue;
    const r = await shop(`${origin}/products/${encodeURIComponent(p.handle)}.json`, cookie);
    if (r.status !== 200) { if (r.status === 429) break; continue; }
    try { for (const v of (await r.json())?.product?.variants || []) barcodes[v.id] = v.barcode ?? null; fetched++; } catch {}
  }
  return { status: 'ok', origin, products, currency, country, barcodes, gtin_fetched: fetched, pages: page, http };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
