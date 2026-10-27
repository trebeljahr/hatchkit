#!/usr/bin/env python3
"""Check explicitly reviewed container controls; never learn or apply policy."""
import datetime as dt
import hmac
import ipaddress
import secrets
import socket
import struct
import time
import json
import os
from pathlib import Path
import re
import subprocess

CONFIG = Path('/etc/hatchkit-security/container-policy.json')
STATUS = Path('/var/lib/hatchkit-backups/container-policy-status.json')
EXPECTED_FIELDS = {'Memory','MemorySwap','NanoCpus','PidsLimit','ReadonlyRootfs','noNewPrivileges',
                   'uid','imageId','healthy','CapAdd','CapDrop','noHostNamespaces','noPublishedPorts',
                   'networks','mountDestinations','readOnlyMountDestinations','Tmpfs','noDirectDockerSocket','dockerEndpoint',
                   'mongoCacheMaxBytes','databaseReady','dnsReady','PortBindings'}


def kernel_status(pid):
    text = (Path('/proc')/str(pid)/'status').read_text()
    return {'uid': int(re.search(r'^Uid:\s+(\d+)', text, re.M)[1]),
            'nnp': int(re.search(r'^NoNewPrivs:\s+(\d+)', text, re.M)[1])}


def caps(values):
    return {c.upper().removeprefix('CAP_') for c in values or []}


def tmpfs_options(value):
    """Normalize Docker/Compose size and mode spellings without dropping flags."""
    result = {}
    for item in value.split(','):
        key, separator, option = item.partition('=')
        if key in result:
            raise ValueError('Duplicate temporary-filesystem option')
        if key == 'size':
            match = re.fullmatch(r'(\d+)([kmg]?)', option.lower())
            if not match:
                raise ValueError('Invalid temporary-filesystem size')
            result[key] = int(match[1])*{'': 1, 'k': 1024, 'm': 1024**2, 'g': 1024**3}[match[2]]
        elif key == 'mode':
            result[key] = int(option, 8)
        elif key != 'rw':
            result[key] = option if separator else True
    return result


def discovery_pair(containers, pair):
    clients = [d for d in containers if d['Name'].lstrip('/') == pair['client']]
    brokers = [d for d in containers if d['Name'].lstrip('/') == pair['broker']]
    if len(clients) != 1 or len(brokers) != 1:
        return False
    environment = dict(x.split('=', 1) for x in brokers[0]['Config'].get('Env') or [] if '=' in x)
    token = environment.get('DISCOVERY_TOKEN', '')
    flags = clients[0]['Config'].get('Cmd') or []
    passwords = [x.split('=', 1)[1] for x in flags if x.startswith('--providers.docker.password=')]
    users = [x.split('=', 1)[1] for x in flags if x.startswith('--providers.docker.username=')]
    return bool(re.fullmatch(r'[A-Za-z0-9_-]{43}', token) and users == ['discovery']
                and len(passwords) == 1 and hmac.compare_digest(passwords[0], token))


def mongo_cache_max(container_id):
    # Authentication values are read inside the container. Never put them in
    # Docker/mongosh argv or return raw shell diagnostics to the status report.
    script = r'''const a=db.getSiblingDB("admin");
if(!process.env.MONGO_INITDB_ROOT_USERNAME||!process.env.MONGO_INITDB_ROOT_PASSWORD||!a.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD))throw Error("authentication");
const r=a.runCommand({serverStatus:1});if(r.ok!==1)throw Error("serverStatus");
print(JSON.stringify({bytes:Number(r.wiredTiger.cache["maximum bytes configured"])}));'''
    result = subprocess.run(['docker','exec','-i',container_id,'mongosh','--quiet','--norc','--file','/dev/stdin'],
                            input=script+'\n',capture_output=True,text=True,timeout=15)
    if result.returncode:
        raise RuntimeError('Mongo cache inspection failed')
    try:
        value = json.loads(result.stdout.strip())
        if set(value) != {'bytes'} or type(value['bytes']) is not int or not 0 < value['bytes'] < 2**50:
            raise ValueError('Invalid Mongo cache result')
        return value['bytes']
    except (ValueError, TypeError, KeyError):
        raise RuntimeError('Mongo cache inspection returned invalid metadata') from None


def database_ready(container_id, engine):
    if engine == 'postgres':
        script = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT 1"'
        expected = '1'
    elif engine == 'valkey':
        script = 'if [ -n "${VALKEY_PASSWORD:-${REDIS_PASSWORD:-}}" ]; then export VALKEYCLI_AUTH="${VALKEY_PASSWORD:-$REDIS_PASSWORD}"; fi; exec valkey-cli --raw PING'
        expected = 'PONG'
    elif engine == 'redis':
        script = 'if [ -n "${REDIS_PASSWORD:-}" ]; then export REDISCLI_AUTH="$REDIS_PASSWORD"; fi; exec redis-cli --raw PING'
        expected = 'PONG'
    else:
        raise ValueError('Unsupported database readiness engine')
    result = subprocess.run(['docker','exec',container_id,'sh','-c',script],
                            capture_output=True,text=True,timeout=15)
    if result.returncode or result.stdout.strip() != expected:
        raise RuntimeError('Database readiness inspection failed')
    return True


def dns_packet(packet, nonce):
    if len(packet) < 12:
        raise ValueError('Short DNS response')
    identity, flags, questions, answers, _, _ = struct.unpack('!6H', packet[:12])
    if identity != nonce or not flags & 0x8000 or flags & 0x7a00 or questions != 1 or answers > 32:
        raise ValueError('Invalid DNS response header')
    def skip_name(offset):
        for _ in range(128):
            if offset >= len(packet):
                raise ValueError('Invalid DNS name')
            size = packet[offset]
            if size & 0xc0 == 0xc0:
                if offset+1 >= len(packet) or ((size & 0x3f)*256+packet[offset+1]) >= len(packet):
                    raise ValueError('Invalid DNS pointer')
                return offset+2
            if size > 63 or offset+1+size > len(packet):
                raise ValueError('Invalid DNS label')
            offset += 1+size
            if not size:
                return offset
        raise ValueError('Oversized DNS name')
    offset = skip_name(12)+4
    if offset > len(packet):
        raise ValueError('Short DNS question')
    addresses = []
    for _ in range(answers):
        offset = skip_name(offset)
        if offset+10 > len(packet):
            raise ValueError('Short DNS answer')
        kind, cls, _, size = struct.unpack('!HHIH', packet[offset:offset+10]);offset += 10
        if offset+size > len(packet):
            raise ValueError('Short DNS record')
        if kind == 1 and cls == 1 and size == 4:
            addresses.append(socket.inet_ntoa(packet[offset:offset+size]))
        elif kind == 28 and cls == 1 and size == 16:
            addresses.append(socket.inet_ntop(socket.AF_INET6, packet[offset:offset+size]))
        offset += size
    return {'rcode': flags & 15, 'addresses': sorted(addresses)}


def dns_query(address, port, name, kind=1, transport='udp'):
    if transport not in ('udp','tcp') or kind not in (1,28):
        raise ValueError('Invalid DNS probe type')
    labels = name.rstrip('.').encode('ascii').split(b'.')
    if not labels or any(not 0 < len(label) <= 63 for label in labels) or len(name) > 253:
        raise ValueError('Invalid DNS probe name')
    nonce = secrets.randbelow(65536)
    question = b''.join(bytes([len(label)])+label for label in labels)+b'\0'+struct.pack('!HH', kind, 1)
    wire = struct.pack('!6H', nonce, 0x0100, 1, 0, 0, 0)+question
    deadline = time.monotonic()+2
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if transport == 'udp' else socket.SOCK_STREAM) as client:
        client.settimeout(2);client.connect((address,port))
        if transport == 'udp':
            client.send(wire);packet = client.recv(4096)
        else:
            client.sendall(struct.pack('!H',len(wire))+wire)
            def receive(size):
                result = b''
                while len(result) < size:
                    remaining = deadline-time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError('DNS probe deadline')
                    client.settimeout(remaining);part = client.recv(size-len(result))
                    if not part:
                        raise ValueError('Short DNS TCP response')
                    result += part
                return result
            size = struct.unpack('!H',receive(2))[0]
            if not 12 <= size <= 4096:
                raise ValueError('Oversized DNS response')
            packet = receive(size)
    return dns_packet(packet,nonce)


def dns_ready(expected):
    try:
        for transport in ('udp','tcp'):
            result = dns_query(expected['address'],expected['port'],expected['name'],transport=transport)
            if result != {'rcode':0,'addresses':[expected['answer']]}:
                raise ValueError('Unexpected DNS result')
        return True
    except (OSError,ValueError,KeyError,TypeError,struct.error):
        raise RuntimeError('DNS readiness inspection failed') from None


def valid_dns_policy(value):
    try:
        if not isinstance(value,dict) or set(value) != {'address','port','name','answer'}:
            return False
        tailnet = ipaddress.ip_network('100.64.0.0/10')
        return (all(type(value[key]) is str and ipaddress.ip_address(value[key]) in tailnet for key in ('address','answer'))
                and type(value['port']) is int and 1 <= value['port'] <= 65535
                and isinstance(value['name'],str) and 0 < len(value['name']) <= 253 and not value['name'].endswith('..')
                and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',label) for label in value['name'].rstrip('.').split('.')))
    except (ValueError,TypeError):
        return False


def evaluate(containers, policies, proc=kernel_status, mongo_cache=mongo_cache_max, database_probe=database_ready, dns_probe=dns_ready):
    findings = []
    for policy in policies:
        if not isinstance(policy.get('expected'),dict) or set(policy['expected'])-EXPECTED_FIELDS:
            raise ValueError('Unsupported reviewed control field')
        cache = policy['expected'].get('mongoCacheMaxBytes')
        if 'mongoCacheMaxBytes' in policy['expected'] and (type(cache) is not int or not 0 < cache < 2**50
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', policy['expected'].get('imageId',''))):
            raise ValueError('Mongo cache control requires a positive ceiling and exact image')
        if 'databaseReady' in policy['expected'] and (policy['expected']['databaseReady'] not in ('postgres','valkey','redis')
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', policy['expected'].get('imageId',''))):
            raise ValueError('Database readiness requires a reviewed engine and exact image')
        if 'dnsReady' in policy['expected'] and (not valid_dns_policy(policy['expected']['dnsReady'])
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', policy['expected'].get('imageId',''))):
            raise ValueError('DNS readiness requires a reviewed tailnet destination and exact image')
        if 'PortBindings' in policy['expected'] and not isinstance(policy['expected']['PortBindings'],dict):
            raise ValueError('Invalid reviewed port bindings')
        readonly = policy['expected'].get('readOnlyMountDestinations', [])
        if (not isinstance(readonly,list) or any(not isinstance(path,str) or not path.startswith('/') for path in readonly)
                or len(set(readonly))!=len(readonly)):
            raise ValueError('Invalid reviewed read-only mount list')
        selector = policy['selector']
        if set(selector) == {'name'}:
            selected = [d for d in containers if d['Name'].lstrip('/') == selector['name']]
        elif set(selector) == {'prefix'} and len(selector['prefix']) >= 20:
            selected = [d for d in containers if d['Name'].lstrip('/').startswith(selector['prefix'])]
        else:
            raise ValueError('Invalid reviewed selector')
        if not selected:
            findings.append({'resource': policy['resource'], 'field': 'missingContainer'})
        for d in selected:
            expected, host = policy['expected'], d['HostConfig']
            def require(condition, field):
                if not condition:
                    findings.append({'resource': policy['resource'], 'field': field})
            require(d['State']['Running'] is True, 'running')
            for key in ['Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'ReadonlyRootfs', 'PortBindings']:
                if key in expected:
                    require(host.get(key) == expected[key], key)
            if expected.get('noNewPrivileges'):
                require(any(x in {'no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true'} for x in host.get('SecurityOpt') or []), 'noNewPrivileges')
                require(proc(d['State']['Pid'])['nnp'] == 1, 'kernelNoNewPrivileges')
            if 'uid' in expected:
                require(proc(d['State']['Pid'])['uid'] == expected['uid'], 'runtimeUid')
            if 'imageId' in expected:
                require(d['Image'] == expected['imageId'], 'reviewedImage')
            if 'mongoCacheMaxBytes' in expected:
                require(d['Image'] == expected['imageId'] and mongo_cache(d['Id']) == expected['mongoCacheMaxBytes'], 'mongoCacheMaxBytes')
            if 'databaseReady' in expected:
                require(d['Image'] == expected['imageId'] and database_probe(d['Id'], expected['databaseReady']), 'databaseReady')
            if 'dnsReady' in expected:
                require(d['Image'] == expected['imageId'] and dns_probe(expected['dnsReady']), 'dnsReady')
            if expected.get('healthy'):
                require(d['State'].get('Health', {}).get('Status') == 'healthy', 'health')
            for key in ['CapAdd', 'CapDrop']:
                if key in expected:
                    require(caps(host.get(key)) == caps(expected[key]), key)
            if expected.get('noHostNamespaces'):
                require(not host.get('Privileged') and all(host.get(k) != 'host' for k in ['PidMode', 'IpcMode', 'NetworkMode']), 'hostPrivileges')
            if expected.get('noPublishedPorts'):
                require(not any(host.get('PortBindings', {}).values()), 'publishedPorts')
            if 'networks' in expected:
                require(set(d['NetworkSettings']['Networks']) == set(expected['networks']), 'isolatedNetworks')
            if 'mountDestinations' in expected:
                require({m['Destination'] for m in d['Mounts']} == set(expected['mountDestinations']), 'mounts')
            if 'readOnlyMountDestinations' in expected:
                readonly={m['Destination'] for m in d['Mounts'] if m.get('RW') is False}
                require(set(expected['readOnlyMountDestinations']) <= readonly, 'readOnlyMounts')
            if 'Tmpfs' in expected:
                actual = {path: tmpfs_options(value) for path, value in (host.get('Tmpfs') or {}).items()}
                wanted = {path: tmpfs_options(value) for path, value in expected['Tmpfs'].items()}
                require(actual == wanted, 'temporaryFilesystems')
            if expected.get('noDirectDockerSocket'):
                dangerous = {'/', '/var', '/var/run', '/run', '/var/run/docker.sock', '/run/docker.sock', '/var/lib/docker'}
                require(all(not m['Destination'].endswith('/docker.sock') and (m['Type'] != 'bind' or (m.get('Source', '').rstrip('/') not in {p.rstrip('/') for p in dangerous} and not m.get('Source', '').endswith('/docker.sock'))) for m in d['Mounts']), 'directDockerSocket')
            if 'dockerEndpoint' in expected:
                flags = [x.split('=', 1)[1] for x in d['Config'].get('Cmd') or [] if x.startswith('--providers.docker.endpoint=')]
                environment = dict(x.split('=', 1) for x in d['Config'].get('Env') or [] if '=' in x)
                require(flags == [expected['dockerEndpoint']] and environment.get('DOCKER_HOST', expected['dockerEndpoint']) == expected['dockerEndpoint'], 'discoveryEndpoint')
    return findings


def main():
    os.umask(0o077)
    report = {'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'ok': False, 'complete': False, 'findings': []}
    try:
        config = json.loads(CONFIG.read_text())
        assert config['schema'] in (1,2) and 0 < len(config['policies']) <= 100
        ids = subprocess.check_output(['docker', 'ps', '-q'], text=True, timeout=15).split()
        containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], timeout=30)) if ids else []
        report['findings'] = evaluate(containers, config['policies'])
        if config.get('discoveryPair') and not discovery_pair(containers, config['discoveryPair']):
            report['findings'].append({'resource': 'discovery-authentication', 'field': 'credentialPair'})
        for name in config.get('internalNetworks', []):
            value = subprocess.check_output(['docker', 'network', 'inspect', '--format', '{{json .Internal}}', name], text=True, timeout=15)
            if json.loads(value) is not True:
                report['findings'].append({'resource': 'discovery-network', 'field': 'internalNetwork'})
        report.update(ok=not report['findings'], complete=True)
    except Exception as error:
        report['error'] = type(error).__name__
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    temp = STATUS.with_suffix('.tmp')
    temp.write_text(json.dumps(report, indent=2)+'\n');temp.replace(STATUS)
    print(json.dumps({'checkedAt': report['checkedAt'], 'ok': report['ok'], 'complete': report['complete'], 'findings': len(report['findings']), 'error': report.get('error')}))
    # The independent monitor owns notification of findings and stale runs.
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
