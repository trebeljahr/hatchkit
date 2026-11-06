import assert from 'node:assert/strict';
import {sanitize,issuesFor,pendingFor,sweep,CHECKS,issueKind,DIGEST_UTC_HOUR,digestHour,hostsOf} from './src/templates/security-controller/worker-core.mjs';
const now=Date.parse('2026-10-23T04:00:00Z');
const healthy={schema:1,checks:Object.fromEntries(Object.keys(CHECKS).map(k=>[k,{checkedAt:new Date(now).toISOString(),ok:true,complete:true,findings:0}]))};
const clean=sanitize({...healthy,secret:'MUST_NOT_LEAVE_HOST'},now);
assert(!JSON.stringify(clean).includes('MUST_NOT'));assert.deepEqual(issuesFor('host',clean,now),[]);
assert.match(issuesFor('host',clean,now+21*60000)[0],/publisher missing/);
for(const [check,age] of Object.entries(CHECKS)) {
 const old=structuredClone(clean);old.checks[check].checkedAt=new Date(now-(age+1)*1000).toISOString();
 assert(issuesFor('host',old,now).some(s=>s.includes(`${check} check missing or overdue`)));
}
assert.throws(()=>sanitize({...healthy,checks:{...healthy.checks,files:{ok:true,complete:true,checkedAt:new Date(now+300001).toISOString()}}},now),/future/);
const incomplete=structuredClone(clean);incomplete.checks.images.complete=false;assert.match(issuesFor('host',incomplete,now)[0],/incomplete/);
const changedFiles=structuredClone(clean);changedFiles.checks.files.ok=false;
assert.match(issuesFor('host',changedFiles,now)[0],/file integrity reported changes or failed/);
assert(!issuesFor('host',changedFiles,now)[0].includes('0 finding'));
const changedProcesses=structuredClone(clean);changedProcesses.checks.process.ok=false;changedProcesses.checks.process.findings=2;
assert.match(issuesFor('host',changedProcesses,now)[0],/process needs attention \(2 finding/);
const initializing=structuredClone(clean);
initializing.checks.images={checkedAt:new Date(now).toISOString(),ok:false,complete:false,findings:0,phase:'initializing',progressAt:new Date(now).toISOString(),startedAt:new Date(now).toISOString()};
assert.deepEqual(issuesFor('host',initializing,now),[]);
assert.equal(pendingFor('host',initializing,now).length,1);
const progressing=structuredClone(initializing);progressing.receivedAt=new Date(now+21*60000).toISOString();
assert(issuesFor('host',progressing,now+21*60000).some(x=>x.includes('stalled')));
const refreshing=structuredClone(initializing);Object.assign(refreshing.checks.images,{phase:'refreshing',ok:true,complete:true});
assert.deepEqual(issuesFor('host',refreshing,now),[]);assert.deepEqual(pendingFor('host',refreshing,now),[]);
refreshing.checks.images.phase='failed';assert(issuesFor('host',refreshing,now).some(x=>x.includes('failed')));
const data=new Map([['hosts/app-vps.json',clean],['hosts/ops-vps.json',clean]]);let sent=0,fail=false;
const env={PING_KEYS:JSON.stringify({'app-vps':'APP_PING_KEY','ops-vps':'OPS_PING_KEY'}),STATE:{get:async k=>data.has(k)?{json:async()=>structuredClone(data.get(k))}:null,put:async(k,v)=>data.set(k,JSON.parse(v))},EMAIL:{send:async()=>{if(fail)throw Error('delivery failed');sent++;return{messageId:'test'};}},MAIL_FROM:'security@example.com',MAIL_TO:'owner@example.com'};
await sweep(env,now);assert.equal(sent,0);
data.set('hosts/ops-vps.json',initializing);const setup=await sweep(env,now);assert.equal(sent,0);assert.equal(setup.ok,false);assert.equal(setup.pending.length,1);data.set('hosts/ops-vps.json',clean);
data.delete('hosts/ops-vps.json');fail=true;await assert.rejects(sweep(env,now),/delivery failed/);assert(!data.get('sweep.json').lastMailedAt);
fail=false;await sweep(env,now+1);assert.equal(sent,1);
await sweep(env,now+2);assert.equal(sent,1);
data.set('hosts/ops-vps.json',clean);fail=true;await assert.rejects(sweep(env,now+3));
fail=false;await sweep(env,now+4);assert.equal(sent,2);
// Partial recovery stays quiet; recurrence and failed delivery remain actionable.
const twoProblems=structuredClone(clean);twoProblems.checks.process.ok=false;twoProblems.checks.process.findings=1;twoProblems.checks.backups.ok=false;twoProblems.checks.backups.findings=1;
data.set('hosts/ops-vps.json',twoProblems);await sweep(env,now+5);assert.equal(sent,3);
const oneProblem=structuredClone(twoProblems);oneProblem.checks.backups.ok=true;oneProblem.checks.backups.findings=0;
data.set('hosts/ops-vps.json',oneProblem);await sweep(env,now+6);assert.equal(sent,3);
data.set('hosts/ops-vps.json',twoProblems);fail=true;await assert.rejects(sweep(env,now+7));
fail=false;await sweep(env,now+8);assert.equal(sent,4);await sweep(env,now+9);assert.equal(sent,4);
data.set('hosts/ops-vps.json',clean);await sweep(env,now+10);assert.equal(sent,5);
// Only a dark check repeats on its own; host findings repeat in the host digest.
assert.equal(issueKind('h: publisher missing for more than 20 minutes'),'dark');
assert.equal(issueKind('h: images scan failed or stalled'),'dark');
assert.equal(issueKind('h: process needs attention (2 finding(s))'),'alert');
assert.equal(issueKind('h: backups needs attention (1 finding(s))'),'alert');
assert.equal(issueKind('h: images check incomplete'),'digest');
assert.equal(issueKind('h: file integrity reported changes or failed; inspect its local status'),'digest');
assert.equal(issueKind('h: alert mail or the daily digest failed; inspect its local status'),'dark');
{
 // Incomplete coverage and AIDE changes wait for one daily mail. Delivery retries.
 const quiet=structuredClone(clean);quiet.checks.images.complete=false;quiet.checks.files.ok=false;
 const at=hour=>Date.UTC(2026,9,23,hour,0,0);
 const store=new Map();const put=(host,row,time)=>{store.set(`hosts/${host}.json`,{...row,receivedAt:new Date(time).toISOString(),checks:Object.fromEntries(Object.entries(row.checks).map(([k,v])=>[k,{...v,checkedAt:new Date(time).toISOString()}]))});};
 let mails=[],broken=false;
 const local={PING_KEYS:JSON.stringify({'app-vps':'APP_PING_KEY','ops-vps':'OPS_PING_KEY'}),STATE:{get:async k=>store.has(k)?{json:async()=>structuredClone(store.get(k))}:null,put:async(k,v)=>store.set(k,JSON.parse(v))},EMAIL:{send:async m=>{if(broken)throw Error('delivery failed');mails.push(m);return{messageId:'m'};}},MAIL_FROM:'security@example.com',MAIL_TO:'owner@example.com'};
 const tick=async time=>{put('app-vps',clean,time);put('ops-vps',quiet,time);return sweep(local,time);};
 await tick(at(4));await tick(at(5));assert.equal(mails.length,0);
 broken=true;await assert.rejects(tick(at(DIGEST_UTC_HOUR)));broken=false;
 await tick(at(DIGEST_UTC_HOUR)+60000);assert.equal(mails.length,1);
 assert.match(mails[0].subject,/^\[Hatchkit\] VPS monitor: 1 needs you, 1 not checked$/);
 assert.match(mails[0].text,/Not checked\n-+\n1\. ops-vps: images check incomplete/);
 assert.match(mails[0].html,/cid:hatchkit-icon/);
 await tick(at(DIGEST_UTC_HOUR)+120000);assert.equal(mails.length,1);
 store.delete('hosts/ops-vps.json');put('app-vps',clean,at(23));await sweep(local,at(23));assert.equal(mails.length,2);
 assert.match(mails[1].text,/Needs you[\s\S]*publisher missing/);
 assert.doesNotMatch(mails[1].subject,/ATTENTION|URGENT/);
}
{
 // The raw message: real alternatives, the icon as a related part, fixed identity headers.
 const {rawMessage,renderMail}=await import('./src/templates/security-controller/mail-core.mjs');
 const raw=rawMessage({from:'security@example.com',to:'owner@example.com',subject:'[Hatchkit] VPS monitor: 1 needs you',...renderMail({title:'VPS monitor',sections:{needs:[{what:'Größe',command:'x'}]}}),id:'fixed',boundary:'b'});
 assert.match(raw,/^From: Hatchkit Alerts <security@example\.com>\r\n/);
 assert.match(raw,/\r\nMessage-ID: <fixed@example\.com>\r\n/);
 assert.match(raw,/\r\nAuto-Submitted: auto-generated\r\n/);
 assert.match(raw,/Content-Type: multipart\/alternative; boundary="alt-b"/);
 assert.ok(raw.indexOf('text/plain')<raw.indexOf('multipart/related')&&raw.indexOf('multipart/related')<raw.indexOf('image/png'));
 assert.throws(()=>rawMessage({from:'a@b',to:'c',subject:'x\r\nBcc: y',text:'t',html:'h'}),/invalid mail header/);
}
console.log('External freshness, metadata boundary, quiet healthy runs and delivery retry passed.');
const {default:api}=await import('./src/templates/security-controller/worker-core.mjs');
const liveEnv={...env,APP_PING_KEY:'a'.repeat(43),OPS_PING_KEY:'b'.repeat(43),READER_KEY:'c'.repeat(43)};
const payload={schema:1,checks:Object.fromEntries(Object.keys(CHECKS).map(k=>[k,{checkedAt:new Date().toISOString(),ok:true,complete:true,findings:0}]))};
data.delete('hosts/app-vps.json');
const ping=key=>new Request('https://monitor.test/ping/app-vps',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify(payload)});
assert.equal((await api.fetch(ping(liveEnv.APP_PING_KEY),liveEnv)).status,200);
assert.equal((await api.fetch(ping(liveEnv.OPS_PING_KEY),liveEnv)).status,403);
assert.equal((await api.fetch(ping(liveEnv.APP_PING_KEY),liveEnv)).status,429);
console.log('Per-host authentication, cross-host denial and replay limiting passed.');

// Hosts come only from PING_KEYS: without it a ping answers 503 and a sweep fails.
{
  const bare={STATE:env.STATE,EMAIL:env.EMAIL,READER_KEY:'c'.repeat(43)};
  assert.equal((await api.fetch(ping('a'.repeat(43)),bare)).status,503);
  await assert.rejects(sweep(bare,now),/PING_KEYS is not configured/);
  assert.throws(()=>hostsOf({PING_KEYS:'["app-vps"]'}),/not configured/);
  assert.throws(()=>hostsOf({PING_KEYS:'{"App VPS":"APP_PING_KEY"}'}),/not configured/);
  assert.deepEqual(Object.keys(hostsOf(liveEnv)),['app-vps','ops-vps']);
  assert.equal(digestHour({}),DIGEST_UTC_HOUR);
  assert.equal(digestHour({DIGEST_UTC_HOUR:'7'}),7);
  assert.equal(digestHour({DIGEST_UTC_HOUR:'24'}),DIGEST_UTC_HOUR);
}
