import test from 'node:test';
import assert from 'node:assert/strict';
import {s3Store} from './src/templates/protected-recovery/s3-store.mjs';
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
 let writes=0;const store=s3Store({send:async c=>{if(c.constructor.name==='GetObjectCommand')return {ETag:'current',ContentLength:30,Body:{transformToString:async()=>JSON.stringify({owner:'one',expiresAt:20})}};writes++;}});
 assert.equal(await store.acquireLease('destination',{owner:'two',expiresAt:30},10),null);assert.equal(writes,0);
});
test('expired leases require matching ETag and a race loses safely',async()=>{
 let input;const store=s3Store({send:async c=>{if(c.constructor.name==='GetObjectCommand')return {ETag:'old',ContentLength:30,Body:{transformToString:async()=>JSON.stringify({owner:'old',expiresAt:0})}};input=c.input;throw conflict;}});
 assert.equal(await store.acquireLease('destination',{owner:'new',expiresAt:20},10),null);assert.equal(input.IfMatch,'old');
});
test('lease release cannot overwrite a newer owner and never deletes',async()=>{
 let input;await s3Store({send:async c=>{assert.equal(c.constructor.name,'PutObjectCommand');input=c.input;throw conflict;}}).releaseLease('destination',{owner:'old',etag:'old-etag'});
 assert.equal(input.IfMatch,'old-etag');assert.equal(input.Key,'control/copy-lease.json');
});
