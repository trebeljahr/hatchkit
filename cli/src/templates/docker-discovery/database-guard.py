#!/usr/bin/env python3
"""Deny proxy IP access to explicitly named databases, preserving other rules.

Container addresses are resolved each five seconds. New topology is incomplete
until reconciled; this is a bounded convergence window, not atomic isolation.
Only a new Docker invocation may recreate a missing owned table automatically.
"""
import argparse
import datetime as dt
import fcntl
import ipaddress
import json
import os
import re
from pathlib import Path
import subprocess
import time

TABLE='hatchkit_db_guard'
TAG='hatchkit-proxy-db-v1'
CONFIG=Path('/etc/hatchkit-security/database-guard.json')
WORK=Path('/var/lib/hatchkit-security/database-guard')
STATUS=Path('/var/lib/hatchkit-backups/database-guard-status.json')


def run(args,**kwargs):
    return subprocess.run(args,capture_output=True,text=True,check=True,timeout=25,**kwargs).stdout


def topology(config,rows,interfaces):
    assert set(config)=={'schema','proxy','databases'} and type(config['schema'])is int and config['schema']==1
    assert isinstance(config['databases'],list)
    names=[config['proxy'],*config['databases']]
    assert 1<len(names)<=65 and len(set(names))==len(names)
    assert all(isinstance(n,str) and n and all(c.isalnum()or c in '_.-'for c in n)for n in names)
    selected={r['Name'].lstrip('/'):r for r in rows if r['Name'].lstrip('/')in names}
    assert set(selected)==set(names),'Required container missing; retain previous protection'
    assert all(r['State']['Running']for r in selected.values())
    proxy=selected[config['proxy']];pairs=set()
    for name in config['databases']:
        database=selected[name];common=set(proxy['NetworkSettings']['Networks'])&set(database['NetworkSettings']['Networks'])
        assert common,'Review changed topology; no common proxy/database network'
        for network in common:
            endpoints=[r['NetworkSettings']['Networks'][network]for r in [proxy,database]]
            for field in ['IPAddress','GlobalIPv6Address']:
                addresses=[e.get(field)for e in endpoints]
                assert all(addresses)or not any(addresses),'Partial address family'
                if all(addresses):
                    a,b=[ipaddress.ip_address(x)for x in addresses]
                    assert a.version==b.version and not(a.is_unspecified or b.is_unspecified or a==b)
                    for interface in interfaces.values():
                        assert interface.startswith("veth") and interface.isascii() and interface.isalnum(),"Unsupported host veth name"
                        pairs.add((a.version,interface,str(b)))
    assert pairs,'No database address pairs'
    return sorted(pairs)


def wanted(pairs):
    # Attach before bridging or host routing. IP or MAC spoofing cannot change
    # the kernel ingress device. Match all IP traffic to these database IPs.
    result=[{'table':{'family':'netdev','name':TABLE}}]
    for index,interface in enumerate(sorted({a for v,a,b in pairs})):
        chain='proxy'+str(index)
        result.append({'chain':{'family':'netdev','table':TABLE,'name':chain,'type':'filter','hook':'ingress','prio':-500,'dev':interface,'policy':'accept'}})
        for version,source,address in pairs:
            if source!=interface:continue
            result.append({'rule':{'family':'netdev','table':TABLE,'chain':chain,'expr':[{'match':{'op':'==','left':{'payload':{'protocol':'ip'if version==4 else'ip6','field':'daddr'}},'right':address}},{'drop':None}],'comment':TAG}})
    return normalize_table({'nftables':result})


def normalize_table(value):
    assert set(value)=={'nftables'} and len(value['nftables'])<=5000
    result=[]
    for row in value['nftables']:
        assert len(row)==1
        kind,content=next(iter(row.items()))
        if kind=='metainfo':continue
        assert kind in {'table','chain','rule'},'Unknown owned-table element'
        assert content.get('family')=='netdev'and(content.get('name')if kind=='table'else content.get('table'))==TABLE
        result.append({kind:{k:v for k,v in content.items()if k not in {'handle','index'}}})
    # nft lists all chain declarations before their rules when multiple
    # ingress interfaces exist. Global declaration order is not rule order.
    tables=[r for r in result if 'table'in r];chains=[r for r in result if 'chain'in r]
    assert len(tables)==1 and len({r['chain']['name']for r in chains})==len(chains)
    names=sorted(r['chain']['name']for r in chains)
    assert all(r['rule']['chain']in names for r in result if 'rule'in r)
    return tables+sorted(chains,key=lambda r:r['chain']['name'])+[r for name in names for r in result if 'rule'in r and r['rule']['chain']==name]


def current_table():
    text=run(['nft','-j','list','tables']);assert len(text)<4*1024**2
    tables=json.loads(text)['nftables']
    if not any(row.get('table',{}).get('family')=='netdev'and row['table'].get('name')==TABLE for row in tables):return None
    text=run(['nft','-j','list','table','netdev',TABLE]);assert len(text)<4*1024**2
    rows=normalize_table(json.loads(text))
    # nft 1.0.9's JSON output omits the ingress device. Verify it independently
    # in its bounded native rendering; never discard that security property.
    native=run(['nft','list','table','netdev',TABLE]);assert len(native)<4*1024**2
    devices=dict(re.findall(r'^\s*chain (proxy[0-9]+) \{\n\s*type filter hook ingress device "(veth[A-Za-z0-9]+)" priority -500; policy accept;\s*$',native,re.M))
    chains=[r['chain']for r in rows if 'chain'in r]
    assert set(devices)=={r['name']for r in chains},'Ingress binding not established'
    for chain in chains:
        assert 'dev'not in chain or chain['dev']==devices[chain['name']]
        chain['dev']=devices[chain['name']]
    return rows


def transaction(current,expected):
    commands=([{'delete':{'table':{'family':'netdev','name':TABLE}}}]if current is not None else[])+[{'add':row}for row in expected]
    return json.dumps({'nftables':commands})


def proxy_interfaces(proxy):
    pid=proxy['State']['Pid'];assert isinstance(pid,int) and pid>0
    inside=json.loads(run(['nsenter','-t',str(pid),'-n','ip','-j','link']))
    outside={r['ifindex']:r for r in json.loads(run(['ip','-d','-j','link']))}
    result={}
    for network,endpoint in proxy['NetworkSettings']['Networks'].items():
        matches=[r for r in inside if r.get('address')==endpoint.get('MacAddress')]
        assert len(matches)==1 and matches[0].get('link_index')in outside,'Proxy peer link not established'
        link=outside[matches[0]['link_index']]
        assert link.get('linkinfo',{}).get('info_kind')=='veth','Proxy peer is not a host veth'
        result[network]=link['ifname']
    return result



def after_device_loss(rules,live_devices):
    lost={r['chain']['name']for r in rules if 'chain'in r and r['chain']['dev']not in live_devices}
    return [r for r in rules if not('chain'in r and r['chain']['name']in lost)and not('rule'in r and r['rule']['chain']in lost)]


def write(path,value):
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,indent=2)+'\n');temp.chmod(0o600);temp.replace(path)


def cycle(apply=False):
    config=json.loads(CONFIG.read_text());raw=run(['docker','ps','-q']).split();assert raw
    rows=json.loads(run(['docker','inspect',*raw]));proxy=next(r for r in rows if r['Name'].lstrip('/')==config['proxy'])
    interfaces=proxy_interfaces(proxy);pairs=topology(config,rows,interfaces)
    invocation=run(['systemctl','show','docker.service','-p','InvocationID','--value']).strip();assert invocation
    prior=json.loads((WORK/'state.json').read_text())if(WORK/'state.json').exists()else None
    current=current_table();expected=wanted(pairs)
    stamp={'id':proxy['Id'],'startedAt':proxy['State']['StartedAt'],'interfaces':interfaces}
    if apply:
        if current is not None:
            assert prior,'Unexplained pre-existing firewall; do not overwrite'
            if current!=prior['rules']:
                # Linux removes netdev chains when their veth disappears.
                # Permit only that exact subtraction, with a changed Docker
                # identity/topology and independently absent host devices.
                live_devices={r['ifname']for r in json.loads(run(['ip','-j','link']))}
                assert stamp!=prior['proxyStamp']and current==after_device_loss(prior['rules'],live_devices),'Unexplained firewall drift; do not overwrite'
        else:
            assert not prior or invocation!=prior['dockerInvocation'],'Owned protection disappeared during this Docker invocation'
        if current!=expected:
            content=transaction(current,expected)
            run(['nft','--check','-j','-f','-'],input=content)
            run(['nft','-j','-f','-'],input=content)
        current=current_table();assert current==expected
        write(WORK/'state.json',{'dockerInvocation':invocation,'rules':expected,'proxyStamp':stamp})
    assert current==expected,'Topology or firewall differs from current protection'
    return {'databases':len(config['databases']),'addressPairs':len(pairs),'ipv6Pairs':sum(v==6 for v,a,b in pairs)}


def once(apply):
    report={'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'ok':False,'complete':False,'findings':[]}
    try:report.update(cycle(apply),ok=True,complete=True)
    except Exception as error:report['error']=type(error).__name__
    write(STATUS,report)
    return report


def main():
    os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('action',choices=['check','watch']);args=p.parse_args()
    WORK.mkdir(parents=True,exist_ok=True,mode=0o700)
    watchlock=(WORK/'.watch.lock').open('w')
    if args.action=='watch':fcntl.flock(watchlock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    while True:
        with(WORK/'.lock').open('w')as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            report=once(args.action=='watch')
        if not report['ok']or args.action=='check':
            print(json.dumps({k:report[k]for k in ['checkedAt','ok','complete']}),flush=True);return 0 if report['ok']else 1
        time.sleep(5)


if __name__=='__main__':raise SystemExit(main())
