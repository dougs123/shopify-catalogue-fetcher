import{pathToFileURL}from'node:url';
export async function replay({worker=process.env.WORKER_URL,key=process.env.INGEST_KEY,receiptKey=process.env.REPLAY_RECEIPT,request=fetch}={}){
 if(!worker||!key)throw Error('Existing Worker credentials required');
 if(!/^datafeeds\/shopify\/submissions\/\d{4}-\d{2}-\d{2}\/[a-f0-9-]{36}\/receipt\.json$/.test(receiptKey||''))throw Error('Invalid retained receipt key');
 const response=await request(worker.replace(/\/$/,'')+'/ext/replay',{method:'POST',headers:{'content-type':'application/json','x-ingest-key':key},body:JSON.stringify({receiptKey}),signal:AbortSignal.timeout(600000)});
 if(!response.ok)throw Error('Recovery HTTP '+response.status);
 const result=await response.json();if(!['ok','superseded'].includes(result.status))throw Error('Recovery did not complete: '+String(result.status));
 return {status:result.status,products:result.products,variants:result.variants,bytes:result.bytes};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(await replay());
