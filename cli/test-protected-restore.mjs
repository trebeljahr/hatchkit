import test from 'node:test';
import assert from 'node:assert/strict';
import {copyGeneration,RecoveryError,sha256} from './src/templates/protected-recovery/generation.mjs';
import {verifyRestoreSelection,loadRestoreSelection} from './src/templates/protected-recovery/restore-selection.mjs';

const base=Date.parse('2026-10-23T12:00:00Z'),day=86400000,id='20261023T120000Z-0123456789abcdef',hash='a'.repeat(64);
const policy={sourceBucket:'primary-backups',destinationBucket:'protected-backups',projects:['app'],maxGenerationBytes:1024**3,maxStoredBytes:2*1024**3,maxObjects:4000,maxPages:20,maxDurationMs:600000};
const rejected=code=>error=>error instanceof RecoveryError&&error.code===code;
async function fixture() {
 const source=['config',`keys/${hash}`,`snapshots/${hash}`,`index/${hash}`,`data/aa/${hash}`].map((key,i)=>({key:'app/'+key,size:100+i,etag:'source-'+i}));
 const destination=new Map();let heads=0;
 const store={async acquireLease(){return{etag:'lease',owner:id};},async releaseLease(){},
  async list(bucket){return{objects:bucket===policy.sourceBucket?source:[...destination.values()],truncated:false};},
  async copy(p){const original=source.find(x=>x.key===p.sourceKey),row={...original,key:p.destinationKey,etag:'destination-'+original.etag};destination.set(row.key,row);return{etag:row.etag};},
  async head(bucket,key){heads++;return destination.get(key);},
  async putNew(bucket,key,value){destination.set(key,{key,size:new TextEncoder().encode(value).length,etag:'metadata',value});},
  async readMetadata(bucket,key){assert.equal(bucket,policy.destinationBucket);return destination.get(key)?.value??null;}};
 const proof=await copyGeneration(store,policy,{id,now:()=>base});heads=0;
 return{store,proof,manifestText:destination.get(`generations/${id}/manifest.json`).value,heads:()=>heads};
}
const options=f=>({proof:f.proof,manifestText:f.manifestText,before:new Date(base+3600000).toISOString(),now:()=>base+day});
async function change(f,mutate){const m=JSON.parse(f.manifestText);mutate(m);f.manifestText=JSON.stringify(m);f.proof.manifestSHA256=await sha256(f.manifestText);}

test('a real generated manifest verifies every destination object without claiming native restore or cleanliness',async()=>{
 const f=await fixture(),result=await verifyRestoreSelection(f.store,policy,options(f));
 assert.equal(f.heads(),5);assert.equal(result.metadataVerified,true);assert.equal(result.nativeRestoreVerified,false);
 assert.equal(result.incidentCleanliness,'unassessed');assert.equal(result.currentlyProtected,true);
 assert.equal(result.repositoryPrefix,`generations/${id}/repository/`);
 assert.equal(JSON.stringify(result).includes('destination-source-'),false);
});
test('an explicit cutoff is required and post-cutoff generations are refused before object reads',async()=>{
 const f=await fixture();await assert.rejects(verifyRestoreSelection(f.store,policy,{...options(f),before:undefined}),rejected('invalid-recovery-time'));
 await assert.rejects(verifyRestoreSelection(f.store,policy,{...options(f),before:new Date(base-1).toISOString()}),rejected('generation-after-recovery-cutoff'));
 assert.equal(f.heads(),0);
});
test('missing or modified manifest data cannot be selected',async()=>{
 const f=await fixture();f.manifestText+=' ';
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('manifest-hash-mismatch'));assert.equal(f.heads(),0);
});
test('generation identity and approved source bucket must match',async()=>{
 const f=await fixture();await change(f,m=>{m.sourceBucket='other-records';});
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('manifest-identity-mismatch'));
});
test('traversal, unregistered projects and duplicate object rows fail closed',async()=>{
 for(const [key,code]of[['app/../../private','unexpected-source-object'],['personal/config','unregistered-source-project']]){
  const f=await fixture();await change(f,m=>{m.objects[0].key=key;});
  await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected(code));assert.equal(f.heads(),0);
 }
 const f=await fixture();await change(f,m=>{m.objects.push(m.objects[0]);m.bytes+=m.objects[0].size;});f.proof.objects++;f.proof.bytes+=100;
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('invalid-recovery-object'));
});
test('a missing object, changed ETag or changed size prevents selection',async()=>{
 for(const head of [null,{size:100,etag:'wrong'},{size:0,etag:'destination-source-0'}]){
  const f=await fixture();f.store.head=async()=>head;
  await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('recovery-object-changed'));
 }
});
test('retention boundaries and the conservative pre-expiry cutoff are enforced',async()=>{
 const f=await fixture();
 await assert.rejects(verifyRestoreSelection(f.store,policy,{...options(f),requireCurrentlyProtected:0}),rejected('invalid-recovery-policy'));
 await assert.rejects(verifyRestoreSelection(f.store,policy,{...options(f),now:()=>base+90*day}),rejected('recovery-protection-expired'));
 const old=await verifyRestoreSelection(f.store,policy,{...options(f),now:()=>base+95*day,requireCurrentlyProtected:false});
 assert.equal(old.currentlyProtected,false);
 await assert.rejects(verifyRestoreSelection(f.store,policy,{...options(f),now:()=>base+119*day,requireCurrentlyProtected:false}),rejected('recovery-generation-expired'));
 f.proof.protectedUntil=new Date(base+91*day).toISOString();
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('invalid-recovery-retention'));
});
test('object counts and byte totals must agree with immutable completion metadata',async()=>{
 const f=await fixture();f.proof.objects++;
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('invalid-recovery-object-count'));
 f.proof.objects--;f.proof.bytes++;
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),rejected('recovery-size-mismatch'));
});
test('malformed metadata and upstream errors never echo raw supplied contents',async()=>{
 const f=await fixture();f.manifestText='PRIVATE_SECRET_NOT_TO_EXPORT';f.proof.manifestSHA256=await sha256(f.manifestText);
 await assert.rejects(verifyRestoreSelection(f.store,policy,options(f)),error=>rejected('manifest-json-invalid')(error)&&!error.message.includes('PRIVATE_SECRET'));
 const g=await fixture();g.store.head=async()=>{throw Error('PRIVATE_PROVIDER_CREDENTIAL');};
 await assert.rejects(verifyRestoreSelection(g.store,policy,options(g)),rejected('recovery-object-unavailable'));
});
test('slow provider calls cannot finish a metadata verification beyond its work budget',async()=>{
 const f=await fixture();let current=base+day;const original=f.store.head;
 f.store.head=async(...args)=>{const result=await original(...args);current+=600001;return result;};
 await assert.rejects(verifyRestoreSelection(f.store,policy,{...options(f),now:()=>current}),rejected('restore-selection-deadline-exceeded'));
});
const loadOptions=()=>({id,before:new Date(base+3600000).toISOString(),now:()=>base+day});
test('loader verifies only the explicitly requested generation and returns the same metadata gate',async()=>{
 const f=await fixture(),result=await loadRestoreSelection(f.store,policy,loadOptions());
 assert.equal(result.id,id);assert.equal(result.metadataVerified,true);assert.equal(f.heads(),5);
 assert.equal(result.nativeRestoreVerified,false);
});
test('loader never selects incomplete or mismatched generations',async()=>{
 for(const [value,code]of [[null,'incomplete-recovery-generation'],['{','completion-json-invalid'],['x'.repeat(4097),'completion-size-exceeded'],[JSON.stringify({id:'another'}),'requested-generation-mismatch']]){
  const f=await fixture();let reads=0;f.store.readMetadata=async()=>{reads++;return value;};
  await assert.rejects(loadRestoreSelection(f.store,policy,loadOptions()),rejected(code));
  assert.equal(reads,1);assert.equal(f.heads(),0);
 }
 const f=await fixture(),original=f.store.readMetadata;
 f.store.readMetadata=async(bucket,key)=>key.endsWith('/manifest.json')?null:original(bucket,key);
 await assert.rejects(loadRestoreSelection(f.store,policy,loadOptions()),rejected('incomplete-recovery-generation'));
});
test('invalid generation names do not reach storage and upstream read errors remain generic',async()=>{
 const f=await fixture();let reads=0;f.store.readMetadata=async()=>{reads++;throw Error('PRIVATE_SECRET');};
 await assert.rejects(loadRestoreSelection(f.store,policy,{...loadOptions(),id:'../other'}),rejected('invalid-generation-id'));assert.equal(reads,0);
 await assert.rejects(loadRestoreSelection(f.store,policy,loadOptions()),rejected('recovery-metadata-unavailable'));
});
test('metadata loading and subsequent object reads share one deadline',async()=>{
 const f=await fixture();let current=base+day,reads=0;const original=f.store.readMetadata;
 f.store.readMetadata=async(...args)=>{reads++;const result=await original(...args);current+=300001;return result;};
 await assert.rejects(loadRestoreSelection(f.store,policy,{...loadOptions(),now:()=>current}),rejected('restore-selection-deadline-exceeded'));
 assert.equal(reads,2);assert.equal(f.heads(),0);
 const g=await fixture();current=base+day;const read=g.store.readMetadata,head=g.store.head;
 g.store.readMetadata=async(...args)=>{const result=await read(...args);current+=200000;return result;};
 g.store.head=async(...args)=>{const result=await head(...args);current+=200001;return result;};
 await assert.rejects(loadRestoreSelection(g.store,policy,{...loadOptions(),now:()=>current}),rejected('restore-selection-deadline-exceeded'));
 assert.equal(g.heads(),1);
});
