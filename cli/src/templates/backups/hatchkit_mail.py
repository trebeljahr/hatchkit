#!/usr/bin/env python3
"""One look for every Hatchkit alert mail. Standard library only; runs on hosts.

A sender builds a plain document (a dict), so a check can describe a mail without
importing this module. security-controller/mail-core.mjs renders the same document
to the same bytes; cli/test-ops-digest.py compares the two.

Document fields, all optional except title:
  title, host, intro
  sections: {needs, fixed, waiting, unchecked}: lists of items
  item: {what, detail, flags: [...], deadline, command}
  notes: [text], footer: [text], ledger: path
  paste: {instruction, meta: [text], rows: ['## heading' or '- row'], ledger}

Colours are the docs theme (docs/app/global.css on the Fumadocs neutral preset),
flattened to hex because mail clients do not read oklch or alpha borders. Gmail
drops the media query on most surfaces, so the inline colours must stand alone.

The icon is docs/public/img/apple-touch-icon.png at 48 px, sent as a CID part.
Gmail strips SVG and data: URIs, and a remote image would be a request per open.
"""
import base64
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr
from html import escape

FROM_NAME = 'Hatchkit Alerts'
SECTIONS = (('needs', 'Needs you'), ('fixed', 'Fixed automatically'),
            ('waiting', 'Waiting on vendor'), ('unchecked', 'Not checked'))
# Gmail clips a message at about 102 KB of HTML. Stop well before it.
HTML_LIMIT = 90000
FITS = ((40, 42000), (25, 30000), (12, 18000), (6, 8000))
WHAT_LIMIT, DETAIL_LIMIT = 420, 320
PASTE_START, PASTE_END = '----- COPY FOR AN LLM: START -----', '----- COPY FOR AN LLM: END -----'
MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"
LIGHT = {'bg': '#f5f5f5', 'fg': '#0a0a0a', 'muted': '#737373', 'border': '#e1e1e1',
         'code': '#ededed', 'primary': '#526ee3'}
DARK = {'bg': '#121212', 'fg': '#ebebeb', 'muted': '#929292', 'border': '#232323',
        'code': '#212121', 'primary': '#97b3ff'}
ICON_CID = 'hatchkit-icon'
ICON_PNG = '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'


def clip(value, limit):
    value = str(value)
    return value if len(value) <= limit else value[:limit - 1].rstrip() + '…'


def plural(count, one, many):
    return str(count) + ' ' + (one if count == 1 else many)


def summary_line(doc):
    sections = doc.get('sections') or {}
    count = lambda key: len(sections.get(key) or [])
    parts = []
    if count('needs'):
        parts.append(plural(count('needs'), 'needs you', 'need you'))
    if count('fixed'):
        parts.append(str(count('fixed')) + ' fixed')
    if count('waiting'):
        parts.append(str(count('waiting')) + ' waiting')
    if count('unchecked'):
        parts.append(str(count('unchecked')) + ' not checked')
    return ', '.join(parts)


def paste_text(paste, cap):
    """The block is plain text in both parts. The cap reports what it left out."""
    lines = [paste['instruction'], ''] + list(paste.get('meta') or []) + ['']
    used = sum(len((line + '\n').encode()) for line in lines)
    rows = paste.get('rows') or []
    kept = 0
    for row in rows:
        size = len((row + '\n').encode())
        if used + size > cap:
            break
        lines.append(row)
        used += size
        kept += 1
    left = sum(1 for row in rows[kept:] if row.startswith('- '))
    if left:
        lines += ['', str(left) + ' more grouped lines are in the ledger: ' + paste.get('ledger', '')]
    return '\n'.join(lines)


def hidden_line(count, doc):
    where = 'the copy section below' if doc.get('paste') else (doc.get('ledger') or 'the ledger')
    return str(count) + ' more in ' + where + '.'


def title_line(doc):
    return doc['title'] + (' on ' + doc['host'] if doc.get('host') else '')


def render_text(doc, item_cap, paste_cap):
    lines = ['Hatchkit Alerts', title_line(doc)]
    summary = summary_line(doc)
    if summary:
        lines.append(summary)
    if doc.get('intro'):
        lines += ['', doc['intro']]
    for key, label in SECTIONS:
        items = (doc.get('sections') or {}).get(key) or []
        if not items:
            continue
        lines += ['', label, '-' * len(label)]
        for number, item in enumerate(items[:item_cap], 1):
            lines.append(str(number) + '. ' + clip(item['what'], WHAT_LIMIT))
            if item.get('detail'):
                lines.append('   ' + clip(item['detail'], DETAIL_LIMIT))
            if item.get('flags'):
                lines.append('   ' + ', '.join(item['flags']))
            if item.get('deadline'):
                lines.append('   Deadline: ' + item['deadline'])
            if item.get('command'):
                lines.append('   Run: ' + item['command'])
        if len(items) > item_cap:
            lines.append(hidden_line(len(items) - item_cap, doc))
    if doc.get('notes'):
        lines.append('')
        lines += list(doc['notes'])
    if doc.get('paste'):
        lines += ['', PASTE_START, paste_text(doc['paste'], paste_cap), PASTE_END]
    if doc.get('footer'):
        lines.append('')
        lines += list(doc['footer'])
    return '\n'.join(lines) + '\n'


def dark_css():
    d = DARK
    return ('@media (prefers-color-scheme:dark){'
            '.hk-bg{background:' + d['bg'] + '!important}'
            '.hk-fg{color:' + d['fg'] + '!important}'
            '.hk-mu{color:' + d['muted'] + '!important}'
            '.hk-pr{color:' + d['primary'] + '!important}'
            '.hk-bd{border-color:' + d['border'] + '!important}'
            '.hk-co{background:' + d['code'] + '!important;color:' + d['fg'] + '!important}}')


def render_item(item):
    c = LIGHT
    small = 'font-size:13px;line-height:20px;'
    rows = ['<div class="hk-fg" style="color:' + c['fg'] + ';font-size:15px;line-height:22px;">'
            + escape(clip(item['what'], WHAT_LIMIT)) + '</div>']
    if item.get('detail'):
        rows.append('<div class="hk-mu" style="color:' + c['muted'] + ';' + small + '">'
                    + escape(clip(item['detail'], DETAIL_LIMIT)) + '</div>')
    if item.get('flags'):
        rows.append('<div class="hk-fg" style="color:' + c['fg'] + ';' + small + 'font-weight:600;">'
                    + escape(', '.join(item['flags'])) + '</div>')
    if item.get('deadline'):
        rows.append('<div class="hk-mu" style="color:' + c['muted'] + ';' + small + '">Deadline: '
                    + escape(item['deadline']) + '</div>')
    if item.get('command'):
        rows.append('<div class="hk-co hk-fg" style="background:' + c['code'] + ';color:' + c['fg']
                    + ';font-family:' + MONO + ';font-size:12px;line-height:18px;padding:6px 8px;'
                    'margin-top:6px;border-radius:4px;word-break:break-word;">' + escape(item['command']) + '</div>')
    return ('<tr><td class="hk-bd" style="border-top:1px solid ' + c['border'] + ';padding:12px 0;">'
            + ''.join(rows) + '</td></tr>')


def render_html(doc, item_cap, paste_cap):
    c = LIGHT
    heading = escape(title_line(doc))
    summary = summary_line(doc)
    out = ['<!doctype html><html lang="en"><head><meta charset="utf-8">'
           '<meta name="viewport" content="width=device-width,initial-scale=1">'
           '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">'
           '<title>' + heading + '</title><style>' + dark_css() + '</style></head>'
           '<body class="hk-bg" style="margin:0;padding:0;background:' + c['bg'] + ';">']
    if summary:
        out.append('<div style="display:none;max-height:0;overflow:hidden;">' + escape(summary) + '</div>')
    out.append('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hk-bg" '
               'style="background:' + c['bg'] + ';"><tr><td align="center" style="padding:24px 16px;">'
               '<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" '
               'style="width:100%;max-width:640px;font-family:' + SANS + ';">')
    out.append('<tr><td style="padding-bottom:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
               '<td style="padding-right:10px;vertical-align:middle;"><img src="cid:' + ICON_CID + '" width="24" height="24" '
               'alt="" style="display:block;border:0;border-radius:5px;"></td>'
               '<td class="hk-mu" style="color:' + c['muted'] + ';font-size:13px;vertical-align:middle;">'
               + FROM_NAME + '</td></tr></table></td></tr>')
    out.append('<tr><td class="hk-fg" style="color:' + c['fg'] + ';font-size:20px;line-height:28px;font-weight:600;">'
               + heading + '</td></tr>')
    if summary:
        out.append('<tr><td class="hk-mu" style="color:' + c['muted'] + ';font-size:14px;line-height:22px;">'
                   + escape(summary) + '</td></tr>')
    if doc.get('intro'):
        out.append('<tr><td class="hk-fg" style="color:' + c['fg'] + ';font-size:14px;line-height:22px;'
                   'padding-top:12px;white-space:pre-wrap;">' + escape(doc['intro']) + '</td></tr>')
    for key, label in SECTIONS:
        items = (doc.get('sections') or {}).get(key) or []
        if not items:
            continue
        out.append('<tr><td class="hk-pr" style="color:' + c['primary'] + ';font-size:14px;line-height:20px;'
                   'font-weight:600;padding:24px 0 8px;">' + label + '</td></tr>')
        out.append('<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">')
        out += [render_item(item) for item in items[:item_cap]]
        if len(items) > item_cap:
            out.append('<tr><td class="hk-mu hk-bd" style="border-top:1px solid ' + c['border'] + ';color:' + c['muted']
                       + ';font-size:13px;line-height:20px;padding:12px 0;">'
                       + escape(hidden_line(len(items) - item_cap, doc)) + '</td></tr>')
        out.append('</table></td></tr>')
    for note in doc.get('notes') or []:
        out.append('<tr><td class="hk-mu" style="color:' + c['muted'] + ';font-size:13px;line-height:20px;'
                   'padding-top:12px;">' + escape(note) + '</td></tr>')
    if doc.get('paste'):
        out.append('<tr><td class="hk-pr" style="color:' + c['primary'] + ';font-size:14px;line-height:20px;'
                   'font-weight:600;padding:24px 0 4px;">Copy for an LLM</td></tr>'
                   '<tr><td class="hk-mu" style="color:' + c['muted'] + ';font-size:13px;line-height:20px;'
                   'padding-bottom:8px;">Select this block and paste it into a chat. It holds no secrets, '
                   'SMTP details or application records.</td></tr>'
                   '<tr><td class="hk-co hk-fg" style="background:' + c['code'] + ';color:' + c['fg']
                   + ';padding:12px;border-radius:6px;"><pre class="hk-fg" style="margin:0;color:' + c['fg']
                   + ';font-family:' + MONO + ';font-size:12px;line-height:18px;white-space:pre-wrap;'
                   'word-break:break-word;">' + escape(paste_text(doc['paste'], paste_cap)) + '</pre></td></tr>')
    if doc.get('footer'):
        out.append('<tr><td class="hk-mu" style="color:' + c['muted'] + ';font-size:12px;line-height:18px;'
                   'padding-top:24px;">' + '<br>'.join(escape(line) for line in doc['footer']) + '</td></tr>')
    out.append('</table></td></tr></table></body></html>')
    return ''.join(out)


def render(doc):
    """Both parts, at the largest caps whose HTML stays under Gmail's clipping limit."""
    for item_cap, paste_cap in FITS:
        html = render_html(doc, item_cap, paste_cap)
        if len(html.encode()) <= HTML_LIMIT:
            break
    return render_text(doc, item_cap, paste_cap), html


def notice(subject, body):
    """A sender that only has text still gets the shared look."""
    title = subject.replace('[Hatchkit]', '', 1).strip()
    return {'title': title or 'Notice', 'intro': body.strip()}


def text_of(body):
    """The plain-text part for a document or a plain string."""
    return render(body)[0] if isinstance(body, dict) else body


def build_message(settings, subject, body):
    doc = body if isinstance(body, dict) else notice(subject, body)
    text, html = render(doc)
    address = parseaddr(settings['from'])[1]
    message = EmailMessage()
    # One display name across senders. The address stays what the filter matches.
    message['From'] = formataddr((FROM_NAME, address))
    message['To'] = settings['to']
    message['Subject'] = subject
    message['Date'] = formatdate(localtime=False)
    # A bare make_msgid() names the host's private hostname.
    message['Message-ID'] = make_msgid(domain=address.rpartition('@')[2] or 'localhost')
    message['Auto-Submitted'] = 'auto-generated'
    message.set_content(text)
    message.add_alternative(html, subtype='html')
    message.get_payload()[1].add_related(base64.b64decode(ICON_PNG), 'image', 'png', cid='<' + ICON_CID + '>',
                                         disposition='inline', filename='hatchkit.png')
    return message
