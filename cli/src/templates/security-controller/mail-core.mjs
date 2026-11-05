// The Worker's copy of backups/hatchkit_mail.py. Same document, same bytes:
// cli/test-ops-digest.py compares the two renderers. Change both together.
export const FROM_NAME='Hatchkit Alerts';
const SECTIONS=[['needs','Needs you'],['fixed','Fixed automatically'],['waiting','Waiting on vendor'],['unchecked','Not checked']];
const HTML_LIMIT=90000;
const FITS=[[40,42000],[25,30000],[12,18000],[6,8000]];
const WHAT_LIMIT=420,DETAIL_LIMIT=320;
const PASTE_START='----- COPY FOR AN LLM: START -----',PASTE_END='----- COPY FOR AN LLM: END -----';
const MONO="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const SANS="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
export const LIGHT={bg:'#f5f5f5',fg:'#0a0a0a',muted:'#737373',border:'#e1e1e1',code:'#ededed',primary:'#526ee3'};
export const DARK={bg:'#121212',fg:'#ebebeb',muted:'#929292',border:'#232323',code:'#212121',primary:'#97b3ff'};
export const ICON_CID='hatchkit-icon';
export const ICON_PNG='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';
const encoder=new TextEncoder();
const bytes=value=>encoder.encode(value).length;
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
function clip(value,limit) {
  const points=Array.from(String(value));
  return points.length<=limit ? String(value) : points.slice(0,limit-1).join('').trimEnd()+'…';
}
const plural=(count,one,many)=>`${count} ${count===1?one:many}`;
export function summaryLine(doc) {
  const count=key=>(doc.sections?.[key]||[]).length;
  const parts=[];
  if(count('needs'))parts.push(plural(count('needs'),'needs you','need you'));
  if(count('fixed'))parts.push(`${count('fixed')} fixed`);
  if(count('waiting'))parts.push(`${count('waiting')} waiting`);
  if(count('unchecked'))parts.push(`${count('unchecked')} not checked`);
  return parts.join(', ');
}
function pasteText(paste,cap) {
  const lines=[paste.instruction,'',...(paste.meta||[]),''];
  let used=lines.reduce((sum,line)=>sum+bytes(line+'\n'),0),kept=0;
  const rows=paste.rows||[];
  for(const row of rows) {
    const size=bytes(row+'\n');
    if(used+size>cap)break;
    lines.push(row);used+=size;kept++;
  }
  const left=rows.slice(kept).filter(row=>row.startsWith('- ')).length;
  if(left)lines.push('',`${left} more grouped lines are in the ledger: ${paste.ledger||''}`);
  return lines.join('\n');
}
const hiddenLine=(count,doc)=>`${count} more in ${doc.paste?'the copy section below':(doc.ledger||'the ledger')}.`;
const titleLine=doc=>doc.title+(doc.host?` on ${doc.host}`:'');
function renderText(doc,itemCap,pasteCap) {
  const lines=['Hatchkit Alerts',titleLine(doc)];
  const summary=summaryLine(doc);
  if(summary)lines.push(summary);
  if(doc.intro)lines.push('',doc.intro);
  for(const [key,label] of SECTIONS) {
    const items=doc.sections?.[key]||[];
    if(!items.length)continue;
    lines.push('',label,'-'.repeat(label.length));
    items.slice(0,itemCap).forEach((item,index)=>{
      lines.push(`${index+1}. ${clip(item.what,WHAT_LIMIT)}`);
      if(item.detail)lines.push(`   ${clip(item.detail,DETAIL_LIMIT)}`);
      if(item.flags?.length)lines.push(`   ${item.flags.join(', ')}`);
      if(item.deadline)lines.push(`   Deadline: ${item.deadline}`);
      if(item.command)lines.push(`   Run: ${item.command}`);
    });
    if(items.length>itemCap)lines.push(hiddenLine(items.length-itemCap,doc));
  }
  if(doc.notes?.length)lines.push('',...doc.notes);
  if(doc.paste)lines.push('',PASTE_START,pasteText(doc.paste,pasteCap),PASTE_END);
  if(doc.footer?.length)lines.push('',...doc.footer);
  return lines.join('\n')+'\n';
}
const darkCss=()=>'@media (prefers-color-scheme:dark){'+
  `.hk-bg{background:${DARK.bg}!important}`+`.hk-fg{color:${DARK.fg}!important}`+
  `.hk-mu{color:${DARK.muted}!important}`+`.hk-pr{color:${DARK.primary}!important}`+
  `.hk-bd{border-color:${DARK.border}!important}`+`.hk-co{background:${DARK.code}!important;color:${DARK.fg}!important}}`;
function renderItem(item) {
  const c=LIGHT,small='font-size:13px;line-height:20px;';
  const rows=[`<div class="hk-fg" style="color:${c.fg};font-size:15px;line-height:22px;">${escape(clip(item.what,WHAT_LIMIT))}</div>`];
  if(item.detail)rows.push(`<div class="hk-mu" style="color:${c.muted};${small}">${escape(clip(item.detail,DETAIL_LIMIT))}</div>`);
  if(item.flags?.length)rows.push(`<div class="hk-fg" style="color:${c.fg};${small}font-weight:600;">${escape(item.flags.join(', '))}</div>`);
  if(item.deadline)rows.push(`<div class="hk-mu" style="color:${c.muted};${small}">Deadline: ${escape(item.deadline)}</div>`);
  if(item.command)rows.push(`<div class="hk-co hk-fg" style="background:${c.code};color:${c.fg};font-family:${MONO};font-size:12px;line-height:18px;padding:6px 8px;margin-top:6px;border-radius:4px;word-break:break-word;">${escape(item.command)}</div>`);
  return `<tr><td class="hk-bd" style="border-top:1px solid ${c.border};padding:12px 0;">${rows.join('')}</td></tr>`;
}
function renderHtml(doc,itemCap,pasteCap) {
  const c=LIGHT,heading=escape(titleLine(doc)),summary=summaryLine(doc);
  const out=[`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${heading}</title><style>${darkCss()}</style></head><body class="hk-bg" style="margin:0;padding:0;background:${c.bg};">`];
  if(summary)out.push(`<div style="display:none;max-height:0;overflow:hidden;">${escape(summary)}</div>`);
  out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hk-bg" style="background:${c.bg};"><tr><td align="center" style="padding:24px 16px;"><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;font-family:${SANS};">`);
  out.push(`<tr><td style="padding-bottom:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:10px;vertical-align:middle;"><img src="cid:${ICON_CID}" width="24" height="24" alt="" style="display:block;border:0;border-radius:5px;"></td><td class="hk-mu" style="color:${c.muted};font-size:13px;vertical-align:middle;">${FROM_NAME}</td></tr></table></td></tr>`);
  out.push(`<tr><td class="hk-fg" style="color:${c.fg};font-size:20px;line-height:28px;font-weight:600;">${heading}</td></tr>`);
  if(summary)out.push(`<tr><td class="hk-mu" style="color:${c.muted};font-size:14px;line-height:22px;">${escape(summary)}</td></tr>`);
  if(doc.intro)out.push(`<tr><td class="hk-fg" style="color:${c.fg};font-size:14px;line-height:22px;padding-top:12px;white-space:pre-wrap;">${escape(doc.intro)}</td></tr>`);
  for(const [key,label] of SECTIONS) {
    const items=doc.sections?.[key]||[];
    if(!items.length)continue;
    out.push(`<tr><td class="hk-pr" style="color:${c.primary};font-size:14px;line-height:20px;font-weight:600;padding:24px 0 8px;">${label}</td></tr>`);
    out.push('<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">');
    out.push(...items.slice(0,itemCap).map(renderItem));
    if(items.length>itemCap)out.push(`<tr><td class="hk-mu hk-bd" style="border-top:1px solid ${c.border};color:${c.muted};font-size:13px;line-height:20px;padding:12px 0;">${escape(hiddenLine(items.length-itemCap,doc))}</td></tr>`);
    out.push('</table></td></tr>');
  }
  for(const note of doc.notes||[])out.push(`<tr><td class="hk-mu" style="color:${c.muted};font-size:13px;line-height:20px;padding-top:12px;">${escape(note)}</td></tr>`);
  if(doc.paste)out.push(`<tr><td class="hk-pr" style="color:${c.primary};font-size:14px;line-height:20px;font-weight:600;padding:24px 0 4px;">Copy for an LLM</td></tr><tr><td class="hk-mu" style="color:${c.muted};font-size:13px;line-height:20px;padding-bottom:8px;">Select this block and paste it into a chat. It holds no secrets, SMTP details or application records.</td></tr><tr><td class="hk-co hk-fg" style="background:${c.code};color:${c.fg};padding:12px;border-radius:6px;"><pre class="hk-fg" style="margin:0;color:${c.fg};font-family:${MONO};font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;">${escape(pasteText(doc.paste,pasteCap))}</pre></td></tr>`);
  if(doc.footer?.length)out.push(`<tr><td class="hk-mu" style="color:${c.muted};font-size:12px;line-height:18px;padding-top:24px;">${doc.footer.map(escape).join('<br>')}</td></tr>`);
  out.push('</table></td></tr></table></body></html>');
  return out.join('');
}
export function renderMail(doc) {
  let html,itemCap,pasteCap;
  for([itemCap,pasteCap] of FITS) {
    html=renderHtml(doc,itemCap,pasteCap);
    if(bytes(html)<=HTML_LIMIT)break;
  }
  return {text:renderText(doc,itemCap,pasteCap),html};
}
const lines76=raw=>raw.match(/.{1,76}/g).join('\r\n');
function utf8Base64(text) {
  let binary='';
  for(const byte of encoder.encode(text))binary+=String.fromCharCode(byte);
  return lines76(btoa(binary));
}
/** multipart/alternative(text, multipart/related(html, icon)), as the host senders build it. */
export function rawMessage({from,to,subject,text,html,date=new Date(),id=crypto.randomUUID(),boundary=crypto.randomUUID().replaceAll('-','')}) {
  if(/[\r\n]/.test(from+to+subject))throw new Error('invalid mail header');
  const domain=from.split('@')[1]||'localhost';
  return [
    `From: ${FROM_NAME} <${from}>`,`To: ${to}`,`Subject: ${subject}`,`Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,'Auto-Submitted: auto-generated','MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="alt-${boundary}"`,'',
    `--alt-${boundary}`,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',utf8Base64(text),
    `--alt-${boundary}`,`Content-Type: multipart/related; boundary="rel-${boundary}"`,'',
    `--rel-${boundary}`,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',utf8Base64(html),
    `--rel-${boundary}`,'Content-Type: image/png','Content-Transfer-Encoding: base64',`Content-ID: <${ICON_CID}>`,'Content-Disposition: inline; filename="hatchkit.png"','',lines76(ICON_PNG),
    `--rel-${boundary}--`,`--alt-${boundary}--`,'',
  ].join('\r\n');
}
