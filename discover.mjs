import {pathToFileURL} from 'node:url';
const UA='37xCatalogueBot/1.0 (+https://37xventures.com; affiliate partner catalogue sync)';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function safeUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(u.hostname)||/\.(?:local|internal|localhost|test|invalid)$/i.test(u.hostname))throw new Error('Invalid public merchant URL');return u;}
export async function boundedText(response,max=1000000){if(!response.body)return '';const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;try{while(true){const {value,done}=await reader.read();if(done)break;const remaining=max-bytes;text+=decoder.decode(value.subarray(0,remaining),{stream:true});bytes+=value.length;if(bytes>=max){await reader.cancel();break;}}return text+decoder.decode();}finally{reader.releaseLock();}}
export async function detectStore(host,{get=fetch}={}){
 const signals=[];const request=async value=>{let url=safeUrl(value);for(let hop=0;hop<6;hop++){const r=await get(url.href,{redirect:'manual',headers:{'user-agent':UA,accept:'text/html,application/json'},signal:AbortSignal.timeout(20000)});if([301,302,303,307,308].includes(r.status)){const target=r.headers.get('location');await r.body?.cancel();if(!target)throw new Error('Redirect without location');url=safeUrl(new URL(target,url).href);continue;}return {r,url};}throw new Error('Too many merchant redirects');};
 try{
 const {r,url}=await request(`https://${host}/`);if(!r.ok){await r.body?.cancel();return {status:'retry',http:r.status,signals,error:'Merchant homepage unavailable'};}
 if(r.headers.has('x-shopid')||/shopify/i.test(r.headers.get('x-powered-by')||''))signals.push('shopify_header');
 const html=await boundedText(r);
 if(/Shopify\.(?:shop|theme)\s*=/.test(html))signals.push('shopify_global');
 const cdn=/(?:cdn\.shopify\.com|\/cdn\/shop\/)/i.test(html);
 if(!signals.length&&!cdn){if(/cf-chl-|just a moment|access denied/i.test(html.slice(0,10000)))return {status:'retry',signals,error:'Homepage challenge'};return {status:'not_shopify',signals,http:r.status};}
 if(signals.length)return {status:'shopify',signals,http:r.status};
 // CDN images alone also appear on other platforms. Require a Shopify-shaped catalogue.
 const probe=await request(url.origin+'/products.json?limit=1');if(!probe.r.ok){await probe.r.body?.cancel();return {status:'retry',signals,http:probe.r.status,error:'Shopify signal requires catalogue confirmation'};}
 let body;try{body=JSON.parse(await boundedText(probe.r));}catch{return {status:'retry',signals,error:'Catalogue confirmation was not JSON'};}
 if(Array.isArray(body.products)&&body.products.some(p=>p&&p.id&&p.handle&&Array.isArray(p.variants))){signals.push('shopify_catalogue');return {status:'shopify',signals,http:probe.r.status};}
 return {status:'not_shopify',signals,http:probe.r.status};
 }catch(e){return {status:'retry',signals,error:String(e.message||e).slice(0,150)};}
}
export async function runDiscovery(cfg={}){
 const worker=(cfg.worker||process.env.WORKER_URL||'').replace(/\/$/,''),key=cfg.key||process.env.INGEST_KEY;
 if(!worker||!key)throw new Error('WORKER_URL and INGEST_KEY required');
 const deadline=Date.now()+(cfg.maxMinutes??Number(process.env.DISCOVERY_MINUTES||70))*60000,log=cfg.log||console.log;
 const call=async(path,body)=>{const r=await fetch(worker+path,{method:body?'POST':'GET',headers:{'x-ingest-key':key,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});if(!r.ok){await r.body?.cancel();throw new Error('Discovery API HTTP '+r.status);}return r.json();};
 const start=await call('/ext/discovery/start',{});log('Approved merchant discovery',JSON.stringify(start));
 let nextAt=0;const paced=async(url,init)=>{const delay=nextAt-Date.now();if(delay>0)await sleep(delay);nextAt=Date.now()+(cfg.gapMs??1000);return fetch(url,init);};
 const stats={checked:0,shopify:0,not_shopify:0,retry:0};
 while(Date.now()<deadline-60000){const {work}=await call('/ext/discovery/work');if(!work.length)break;const merchant=work[0];const result=await detectStore(merchant.host,{get:paced});await call('/ext/discovery/result',{host:merchant.host,...result});stats.checked++;stats[result.status]++;}
 log('Discovery complete',JSON.stringify(stats));return stats;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runDiscovery().catch(e=>{console.error(e.message);process.exit(1);});
