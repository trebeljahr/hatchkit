import {ListObjectsV2Command,CopyObjectCommand,HeadObjectCommand,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
const leaseKey='control/copy-lease.json';
const conflict=error=>[409,412].includes(error?.$metadata?.httpStatusCode);
const absent=error=>error?.$metadata?.httpStatusCode===404;
const encodeKey=value=>value.split('/').map(encodeURIComponent).join('/');
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
