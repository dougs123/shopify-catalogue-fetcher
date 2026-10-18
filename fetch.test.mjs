import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchStore,slim} from './fetch.mjs';
const product={id:1,handle:'item',variants:[{id:2,price:'12.00',available:true}]};
const response=(products,status=200)=>({status,headers:new Headers({'content-type':'application/json'}),json:async()=>({products})});
function shop(pages){return async url=>url.includes('/meta.json')?{status:200,url:'https://example.com/meta.json',json:async()=>({currency:'GBP',country:'GB'})}:pages.shift();}
test('unchanged prices remain in a complete dated catalogue',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response([product])])});assert.equal(r.status,'ok');assert.equal(r.complete,true);assert.equal(r.products[0].variants[0].price,'12.00');assert.ok(Number.isFinite(Date.parse(r.fetched_at)));assert.equal(slim(r).fetched_at,r.fetched_at);});
for(const status of [403,429,500,0]) test(`later page HTTP ${status} cannot publish a partial catalogue`,async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response(Array(250).fill(product)),response([],status)])});assert.equal(r.status,'retry');assert.equal(r.products,undefined);});
test('later invalid JSON cannot publish partial data',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response(Array(250).fill(product)),{status:200,headers:new Headers(),json:async()=>({})}])});assert.equal(r.status,'retry');assert.equal(r.complete,false);});
test('page limit retains previous complete snapshot',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response(Array(250).fill(product))]),MAX_PAGES:1});assert.equal(r.status,'retry');assert.equal(r.complete,false);});
test('explicit unavailable variant stays unavailable',async()=>{const r=await fetchStore({host:'example.com'},0,{shop:shop([response([{...product,variants:[{id:2,price:'12',available:false}]}])])});assert.equal(r.status,'ok');assert.equal(r.products[0].variants[0].available,false);});
