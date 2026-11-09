import assert from 'node:assert/strict';
import {storageWatch,readUsage,limitsOf,parseBytes,formatBytes,evaluate,FREE_LIMITS,DEFAULT_GROWTH} from './src/templates/security-controller/storage-watch.mjs';

const GB=1e9,HOUR=3600000,DAY=86400000;
const ACCOUNT='0123456789abcdef0123456789abcdef';
const start=Date.parse('2026-11-10T06:00:00Z');

// Sizes and limits parse strictly; a typo is a configuration error, not a default.
assert.equal(parseBytes('50GB'),50*GB);assert.equal(parseBytes('500 mb'),5e8);assert.equal(parseBytes(1234),1234);
assert.equal(parseBytes('lots'),null);assert.equal(parseBytes(0),null);assert.equal(parseBytes('-1GB'),null);
assert.equal(formatBytes(8.3*GB),'8.3 GB');assert.equal(formatBytes(450e6),'450 MB');assert.equal(formatBytes(150*GB),'150 GB');
{
  const l=limitsOf({});
  assert.equal(l.total('r2'),FREE_LIMITS.r2);assert.equal(l.resource('kv','x','id'),FREE_LIMITS.kv);assert.equal(l.growth,DEFAULT_GROWTH);
  const c=limitsOf({STORAGE_LIMITS:JSON.stringify({r2:'100GB','r2/*':'20GB','r2/big':'80GB','d1/abc-id':'1GB'}),STORAGE_DAILY_GROWTH:'2GB'});
  assert.equal(c.total('r2'),100*GB);assert.equal(c.resource('r2','small','small'),20*GB);assert.equal(c.resource('r2','big','big'),80*GB);
  assert.equal(c.resource('d1','named','abc-id'),1*GB);assert.equal(c.growth,2*GB);
  assert.throws(()=>limitsOf({STORAGE_LIMITS:'{r2:1}'}),/not valid JSON/);
  assert.throws(()=>limitsOf({STORAGE_LIMITS:'{"s3":"1GB"}'}),/unknown key/);
  assert.throws(()=>limitsOf({STORAGE_LIMITS:'{"r2":"big"}'}),/not a size/);
  assert.throws(()=>limitsOf({STORAGE_DAILY_GROWTH:'fast'}),/not a size/);
}

// A fake Cloudflare API: one GraphQL query plus the KV and D1 name lists.
function fakeCloudflare(state) {
  const calls=[];
  const fetcher=async(url,init={})=>{
    calls.push({url,init});
    assert.equal(init.headers.authorization,'Bearer usage-token');
    assert.equal(init.headers['user-agent'],'hatchkit-security-monitor');
    const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
    if(url.endsWith('/graphql')) {
      if(state.graphqlDown)return new Response('error code: 1010',{status:403});
      const vars=JSON.parse(init.body).variables;
      assert.equal(vars.account,ACCOUNT);
      const data={
        r2:state.r2===undefined?[]:Object.entries(state.r2).flatMap(([bucketName,bytes])=>[
          {dimensions:{bucketName,storageClass:'Standard'},max:{payloadSize:bytes-1000,metadataSize:1000}},
          {dimensions:{bucketName,storageClass:'InfrequentAccess'},max:{payloadSize:0,metadataSize:0}}]),
        kv:Object.entries(state.kv||{}).map(([namespaceId,byteCount])=>({dimensions:{namespaceId},max:{byteCount}})),
        d1:Object.entries(state.d1||{}).map(([databaseId,databaseSizeBytes])=>({dimensions:{databaseId},max:{databaseSizeBytes}})),
      };
      const errors=[];
      if(state.d1Error){data.d1=null;errors.push({message:'not authorized for d1StorageAdaptiveGroups',path:['viewer','accounts',0,'d1']});}
      return json({data:{viewer:{accounts:[data]}},errors:errors.length?errors:null});
    }
    if(url.includes('/storage/kv/namespaces')) {
      if(state.kvNamesDown)return json({success:false,errors:[{code:10000,message:'Authentication error'}]},403);
      return json({success:true,result:Object.keys(state.kv||{}).map(id=>({id,title:`kv-${id}`})),result_info:{page:1,per_page:100,total_count:Object.keys(state.kv||{}).length}});
    }
    if(url.includes('/d1/database'))
      return json({success:true,result:Object.keys(state.d1||{}).map(uuid=>({uuid,name:`db-${uuid}`})),result_info:{page:1,per_page:100,total_count:Object.keys(state.d1||{}).length}});
    throw new Error(`unexpected ${url}`);
  };
  return {fetcher,calls};
}
function worker(extra={}) {
  const store=new Map(),mails=[];let broken=false;
  const env={CF_ACCOUNT_ID:ACCOUNT,CF_USAGE_TOKEN:'usage-token',MAIL_FROM:'security@example.com',MAIL_TO:'owner@example.com',
    STATE:{get:async k=>store.has(k)?{json:async()=>structuredClone(store.get(k))}:null,put:async(k,v)=>store.set(k,JSON.parse(v))},
    EMAIL:{send:async m=>{if(broken)throw new Error('delivery failed');mails.push(m);return{messageId:'m'};}},...extra};
  return {env,store,mails,setBroken:v=>{broken=v;}};
}

// Usage reading: R2 storage classes add up, names come from the REST lists.
{
  const cf=fakeCloudflare({r2:{'app-assets':2*GB},kv:{ns1:5e6},d1:{db1:1e6}});
  const u=await readUsage(worker().env,start,cf.fetcher);
  assert.deepEqual(u.unread,{});
  assert.deepEqual(u.resources.map(r=>[r.kind,r.name,r.bytes]),[['r2','app-assets',2*GB],['kv','kv-ns1',5e6],['d1','db-db1',1e6]]);
  // The token never appears in what the Worker stores or mails.
  assert(!JSON.stringify(u).includes('usage-token'));
}
// Missing name grants keep the sizes and say so; a dataset error leaves that kind unread.
{
  const cf=fakeCloudflare({kv:{ns1:5e6},d1:{db1:1e6},kvNamesDown:true,d1Error:true});
  const u=await readUsage(worker().env,start,cf.fetcher);
  assert.equal(u.resources.find(r=>r.kind==='kv').name,'ns1');
  assert.match(u.notes[0],/KV namespaces are shown by id/);
  assert.match(u.unread.d1,/not authorized/);assert.equal(u.unread.r2,undefined);
  const down=await readUsage(worker().env,start,fakeCloudflare({graphqlDown:true}).fetcher);
  assert.deepEqual(Object.keys(down.unread),['r2','kv','d1']);assert.match(down.unread.r2,/GraphQL HTTP 403/);
}

// Healthy account: no mail, state records the sizes, the next run waits a day.
{
  const cfState={r2:{'app-assets':2*GB,'media':1*GB},kv:{ns1:1e6},d1:{db1:2e6}};
  const cf=fakeCloudflare(cfState);const w=worker();
  let s=await storageWatch(w.env,start,cf.fetcher);
  assert.equal(s.ok,true);assert.equal(w.mails.length,0);assert.equal(s.sizes['r2/app-assets'],2*GB);assert.equal(s.sizes.r2,3*GB);
  const reads=cf.calls.length;
  await storageWatch(w.env,start+5*60000,cf.fetcher);await storageWatch(w.env,start+12*HOUR,cf.fetcher);
  assert.equal(cf.calls.length,reads,'one read a day');

  // A bucket passes 80 % of its 10 GB default and the R2 total passes too: one mail.
  cfState.r2['app-assets']=8.5*GB;
  s=await storageWatch(w.env,start+DAY,cf.fetcher);
  assert.equal(w.mails.length,1);
  const mail=w.mails[0];
  assert.match(mail.subject,/^\[Hatchkit\] Cloudflare storage: 4 need you$/);// bucket and total: limit and growth
  assert.match(mail.text,/Needs you\n-+\n1\. R2 bucket app-assets: 8\.5 GB of 10\.0 GB \(85 %\)/);
  assert.match(mail.text,/R2 bucket app-assets grew 6\.5 GB since 2026-11-10/);
  assert.match(mail.text,/R2 storage \(all buckets\): 9\.5 GB of 10\.0 GB/);
  assert.match(mail.text,/Run: npx wrangler r2 bucket info app-assets/);
  assert.match(mail.html,/cid:hatchkit-icon/);
  assert(!mail.text.includes('usage-token'));

  // The next day: still above the limit, no new crossing, no mail.
  cfState.r2['app-assets']=8.6*GB;
  await storageWatch(w.env,start+2*DAY,cf.fetcher);assert.equal(w.mails.length,1);
  // It drops below and crosses again: a new crossing mails again.
  cfState.r2['app-assets']=2*GB;await storageWatch(w.env,start+3*DAY,cf.fetcher);assert.equal(w.mails.length,1);
  cfState.r2['app-assets']=9*GB;await storageWatch(w.env,start+4*DAY,cf.fetcher);assert.equal(w.mails.length,2);
}

// Growth alone: a KV namespace adds 1.5 GB to a paid-plan limit; a raised limit is quiet.
{
  const cfState={kv:{ns1:0.2*GB}};const cf=fakeCloudflare(cfState);
  const w=worker({STORAGE_LIMITS:JSON.stringify({kv:'100GB','kv/*':'50GB'})});
  await storageWatch(w.env,start,cf.fetcher);
  cfState.kv.ns1=1.7*GB;
  await storageWatch(w.env,start+DAY,cf.fetcher);
  assert.equal(w.mails.length,1);
  assert.match(w.mails[0].subject,/2 need you/);// the namespace and the KV total both grew
  assert.match(w.mails[0].text,/KV namespace kv-ns1 grew 1\.5 GB/);
  assert.doesNotMatch(w.mails[0].text,/% \)/);
  // Growth over two days is measured per day: 1.8 GB in 2 days is quiet.
  cfState.kv.ns1=3.5*GB;
  const w2=worker({STORAGE_LIMITS:JSON.stringify({kv:'100GB','kv/*':'50GB'})});const cf2=fakeCloudflare({kv:{ns1:1.7*GB}});
  await storageWatch(w2.env,start,cf2.fetcher);
  const later=fakeCloudflare(cfState);await storageWatch(w2.env,start+2*DAY,later.fetcher);
  assert.equal(w2.mails.length,0);
}

// A failing read is never healthy: hourly retries, then "Not checked" after a day without data.
{
  const cfState={r2:{'app-assets':1*GB}};const cf=fakeCloudflare(cfState);const w=worker();
  await storageWatch(w.env,start,cf.fetcher);
  cfState.graphqlDown=true;
  let s=await storageWatch(w.env,start+DAY,cf.fetcher);
  assert.equal(s.ok,false);assert.equal(s.unchecked.length,3);assert.equal(w.mails.length,0,'one failed read does not mail');
  const reads=cf.calls.length;
  await storageWatch(w.env,start+DAY+10*60000,cf.fetcher);assert.equal(cf.calls.length,reads,'retries wait an hour');
  for(let h=1;h<=2;h++)await storageWatch(w.env,start+DAY+h*HOUR,cf.fetcher);
  assert.equal(w.mails.length,1);
  assert.match(w.mails[0].subject,/Cloudflare storage: 3 not checked$/);
  assert.match(w.mails[0].text,/Not checked\n-+\n1\. R2 bucket sizes could not be read: GraphQL HTTP 403/);
  await storageWatch(w.env,start+DAY+4*HOUR,cf.fetcher);assert.equal(w.mails.length,1,'not repeated hourly');
  // Recovery reads again at once and stays quiet when healthy.
  cfState.graphqlDown=false;
  s=await storageWatch(w.env,start+DAY+5*HOUR,cf.fetcher);
  assert.equal(s.ok,true);assert.equal(w.mails.length,1);
}

// Configuration: off without both settings; half or invalid settings are "Not checked", not healthy.
{
  const off=worker({CF_ACCOUNT_ID:undefined,CF_USAGE_TOKEN:undefined});
  assert.deepEqual(await storageWatch(off.env,start,()=>{throw new Error('no fetch');}),{configured:false});
  assert.equal(off.store.size,0);
  const half=worker({CF_USAGE_TOKEN:undefined});
  let s=await storageWatch(half.env,start,()=>{throw new Error('no fetch');});
  assert.equal(s.ok,false);assert.match(s.unchecked[0].what,/half configured/);
  await storageWatch(half.env,start+3*HOUR,()=>{throw new Error('no fetch');});
  assert.equal(half.mails.length,1);assert.match(half.mails[0].subject,/1 not checked/);
  const bad=worker({STORAGE_LIMITS:'{"r2":"lots"}'});
  s=await storageWatch(bad.env,start,()=>{throw new Error('no fetch');});
  assert.match(s.unchecked[0].what,/STORAGE_LIMITS r2 is not a size/);
}

// A failed delivery stays pending and is retried on the next run.
{
  const cfState={d1:{db1:0.1*GB}};const cf=fakeCloudflare(cfState);const w=worker();
  await storageWatch(w.env,start,cf.fetcher);
  cfState.d1.db1=4.5*GB;w.setBroken(true);
  await assert.rejects(storageWatch(w.env,start+DAY,cf.fetcher),/delivery failed/);
  assert.equal(w.store.get('storage.json').deliveryPending,true);
  w.setBroken(false);
  await storageWatch(w.env,start+DAY+5*60000,cf.fetcher);
  assert.equal(w.mails.length,1);assert.match(w.mails[0].text,/D1 database db-db1: 4\.5 GB of 5\.0 GB \(90 %\)/);
  await storageWatch(w.env,start+DAY+10*60000,cf.fetcher);assert.equal(w.mails.length,1);
}

// evaluate() keys stay stable while sizes change.
{
  const l=limitsOf({});
  const a=evaluate({resources:[{kind:'r2',id:'b',name:'b',bytes:9*GB}],unread:{kv:'x',d1:'x'}},{},l,start);
  const b=evaluate({resources:[{kind:'r2',id:'b',name:'b',bytes:9.5*GB}],unread:{kv:'x',d1:'x'}},{},l,start);
  assert.deepEqual(a.needs.map(n=>n.key),b.needs.map(n=>n.key));
  assert.deepEqual(a.needs.map(n=>n.key),['limit:r2/b','limit:r2']);
}
console.log('Storage watch: limits, usage reading, new-crossing mail, growth, unchecked reads and delivery retry passed.');
