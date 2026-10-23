#!/usr/bin/env python3
"""Check explicitly reviewed container controls; never learn or apply policy."""
import datetime as dt
import hmac
import json
import os
from pathlib import Path
import re
import subprocess

CONFIG = Path('/etc/hatchkit-security/container-policy.json')
STATUS = Path('/var/lib/hatchkit-backups/container-policy-status.json')


def kernel_status(pid):
    text = (Path('/proc')/str(pid)/'status').read_text()
    return {'uid': int(re.search(r'^Uid:\s+(\d+)', text, re.M)[1]),
            'nnp': int(re.search(r'^NoNewPrivs:\s+(\d+)', text, re.M)[1])}


def caps(values):
    return {c.upper().removeprefix('CAP_') for c in values or []}


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


def evaluate(containers, policies, proc=kernel_status):
    findings = []
    for policy in policies:
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
            for key in ['Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'ReadonlyRootfs']:
                if key in expected:
                    require(host.get(key) == expected[key], key)
            if expected.get('noNewPrivileges'):
                require(any(x in {'no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true'} for x in host.get('SecurityOpt') or []), 'noNewPrivileges')
                require(proc(d['State']['Pid'])['nnp'] == 1, 'kernelNoNewPrivileges')
            if 'uid' in expected:
                require(proc(d['State']['Pid'])['uid'] == expected['uid'], 'runtimeUid')
            if 'imageId' in expected:
                require(d['Image'] == expected['imageId'], 'reviewedImage')
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
        assert config['schema'] == 1 and 0 < len(config['policies']) <= 100
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
