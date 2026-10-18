import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {safeUrl} from './discover.mjs';
export const PLATFORMS={
 shopify:{name:'Shopify',signals:/Shopify\.(?:shop|theme)\s*=/,maps:['/sitemap.xml'],product:/\/products\//},
 woocommerce:{name:'WooCommerce',signals:/wp-content\/plugins\/woocommerce|name=["']generator["'][^>]+WooCommerce|woocommerce(?:-js|_params)/i,maps:['/wp-sitemap.xml','/sitemap_index.xml'],product:/\/product\//},
 magento:{name:'Magento / Adobe Commerce',signals:/Magento_(?:Catalog|Theme|Ui)|mage\/cookies|text\/x-magento-init/i,maps:['/sitemap.xml','/sitemap_index.xml'],product:/\.html(?:\?|$)/},
 bigcommerce:{name:'BigCommerce',signals:/stencilBootstrap|cdn\d*\.bigcommerce\.com|BCData\s*=/i,maps:['/xmlsitemap.php','/sitemap.xml'],product:/.+/},
 prestashop:{name:'PrestaShop',signals:/prestashop\s*=|name=["']generator["'][^>]+PrestaShop|prestashop\/themes/i,maps:['/1_index_sitemap.xml','/sitemap.xml'],product:/\/\d+(?:-\d+)?-[^/]+\.html/},
 shopware:{name:'Shopware',signals:/Shopware\.Context|data-swag-|name=["']generator["'][^>]+Shopware|window\.PluginManager/i,maps:['/sitemap.xml'],product:/.+/},
 squarespace:{name:'Squarespace Commerce',signals:/Static\.SQUARESPACE_CONTEXT|squarespace\.com\/universal|name=["']generator["'][^>]+Squarespace/i,maps:['/sitemap.xml'],product:/\/(?:p|shop|store|products)\//},
 wix:{name:'Wix Stores',signals:/name=["']generator["'][^>]+Wix|X-Wix-Published-Version|wix-site-id/i,maps:['/sitemap.xml','/store-products-sitemap.xml'],product:/\/product-page\//},
 salesforce:{name:'Salesforce Commerce Cloud',signals:/demandware\.static|\/on\/demandware\.store|\bdwvar_|dwstatic/i,maps:['/sitemap_index.xml','/sitemap.xml'],product:/\.html(?:\?|$)|\/(?:p|product)\//},
 opencart:{name:'OpenCart',signals:/index\.php\?route=product\/(?:product|category)|catalog\/view\/theme\/[^"']+stylesheet/i,maps:['/index.php?route=extension/feed/google_sitemap','/sitemap.xml'],product:/.+/}
};
export const decode=s=>String(s||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export const clean=s=>decode(String(s??'').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
export function sameStore(value,host){try{const u=safeUrl(value);return u.hostname.replace(/^www\./,'')===host.replace(/^www\./,'');}catch{return false;}}
export async function readBounded(response,max=8*1024*1024){const reader=response.body?.getReader();if(!reader)return '';let size=0;const chunks=[];try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('Response exceeds capture bound');}chunks.push(value);}const b=Buffer.concat(chunks.map(c=>Buffer.from(c)));return (b[0]===31&&b[1]===139?gunzipSync(b,{maxOutputLength:32*1024*1024}):b).toString('utf8');}finally{reader.releaseLock();}}
export function robotsPolicy(text,agent='37xcataloguebot'){
 const groups=[];let group=null,hasRules=false;
 for(const raw of text.split(/\r?\n/)){const line=raw.replace(/#.*/,'').trim(),m=line.match(/^([^:]+):\s*(.*)$/);if(!m)continue;const key=m[1].toLowerCase(),value=m[2].trim();
 if(key==='user-agent'){if(!group||hasRules){group={agents:[],rules:[]};groups.push(group);hasRules=false;}group.agents.push(value.toLowerCase());}
 else if(group&&key==='crawl-delay'){hasRules=true;const delay=Number(value);if(Number.isFinite(delay)&&delay>=0)group.delay=delay;}
 else if(group&&['allow','disallow'].includes(key)){hasRules=true;if(value)group.rules.push({allow:key==='allow',value});}}
 const ranked=groups.map(g=>({...g,rank:Math.max(-1,...g.agents.map(a=>a==='*'?0:agent.includes(a)?a.length:-1))})),best=Math.max(-1,...ranked.map(g=>g.rank)),rules=ranked.filter(g=>g.rank===best).flatMap(g=>g.rules);
 const policy=url=>{const u=new URL(url),path=u.pathname+u.search;let match=null;for(const r of rules){const end=r.value.endsWith('$'),raw=end?r.value.slice(0,-1):r.value;const re=new RegExp('^'+raw.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+(end?'$':''));if(re.test(path)&&(!match||raw.length>match.length||raw.length===match.length&&r.allow))match={length:raw.length,allow:r.allow};}return match?.allow??true;};policy.crawlDelay=Math.max(0,...ranked.filter(g=>g.rank===best).map(g=>g.delay||0));return policy;
}
export function fingerprint(html,headers=new Headers()){
 const found=Object.entries(PLATFORMS).filter(([k,v])=>v.signals.test(html)).map(([k])=>k);
 if(headers.has('x-shopid'))found.push('shopify');if(headers.has('x-magento-cache-debug'))found.push('magento');if(headers.has('x-wix-request-id'))found.push('wix');
 const unique=[...new Set(found)];return unique.length===1?{platform:unique[0],signals:['platform_'+unique[0]]}:{platform:null,signals:unique.map(p=>'platform_'+p),reason:unique.length?'Conflicting platform signals':'No supported platform detected'};
}
const types=o=>[].concat(o?.['@type']||[]).map(v=>String(v).split(/[\/#]/).at(-1));
export function extractProducts(html,pageUrl,platform,observedAt=new Date().toISOString()){
 const objects=[];for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{objects.push(JSON.parse(m[1].trim().replace(/^<!--|-->$/g,'')));}catch{}}
 const products=[];function walk(v,depth=0){if(depth>25||!v||typeof v!=='object')return;if(Array.isArray(v)){for(const x of v)walk(x,depth+1);return;}if(types(v).includes('Product'))products.push(v);if(v['@graph'])walk(v['@graph'],depth+1);if(v.hasVariant)walk(v.hasVariant,depth+1);if(v.mainEntity)walk(v.mainEntity,depth+1);}for(const o of objects)walk(o);
 const records=[];
 for(const p of products){const offers=[].concat(p.offers||[]);for(const offer of offers){if(!offer||types(offer).includes('AggregateOffer'))continue;let url;try{url=new URL(offer.url||p.url||pageUrl,pageUrl);url.hash='';}catch{continue;}if(!sameStore(url.href,new URL(pageUrl).hostname))continue;
 const stock=String(offer.availability||'').split('/').at(-1).toLowerCase(),available=['instock','limitedavailability','onlineonly'].includes(stock)?true:['outofstock','soldout','discontinued'].includes(stock)?false:null;
 const price=Number(offer.price??offer.priceSpecification?.price),currency=String(offer.priceCurrency||offer.priceSpecification?.priceCurrency||'').toUpperCase(),sku=String(offer.sku||p.sku||p.productID||p.gtin13||p.gtin||url.href);
 const brand=typeof p.brand==='string'?p.brand:p.brand?.name,images=[].concat(p.image||[]).map(x=>typeof x==='string'?x:x?.url).filter(Boolean);
 records.push({id:sku,url:url.href,title:clean(p.name),brand:clean(brand),gtin:String(p.gtin14||p.gtin13||p.gtin12||p.gtin8||p.gtin||''),mpn:clean(p.mpn),sku,description:clean(p.description).slice(0,8000),category:clean(p.category),images,attributes:[].concat(p.additionalProperty||[]).map(x=>({name:clean(x.name),value:clean(x.value)})),price:Number.isFinite(price)?price:null,currency,available,validUntil:offer.priceValidUntil||null,condition:offer.itemCondition?String(offer.itemCondition).split('/').at(-1):null,observedAt,platform,sourceUrl:pageUrl});}}
 return records;
}
export function wooProducts(rows,host,observedAt){return rows.map(p=>{const digits=Number(p.prices?.currency_minor_unit),price=Number(p.prices?.price);return {id:String(p.id),ambiguous:p.type==='variable'||Boolean(p.prices?.price_range),sku:String(p.sku||p.id),url:p.permalink,title:clean(p.name),brand:clean(p.brands?.[0]?.name),gtin:String(p.global_unique_id||p.gtin||''),description:clean(p.description||p.short_description).slice(0,8000),category:(p.categories||[]).map(c=>c.name).join(' > '),images:(p.images||[]).map(i=>i.src),attributes:(p.attributes||[]).map(a=>({name:a.name,value:(a.terms||[]).map(t=>t.name).join(', ')})),price:Number.isFinite(price)&&Number.isInteger(digits)&&digits>=0&&digits<=6?price/10**digits:null,currency:p.prices?.currency_code||'',available:typeof p.is_in_stock==='boolean'?p.is_in_stock:null,condition:null,observedAt,platform:'woocommerce',sourceUrl:`https://${host}/wp-json/wc/store/v1/products`};});}
export async function createClient(host,{get=fetch,gapMs=1000}={}){
 let nextAt=0;const request=async(value,allowAnyPath=false)=>{let u=safeUrl(value);if(!sameStore(u.href,host))throw Error('Off-merchant URL excluded');for(let n=0;n<6;n++){const delay=nextAt-Date.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));nextAt=Date.now()+gapMs;const r=await get(u.href,{headers:{'user-agent':'37xCatalogueBot/1.0 (+https://37xventures.com; affiliate partner catalogue sync)'},redirect:'manual',signal:AbortSignal.timeout(25000)});if([301,302,303,307,308].includes(r.status)){const location=r.headers.get('location');await r.body?.cancel();if(!location)throw Error('Missing redirect');u=safeUrl(new URL(location,u).href);if(!sameStore(u.href,host))throw Error('Off-merchant redirect excluded');continue;}if(r.status===429){const wait=Number(r.headers.get('retry-after'));nextAt=Math.max(nextAt,Date.now()+Math.min(300,Math.max(30,Number.isFinite(wait)?wait:30))*1000);}return {response:r,url:u.href};}throw Error('Redirect bound reached');};
 const robots=await request(`https://${host}/robots.txt`);let robotText='';if(robots.response.status===404||robots.response.status===410)await robots.response.body?.cancel();else if(!robots.response.ok){await robots.response.body?.cancel();throw Error('Robots unavailable HTTP '+robots.response.status);}else{robotText=await readBounded(robots.response,1000000);if(/cf-chl-|just a moment/i.test(robotText))throw Error('Robots challenge');}
 const allowed=robotsPolicy(robotText);gapMs=Math.max(gapMs,allowed.crawlDelay*1000);if(gapMs>60000)throw Error('Robots requests a crawl delay requiring deferred collection');nextAt=Math.max(nextAt,Date.now()+gapMs);
 return {robotText,allowed,async get(url){if(!allowed(url))throw Error('Robots excludes this path');return request(url);}};
}
export async function identify(host,client){const r=await client.get(`https://${host}/`);if(!r.response.ok){await r.response.body?.cancel();throw Error('Homepage HTTP '+r.response.status);}return fingerprint(await readBounded(r.response,1500000),r.response.headers);}
export async function crawlStore(host,platform,cursor,client,{maxPages=60,deadline=Infinity}={}){
 if(!PLATFORMS[platform])throw Error('Unsupported platform');const records=[],state=structuredClone(cursor||{});let requests=0,complete=false;
 if(platform==='woocommerce'&&state.mode!=='sitemap'){
 state.page??=1;state.enrich??=[];
 try{while(requests<maxPages&&Date.now()<deadline-30000){
 if(state.enrich.length){const base=state.enrich[0];if(!client.allowed(base.url)){state.enrich.shift();continue;}const r=await client.get(base.url);requests++;
 if([401,403,404,410].includes(r.response.status)){await r.response.body?.cancel();state.enrich.shift();continue;}if(!r.response.ok){await r.response.body?.cancel();throw Error('WooCommerce product HTTP '+r.response.status);}
 const extra=extractProducts(await readBounded(r.response),r.url,platform).map(p=>p.sku&&p.sku===base.sku?{...p,category:p.category||base.category,brand:p.brand||base.brand,description:p.description||base.description,attributes:[...(base.attributes||[]),...(p.attributes||[])]}:p);records.push(...extra);state.enrich.shift();continue;}
 if(state.apiDone){complete=true;break;}
 const apiUrl=`https://${host}/wp-json/wc/store/v1/products?per_page=100&page=${state.page}`;if(!client.allowed(apiUrl)){state.mode='sitemap';break;}const r=await client.get(apiUrl);requests++;
 if(!r.response.ok){await r.response.body?.cancel();if(state.page===1&&[401,403,404].includes(r.response.status)){state.mode='sitemap';break;}throw Error('Catalogue HTTP '+r.response.status);}
 let rows;try{rows=JSON.parse(await readBounded(r.response));}catch{throw Error('Invalid WooCommerce catalogue JSON');}if(!Array.isArray(rows))throw Error('Invalid WooCommerce catalogue shape');const base=wooProducts(rows,host,new Date().toISOString());records.push(...base);state.page++;
 state.apiDone=rows.length<100||(Number(r.response.headers.get('x-wp-totalpages'))>0&&state.page>Number(r.response.headers.get('x-wp-totalpages')));
 state.enrich=base.filter(p=>(!p.gtin||p.ambiguous)&&p.url&&sameStore(p.url,host));}
 }catch(e){return {records,cursor:state,complete:false,requests,error:String(e.message||e)};}
 if(state.mode!=='sitemap')return {records,cursor:complete?{}:state,complete,requests};
 }

 state.maps??=[...client.robotText.matchAll(/^sitemap:\s*(.+)$/gim)].map(m=>m[1].trim()).filter(u=>sameStore(u,host));if(!state.maps.length&&!state.initialised)state.maps=PLATFORMS[platform].maps.map(p=>`https://${host}${p}`);state.initialised=true;state.urls??=[];state.seenMaps??=[];state.seenUrls??=[];state.blockedUrls??=[];
 const seenMaps=new Set(state.seenMaps),seenUrls=new Set(state.seenUrls);
 let error=null;try{while(requests<maxPages&&Date.now()<deadline-30000){
 if(state.urls.length){const url=state.urls[0],key=createHash('sha256').update(url).digest('hex').slice(0,24);if(seenUrls.has(key)||!sameStore(url,host)||!client.allowed(url)){state.urls.shift();continue;}
 const r=await client.get(url);requests++;if([404,410].includes(r.response.status)){await r.response.body?.cancel();records.push({url,id:url,withdrawn:true,observedAt:new Date().toISOString(),platform});}
 else if([401,403].includes(r.response.status)){await r.response.body?.cancel();state.blockedUrls.push(url);seenUrls.add(key);state.urls.shift();continue;}
 else if(!r.response.ok){await r.response.body?.cancel();throw Error('Product HTTP '+r.response.status);}
 else records.push(...extractProducts(await readBounded(r.response),r.url,platform));
 seenUrls.add(key);state.urls.shift();continue;}
 if(!state.maps.length){if(state.blockedUrls.length){state.urls=[...new Set(state.blockedUrls)];state.blockedUrls=[];for(const u of state.urls)seenUrls.delete(createHash('sha256').update(u).digest('hex').slice(0,24));}else complete=true;break;}
 const map=state.maps[0];if(seenMaps.has(map)||!sameStore(map,host)||!client.allowed(map)){state.maps.shift();continue;}
 const r=await client.get(map);requests++;if([404,410].includes(r.response.status)){await r.response.body?.cancel();seenMaps.add(map);state.maps.shift();continue;}if(!r.response.ok){await r.response.body?.cancel();throw Error('Sitemap HTTP '+r.response.status);}
 const xml=await readBounded(r.response);if(!/<(?:\w+:)?(?:urlset|sitemapindex)\b/i.test(xml))throw Error('Invalid sitemap');const links=[...xml.matchAll(/<(?:\w+:)?loc\b[^>]*>([\s\S]*?)<\/(?:\w+:)?loc>/g)].map(m=>decode(m[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim())).filter(u=>sameStore(u,host));
 if(/<(?:\w+:)?sitemapindex\b/i.test(xml))state.maps.push(...links.filter(u=>!seenMaps.has(u)));else state.urls.push(...links.filter(u=>PLATFORMS[platform].product.test(new URL(u).pathname+new URL(u).search)));
 seenMaps.add(map);state.maps.shift();if(state.urls.length>100000||state.maps.length>2000)throw Error('Sitemap queue exceeds resumable capture bound');}}catch(e){error=String(e.message||e);}
 state.seenMaps=[...seenMaps];state.seenUrls=[...seenUrls];return {records,cursor:complete?{}:state,complete,requests,error};
}
