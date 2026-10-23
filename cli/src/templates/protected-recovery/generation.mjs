// Full independent restic repositories; never expire shared content-addressed packs.
// The store adapter performs server-side copy with a source ETag precondition.
export class RecoveryError extends Error {
  constructor(code) { super(code); this.name='RecoveryError'; this.code=code; }
}
const fail = code => { throw new RecoveryError(code); };
const encoder = new TextEncoder();
const countBytes = rows => rows.reduce((sum,row)=>sum+row.size,0);
const sameInventory = (a,b) => JSON.stringify(a)===JSON.stringify(b);
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export function validatePolicy(p) {
  if(!p || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(p.sourceBucket||'') ||
     !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(p.destinationBucket||'') || p.sourceBucket===p.destinationBucket) fail('invalid-buckets');
  if(!Array.isArray(p.projects)||!p.projects.length||p.projects.length>100||new Set(p.projects).size!==p.projects.length||
     p.projects.some(x=>!/^[-a-z0-9_]{1,100}$/.test(x))) fail('invalid-projects');
  for(const key of ['maxGenerationBytes','maxStoredBytes','maxObjects','maxPages','maxDurationMs']) {
    if(!Number.isSafeInteger(p[key])||p[key]<=0) fail('invalid-budget');
  }
  if(p.maxGenerationBytes>2*1024**3||p.maxStoredBytes>20*1024**3||p.maxObjects>4000||p.maxPages>20||p.maxDurationMs>10*60000) fail('budget-exceeds-reviewed-ceiling');
}
export async function inventory(store,bucket,p,source=false,deadline=()=>{}) {
  const rows=[],seen=new Set();let cursor;
  for(let page=0;page<p.maxPages;page++) {
    deadline();
    const result=await store.list(bucket,cursor);
    deadline();
    for(const obj of result.objects) {
      if(!obj || typeof obj.key!=='string'||seen.has(obj.key)||!Number.isSafeInteger(obj.size)||obj.size<0||typeof obj.etag!=='string'||!obj.etag) fail('invalid-inventory');
      seen.add(obj.key);
      if(source) {
        const [project,...tail]=obj.key.split('/'),relative=tail.join('/');
        if(!p.projects.includes(project)) fail('unregistered-source-project');
        if(/^locks\/[0-9a-f]{64}$/.test(relative)) fail('source-repository-busy');
        if(!/^(?:config|(?:keys|snapshots|index)\/[0-9a-f]{64}|data\/[0-9a-f]{2}\/[0-9a-f]{64})$/.test(relative)) fail('unexpected-source-object');
      }
      rows.push({key:obj.key,size:obj.size,etag:obj.etag});
      if(rows.length>p.maxObjects) fail('object-budget-exceeded');
    }
    if(!result.truncated) return rows.sort((a,b)=>a.key.localeCompare(b.key));
    if(!result.cursor||result.cursor===cursor) fail('invalid-pagination');
    cursor=result.cursor;
  }
  fail('page-budget-exceeded');
}
async function copyLeasedGeneration(store,p,{id,now=()=>Date.now()}={}) {
  validatePolicy(p);
  if(!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$/.test(id||'')) fail('invalid-generation-id');
  const started=now(),prefix=`generations/${id}/`,manifestKey=prefix+'manifest.json',completeKey=prefix+'COMPLETE.json';
  const deadline=()=>{if(now()-started>p.maxDurationMs)fail('copy-deadline-exceeded');};
  const source=await inventory(store,p.sourceBucket,p,true,deadline);
  if(!source.length) fail('empty-source');
  // Require every approved project to have a complete restic repository shape.
  for(const project of p.projects) {
    for(const required of ['config','keys/','snapshots/','index/','data/']) {
      if(!source.some(row=>row.key===project+'/'+required || (required.endsWith('/')&&row.key.startsWith(project+'/'+required)))) fail('incomplete-source-project');
    }
  }
  const bytes=countBytes(source);
  if(bytes>p.maxGenerationBytes) fail('generation-byte-budget-exceeded');
  const existing=await inventory(store,p.destinationBucket,p,false,deadline);
  if(existing.some(row=>row.key.startsWith(prefix))) fail('generation-already-exists');
  // Include incomplete generations and headroom for immutable metadata in the cap.
  const metadataAllowance=encoder.encode(JSON.stringify(source)).byteLength*3+16384;
  if(countBytes(existing)+bytes+metadataAllowance>p.maxStoredBytes) fail('stored-byte-budget-exceeded');
  const copied=[];
  for(const row of source) {
    deadline();
    const key=prefix+'repository/'+row.key;
    const result=await store.copy({sourceBucket:p.sourceBucket,sourceKey:row.key,sourceEtag:row.etag,destinationBucket:p.destinationBucket,destinationKey:key});
    deadline();
    if(!result || typeof result.etag!=='string'||!result.etag) fail('copy-not-confirmed');
    const head=await store.head(p.destinationBucket,key);
    deadline();
    if(!head||head.size!==row.size||head.etag!==result.etag) fail('destination-verification-failed');
    copied.push({...row,destinationEtag:head.etag});
  }
  const after=await inventory(store,p.sourceBucket,p,true,deadline);
  if(!sameInventory(source,after)) fail('source-changed-during-copy');
  // Publish completion last. Failed/incomplete generations remain retained, never restored automatically.
  const manifest=JSON.stringify({schema:1,id,sourceBucket:p.sourceBucket,objects:copied,bytes,startedAt:new Date(started).toISOString()});
  deadline();
  await store.putNew(p.destinationBucket,manifestKey,manifest);
  deadline();
  const manifestHash=await sha256(manifest);
  const proof={schema:1,id,complete:true,objects:source.length,bytes,manifestSHA256:manifestHash,completedAt:new Date(now()).toISOString(),protectedUntil:new Date(started+90*86400000).toISOString(),usableUntil:new Date(started+119*86400000).toISOString()};
  deadline();
  await store.putNew(p.destinationBucket,completeKey,JSON.stringify(proof));
  return proof;
}

export async function copyGeneration(store,p,{id,now=()=>Date.now()}={}) {
  validatePolicy(p);
  if(!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$/.test(id||'')) fail('invalid-generation-id');
  const lease=await store.acquireLease(p.destinationBucket,{owner:id,expiresAt:now()+p.maxDurationMs+60000},now());
  if(!lease) fail('another-generation-is-running');
  try { return await copyLeasedGeneration(store,p,{id,now}); }
  finally { await store.releaseLease(p.destinationBucket,lease); }
}
