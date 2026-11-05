#!/usr/bin/env python3
"""Block only Docker bridge forwarding to provider metadata addresses.

Own one exact chain and tagged jump. Never flush or rewrite another policy.
This is prepared source; install only after host/app TCP and recovery tests.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shlex
import subprocess

CHAIN = 'HATCHKIT-METADATA'
TAG = 'hatchkit-provider-metadata-v1'
ANCHOR = ['-m','comment','--comment',TAG,'-j',CHAIN]
FAMILIES = {'iptables':'169.254.169.254/32','ip6tables':'fe80::a9fe:a9fe/128'}
STATUS = Path('/var/lib/hatchkit-backups/metadata-guard-status.json')
# Tailscale inserts its own FORWARD hook ahead of DOCKER-USER. Its rules match
# only packets entering or leaving tailscale0, so bridge traffic to the provider
# metadata address (which leaves via the uplink) still reaches DOCKER-USER.
# Accept that prefix only with this exact per-family content; any other prefix
# chain or changed ts-forward rule stays a review finding.
TAILSCALE_CHAIN = 'ts-forward'
TAILSCALE_FORWARD = {
    '169.254.169.254/32':[
        ['-i','tailscale0','-j','MARK','--set-xmark','0x40000/0xff0000'],
        ['-m','mark','--mark','0x40000/0xff0000','-j','ACCEPT'],
        ['-s','100.64.0.0/10','-o','tailscale0','-j','DROP'],
        ['-o','tailscale0','-j','ACCEPT'],
    ],
    'fe80::a9fe:a9fe/128':[
        ['-i','tailscale0','-j','MARK','--set-xmark','0x40000/0xff0000'],
        ['-m','mark','--mark','0x40000/0xff0000','-j','ACCEPT'],
        ['-o','tailscale0','-j','ACCEPT'],
    ],
}


def expected_rules(destination):
    return [['-i',interface,'-d',destination,'-j','DROP'] for interface in ['docker0','br+']] + [['-j','RETURN']]


def normalized_rule(rule):
    # iptables -S prints destination before interface. Accept only permutation
    # of these exact three pairs; extra/duplicate options and negation stay invalid.
    if len(rule)==6 and len(set(rule[::2]))==3 and set(rule[::2])=={'-i','-d','-j'}:
        values=dict(zip(rule[::2],rule[1::2]))
        if values['-j']=='DROP':
            return ['-i',values['-i'],'-d',values['-d'],'-j','DROP']
    return rule


def inspect_table(text, destination):
    assert len(text) < 4*1024**2, 'Firewall snapshot exceeds review bound'
    rows=[shlex.split(line) for line in text.splitlines() if line.strip()]
    assert ['-N','DOCKER-USER'] in rows, 'Docker user chain missing'
    forward=[r[2:] for r in rows if r[:2]==['-A','FORWARD']]
    if forward and forward[0]==['-j',TAILSCALE_CHAIN]:
        tailscale=[r[2:] for r in rows if r[:2]==['-A',TAILSCALE_CHAIN]]
        assert rows.count(['-N',TAILSCALE_CHAIN])==1, 'Tailscale forwarding chain missing'
        assert tailscale==TAILSCALE_FORWARD.get(destination), 'Review changed Tailscale forwarding rules'
        forward=forward[1:]
    assert forward and forward[0]==['-j','DOCKER-USER'], 'Review changed forwarding hook order'
    parent=[r[2:] for r in rows if r[:2]==['-A','DOCKER-USER']]
    owned=[r[2:] for r in rows if r[:2]==['-A',CHAIN]]
    exists=['-N',CHAIN] in rows
    references=[r for r in rows if any(r[i:i+2]==['-j',CHAIN] or r[i:i+2]==['-g',CHAIN] for i in range(len(r)-1))]
    assert all(r==['-A','DOCKER-USER',*ANCHOR] for r in references), 'Unexpected reference to owned chain'
    assert len(references)<=1, 'Duplicate owned jump requires review'
    assert not owned or exists, 'Owned rules without chain'
    assert not exists or [normalized_rule(r)for r in owned]==expected_rules(destination), 'Owned chain content changed; do not overwrite'
    assert exists or not references, 'Jump without owned chain'
    return {'exists':exists,'anchored':bool(references),'first':bool(parent and parent[0]==ANCHOR)}


def transaction(state, destination, action):
    lines=[]
    if action=='apply':
        if not state['exists']:
            lines.append(':'+CHAIN+' - [0:0]')
            lines.extend(shlex.join(['-A',CHAIN,*r]) for r in expected_rules(destination))
        if not state['first']:
            if state['anchored']:
                lines.append(shlex.join(['-D','DOCKER-USER',*ANCHOR]))
            lines.append(shlex.join(['-I','DOCKER-USER','1',*ANCHOR]))
    elif action=='rollback':
        if state['anchored']:
            lines.append(shlex.join(['-D','DOCKER-USER',*ANCHOR]))
        if state['exists']:
            lines.extend(['-F '+CHAIN,'-X '+CHAIN])
    else:
        raise ValueError('Unknown mutation')
    return '*filter\n'+'\n'.join(lines)+'\nCOMMIT\n' if lines else None


def snapshot(binary):
    result=subprocess.run([binary,'-w','10','-S'],capture_output=True,text=True,timeout=20,check=True)
    return result.stdout


def bridge_preflight():
    config=Path('/etc/docker/daemon.json')
    assert not config.exists() or json.loads(config.read_text()).get('firewall-backend','iptables')=='iptables', 'Unsupported Docker firewall backend'
    ids=subprocess.check_output(['docker','network','ls','-q','--filter','driver=bridge'],text=True,timeout=15).split()
    rows=json.loads(subprocess.check_output(['docker','network','inspect',*ids],timeout=20))
    for row in rows:
        interface=(row.get('Options')or{}).get('com.docker.network.bridge.name') or ('docker0' if row['Name']=='bridge' else 'br-'+row['Id'][:12])
        assert interface=='docker0' or interface.startswith('br-'), 'Custom bridge name requires explicit coverage review'


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['check','apply','rollback'],default='check',nargs='?')
    args=parser.parse_args()
    report={'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'ok':False,'complete':False,'findings':[]}
    try:
        bridge_preflight()
        # Inspect both families before the first mutation. A family failure never
        # silently changes the foreign forwarding policy or removes an existing guard.
        states={binary:inspect_table(snapshot(binary),destination) for binary,destination in FAMILIES.items()}
        if args.action!='check':
            for binary,destination in FAMILIES.items():
                content=transaction(states[binary],destination,args.action)
                if content:
                    subprocess.run([binary+'-restore','--noflush','--wait','10'],input=content,
                                   capture_output=True,text=True,timeout=30,check=True)
            states={binary:inspect_table(snapshot(binary),destination) for binary,destination in FAMILIES.items()}
        operation_ok=True
        for binary,state in states.items():
            wanted=(state['exists'] and state['first']) if args.action!='rollback' else not state['exists'] and not state['anchored']
            operation_ok=operation_ok and wanted
            if not (state['exists'] and state['first']):
                report['findings'].append({'resource':'provider-metadata','field':binary})
        report.update(ok=not report['findings'],complete=True,operationSucceeded=operation_ok)
    except Exception as error:
        report['error']=type(error).__name__
    STATUS.parent.mkdir(parents=True,exist_ok=True)
    temp=STATUS.with_suffix('.tmp');temp.write_text(json.dumps(report,indent=2)+'\n');temp.replace(STATUS)
    print(json.dumps({'checkedAt':report['checkedAt'],'ok':report['ok'],'complete':report['complete'],
                      'findings':len(report['findings']),'error':report.get('error')}),flush=True)
    return 0 if report.get('operationSucceeded') else 1


if __name__=='__main__':
    raise SystemExit(main())
