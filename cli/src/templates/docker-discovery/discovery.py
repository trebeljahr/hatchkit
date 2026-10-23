#!/usr/bin/env python3
"""Restricted, redacted Docker discovery for the non-Swarm Traefik provider.

Bind only inside a dedicated internal Docker network; never publish its port.
The proxy itself retains daemon trust. Clients receive no generic Docker API.
"""
import base64
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import socket
import threading
import time
from urllib.parse import urlencode, urlsplit

SOCKET = '/var/run/docker.sock'
MAX_JSON = 4 * 1024**2
MAX_EVENT = 65536
COMPOSE_LABELS = {'com.docker.compose.project', 'com.docker.compose.service', 'com.docker.compose.container-number', 'coolify.managed'}
IDENTITY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')


def authorized(header, token):
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token) or not isinstance(header, str) or len(header) > 512:
        return False
    expected = 'Basic '+base64.b64encode(('discovery:'+token).encode()).decode()
    return hmac.compare_digest(header, expected)


def route(method, target):
    if len(target) > 4096 or not target.startswith('/') or target.startswith('//') or '\\' in target:
        return None
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.fragment or '%' in parsed.path:
        return None
    path = re.sub(r'^/v1\.\d{1,3}(?=/)', '', parsed.path)
    prefix = parsed.path[:-len(path)] if path != parsed.path else ''
    if method == 'HEAD' and path == '/_ping':
        return 'ping', prefix+'/_ping'
    if method != 'GET':
        return None
    if path in {'/_ping', '/version', '/containers/json', '/events'}:
        kind = {'/_ping': 'ping', '/version': 'version', '/containers/json': 'list', '/events': 'events'}[path]
        return kind, prefix+path+('?all=1' if kind == 'list' else '')
    match = re.fullmatch(r'/containers/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/json', path)
    return ('inspect', prefix+path) if match else None


def labels(values):
    return {k: v for k, v in (values or {}).items() if isinstance(k, str) and isinstance(v, str)
            and (k.startswith('traefik.') or k in COMPOSE_LABELS)}


def sanitize(kind, value):
    if kind == 'version':
        return {key: value[key] for key in ['Version', 'ApiVersion', 'MinAPIVersion', 'Os', 'Arch'] if key in value}
    if kind == 'list':
        assert isinstance(value, list) and len(value) <= 512
        return [{'Id': row['Id']} for row in value]
    assert kind == 'inspect'
    state, config, networks = value.get('State') or {}, value.get('Config') or {}, (value.get('NetworkSettings') or {})
    result = {'Id': value['Id'], 'Name': value['Name'], 'State': {'Status': state.get('Status', '')},
              'Config': {'Labels': labels(config.get('Labels'))},
              'HostConfig': {'NetworkMode': (value.get('HostConfig') or {}).get('NetworkMode', '')},
              'NetworkSettings': {'Ports': networks.get('Ports') or {}, 'Networks': {}}}
    if state.get('Health'):
        result['State']['Health'] = {'Status': state['Health'].get('Status', '')}
    for name, network in (networks.get('Networks') or {}).items():
        result['NetworkSettings']['Networks'][name] = {k: network.get(k, '') for k in ['NetworkID', 'IPAddress', 'GlobalIPv6Address']}
    return result


def event(value):
    action = value.get('Action', value.get('status', ''))
    if value.get('Type') != 'container' or action not in {'start', 'die', 'health_status: healthy', 'health_status: unhealthy', 'health_status: starting'}:
        return None
    identifier = (value.get('Actor') or {}).get('ID', value.get('id', ''))
    if not isinstance(identifier, str) or not IDENTITY.fullmatch(identifier):
        return None
    return {'Type': 'container', 'Action': action, 'Actor': {'ID': identifier},
            'time': value.get('time', 0), 'timeNano': value.get('timeNano', 0)}


def upstream(method, path):
    connection = http.client.HTTPConnection('localhost', timeout=40)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(40)
    connection.sock.connect(SOCKET)
    connection.request(method, path, headers={'Accept': 'application/json'})
    return connection, connection.getresponse()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(16)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    # Close each ordinary response. Streams retain their connection explicitly.
    protocol_version = 'HTTP/1.0'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *args):
        pass

    def reply(self, status, value, head=False, headers=None):
        body = value if isinstance(value, bytes) else json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for key, val in (headers or {}).items():
            if val:
                self.send_header(key, val)
        self.end_headers()
        if not head:
            self.wfile.write(body)
        self.close_connection = True

    def deny(self):
        self.reply(403, {'message': 'Docker discovery operation denied'})

    def handle_discovery(self, method):
        try:
            lengths = self.headers.get_all('Content-Length') or []
            if self.headers.get('Transfer-Encoding') or len(lengths) > 1 or (lengths and int(lengths[0]) != 0):
                return self.deny()
            target = route(method, self.path)
            if target is None:
                return self.deny()
            kind, path = target
            headers = self.headers.get_all('Authorization') or []
            local_ping = kind == 'ping' and self.client_address[0] == '127.0.0.1'
            if not local_ping and (len(headers) != 1 or not authorized(headers[0], os.environ.get('DISCOVERY_TOKEN'))):
                return self.reply(401, {'message': 'Discovery authentication required'}, head=method == 'HEAD')
            if kind == 'events':
                return self.events(path)
            connection, response = upstream(method, path)
            try:
                if response.status != 200:
                    return self.reply(response.status if 400 <= response.status <= 599 else 502,
                                      {'message': 'Discovery metadata unavailable'}, head=method == 'HEAD')
                body = response.read(MAX_JSON+1)
                assert len(body) <= MAX_JSON
                if kind == 'ping':
                    return self.reply(200, b'OK' if method == 'GET' else b'', head=method == 'HEAD',
                                      headers={'API-Version': response.getheader('API-Version'), 'Docker-Experimental': 'false'})
                return self.reply(200, sanitize(kind, json.loads(body)))
            finally:
                connection.close()
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            if getattr(self, '_stream_started', False):
                self.close_connection = True
                return
            # Never return daemon errors, raw JSON, request paths or credentials.
            self.reply(502, {'message': 'Discovery temporarily unavailable'}, head=method == 'HEAD')

    def events(self, path):
        self._stream_started = True
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        cursor = int(time.time())-2
        # Renew upstream streams and send an ignored empty event every 30s. This
        # detects disconnected clients without exposing a reconnect to Traefik.
        while True:
            until = int(time.time())+30
            query = urlencode({'since': str(cursor), 'until': str(until), 'filters': json.dumps({'type': ['container']})})
            connection, response = upstream('GET', path+'?'+query)
            try:
                if response.status != 200:
                    return
                while True:
                    line = response.readline(MAX_EVENT+1)
                    if not line:
                        break
                    assert len(line) <= MAX_EVENT
                    item = event(json.loads(line))
                    if item:
                        self.wfile.write(json.dumps(item, separators=(',', ':')).encode()+b'\n')
                        self.wfile.flush()
                self.wfile.write(b'{}\n')
                self.wfile.flush()
                cursor = until-1
            finally:
                connection.close()

    def do_GET(self):
        self.handle_discovery('GET')

    def do_HEAD(self):
        self.handle_discovery('HEAD')

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = do_CONNECT = deny


if __name__ == '__main__':
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', os.environ.get('DISCOVERY_TOKEN', '')):
        raise SystemExit('A valid service-local discovery token is required')
    Server(('0.0.0.0', int(os.environ.get('PORT', '2375'))), Handler).serve_forever()
