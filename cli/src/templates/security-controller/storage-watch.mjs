// Account-wide Cloudflare storage watch: one mail when an R2 bucket, a Workers
// KV namespace or a D1 database (or a kind's account total) passes 80 % of its
// limit, or grows more than a set amount in a day. Only sizes and resource
// names cross this boundary; no object keys, rows or values are read.
//
// Configuration (Worker variables and secrets):
//   CF_ACCOUNT_ID         the account to watch (variable)
//   CF_USAGE_TOKEN        read-only account token (secret): Account Analytics
//                         Read; Workers KV Storage Read and D1 Read add names
//   STORAGE_LIMITS        optional JSON: "r2" / "kv" / "d1" = account total,
//                         "r2/*" = default per resource, "r2/<name or id>" =
//                         one resource. Bytes or "50GB" / "500MB".
//   STORAGE_DAILY_GROWTH  optional, default "1GB": growth per day that alerts
// Without CF_ACCOUNT_ID and CF_USAGE_TOKEN the watch is off. Anything else
// that keeps a read from completing reports "Not checked", never healthy.
import {renderMail,summaryLine} from './mail-core.mjs';

const GB=1e9,MB=1e6,DAY=86400000,HOUR=3600000;
/** Free-plan limits: R2 10 GB, KV 1 GB, D1 5 GB (account totals). */
export const FREE_LIMITS={r2:10*GB,kv:1*GB,d1:5*GB};
export const KINDS={r2:'R2 bucket',kv:'KV namespace',d1:'D1 database'};
const TOTAL_LABEL={r2:'R2 storage (all buckets)',kv:'KV storage (all namespaces)',d1:'D1 storage (all databases)'};
export const WARN_SHARE=0.8;
export const DEFAULT_GROWTH=1*GB;
// A successful read counts for a day; a failed one retries hourly.
const READ_EVERY=23*HOUR,RETRY_EVERY=55*60000;
// No successful read for this long mails "Not checked".
export const UNCHECKED_AFTER=26*HOUR;
const GROUP_LIMIT=1000;
const iso=ms=>new Date(ms).toISOString();

export function parseBytes(value) {
  if(typeof value==='number')return Number.isFinite(value)&&value>0?value:null;
  const m=String(value??'').trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if(!m)return null;
  const n=Number(m[1])*{B:1,KB:1e3,MB:MB,GB:GB,TB:1e12}[(m[2]||'B').toUpperCase()];
  return n>0?n:null;
}
export function formatBytes(n) {
  if(n>=GB)return `${(n/GB).toFixed(n>=100*GB?0:1)} GB`;
  if(n>=MB)return `${(n/MB).toFixed(n>=100*MB?0:1)} MB`;
  return `${Math.round(n/1e3)} KB`;
}
/** Throws on invalid configuration: a typo must not fall back to defaults silently. */
export function limitsOf(env) {
  let raw={};
  if(env.STORAGE_LIMITS!==undefined&&env.STORAGE_LIMITS!=='') {
    try {raw=JSON.parse(env.STORAGE_LIMITS);} catch {throw new Error('STORAGE_LIMITS is not valid JSON');}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('STORAGE_LIMITS is not a JSON object');
  }
  const limits={};
  for(const [key,value] of Object.entries(raw)) {
    if(!/^(r2|kv|d1)(\/.{1,200})?$/.test(key))throw new Error(`STORAGE_LIMITS has an unknown key ${JSON.stringify(key)}`);
    const bytes=parseBytes(value);
    if(!bytes)throw new Error(`STORAGE_LIMITS ${key} is not a size`);
    limits[key]=bytes;
  }
  let growth=DEFAULT_GROWTH;
  if(env.STORAGE_DAILY_GROWTH!==undefined&&env.STORAGE_DAILY_GROWTH!=='') {
    growth=parseBytes(env.STORAGE_DAILY_GROWTH);
    if(!growth)throw new Error('STORAGE_DAILY_GROWTH is not a size');
  }
  const total=kind=>limits[kind]??FREE_LIMITS[kind];
  return {growth,
    total,
    resource:(kind,name,id)=>limits[`${kind}/${name}`]??limits[`${kind}/${id}`]??limits[`${kind}/*`]??total(kind),
    configured:(kind,name,id)=>[`${kind}/${name}`,`${kind}/${id}`,`${kind}/*`].some(k=>k in limits)};
}

const QUERY=`query($account:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$account}){
r2:r2StorageAdaptiveGroups(limit:${GROUP_LIMIT},filter:{datetime_geq:$start,datetime_leq:$end}){max{payloadSize metadataSize} dimensions{bucketName storageClass}}
kv:kvStorageAdaptiveGroups(limit:${GROUP_LIMIT},filter:{datetime_geq:$start,datetime_leq:$end}){max{byteCount} dimensions{namespaceId}}
d1:d1StorageAdaptiveGroups(limit:${GROUP_LIMIT},filter:{datetime_geq:$start,datetime_leq:$end}){max{databaseSizeBytes} dimensions{databaseId}}}}}`;
const API='https://api.cloudflare.com/client/v4';
function headers(env) {return {authorization:`Bearer ${env.CF_USAGE_TOKEN}`,'content-type':'application/json','user-agent':'hatchkit-security-monitor'};}
// Error text from Cloudflare can quote the request; keep only a short, plain message.
const short=error=>String(error?.message??error).replace(/[^\x20-\x7e]/g,' ').slice(0,160);

async function names(env,fetcher,path) {
  const map={};
  for(let page=1;page<=10;page++) {
    const res=await fetcher(`${API}/accounts/${env.CF_ACCOUNT_ID}/${path}?per_page=100&page=${page}`,{headers:headers(env)});
    const body=await res.json().catch(()=>null);
    if(!res.ok||!body?.success||!Array.isArray(body.result))throw new Error(`HTTP ${res.status}`);
    for(const row of body.result)if(row?.uuid??row?.id)map[row.uuid??row.id]=String(row.name??row.title??row.uuid??row.id);
    const info=body.result_info;
    if(!info||page*(info.per_page||100)>=(info.total_count??0)||body.result.length===0)return map;
  }
  throw new Error('more than 1000 entries');
}

/** {resources:[{kind,id,name,bytes}], unread:{kind:reason}, notes:[]} — never throws for one kind. */
export async function readUsage(env,now=Date.now(),fetcher=fetch) {
  const unread={},notes=[],resources=[];
  let data=null;
  try {
    const res=await fetcher(`${API}/graphql`,{method:'POST',headers:headers(env),
      body:JSON.stringify({query:QUERY,variables:{account:env.CF_ACCOUNT_ID,start:iso(now-DAY),end:iso(now)}})});
    const body=await res.json().catch(()=>null);
    if(!res.ok||!body)throw new Error(`GraphQL HTTP ${res.status}`);
    data=body.data?.viewer?.accounts?.[0]??null;
    if(!data)throw new Error(body.errors?.[0]?.message?short(body.errors[0].message):'no account in the GraphQL answer');
    for(const e of body.errors??[]) {
      const kind=['r2','kv','d1'].find(k=>(e.path||[]).includes(k));
      if(kind)unread[kind]=short(e.message);
      else for(const k of Object.keys(KINDS))unread[k]??=short(e.message);
    }
  } catch(error) {
    for(const kind of Object.keys(KINDS))unread[kind]=short(error);
    return {resources,unread,notes};
  }
  for(const kind of Object.keys(KINDS)) {
    if(unread[kind])continue;
    const rows=data[kind];
    if(!Array.isArray(rows)){unread[kind]='missing from the GraphQL answer';continue;}
    if(rows.length>=GROUP_LIMIT){unread[kind]=`more than ${GROUP_LIMIT} groups; the list is cut off`;continue;}
    const sizes={};
    for(const row of rows) {
      const id=kind==='r2'?row.dimensions?.bucketName:kind==='kv'?row.dimensions?.namespaceId:row.dimensions?.databaseId;
      const bytes=kind==='r2'?(row.max?.payloadSize??0)+(row.max?.metadataSize??0):kind==='kv'?row.max?.byteCount:row.max?.databaseSizeBytes;
      if(typeof id!=='string'||!Number.isFinite(bytes)){unread[kind]='unexpected row in the GraphQL answer';break;}
      sizes[id]=(sizes[id]??0)+bytes; // R2: one row per storage class
    }
    if(unread[kind])continue;
    let label={};
    if(kind!=='r2'&&Object.keys(sizes).length) {
      try {label=await names(env,fetcher,kind==='kv'?'storage/kv/namespaces':'d1/database');}
      catch(error) {notes.push(`${KINDS[kind]} names could not be read (${short(error)}); ids are shown. The token needs ${kind==='kv'?'Workers KV Storage':'D1'} Read for names.`);}
    }
    for(const [id,bytes] of Object.entries(sizes))resources.push({kind,id,name:label[id]??id,bytes});
  }
  return {resources,unread,notes};
}

function command(kind,id,name) {
  if(kind==='r2')return `npx wrangler r2 bucket info ${name}`;
  if(kind==='kv')return `npx wrangler kv key list --namespace-id ${id} --remote`;
  return `npx wrangler d1 info ${name}`;
}
/** Stable keys: a size that keeps changing must not count as a new crossing. */
export function evaluate(usage,previous,limits,now) {
  const needs=[],sizes={};
  const elapsed=previous?.checkedAt?now-Date.parse(previous.checkedAt):NaN;
  const days=Number.isFinite(elapsed)&&elapsed>0&&elapsed<=7*DAY?Math.max(1,elapsed/DAY):null;
  const rows=[];
  for(const kind of Object.keys(KINDS)) {
    if(usage.unread[kind])continue;
    const mine=usage.resources.filter(r=>r.kind===kind);
    for(const r of mine)rows.push({key:`${kind}/${r.id}`,kind,label:`${KINDS[kind]} ${r.name}`,bytes:r.bytes,
      limit:limits.resource(kind,r.name,r.id),custom:limits.configured(kind,r.name,r.id),setting:`"${kind}/${r.name}"`,command:command(kind,r.id,r.name)});
    rows.push({key:kind,kind,label:TOTAL_LABEL[kind],bytes:mine.reduce((s,r)=>s+r.bytes,0),
      limit:limits.total(kind),custom:false,setting:`"${kind}"`,command:`npx wrangler ${{r2:'r2 bucket',kv:'kv namespace',d1:'d1'}[kind]} list`});
  }
  for(const row of rows) {
    sizes[row.key]=row.bytes;
    const share=row.bytes/row.limit;
    if(share>=WARN_SHARE)needs.push({key:`limit:${row.key}`,what:`${row.label}: ${formatBytes(row.bytes)} of ${formatBytes(row.limit)} (${Math.round(share*100)} %)`,
      detail:`Alerts at ${Math.round(WARN_SHARE*100)} % of the limit. Raise it with STORAGE_LIMITS ${row.setting} if this size is expected.`,command:row.command});
    const before=previous?.sizes?.[row.key];
    if(days&&Number.isFinite(before)&&row.bytes-before>limits.growth*days)
      needs.push({key:`growth:${row.key}`,what:`${row.label} grew ${formatBytes(row.bytes-before)} since ${previous.checkedAt.slice(0,10)} (now ${formatBytes(row.bytes)})`,
        detail:`Alerts above ${formatBytes(limits.growth)} a day (STORAGE_DAILY_GROWTH).`,command:row.command});
  }
  return {needs,sizes};
}

const FOOTER='The storage watch reads sizes and resource names from Cloudflare analytics once a day with a read-only token. It never reads stored objects, keys or rows.';
export function storageDocument(needs,unchecked,notes) {
  const strip=({key,...item})=>item;
  return {title:'Cloudflare storage',sections:{needs:needs.map(strip),unchecked:unchecked.map(strip)},notes,footer:[FOOTER]};
}
export function storageSubject(needs,unchecked) {
  return `[Hatchkit] Cloudflare storage: ${summaryLine(storageDocument(needs,unchecked,[]))}`;
}

async function readState(bucket) {const v=await bucket.get('storage.json');return v?v.json():null;}

export async function storageWatch(env,now=Date.now(),fetcher=fetch) {
  if(!env.CF_ACCOUNT_ID&&!env.CF_USAGE_TOKEN)return {configured:false};
  const previous=await readState(env.STATE)||{};
  const due=!previous.checkedAt||now-Date.parse(previous.checkedAt)>=READ_EVERY;
  const retryWait=previous.attemptedAt&&now-Date.parse(previous.attemptedAt)<RETRY_EVERY;
  if((!due||retryWait)&&!previous.deliveryPending)return previous;
  const state={...previous,attemptedAt:iso(now)};
  let needs=[],unchecked=[],notes=[];
  let limits=null;
  if(!env.CF_ACCOUNT_ID||!env.CF_USAGE_TOKEN||!/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID))
    unchecked.push({key:'config',what:'Storage watch is half configured: set both CF_ACCOUNT_ID (32 hex characters) and the CF_USAGE_TOKEN secret',detail:'Setup: cli/src/templates/security-controller/README.md in hatchkit.'});
  else try {limits=limitsOf(env);} catch(error) {unchecked.push({key:'config',what:`Storage watch settings are invalid: ${short(error)}`,detail:'Setup: cli/src/templates/security-controller/README.md in hatchkit.'});}
  if(limits&&(due||!previous.checkedAt)) {
    const usage=await readUsage(env,now,fetcher);
    notes=usage.notes;
    for(const [kind,reason] of Object.entries(usage.unread))
      unchecked.push({key:`read:${kind}`,what:`${KINDS[kind]} sizes could not be read: ${reason}`,detail:'Check that CF_USAGE_TOKEN is active and has Account Analytics Read.'});
    const result=evaluate(usage,previous,limits,now);
    needs=result.needs;
    if(!Object.keys(usage.unread).length) {
      state.checkedAt=iso(now);state.sizes=result.sizes;state.failingSince=null;
    } else {
      // Keep the last good sizes for kinds that failed, so growth stays measurable.
      state.sizes={...(previous.sizes||{}),...result.sizes};
      state.failingSince=previous.failingSince||iso(now);
    }
  } else if(!limits) {
    state.failingSince=previous.failingSince||iso(now);
  } else {
    needs=previous.needs||[];unchecked=previous.unchecked||[];notes=previous.notes||[];
  }
  state.needs=needs;state.unchecked=unchecked;state.notes=notes;
  state.ok=!needs.length&&!unchecked.length;
  // "Not checked" mails once a whole day of reads is missing (two hours when
  // the watch has never read successfully), not on one failed hourly retry.
  const lastGood=Date.parse(state.checkedAt||'')||null;
  const longDark=unchecked.length>0&&(lastGood?now-lastGood>=UNCHECKED_AFTER:now-Date.parse(state.failingSince||iso(now))>=2*HOUR);
  const mailedNeeds=previous.notifiedNeeds||[],mailedUnchecked=previous.notifiedUnchecked||[];
  const newNeeds=needs.some(item=>!mailedNeeds.includes(item.key));
  const newDark=longDark&&unchecked.some(item=>!mailedUnchecked.includes(item.key));
  const deliver=!!(newNeeds||newDark||(previous.deliveryPending&&(needs.length||unchecked.length)));
  state.deliveryPending=deliver;
  state.notifiedNeeds=mailedNeeds.filter(key=>needs.some(item=>item.key===key));
  state.notifiedUnchecked=mailedUnchecked.filter(key=>unchecked.some(item=>item.key===key));
  await env.STATE.put('storage.json',JSON.stringify(state));
  if(deliver) {
    const sent=await env.EMAIL.send({from:env.MAIL_FROM,to:env.MAIL_TO,subject:storageSubject(needs,unchecked),...renderMail(storageDocument(needs,unchecked,notes))});
    state.notifiedNeeds=needs.map(item=>item.key);
    if(longDark)state.notifiedUnchecked=unchecked.map(item=>item.key);
    state.lastMailedAt=iso(now);state.messageId=sent?.messageId||null;state.deliveryPending=false;
    await env.STATE.put('storage.json',JSON.stringify(state));
  }
  return state;
}
