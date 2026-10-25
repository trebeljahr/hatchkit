// Only fixed health metadata crosses this boundary. No app logs, records or secrets.
export const HOSTS = ['app-vps', 'ops-vps'];
export const CHECKS = {process: 15*60, full: 28*3600, advisory: 8*3600,
  images: 36*3600, files: 28*3600, backups: 36*3600, restore: 9*86400};
const iso = ms => new Date(ms).toISOString();
export function sanitize(body, now=Date.now()) {
  if (!body || typeof body !== 'object' || !body.checks || body.schema !== 1) throw new Error('invalid heartbeat');
  const checks = {};
  for (const name of Object.keys(CHECKS)) {
    const row = body.checks[name];
    if (!row || typeof row.ok !== 'boolean' || typeof row.complete !== 'boolean') throw new Error('invalid check');
    const time = Date.parse(row.checkedAt);
    if (Number.isFinite(time) && time > now+300000) throw new Error('future check');
    checks[name] = {checkedAt: Number.isFinite(time) ? iso(time) : null,
      ok: row.ok, complete: row.complete,
      findings: Number.isSafeInteger(row.findings) && row.findings >= 0 ? Math.min(row.findings, 100000) : 0};
    if (name === 'images' && row.phase !== undefined) {
      if (!['complete','refreshing','initializing','failed'].includes(row.phase)) throw new Error('invalid image phase');
      const safe = checks[name];safe.phase = row.phase;
      for (const field of ['progressAt','startedAt']) {
        const value = Date.parse(row[field]);
        if (Number.isFinite(value) && value > now+300000) throw new Error('future progress');
        safe[field] = Number.isFinite(value) ? iso(value) : null;
      }
    }
  }
  return {receivedAt: iso(now), checks};
}
function freshProgress(check, now) {
  const started = Date.parse(check.startedAt), last = Date.parse(check.progressAt);
  return Number.isFinite(started) && Number.isFinite(last) &&
    now-started <= 2*3600000 && now-last <= 20*60000 && started <= now+300000 && last <= now+300000;
}
export function pendingFor(host, heartbeat, now=Date.now()) {
  const c = heartbeat?.checks?.images;
  return c?.phase === 'initializing' && freshProgress(c,now) ? [`${host}: initial image inventory in progress`] : [];
}
export function issuesFor(host, heartbeat, now=Date.now()) {
  if (!heartbeat || now-Date.parse(heartbeat.receivedAt) > 20*60000) return [`${host}: publisher missing for more than 20 minutes`];
  const issues = [];
  for (const [name, maximum] of Object.entries(CHECKS)) {
    const c = heartbeat.checks[name];
    if (name === 'images' && c?.phase === 'initializing' && freshProgress(c,now)) continue;
    if (name === 'images' && (c?.phase === 'failed' || (['initializing','refreshing'].includes(c?.phase) && !freshProgress(c,now)))) issues.push(`${host}: images scan failed or stalled`);
    else if (!c || !c.checkedAt || now-Date.parse(c.checkedAt) > maximum*1000) issues.push(`${host}: ${name} check missing or overdue`);
    else if (!c.complete) issues.push(`${host}: ${name} check incomplete`);
    else if (!c.ok && !c.findings) issues.push(name === 'files'
      ? `${host}: file integrity reported changes or failed; inspect its local status`
      : `${host}: ${name} check unsuccessful; inspect its local status`);
    else if (!c.ok) issues.push(`${host}: ${name} needs attention (${c.findings} finding(s))`);
  }
  return issues;
}
async function authorized(actual, expected) {
  if (!actual || !expected || actual.length > 200) return false;
  const hash = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a,b] = await Promise.all([hash(actual),hash(expected)]);
  let difference=0;const aa=new Uint8Array(a),bb=new Uint8Array(b);
  for(let n=0;n<aa.length;n++) difference |= aa[n]^bb[n];
  return difference===0;
}
async function jsonObject(bucket,key) { const value=await bucket.get(key);return value ? value.json() : null; }
async function readSmall(request) {
  const reader=request.body?.getReader();if(!reader)throw new Error('missing body');
  let length=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;
    if(length>8192){await reader.cancel();throw new Error('oversized body');}chunks.push(value);}
  const all=new Uint8Array(length);let at=0;for(const c of chunks){all.set(c,at);at+=c.length;}
  return JSON.parse(new TextDecoder().decode(all));
}
export async function sweep(env, now=Date.now()) {
  const issues=[],pending=[];
  for(const host of HOSTS) {
    const heartbeat=await jsonObject(env.STATE,`hosts/${host}.json`);
    issues.push(...issuesFor(host,heartbeat,now));pending.push(...pendingFor(host,heartbeat,now));
  }
  const previous=await jsonObject(env.STATE,'sweep.json') || {};
  const added=issues.some(issue=>!(previous.issues || []).includes(issue));
  const unacknowledged=issues.some(issue=>!(previous.notifiedIssues || []).includes(issue));
  const reminder=issues.length && (!previous.lastMailedAt || now-Date.parse(previous.lastMailedAt)>=86400000);
  const state={checkedAt:iso(now),ok:!issues.length&&!pending.length,issues,pending,lastMailedAt:previous.lastMailedAt || null,notifiedIssues:previous.notifiedIssues || []};
  const shouldDeliver=!!((issues.length && (added || unacknowledged || previous.deliveryPending || reminder)) ||
    (!issues.length && !pending.length && previous.notifiedIssues?.length));
  state.deliveryPending=shouldDeliver;
  // Save the attempted sweep before delivery; a failed delivery must remain retryable.
  await env.STATE.put('sweep.json',JSON.stringify(state));
  if(shouldDeliver) {
    const sent=await env.EMAIL.send({from:env.MAIL_FROM,to:env.MAIL_TO,
      subject:issues.length ? '[Hatchkit] VPS security checks need attention' : '[Hatchkit] VPS checks recovered',
      text:(issues.length ? issues.map(s=>'- '+s).join('\n') : 'Monitoring coverage recovered on both VPSs. Vulnerability findings remain in the separate patch ledger.')+
        '\n\nThe monitor runs outside the VPSs. Use Tailscale to investigate. No application records or logs are included.'});
    state.lastMailedAt=iso(now);state.notifiedIssues=issues;state.messageId=sent?.messageId || null;
    state.deliveryPending=false;
  }
  await env.STATE.put('sweep.json',JSON.stringify(state));
  return state;
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);const bearer=request.headers.get('Authorization')?.replace(/^Bearer /,'');
    const host=url.pathname.match(/^\/ping\/(app-vps|ops-vps)$/)?.[1];
    if(request.method==='POST' && host) {
      if(!await authorized(bearer,env[host==='app-vps'?'DEDICATED_PING_KEY':'SHARED_PING_KEY']))return new Response('Forbidden',{status:403});
      const old=await jsonObject(env.STATE,`hosts/${host}.json`);
      if(old && Date.now()-Date.parse(old.receivedAt)<30000)return new Response('Rate limited',{status:429});
      try {const safe=sanitize(await readSmall(request));await env.STATE.put(`hosts/${host}.json`,JSON.stringify(safe));return Response.json({accepted:true});}
      catch {return new Response('Invalid heartbeat',{status:400});}
    }
    if(url.pathname==='/test' && request.method==='POST' && await authorized(bearer,env.READER_KEY)) {
      const last=await jsonObject(env.STATE,'mail-test.json');
      if(last && Date.now()-Date.parse(last.sentAt)<3600000)return new Response('Rate limited',{status:429});
      await env.EMAIL.send({from:env.MAIL_FROM,to:env.MAIL_TO,subject:'[Hatchkit] Independent VPS alert test',text:'The independent VPS freshness monitor can send alerts. This test includes no application records or logs.'});
      await env.STATE.put('mail-test.json',JSON.stringify({sentAt:iso(Date.now())}));
      return Response.json({sent:true});
    }
    if(url.pathname==='/status' && request.method==='GET' && await authorized(bearer,env.READER_KEY)) {
      const state=await jsonObject(env.STATE,'sweep.json');return Response.json(state || {ok:false,issue:'No sweep yet'});
    }
    return new Response('Not found',{status:404});
  },
  async scheduled(_controller,env,ctx){ctx.waitUntil(sweep(env));},
};
