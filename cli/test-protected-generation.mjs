import test from 'node:test';
import assert from 'node:assert/strict';
import {copyGeneration,RecoveryError} from './src/templates/protected-recovery/generation.mjs';
const id='20261023T120000Z-0123456789abcdef',hash='a'.repeat(64);
const policy={sourceBucket:'primary-backups',destinationBucket:'protected-backups',projects:['app'],maxGenerationBytes:1024**3,maxStoredBytes:2*1024**3,maxObjects:4000,maxPages:20,maxDurationMs:600000};
function fixture(){
 const source=['config',`keys/${hash}`,`snapshots/${hash}`,`index/${hash}`,`data/aa/${hash}`].map((key,i)=>({key:'app/'+key,size:100+i,etag:'source-'+i}));
 const dest=new Map(),calls=[];
 const store={async acquireLease(){return {etag:"lease",owner:id};},async releaseLease(){},async list(bucket){return {objects:bucket===policy.sourceBucket?source.map(x=>({...x})):[...dest.values()],truncated:false};},
  async copy(input){calls.push(input);const row=source.find(x=>x.key===input.sourceKey);assert.equal(input.sourceEtag,row.etag);const result={key:input.destinationKey,size:row.size,etag:'destination-'+row.etag};dest.set(result.key,result);return {etag:result.etag};},
  async head(bucket,key){return dest.get(key);},async putNew(bucket,key,value){assert.equal(dest.has(key),false);dest.set(key,{key,size:new TextEncoder().encode(value).length,etag:'metadata',value});}};
 return {source,dest,calls,store};
}
const fails=code=>error=>error instanceof RecoveryError&&error.code===code;
test('complete independent generation uses source conditions and promotes last',async()=>{
 const f=fixture();const result=await copyGeneration(f.store,policy,{id,now:()=>1792756800000});
 assert.equal(result.complete,true);assert.equal(result.objects,5);assert.equal(f.calls.length,5);
 assert.ok([...f.dest.keys()].every(key=>key.startsWith('generations/'+id+'/')));
 const manifest=JSON.parse(f.dest.get('generations/'+id+'/manifest.json').value);
 assert.equal(manifest.objects[0].destinationEtag.startsWith('destination-'),true);
 assert.ok(!JSON.stringify(result).includes('source-'));
});
test('partial copy failure never publishes completion and never deletes',async()=>{
 const f=fixture();f.store.copy=async()=>{throw Error('simulated network failure');};
 await assert.rejects(copyGeneration(f.store,policy,{id}));assert.equal(f.dest.size,0);
});
test('source mutation after copy leaves an incomplete generation',async()=>{
 const f=fixture();const original=f.store.list;let sourceReads=0;
 f.store.list=async bucket=>{if(bucket===policy.sourceBucket&&++sourceReads===2)f.source[0].etag='changed';return original(bucket);};
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('source-changed-during-copy'));
 assert.equal(f.dest.has('generations/'+id+'/COMPLETE.json'),false);
});
test('existing restic lock prevents copying',async()=>{
 const f=fixture();f.source.push({key:'app/locks/'+hash,size:1,etag:'lock'});
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('source-repository-busy'));assert.equal(f.calls.length,0);
});
test('unregistered data is rejected before payload copying',async()=>{
 const f=fixture();f.source.push({key:'personal/config',size:1,etag:'unexpected'});
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('unregistered-source-project'));assert.equal(f.calls.length,0);
});
test('incomplete generations count toward storage cap',async()=>{
 const f=fixture();f.dest.set('generations/failed/repository/pack',{key:'generations/failed/repository/pack',size:policy.maxStoredBytes,etag:'retained'});
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('stored-byte-budget-exceeded'));assert.equal(f.calls.length,0);
});
test('generation byte cap fails before copying',async()=>{
 const f=fixture();await assert.rejects(copyGeneration(f.store,{...policy,maxGenerationBytes:10},{id}),fails('generation-byte-budget-exceeded'));assert.equal(f.calls.length,0);
});
test('changed destination bytes block completion',async()=>{
 const f=fixture();f.store.head=async()=>({size:0,etag:'wrong'});
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('destination-verification-failed'));assert.equal(f.dest.has('generations/'+id+'/COMPLETE.json'),false);
});
test('duplicate generation is never overwritten',async()=>{
 const f=fixture();await copyGeneration(f.store,policy,{id});const count=f.calls.length;
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('generation-already-exists'));assert.equal(f.calls.length,count);
});
test('an incomplete registered repository cannot be promoted',async()=>{
 const f=fixture();f.source.pop();await assert.rejects(copyGeneration(f.store,policy,{id}),fails('incomplete-source-project'));assert.equal(f.calls.length,0);
});
test('unbounded settings and same source/destination fail closed',async()=>{
 const f=fixture();await assert.rejects(copyGeneration(f.store,{...policy,maxGenerationBytes:10*1024**3},{id}),fails('budget-exceeds-reviewed-ceiling'));
 await assert.rejects(copyGeneration(f.store,{...policy,destinationBucket:policy.sourceBucket},{id}),fails('invalid-buckets'));
});

test('a concurrent generation cannot bypass the global storage cap',async()=>{
 const f=fixture();f.store.acquireLease=async()=>null;
 await assert.rejects(copyGeneration(f.store,policy,{id}),fails('another-generation-is-running'));
 assert.equal(f.calls.length,0);
});

test('a slow provider call cannot publish completion after the lease work deadline',async()=>{
 const f=fixture();let now=1792756800000;const original=f.store.copy;
 f.store.copy=async p=>{const result=await original(p);now+=600001;return result;};
 await assert.rejects(copyGeneration(f.store,policy,{id,now:()=>now}),fails('copy-deadline-exceeded'));
 assert.equal(f.dest.has('generations/'+id+'/COMPLETE.json'),false);
});
test('lease acquisition consumes the original work budget',async()=>{
 const f=fixture();let now=1792756800000;
 f.store.acquireLease=async()=>{now+=600001;return {etag:'lease',owner:id};};
 await assert.rejects(copyGeneration(f.store,policy,{id,now:()=>now}),fails('copy-deadline-exceeded'));
 assert.equal(f.calls.length,0);assert.equal(f.dest.size,0);
});
test('final promotion reserves the full single-request timeout',async()=>{
 const f=fixture();let now=1792756800000;const original=f.store.putNew;
 f.store.putNew=async(bucket,key,value)=>{await original(bucket,key,value);if(key.endsWith('/manifest.json'))now+=580000;};
 await assert.rejects(copyGeneration(f.store,policy,{id,now:()=>now}),fails('copy-deadline-exceeded'));
 assert.equal(f.dest.has('generations/'+id+'/COMPLETE.json'),false);
});
