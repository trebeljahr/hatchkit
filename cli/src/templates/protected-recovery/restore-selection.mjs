// Metadata verification only. A native restic/application restore is still required.
import {RecoveryError,sha256,validatePolicy,validateSourceKey} from './generation.mjs';
const fail=code=>{throw new RecoveryError(code);};
const day=86400000;
function timestamp(value) {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) fail('invalid-recovery-time');
  const result=Date.parse(value);
  if(!Number.isFinite(result)||new Date(result).toISOString().slice(0,19)!==value.slice(0,19)) fail('invalid-recovery-time');
  return result;
}
function fields(value,allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))) fail('unexpected-recovery-metadata');
}
export async function verifyRestoreSelection(store,p,{proof,manifestText,before,now=()=>Date.now(),requireCurrentlyProtected=true}={}) {
  return verifySelection(store,p,{proof,manifestText,before,now,requireCurrentlyProtected},now());
}
// Explicit generation only: never silently fall back to another recovery point.
export async function loadRestoreSelection(store,p,{id,before,now=()=>Date.now(),requireCurrentlyProtected=true}={}) {
  validatePolicy(p);
  if(!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$/.test(id||'')) fail('invalid-generation-id');
  const started=now();
  const cutoff=timestamp(before);
  if(typeof requireCurrentlyProtected!=='boolean') fail('invalid-recovery-policy');
  if(!Number.isFinite(started)||cutoff>started+300000) fail('invalid-recovery-cutoff');
  const deadline=()=>{const current=now();if(!Number.isFinite(current)||current<started||current-started>p.maxDurationMs)fail('restore-selection-deadline-exceeded');};
  const read=async key=>{
    deadline();let result;
    try {result=await store.readMetadata(p.destinationBucket,`generations/${id}/${key}.json`);} catch {fail('recovery-metadata-unavailable');}
    deadline();return result;
  };
  const proofText=await read('COMPLETE');
  if(proofText===null) fail('incomplete-recovery-generation');
  if(typeof proofText!=='string'||new TextEncoder().encode(proofText).length>4096) fail('completion-size-exceeded');
  let proof;try {proof=JSON.parse(proofText);} catch {fail('completion-json-invalid');}
  if(proof?.id!==id) fail('requested-generation-mismatch');
  const manifestText=await read('manifest');
  if(manifestText===null) fail('incomplete-recovery-generation');
  return verifySelection(store,p,{proof,manifestText,before,now,requireCurrentlyProtected},started);
}
async function verifySelection(store,p,{proof,manifestText,before,now,requireCurrentlyProtected},started) {
  validatePolicy(p);
  if(typeof requireCurrentlyProtected!=='boolean') fail('invalid-recovery-policy');
  const cutoff=timestamp(before);
  if(!Number.isFinite(started)||cutoff>started+300000) fail('invalid-recovery-cutoff');
  const deadline=()=>{const current=now();if(!Number.isFinite(current)||current<started||current-started>p.maxDurationMs)fail('restore-selection-deadline-exceeded');};
  deadline();
  fields(proof,['schema','id','complete','objects','bytes','manifestSHA256','completedAt','protectedUntil','usableUntil']);
  if(proof.schema!==1||proof.complete!==true||!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$/.test(proof.id||'')) fail('incomplete-recovery-generation');
  if(typeof manifestText!=='string'||new TextEncoder().encode(manifestText).length>2*1024**2) fail('manifest-size-exceeded');
  if(!/^[a-f0-9]{64}$/.test(proof.manifestSHA256||'')||await sha256(manifestText)!==proof.manifestSHA256) fail('manifest-hash-mismatch');
  let manifest;
  try {manifest=JSON.parse(manifestText);} catch {fail('manifest-json-invalid');}
  fields(manifest,['schema','id','sourceBucket','objects','bytes','startedAt']);
  if(manifest.schema!==1||manifest.id!==proof.id||manifest.sourceBucket!==p.sourceBucket) fail('manifest-identity-mismatch');
  const generationStarted=timestamp(manifest.startedAt),completed=timestamp(proof.completedAt);
  const protectedUntil=timestamp(proof.protectedUntil),usableUntil=timestamp(proof.usableUntil);
  const namedAt=timestamp(`${proof.id.slice(0,4)}-${proof.id.slice(4,6)}-${proof.id.slice(6,8)}T${proof.id.slice(9,11)}:${proof.id.slice(11,13)}:${proof.id.slice(13,15)}Z`);
  if(generationStarted<namedAt||generationStarted-namedAt>60000) fail('generation-time-mismatch');
  if(generationStarted>completed||completed-generationStarted>p.maxDurationMs||completed>started+300000||completed>cutoff) fail('generation-after-recovery-cutoff');
  if(protectedUntil!==generationStarted+90*day||usableUntil!==generationStarted+119*day) fail('invalid-recovery-retention');
  if(started>=usableUntil) fail('recovery-generation-expired');
  if(requireCurrentlyProtected&&started>=protectedUntil) fail('recovery-protection-expired');
  if(!Array.isArray(manifest.objects)||!manifest.objects.length||manifest.objects.length>p.maxObjects||proof.objects!==manifest.objects.length) fail('invalid-recovery-object-count');
  const seen=new Set();let bytes=0;
  for(const row of manifest.objects) {
    fields(row,['key','size','etag','destinationEtag']);validateSourceKey(row.key,p);
    if(seen.has(row.key)||!Number.isSafeInteger(row.size)||row.size<0||['etag','destinationEtag'].some(key=>typeof row[key]!=='string'||!row[key]||row[key].length>256)) fail('invalid-recovery-object');
    seen.add(row.key);bytes+=row.size;
    if(!Number.isSafeInteger(bytes)||bytes>p.maxGenerationBytes) fail('recovery-byte-budget-exceeded');
  }
  if(bytes!==manifest.bytes||bytes!==proof.bytes) fail('recovery-size-mismatch');
  for(const project of p.projects) {
    for(const part of ['config','keys/','snapshots/','index/','data/']) {
      if(![...seen].some(key=>key===project+'/'+part||(part.endsWith('/')&&key.startsWith(project+'/'+part)))) fail('incomplete-recovery-project');
    }
  }
  const prefix=`generations/${proof.id}/repository/`;
  for(const row of manifest.objects) {
    deadline();let head;
    try {head=await store.head(p.destinationBucket,prefix+row.key);} catch {fail('recovery-object-unavailable');}
    deadline();
    if(!head||head.size!==row.size||head.etag!==row.destinationEtag) fail('recovery-object-changed');
  }
  deadline();
  return {schema:1,id:proof.id,bucket:p.destinationBucket,repositoryPrefix:prefix,projects:[...p.projects],objects:seen.size,bytes,
    manifestSHA256:proof.manifestSHA256,completedAt:proof.completedAt,protectedUntil:proof.protectedUntil,usableUntil:proof.usableUntil,
    currentlyProtected:started<protectedUntil,metadataVerified:true,nativeRestoreVerified:false,incidentCleanliness:'unassessed'};
}
