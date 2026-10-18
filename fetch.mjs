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
  const api = (path, init = {}) => fetch(WORKER + path, { signal:AbortSignal.timeout(120000), ...init, headers: { 'x-ingest-key': KEY, ...(init.headers || {}) } });

  const stats = { stores: 0, ok: 0, other: {}, products: 0, workErrors: 0 };
  while (Date.now() < deadline - 5 * 60e3) {
    const SHARD = +(process.env.SHARD || 0), OF = +(process.env.SHARDS || 1);
    let wr, workErr = 0;
    try { wr = await api(`/ext/work?n=10&shard=${SHARD}&of=${OF}`); } catch (e) { wr = { ok: false, status: 0, text: async () => String(e) }; }
    if (!wr.ok) {
      log(`work call failed ${wr.status} ${(await wr.text()).slice(0, 200)}`);
      if (++stats.workErrors > 20) break;
      await sleep(30000); continue;
    }
    const { date, work, barcode_cap: cap } = await wr.json();
    if (!work.length) { log('no work left for', date); break; }
    for (const w of work) {
      if (Date.now() > deadline - 2 * 60e3) break;
      let out;
      try {
        let res;
        try { res = await fetchStore(w, cap, { shop, MAX_PAGES, log, deadline }); }
        catch (e) { res = { status: 'retry', error: 'fetcher: ' + String(e).slice(0, 200) }; }
        const payload = { date, host: w.host, ...slim(res) };
        const body = gzipSync(Buffer.from(JSON.stringify(payload)));
        let pr;
        for (let t = 0; t < 3; t++) {
          try { pr = await api('/ext/ingest', { method: 'POST', headers: { 'content-type': 'application/gzip' }, body }); if (pr.status < 500) break; }
          catch (e) { pr = { ok: false, status: 0, text: async () => String(e) }; }
          await sleep(5000 * (t + 1));
        }
        out = pr.ok ? await pr.json() : { status: 'ingest_failed', error: `${pr.status} ${(await pr.text()).slice(0, 200)} (${(body.length / 1048576).toFixed(1)}MB)` };
      } catch (e) { out = { status: 'crash_skipped', error: String(e).slice(0, 200) }; }
      stats.stores++; stats.products += out.products || 0;
      if (out.status === 'ok') stats.ok++; else stats.other[out.status] = (stats.other[out.status] || 0) + 1;
      log(`${w.host}: ${out.status} products=${out.products || 0} gtins=${out.gtins || 0}${out.error ? ' ' + out.error : ''}`);
    }
  }
  log('done', JSON.stringify(stats));
  if (stats.workErrors > 20 || stats.other.ingest_failed || stats.other.crash_skipped) throw new Error('Catalogue transport failed: inspect runner totals');
  return stats;
}

// Trim the raw catalogue to what the Worker actually stores, so 20k+ product stores stay well under
// the Worker's request-size limit.
export function slim(res) {
  if (!res || !Array.isArray(res.products)) return res;
  return { ...res, products: res.products.map((p) => ({
    id: p.id, title: p.title, handle: p.handle, vendor: p.vendor, product_type: p.product_type, tags: p.tags,
    body_html: typeof p.body_html === 'string' ? p.body_html.slice(0, 6000) : p.body_html,
    created_at: p.created_at, updated_at: p.updated_at, published_at: p.published_at,
    options: p.options, images: (p.images || []).slice(0, 10).map((i) => ({ src: i.src })),
    variants: (p.variants || []).map((v) => ({ id: v.id, sku: v.sku, title: v.title, option1: v.option1, option2: v.option2,
      option3: v.option3, price: v.price, compare_at_price: v.compare_at_price, available: v.available, grams: v.grams })),
  })) };
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
    if (r.status >= 400) return { status: page === 1 ? 'blocked' : 'retry', http, pages:page-1, complete:false, error:`HTTP ${r.status} on page ${page}; last complete catalogue retained`, currency, country };
    let body = null;
    try { body = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null; } catch {}
    if (!body || !Array.isArray(body.products)) return { status:page===1?'not_json':'retry',http,pages:page-1,complete:false,error:'Invalid catalogue page; last complete catalogue retained',currency,country };
    products.push(...body.products);
    if (body.products.length < 250) break;
    if (Date.now() > deadline - 60e3 || page === MAX_PAGES) return {status:'retry',http,pages:page,complete:false,error:'Catalogue incomplete at time/page limit; last complete catalogue retained',currency,country};
  }
  if (!products.length) {
    // Shopify sometimes serves an empty list to suspected bots; meta.json tells us the truth.
    if (published > 0) return { status: 'soft_block', http, pages: page, error: `0 returned, meta says ${published}`, currency, country };
    return { status: 'empty', http, pages: page, currency, country };
  }
  const fetchedAt = new Date().toISOString();
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
  return { status: 'ok', origin, products, currency, country, barcodes, gtin_fetched: fetched, pages: page, http, market_pinned: !!cookie, complete:true, fetched_at:fetchedAt };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
