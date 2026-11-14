import assert from 'node:assert/strict';
import worker,{sweep,CHECKS,sanitize} from './src/templates/security-controller/worker-core.mjs';
import {sanitizeDigest,mergeOpen,applyResolved,digestDocument,digestSubject,RESOLVE_HOLD,DIGEST_STALE} from './src/templates/security-controller/digest-pool.mjs';

// 22:00 UTC on a Tuesday: the daily digest hour, not the weekly day.
const tuesday=Date.parse('2026-11-17T22:00:00Z');
const sunday=Date.parse('2026-11-15T22:00:00Z');
const item=(what,extra={})=>({what,command:'hatchkit host updates --host app-vps --json',...extra});
const post=(host,sections={},extra={})=>({schema:1,host,generatedAt:new Date(tuesday-60000).toISOString(),
  sections:{needs:[],waiting:[],unchecked:[],fixed:[],...sections},weekly:{needs:[],waiting:[]},
  counts:{rawCount:0,reviewedCount:0,packageCount:0,groupCount:0},paste:[],...extra});

// The stored post keeps only the item fields the mail shows.
const stored=sanitizeDigest({...post('app-vps',{needs:[item('runc 1.5.2: fix 1.5.3',{secret:'MUST_NOT_STAY'})]}),extra:'x'},'app-vps',tuesday);
assert(!JSON.stringify(stored).includes('MUST_NOT_STAY'));
assert.throws(()=>sanitizeDigest(post('ops-vps'),'app-vps',tuesday),/invalid digest/);
assert.throws(()=>sanitizeDigest(post('app-vps',{needs:[{detail:'no what'}]}),'app-vps',tuesday),/invalid item/);

// The same finding on two hosts is one line naming both hosts, with one id.
const app=sanitizeDigest(post('app-vps',{needs:[item('runc 1.5.2: fix 1.5.3')],waiting:[item('CVE-1 in chromium. No fix reported.',{flags:['Known exploited']})]}),'app-vps',tuesday);
const ops=sanitizeDigest(post('ops-vps',{needs:[item('runc 1.5.2: fix 1.5.3',{command:'hatchkit host updates --host ops-vps --json'})]}),'ops-vps',tuesday);
const merged=await mergeOpen({'app-vps':app,'ops-vps':ops},['ops-vps: images check incomplete','app-vps: publisher missing for more than 20 minutes'],tuesday);
assert.equal(merged.sections.needs.length,2);
const runc=merged.sections.needs.find(i=>i.what.includes('runc'));
assert.equal(runc.what,'[app-vps, ops-vps] runc 1.5.2: fix 1.5.3');
assert.match(runc.command,/--host app-vps .* ; .*--host ops-vps/);
assert.match(runc.id,/^[0-9a-f]{12}$/);
assert.equal(merged.sections.unchecked.length,1);

// Daily: only what someone can act on. Waiting-on-vendor items wait for the weekly review.
const daily=digestDocument(merged,false,tuesday);
assert.equal(daily.sections.waiting,undefined);
assert(daily.notes.some(n=>n.includes('wait on a vendor fix')));
assert.equal(digestSubject(daily),'[Hatchkit] Daily digest: 2 need you, 1 not checked');
assert(daily.sections.needs.every(i=>i.flags.some(f=>/^ID [0-9a-f]{12}$/.test(f))));
const weekly=digestDocument(merged,true,tuesday);
assert.equal(weekly.sections.waiting.length,1);
assert.match(digestSubject(weekly),/^\[Hatchkit\] Weekly review: /);

// A day with only vendor-blocked items sends nothing; the weekly review does.
const onlyWaiting=await mergeOpen({'app-vps':sanitizeDigest(post('app-vps',{waiting:[item('CVE-1. No fix reported.')]}),'app-vps',tuesday)},[],tuesday);
assert.equal(digestDocument(onlyWaiting,false,tuesday),null);
assert.equal(digestDocument(onlyWaiting,true,tuesday).sections.waiting.length,1);
assert.equal(digestDocument(await mergeOpen({},[],tuesday),true,tuesday),null);

// Resolve hides an item until the hold ends; a host still reporting it brings it back flagged.
const hidden=applyResolved(merged,{[runc.id]:{at:new Date(tuesday).toISOString()}},tuesday+3600000);
assert(!hidden.open.sections.needs.some(i=>i.id===runc.id));
assert(hidden.resolved[runc.id]);
const back=applyResolved(merged,{[runc.id]:{at:new Date(tuesday).toISOString()}},tuesday+RESOLVE_HOLD+1);
assert(back.open.sections.needs.find(i=>i.id===runc.id).flags.includes('Still reported after it was resolved'));
assert.deepEqual(back.resolved,{});

// The Worker end to end: posts, one mail a day, retry on failure, nothing on quiet days.
const healthy=sanitize({schema:1,checks:Object.fromEntries(Object.keys(CHECKS).map(k=>[k,{checkedAt:new Date(tuesday).toISOString(),ok:true,complete:true,findings:0}]))},tuesday);
const data=new Map();const mails=[];let fail=false;
const env={POOL_MAIL:'1',PING_KEYS:JSON.stringify({'app-vps':'APP_KEY','ops-vps':'OPS_KEY'}),APP_KEY:'a'.repeat(43),OPS_KEY:'o'.repeat(43),
  RESOLVER_KEY:'r'.repeat(43),READER_KEY:'q'.repeat(43),MAIL_FROM:'alerts@example.com',MAIL_TO:'owner@example.com',
  STATE:{get:async k=>data.has(k)?{json:async()=>structuredClone(data.get(k))}:null,put:async(k,v)=>data.set(k,JSON.parse(v))},
  EMAIL:{send:async m=>{if(fail)throw Error('delivery failed');mails.push(m);return{messageId:'m'+mails.length};}}};
const request=(path,key,body,method='POST')=>new Request('https://monitor.example.com'+path,{method,headers:{Authorization:'Bearer '+key},body:body===undefined?undefined:JSON.stringify(body)});
const at=async(ms,fn)=>{const real=Date.now;Date.now=()=>ms;try{return await fn();}finally{Date.now=real;}};
const heartbeat=ms=>{for(const h of ['app-vps','ops-vps'])data.set(`hosts/${h}.json`,{receivedAt:new Date(ms).toISOString(),checks:Object.fromEntries(Object.entries(healthy.checks).map(([k,v])=>[k,{...v,checkedAt:new Date(ms).toISOString()}]))});};

assert.equal((await worker.fetch(request('/digest/app-vps','o'.repeat(43),post('app-vps')),env)).status,403);
assert.equal((await worker.fetch(request('/digest/ops-vps','o'.repeat(43),post('app-vps')),env)).status,400);
const digestAt=ms=>at(ms,async()=>{for(const [h,k,p] of [['app-vps','a'.repeat(43),app],['ops-vps','o'.repeat(43),ops]])
  assert.equal((await worker.fetch(request(`/digest/${h}`,k,post(h,p.sections,{generatedAt:new Date(ms-60000).toISOString()})),env)).status,200);});
await digestAt(tuesday);heartbeat(tuesday);
await sweep(env,tuesday-3600000);assert.equal(mails.length,0,'nothing before the digest hour');
fail=true;await assert.rejects(sweep(env,tuesday));assert.equal(mails.length,0);
fail=false;await sweep(env,tuesday+300000);assert.equal(mails.length,1,'a failed send retries on the next sweep');
await sweep(env,tuesday+600000);assert.equal(mails.length,1,'one mail a day');
assert.match(mails[0].subject,/^\[Hatchkit\] Daily digest: 1 needs you$/);
assert(mails[0].text.includes('[app-vps, ops-vps] runc 1.5.2'));

// /open and /resolve: only the resolver key resolves; unknown ids are refused.
const open=await (await at(tuesday,()=>worker.fetch(request('/open','q'.repeat(43),undefined,'GET'),env))).json();
const id=open.sections.needs[0].id;
assert.equal((await at(tuesday,()=>worker.fetch(request('/resolve','q'.repeat(43),{ids:[id]}),env))).status,403);
assert.equal((await at(tuesday,()=>worker.fetch(request('/resolve','r'.repeat(43),{ids:['0123456789ab']}),env))).status,404);
assert.equal((await at(tuesday,()=>worker.fetch(request('/resolve','r'.repeat(43),{ids:[id],note:'fixed'}),env))).status,200);

// Next day: the resolved item is hidden, only vendor-blocked items remain, so no mail.
const wednesday=tuesday+86400000;await digestAt(wednesday);heartbeat(wednesday);
await sweep(env,wednesday);assert.equal(mails.length,1,'nothing actionable left');

// A host that stops posting shows up as not received.
heartbeat(wednesday+DIGEST_STALE+86400000);
await sweep(env,wednesday+86400000+DIGEST_STALE);
const thursday=Date.parse('2026-11-19T22:00:00Z');heartbeat(thursday);
await sweep(env,thursday);
assert.equal(mails.length,2);assert(mails[1].text.includes('daily digest not received'));

// The weekly review lists what waits on a vendor even when nothing else is open.
data.clear();mails.length=0;
data.set('digests/app-vps.json',sanitizeDigest(post('app-vps',{waiting:[item('CVE-1. No fix reported.')]},{generatedAt:new Date(sunday-60000).toISOString()}),'app-vps',sunday));
data.set('digests/ops-vps.json',sanitizeDigest(post('ops-vps',{},{generatedAt:new Date(sunday-60000).toISOString()}),'ops-vps',sunday));
for(const h of ['app-vps','ops-vps'])data.set(`hosts/${h}.json`,{...healthy,receivedAt:new Date(sunday).toISOString(),checks:Object.fromEntries(Object.entries(healthy.checks).map(([k,v])=>[k,{...v,checkedAt:new Date(sunday).toISOString()}]))});
await sweep(env,sunday);
assert.equal(mails.length,1);assert.match(mails[0].subject,/^\[Hatchkit\] Weekly review: 1 waiting$/);
console.log('Pooled digest: merge, daily/weekly gating, resolve, retry and stale-host checks passed.');
