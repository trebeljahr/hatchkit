import test from 'node:test';
import assert from 'node:assert/strict';
import {s3Store} from './src/templates/protected-recovery/s3-store.mjs';
import {RecoveryError} from './src/templates/protected-recovery/generation.mjs';
const absent={$metadata:{httpStatusCode:404}},conflict={$metadata:{httpStatusCode:412}};
test('server-side copy is restricted to the exact source identity and destination',async()=>{
 const calls=[],store=s3Store({send:async command=>{calls.push(command);return {CopyObjectResult:{ETag:'copied'}};}});
 assert.deepEqual(await store.copy({sourceBucket:'source',sourceKey:'app/data/aa/pack',sourceEtag:'source-etag',destinationBucket:'destination',destinationKey:'generations/one/repository/app/data/aa/pack'}),{etag:'copied'});
 assert.deepEqual(calls[0].input,{Bucket:'destination',Key:'generations/one/repository/app/data/aa/pack',CopySource:'source/app/data/aa/pack',CopySourceIfMatch:'source-etag',MetadataDirective:'COPY'});
});
test('immutable generation metadata uses conditional creation',async()=>{
 let input;await s3Store({send:async c=>{input=c.input;}}).putNew('destination','generations/id/COMPLETE.json','{}');
 assert.equal(input.IfNoneMatch,'*');assert.equal(input.Bucket,'destination');
});
test('new lease uses atomic absence precondition',async()=>{
 const calls=[],store=s3Store({send:async c=>{calls.push(c);if(c.constructor.name==='GetObjectCommand')throw absent;return {ETag:'lease-etag'};}});
 assert.equal((await store.acquireLease('destination',{owner:'one',expiresAt:20},10)).etag,'lease-etag');
 assert.equal(calls[1].input.IfNoneMatch,'*');
});
test('an active lease prevents a second writer',async()=>{
 let writes=0;const store=s3Store({send:async c=>{if(c.constructor.name==='GetObjectCommand')return {ETag:'current',...leaseResult({owner:'one',expiresAt:20})};writes++;}});
 assert.equal(await store.acquireLease('destination',{owner:'two',expiresAt:30},10),null);assert.equal(writes,0);
});
test('expired leases require matching ETag and a race loses safely',async()=>{
 let input;const store=s3Store({send:async c=>{if(c.constructor.name==='GetObjectCommand')return {ETag:'old',...leaseResult({owner:'old',expiresAt:0})};input=c.input;throw conflict;}});
 assert.equal(await store.acquireLease('destination',{owner:'new',expiresAt:20},10),null);assert.equal(input.IfMatch,'old');
});
test('lease release cannot overwrite a newer owner and never deletes',async()=>{
 let input;await s3Store({send:async c=>{assert.equal(c.constructor.name,'PutObjectCommand');input=c.input;throw conflict;}}).releaseLease('destination',{owner:'old',etag:'old-etag'});
 assert.equal(input.IfMatch,'old-etag');assert.equal(input.Key,'control/copy-lease.json');
});
const metadataKey='generations/20261023T120000Z-0123456789abcdef/COMPLETE.json';
const rejected=code=>error=>error instanceof RecoveryError&&error.code===code;
function streamResult(chunks,length) {
 return {ContentLength:length,Body:(async function*(){yield* chunks;})()};
}
test('metadata loader reads exact UTF-8 bytes from SDK and Web streams',async()=>{
 const bytes=new TextEncoder().encode('{"label":"é"}');
 for(const body of [(async function*(){yield bytes.slice(0,11);yield bytes.slice(11);})(),new ReadableStream({start(c){c.enqueue(bytes);c.close();}})]){
  let input;const store=s3Store({send:async c=>{input=c.input;return {ContentLength:bytes.length,Body:body};}});
  assert.equal(await store.readMetadata('protected-backups',metadataKey),'{"label":"é"}');
  assert.deepEqual(input,{Bucket:'protected-backups',Key:metadataKey});
 }
});
test('metadata reads reject traversal and repository payloads before making a request',async()=>{
 let calls=0;const store=s3Store({send:async()=>{calls++;}});
 for(const key of ['../COMPLETE.json',metadataKey+'/other',metadataKey.replace('COMPLETE.json','repository/app/config'),metadataKey.replace('COMPLETE','latest')]){
  await assert.rejects(store.readMetadata('protected-backups',key),rejected('invalid-metadata-key'));
 }
 assert.equal(calls,0);
});
test('metadata headers, streamed sizes and truncated bodies are bounded independently',async()=>{
 for(const [length,chunks]of [[4097,[]],[-1,[]],[undefined,[]],[1,[new Uint8Array(2)]],[2,[new Uint8Array(1)]],[4096,[new Uint8Array(4096),new Uint8Array(1)]]]){
  const store=s3Store({send:async()=>streamResult(chunks,length)});
  await assert.rejects(store.readMetadata('protected-backups',metadataKey),rejected('metadata-size-invalid'));
 }
});
test('metadata streams are cancelled on overflow and invalid UTF-8 fails closed',async()=>{
 let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}});
 const store=s3Store({send:async()=>({ContentLength:2,Body:body})});
 await assert.rejects(store.readMetadata('protected-backups',metadataKey),rejected('metadata-size-invalid'));assert.equal(cancelled,true);
 const invalid=s3Store({send:async()=>streamResult([new Uint8Array([0xc3])],1)});
 await assert.rejects(invalid.readMetadata('protected-backups',metadataKey),rejected('metadata-body-invalid'));
});
test('missing metadata returns null and provider failures expose no provider text',async()=>{
 assert.equal(await s3Store({send:async()=>{throw absent;}}).readMetadata('protected-backups',metadataKey),null);
 const store=s3Store({send:async()=>{throw Error('PRIVATE_PROVIDER_CREDENTIAL');}});
 await assert.rejects(store.readMetadata('protected-backups',metadataKey),rejected('recovery-metadata-unavailable'));
});

function leaseResult(value) {
 const bytes=new TextEncoder().encode(JSON.stringify(value));return streamResult([bytes],bytes.length);
}
test('lease parsing bounds streamed bytes independently of claimed length and never writes on malformed input',async()=>{
 for(const result of [streamResult([],4097),streamResult([],-1),streamResult([new Uint8Array(2)],1),streamResult([new Uint8Array(1)],2),streamResult([new Uint8Array([0xc3])],1),streamResult([new TextEncoder().encode('PRIVATE_LEASE_PAYLOAD')],21)]) {
  let writes=0;const store=s3Store({send:async command=>{if(command.constructor.name==='GetObjectCommand')return {ETag:'old',...result};writes++;}});
  await assert.rejects(store.acquireLease('destination',{owner:'new',expiresAt:20},10),error=>error instanceof RecoveryError&&!error.message.includes('PRIVATE_LEASE_PAYLOAD'));
  assert.equal(writes,0);
 }
});
test('an overflowing lease stream is cancelled without acquiring or releasing another writer',async()=>{
 let cancelled=false,writes=0;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}});
 const store=s3Store({send:async command=>{if(command.constructor.name==='GetObjectCommand')return {ETag:'old',ContentLength:2,Body:body};writes++;}});
 await assert.rejects(store.acquireLease('destination',{owner:'new',expiresAt:20},10),rejected('metadata-size-invalid'));
 assert.equal(cancelled,true);assert.equal(writes,0);
});
