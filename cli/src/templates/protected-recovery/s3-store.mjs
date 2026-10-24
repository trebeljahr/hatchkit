import {ListObjectsV2Command,CopyObjectCommand,HeadObjectCommand,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {RecoveryError} from './generation.mjs';
const leaseKey='control/copy-lease.json';
const conflict=error=>[409,412].includes(error?.$metadata?.httpStatusCode);
const absent=error=>error?.$metadata?.httpStatusCode===404;
const encodeKey=value=>value.split('/').map(encodeURIComponent).join('/');
const fail=code=>{throw new RecoveryError(code);};
// Never use transformToString(): a false ContentLength must not permit an
// unbounded allocation. Both SDK Node streams and Web streams are supported.
async function boundedText(result,limit) {
  const body=result.Body;let reader,done=false;
  try {
    if(!Number.isSafeInteger(result.ContentLength)||result.ContentLength<0||result.ContentLength>limit) fail('metadata-size-invalid');
    const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let bytes=0,text='';
    const append=chunk=>{
      if(!(chunk instanceof Uint8Array)) fail('metadata-body-invalid');
      bytes+=chunk.byteLength;
      if(bytes>limit||bytes>result.ContentLength) fail('metadata-size-invalid');
      text+=decoder.decode(chunk,{stream:true});
    };
    if(typeof body?.getReader==='function') {
      reader=body.getReader();
      while(true) {const part=await reader.read();if(part.done)break;append(part.value);}
    } else if(typeof body?.[Symbol.asyncIterator]==='function') {
      for await(const chunk of body) append(chunk);
    } else fail('metadata-body-invalid');
    if(bytes!==result.ContentLength) fail('metadata-size-invalid');
    text+=decoder.decode();done=true;return text;
  } catch(error) {
    if(error instanceof RecoveryError)throw error;
    fail('metadata-body-invalid');
  } finally {
    if(!done) {
      try {if(reader)await reader.cancel();else if(typeof body?.destroy==='function')body.destroy();else await body?.cancel?.();} catch {}
    }
    reader?.releaseLock();
  }
}
export function s3Store(client) {
  return {
    async list(bucket,cursor) {
      const result=await client.send(new ListObjectsV2Command({Bucket:bucket,ContinuationToken:cursor,MaxKeys:1000}));
      return {objects:(result.Contents||[]).map(o=>({key:o.Key,size:o.Size,etag:o.ETag})),
        truncated:result.IsTruncated===true,cursor:result.NextContinuationToken};
    },
    async copy(p) {
      const result=await client.send(new CopyObjectCommand({Bucket:p.destinationBucket,Key:p.destinationKey,
        CopySource:encodeKey(p.sourceBucket+'/'+p.sourceKey),CopySourceIfMatch:p.sourceEtag,MetadataDirective:'COPY'}));
      return {etag:result.CopyObjectResult?.ETag};
    },
    async head(bucket,key) {
      try {
        const result=await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
        return {size:result.ContentLength,etag:result.ETag};
      } catch(error) {if(absent(error))return null;throw error;}
    },
    async readMetadata(bucket,key) {
      const match=typeof key==='string'&&/^generations\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}\/(manifest|COMPLETE)\.json$/.exec(key);
      if(!match) fail('invalid-metadata-key');
      try {
        const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}));
        return await boundedText(result,match[1]==='manifest'?2*1024**2:4096);
      } catch(error) {
        if(absent(error))return null;
        if(error instanceof RecoveryError)throw error;
        fail('recovery-metadata-unavailable');
      }
    },
    async putNew(bucket,key,value) {
      return client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:value,IfNoneMatch:'*',ContentType:'application/json',CacheControl:'no-store'}));
    },
    async acquireLease(bucket,value,now) {
      let current;
      try {
        const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:leaseKey}));
        if(!Number.isSafeInteger(result.ContentLength)||result.ContentLength>4096)throw Error('invalid-lease-size');
        current={...JSON.parse(await result.Body.transformToString()),etag:result.ETag};
        if(!Number.isFinite(current.expiresAt)||!current.etag)throw Error('invalid-lease');
        if(current.expiresAt>now)return null;
      } catch(error) {if(!absent(error))throw error;}
      try {
        const result=await client.send(new PutObjectCommand({Bucket:bucket,Key:leaseKey,Body:JSON.stringify(value),ContentType:'application/json',
          ...(current?{IfMatch:current.etag}:{IfNoneMatch:'*'})}));
        if(!result.ETag)throw Error('lease-not-confirmed');
        return {...value,etag:result.ETag};
      } catch(error) {if(conflict(error))return null;throw error;}
    },
    async releaseLease(bucket,lease) {
      try {
        await client.send(new PutObjectCommand({Bucket:bucket,Key:leaseKey,Body:JSON.stringify({owner:lease.owner,expiresAt:0}),
          ContentType:'application/json',IfMatch:lease.etag}));
      } catch(error) {if(!conflict(error))throw error;}
    },
  };
}
