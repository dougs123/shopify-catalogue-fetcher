import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchStore,slim,ingestResult} from './fetch.mjs';
import {gunzipSync} from 'node:zlib';
const product={id:1,handle:'item',variants:[{id:2,price:'12.00',available:true}]};
const response=(products,status=200)=>({status,headers:new Headers({'content-type':'application/json'}),json:async()=>({products})});
function shop(pages){return async url=>url.includes('/meta.json')?{status:200,url:'https://example.com/meta.json',json:async()=>({currency:'GBP',country:'GB'})}:pages.shift();}
test('unchanged prices remain in a complete dated catalogue',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response([product])])});assert.equal(r.status,'ok');assert.equal(r.complete,true);assert.equal(r.products[0].variants[0].price,'12.00');assert.ok(Number.isFinite(Date.parse(r.fetched_at)));assert.equal(slim(r).fetched_at,r.fetched_at);});
for(const status of [403,429,500,0]) test(`later page HTTP ${status} cannot publish a partial catalogue`,async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response(fullPage()),response([],status)])});assert.equal(r.status,'retry');assert.equal(r.products,undefined);});
test('later invalid JSON cannot publish partial data',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response(fullPage()),{status:200,headers:new Headers(),json:async()=>({})}])});assert.equal(r.status,'retry');assert.equal(r.complete,false);});
test('page limit retains previous complete snapshot',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response(fullPage())]),MAX_PAGES:1});assert.equal(r.status,'retry');assert.equal(r.complete,false);});
test('explicit unavailable variant stays unavailable',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response([{...product,variants:[{id:2,price:'12',available:false}]}])])});assert.equal(r.status,'ok');assert.equal(r.products[0].variants[0].available,false);});
function fullPage(start=1){return Array.from({length:250},(_,i)=>({...product,id:start+i}));}
function countedShop(count,pages,calls=[]){return async url=>{calls.push(url);return url.includes('/meta.json')?{status:200,url:'https://example.com/meta.json',json:async()=>({currency:'GBP',country:'GB',published_products_count:count})}:pages.shift();};}
test('known oversized store stops before downloading 100 unusable pages',async()=>{const calls=[];const r=await fetchStore({host:'example.com'},0,{shop:countedShop(25001,[],calls),MAX_PAGES:200});assert.equal(r.status,'source_limit');assert.equal(r.complete,false);assert.equal(r.products,undefined);assert.equal(calls.length,1);});
test('unknown count never requests forbidden page 101',async()=>{const calls=[];const pages=Array.from({length:100},(_,i)=>response(fullPage(1+i*250)));const r=await fetchStore({host:'example.com'},0,{shop:countedShop(null,pages,calls),MAX_PAGES:200});assert.equal(r.status,'source_limit');assert.equal(r.products,undefined);assert.equal(calls.length,101);assert(!calls.some(u=>u.includes('page=101')));});
test('exact 25000 count completes at page 100 without a false failure',async()=>{const calls=[];const pages=Array.from({length:100},(_,i)=>response(fullPage(1+i*250)));const r=await fetchStore({host:'example.com'},0,{shop:countedShop(25000,pages,calls),MAX_PAGES:200});assert.equal(r.status,'ok');assert.equal(r.products.length,25000);assert.equal(r.complete,true);assert.equal(calls.length,101);});
test('repeated pages cannot inflate a supposedly complete catalogue',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:countedShop(null,[response(fullPage()),response(fullPage())])});assert.equal(r.status,'retry');assert.match(r.error,/repeated product/);assert.equal(r.products,undefined);});
test('short first page below metadata count cannot overwrite the previous complete catalogue',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:countedShop(20,[response([product])])});assert.equal(r.status,'retry');assert.match(r.error,/count mismatch/);assert.equal(r.products,undefined);});
test('counted exact full page completes without unnecessary next page',async()=>{const calls=[];const r=await fetchStore({host:'example.com'},0,{shop:countedShop(250,[response(fullPage())],calls)});assert.equal(r.status,'ok');assert.equal(calls.length,2);});
const rawKey='datafeeds/shopify/submissions/2026-11-03/12345678-abcd-abcd-abcd-123456789abc.json.gz';
test('a retained oversized submission records held without resending products',async()=>{
 let calls=0;const api=async(path,init)=>{calls++;assert.equal(path,'/ext/ingest');const p=JSON.parse(gunzipSync(init.body));assert.equal(p.host,'example.com');assert.equal(p.date,'2026-11-03');assert.equal(p.status,'held');assert.equal(p.http,413);assert.equal(p.complete,false);assert.equal(p.products,undefined);assert.match(p.error,/raw retained/);assert(init.body.length<1024);return Response.json({status:'held',error:p.error});};
 const r=await ingestResult(Response.json({rawKey,error:'budget'},{status:413}),{api,date:'2026-11-03',host:'example.com',bytes:1000000});assert.equal(r.status,'held');assert.equal(calls,1);
});
for(const [name,status,body] of [['server failure',503,{rawKey}],['unretained rejection',413,{}],['invalid evidence path',413,{rawKey:'https://example.com/private'}],['invalid JSON',413,'not json']])test(`${name} cannot claim a durable held state`,async()=>{
 const r=await ingestResult(new Response(typeof body==='string'?body:JSON.stringify(body),{status}),{api:async()=>assert.fail('Unexpected receipt'),bytes:1});assert.equal(r.status,'ingest_failed');
});
for(const mode of ['transport','http','wrong-status'])test(`failed hold receipt ${mode} remains an actionable runner failure`,async()=>{
 const api=async()=>{if(mode==='transport')throw Error('network');return mode==='http'?new Response('',{status:500}):Response.json({status:'ok'});};
 const r=await ingestResult(Response.json({rawKey},{status:413}),{api,date:'2026-11-03',host:'example.com',bytes:1});assert.equal(r.status,'ingest_failed');
});
