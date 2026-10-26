#!/usr/bin/env python3
"""Allow database IP destinations only to explicitly reviewed app containers.

This is IP destination control at the host veth, not Layer 2 separation or a
stateful transport policy. ARP is retained. IPv6 and all other destinations are
dropped. Topology updates converge on the five-second watch cycle.
"""
import argparse
import datetime as dt
import fcntl
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import time

spec=importlib.util.spec_from_file_location('egress_owned_table',Path(__file__).with_name('database-guard.py'))
owned=importlib.util.module_from_spec(spec);spec.loader.exec_module(owned)
TABLE='hatchkit_db_egress'
TAG='hatchkit-db-egress-v1'
owned.TABLE=TABLE
CONFIG=Path('/etc/hatchkit-security/database-egress.json')
WORK=Path('/var/lib/hatchkit-security/database-egress')
STATUS=Path('/var/lib/hatchkit-backups/database-egress-status.json')

def validate(config):
    assert set(config)=={'schema','databases'}and type(config['schema'])is int and config['schema']==1
    databases=config['databases'];assert isinstance(databases,list)and 1<=len(databases)<=16
    names=[]
    for row in databases:
        assert set(row)=={'container','clients'}and isinstance(row['clients'],list)and 1<=len(row['clients'])<=8
        names.append(row['container']);assert len(set(row['clients']))==len(row['clients'])
        for name in [row['container'],*row['clients']]:
            assert isinstance(name,str)and name and name.isascii()and all(c.isalnum()or c in'_.-'for c in name)
    assert len(set(names))==len(names)
    assert not any(name in names for row in databases for name in row['clients']),'Database cross-access requires separate review'
    return databases

def topology(config,rows,interfaces):
    databases=validate(config);selected={r['Name'].lstrip('/'):r for r in rows if r['State']['Running']}
    entries=[];stamps=[];missing_databases=missing_clients=0
    for definition in databases:
        name=definition['container'];database=selected.get(name)
        if database is None:
            missing_databases+=1;stamps.append({'database':name,'missing':True});continue
        networks=database['NetworkSettings']['Networks'];assert 1<=len(networks)<=8
        peers={};client_stamps=[]
        for client in definition['clients']:
            row=selected.get(client)
            if row is None:
                missing_clients+=1;client_stamps.append({'client':client,'missing':True});continue
            common=set(networks)&set(row['NetworkSettings']['Networks'])
            assert common,'Client/database network membership changed'
            client_stamps.append({'client':client,'id':row['Id'],'startedAt':row['State']['StartedAt']})
            for network in common:
                endpoint=row['NetworkSettings']['Networks'][network]
                assert not endpoint.get('GlobalIPv6Address'),'Review newly enabled database IPv6'
                address=ipaddress.ip_address(endpoint['IPAddress'])
                assert address.version==4 and not address.is_unspecified
                peers.setdefault(network,set()).add(str(address))
        links=interfaces[name]
        assert set(links)==set(networks)
        for network,endpoint in networks.items():
            assert not endpoint.get('GlobalIPv6Address'),'Review newly enabled database IPv6'
            own=ipaddress.ip_address(endpoint['IPAddress']);assert own.version==4 and not own.is_unspecified
            interface=links[network]
            assert interface.startswith('veth')and interface.isascii()and interface.isalnum()
            addresses=tuple(sorted(peers.get(network,set()),key=lambda a:int(ipaddress.ip_address(a))))
            assert str(own)not in addresses
            entries.append((interface,addresses))
        stamps.append({'database':name,'id':database['Id'],'startedAt':database['State']['StartedAt'],'interfaces':links,'clients':client_stamps})
    assert len({interface for interface,addresses in entries})==len(entries),'Ambiguous source veth'
    return sorted(entries),stamps,{'databases':len(databases),'interfaces':len(entries),
        'allowedPeerAddresses':sum(len(addresses)for interface,addresses in entries),
        'missingDatabases':missing_databases,'missingClients':missing_clients,'ipv6EgressAllowed':False}

def wanted(entries):
    rows=[{'table':{'family':'netdev','name':TABLE}}]
    for index,(interface,addresses)in enumerate(entries):
        # Keep the already tested ingress-binding verifier's chain syntax.
        chain='proxy'+str(index)
        rows.append({'chain':{'family':'netdev','table':TABLE,'name':chain,'type':'filter','hook':'ingress','prio':-500,'dev':interface,'policy':'accept'}})
        expressions=[[{'match':{'op':'==','left':{'meta':{'key':'protocol'}},'right':'arp'}},{'accept':None}]]
        for address in addresses:
            assert ipaddress.ip_address(address).version==4
            expressions.append([{'match':{'op':'==','left':{'payload':{'protocol':'ip','field':'daddr'}},'right':address}},{'accept':None}])
        expressions.append([{'drop':None}])
        for expr in expressions:rows.append({'rule':{'family':'netdev','table':TABLE,'chain':chain,'expr':expr,'comment':TAG}})
    return owned.normalize_table({'nftables':rows})

def cycle(apply=False):
    config=json.loads(CONFIG.read_text());definitions=validate(config)
    ids=owned.run(['docker','ps','-q']).split();assert ids
    rows=json.loads(owned.run(['docker','inspect',*ids]))
    selected={r['Name'].lstrip('/'):r for r in rows}
    interfaces={d['container']:owned.proxy_interfaces(selected[d['container']])for d in definitions if d['container']in selected}
    entries,stamp,summary=topology(config,rows,interfaces)
    invocation=owned.run(['systemctl','show','docker.service','-p','InvocationID','--value']).strip();assert invocation
    prior=json.loads((WORK/'state.json').read_text())if(WORK/'state.json').exists()else None
    current=owned.current_table();expected=wanted(entries)
    if apply:
        if current is not None:
            assert prior,'Unexplained pre-existing firewall; do not overwrite'
            if current!=prior['rules']:
                live={r['ifname']for r in json.loads(owned.run(['ip','-j','link']))}
                assert stamp!=prior['topologyStamp']and current==owned.after_device_loss(prior['rules'],live),'Unexplained firewall drift; do not overwrite'
        else:
            assert not prior or invocation!=prior['dockerInvocation'],'Owned protection disappeared during this Docker invocation'
        if current!=expected:
            content=owned.transaction(current,expected)
            owned.run(['nft','--check','-j','-f','-'],input=content)
            owned.run(['nft','-j','-f','-'],input=content)
        current=owned.current_table();assert current==expected
        owned.write(WORK/'state.json',{'dockerInvocation':invocation,'rules':expected,'topologyStamp':stamp})
    assert current==expected,'Current database topology is not protected'
    complete=not(summary['missingDatabases']or summary['missingClients'])
    return {**summary,'ok':complete,'complete':complete}

def once(apply=False):
    report={'checkedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'ok':False,'complete':False,'findings':[]}
    try:report.update(cycle(apply))
    except Exception as error:report['error']=type(error).__name__
    owned.write(STATUS,report);return report

def main():
    os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('action',choices=['check','watch']);args=p.parse_args()
    WORK.mkdir(parents=True,exist_ok=True,mode=0o700)
    watch=(WORK/'.watch.lock').open('w')
    if args.action=='watch':fcntl.flock(watch,fcntl.LOCK_EX|fcntl.LOCK_NB)
    while True:
        with(WORK/'.lock').open('w')as lock:
            fcntl.flock(lock,fcntl.LOCK_EX);report=once(args.action=='watch')
        if args.action=='check'or report.get('error'):
            print(json.dumps({k:report[k]for k in ['checkedAt','ok','complete']}),flush=True);return 0 if report['ok']else 1
        # A missing app is denied until rediscovered; keep reconciling rather
        # than adding restart backoff to an ordinary app replacement.
        time.sleep(5)
if __name__=='__main__':raise SystemExit(main())
