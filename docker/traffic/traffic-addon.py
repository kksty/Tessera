"""Stream complete HTTP bodies to disk; archive metadata and upload bounded chunks separately."""
import asyncio
import base64
import datetime
import json
import os
from pathlib import Path
import queue
import threading
import time
import urllib.request
import uuid

CHUNK = 256 * 1024
BATCH = 8
DRAIN = 32
def stamp(value):
    return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


class Capture:
    def __init__(self):
        self.queue = queue.Queue(maxsize=256)
        self.dropped = 0
        # Must not be called "error": that would shadow the mitmproxy error hook below.
        self.capture_error = None
        self.upload_error = None
        self.tls_notice = None
        self.tls_notice_hosts = set()
        self.tls_downgraded = False
        self.connections = {}
        self.stop = threading.Event()
        self.thread = None
        self.writer = None
        self.loop = None
        self.master = None
        self.bypass = json.loads(os.environ.get("TESSERA_PROXY_BYPASS", "[]"))
        self.excluded = set(os.environ.get('TESSERA_PROXY_EXCLUDE', '').split(','))

    def running(self):
        try:
            from mitmproxy import ctx
            self.loop = asyncio.get_running_loop()
            self.master = ctx.master
        except (ImportError, RuntimeError):
            pass
        self.writer = threading.Thread(target=self.persist, daemon=True)
        self.thread = threading.Thread(target=self.upload, daemon=True)
        self.writer.start(); self.thread.start()

    def skip(self, flow):
        return flow.request.host in self.excluded or any(item['host'].lower() == flow.request.host.lower() and item['port'] == getattr(flow.request, 'port', 443 if flow.request.pretty_url.startswith('https:') else 80) for item in self.bypass)

    def fail(self, error):
        # May run in the proxy hook: no disk/network I/O and no forwarding shutdown.
        self.dropped += 1
        self.capture_error = error

    def done(self):
        self.stop.set()
        if self.writer:
            self.writer.join(timeout=2)
        if self.thread:
            self.thread.join(timeout=2)

    def enqueue(self, record):
        try:
            self.queue.put_nowait(record)
        except queue.Full:
            self.fail('流量记录队列已满，部分记录可能缺失；连接继续转发。')
            return False
        return True

    def identity(self, flow):
        auth = flow.request.headers.pop('proxy-authorization', '')
        value = self.connections.get(flow.client_conn.id, {})
        if auth.lower().startswith('basic '):
            try:
                run, step = base64.b64decode(auth[6:], validate=True).decode().split(':', 1)
                value = {'run_id': run[:160], 'step_id': step[:160]}
                self.connections[flow.client_conn.id] = value
            except (ValueError, UnicodeError):
                pass
        flow.metadata['tessera_identity'] = value

    def http_connect(self, flow):
        self.identity(flow)

    def client_disconnected(self, client):
        self.connections.pop(client.id, None)

    def stream(self, flow, side):
        identity = str(uuid.uuid4())
        root = Path(os.environ['TESSERA_PROXY_DIR']) / 'bodies'
        item = {'id': identity, 'size': 0, 'file': None, 'failed': False}
        flow.metadata[side] = item
        try:
            root.mkdir(mode=0o700, parents=True, exist_ok=True)
            item['file'] = (root / identity).open('xb')
        except OSError:
            item['failed'] = True
            self.fail('HTTP 正文文件无法创建，保存失败；连接继续转发。')
        def chunk(data):
            item['size'] += len(data)
            if not item['failed']:
                try:
                    if data:
                        item['file'].write(data)
                    else:
                        item['file'].flush(); os.fsync(item['file'].fileno()); item['file'].close()
                except (OSError, ValueError):
                    item['failed'] = True
                    self.fail('HTTP 正文写入失败，记录不完整；连接继续转发，不重试请求。')
            return data
        return chunk

    def requestheaders(self, flow):
        self.identity(flow)
        if self.skip(flow):
            flow.metadata['tessera_skip'] = True
            flow.request.stream = True
            return
        flow.request.stream = self.stream(flow, 'tessera_request')

    def responseheaders(self, flow):
        flow.response.stream = True if flow.metadata.get('tessera_skip') else self.stream(flow, 'tessera_response')

    def message(self, flow, message, side):
        item = flow.metadata.get(side)
        if not item:
            stream = self.stream(flow, side)
            stream(message.raw_content or b''); stream(b'')
            item = flow.metadata[side]
        # Error hooks can arrive before the stream's final empty chunk.
        if item and item['file'] and not item['file'].closed:
            try:
                item['file'].flush(); os.fsync(item['file'].fileno()); item['file'].close()
            except OSError:
                item['failed'] = True
                self.fail('HTTP 正文文件保存失败，记录不完整；连接继续转发。')
        size = item['size']
        if side == 'tessera_request':
            first = f'{message.method} {message.path} {message.http_version}'
        else:
            first = f'{message.http_version} {message.status_code} {message.reason}'
        head = first + '\r\n' + '\r\n'.join(f'{k}: {v}' for k, v in message.headers.items(multi=True))
        trailers = getattr(message, 'trailers', None)
        return {'head': head, 'body_base64': '', 'size': size,
                **({'trailers':'\r\n'.join(f'{k}: {v}' for k, v in trailers.items(multi=True))} if trailers else {}),
                'truncated': bool(item and item['failed']),
                **({'body_id': item['id']} if item and not item['failed'] else {})}

    def record(self, flow):
        if flow.metadata.get('tessera_skip') or self.skip(flow):
            return
        request = flow.request
        end = flow.response.timestamp_end if flow.response else None
        record = {'id': flow.id, 'capture_kind': 'http', 'created_at': stamp(request.timestamp_start),
                  'method': request.method[:32], 'url': request.pretty_url[:16384], 'host': request.host[:512], 'protocol': request.http_version[:32],
                  'status': flow.response.status_code if flow.response else None,
                  'duration_ms': max(0, ((end or time.time()) - request.timestamp_start)*1000) if flow.response or flow.error else None,
                  'request': self.message(flow, request, 'tessera_request'),
                  'response': self.message(flow, flow.response, 'tessera_response') if flow.response else None,
                  **flow.metadata.get('tessera_identity', {})}
        if flow.error:
            record['error'] = str(flow.error)[:4000]
        host = getattr(request, 'host', '')
        if host in self.tls_notice_hosts and self.tls_notice:
            record['error'] = ((record.get('error', '') + '；') if record.get('error') else '') + self.tls_notice
            record['error'] = record['error'][:4000]
        if any(message and message['truncated'] for message in (record['request'], record['response'])):
            record['error'] = 'HTTP 正文保存失败，记录不完整。'
        self.enqueue(record)

    def request(self, flow):
        self.record(flow)

    def response(self, flow):
        self.clear_tls_notice(flow)
        self.record(flow)

    def needs_tls12(self, flow):
        """A server that drops TLS 1.3 from OpenSSL may accept TLS 1.2 on later connections."""
        if getattr(flow.request, 'scheme', '') != 'https':
            return False
        server = getattr(flow, 'server_conn', None)
        return server is not None and not getattr(server, 'tls_established', True)

    def tls_handshake_failed(self, flow):
        """TCP connected but TLS did not, so a retry with TLS 1.2 is meaningful."""
        return self.needs_tls12(flow) and getattr(flow.server_conn, 'timestamp_tcp_setup', None) is not None

    def tls12_mode(self):
        try:
            from mitmproxy import ctx
        except ImportError:
            return False
        return ctx.options.tls_version_server_max == 'TLS1_2'

    def render_tls_notice(self):
        if not self.tls_notice_hosts:
            self.tls_notice = None
            return
        hosts = sorted(self.tls_notice_hosts)
        shown = '、'.join(hosts[:3])
        if len(hosts) > 3:
            shown += f' 等 {len(hosts)} 个目标'
        state = '已降级到 TLS 1.2' if self.tls_downgraded else '上游 TLS 上限为 1.2'
        self.tls_notice = (
            f'录制代理{state}；{shown} 的 TLS 握手失败，'
            '可能是目标要求 TLS 1.3 或降级导致。可在设置中调整录制代理，或关闭代理后直连复核。'
        )

    def note_tls_failure(self, flow):
        host = getattr(flow.request, 'host', '') or '未知目标'
        self.tls_notice_hosts.add(host)
        self.render_tls_notice()

    def clear_tls_notice(self, flow):
        host = getattr(getattr(flow, 'request', None), 'host', '')
        if host in self.tls_notice_hosts:
            self.tls_notice_hosts.discard(host)
            self.render_tls_notice()

    def fallback_tls(self, flow):
        if not self.needs_tls12(flow):
            return
        try:
            from mitmproxy import ctx
        except ImportError:
            return
        # Only lower an upper bound that still allows TLS 1.3. Never raise a user setting.
        if ctx.options.tls_version_server_max in ('UNBOUNDED', 'TLS1_3'):
            ctx.options.tls_version_server_max = 'TLS1_2'
            self.tls_downgraded = True

    def error(self, flow):
        # No HTTP request is sent when the upstream TLS handshake fails, so this only
        # changes the version for future connections; it never replays the failed flow.
        failed_tls = self.tls_handshake_failed(flow)
        was_tls12 = self.tls12_mode()
        self.fallback_tls(flow)
        if failed_tls and was_tls12:
            self.note_tls_failure(flow)
        elif getattr(flow, 'server_conn', None) is not None and getattr(flow.server_conn, 'tls_established', False):
            # TLS worked; an HTTP-level error is not evidence of a downgrade problem.
            self.clear_tls_notice(flow)
        if getattr(flow, 'request', None) is not None:
            self.record(flow)

    def persist(self):
        root = Path(os.environ['TESSERA_PROXY_DIR']) / 'spool'
        try:root.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError:self.fail("流量记录目录不可写，部分记录可能缺失；连接继续转发。")
        while not self.stop.is_set() or not self.queue.empty():
            try:
                record = self.queue.get(timeout=0.1)
                import hashlib
                # Append each stage so uploading a request cannot delete its newer response.
                name = f'{time.time_ns()}-' + hashlib.sha256(record['id'].encode()).hexdigest()
                tmp = root / (name + '.tmp'); dest = root / (name + '.json')
                tmp.write_text(json.dumps(record), encoding='utf-8'); tmp.replace(dest)
            except queue.Empty:
                continue
            except OSError:
                self.fail('流量无法写入项目存储，部分记录可能缺失；连接继续转发。')
                self.stop.wait(2)

    def upload(self):
        root = Path(os.environ['TESSERA_PROXY_DIR']) / 'spool'
        try:root.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError:self.fail("流量记录目录不可写，部分记录可能缺失；连接继续转发。")
        server = os.environ['TESSERA_CAPTURE_SERVER'].rstrip('/') + '/api/projects/' + os.environ['TESSERA_CAPTURE_PROJECT'] + '/traffic'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def post(url, data):
            req = urllib.request.Request(url, json.dumps(data).encode(), {'content-type':'application/json', 'x-tessera-project-token':os.environ.get('TESSERA_PROJECT_TOKEN') or os.environ.get('TESSERA_WORKER_TOKEN','')})
            with opener.open(req, timeout=5) as response:
                response.read(1024)
        last = 0
        while not self.stop.is_set():
            try:
                files = sorted(root.glob('*.json'), key=lambda p:p.stat().st_mtime)
                if time.time()-last>5:
                    guard_file = Path(os.environ['TESSERA_PROXY_DIR'])/'guard-status.json'
                    guard = json.loads(guard_file.read_text()) if guard_file.exists() else {}
                    loss_file = Path(os.environ['TESSERA_PROXY_DIR'])/'capture-loss.json'
                    stored = json.loads(loss_file.read_text()).get('error') if loss_file.exists() else guard.get('error')
                    error = self.capture_error or self.upload_error or stored
                    if self.capture_error:
                        try:loss_file.write_text(json.dumps({'error':self.capture_error,'dropped':self.dropped}))
                        except OSError:pass
                    blocked = guard.get('blocked',0)
                    data = {'state':'degraded' if error or self.tls_notice else 'active','dropped':self.dropped,'blocked':blocked,'guard':guard.get('guard',False),
                            **({'error':error} if error else {}), **({'tls_notice':self.tls_notice} if self.tls_notice else {})}
                    post(server+'/status', data); last=time.time()
                # The API accepts at most 8 records per request; drain several batches per pass and
                # only unlink a spool file after its own batch has been accepted.
                sent = 0
                while files and sent < DRAIN:
                    batch = files[:BATCH]; files = files[BATCH:]
                    records = [json.loads(f.read_text(encoding='utf-8')) for f in batch]
                    for record in records:
                        for message in (record.get('request'), record.get('response')):
                            if not message or not message.get('body_id'):
                                continue
                            body = root.parent / 'bodies' / message['body_id']
                            marker = body.with_suffix('.sent')
                            if marker.exists() and marker.read_text() == str(message['size']):
                                continue
                            offset = 0
                            with body.open('rb') as source:
                                while True:
                                    chunk = source.read(CHUNK)
                                    if not chunk and offset:
                                        break
                                    post(server+'/bodies/'+message['body_id'], {'offset':offset, 'data_base64':base64.b64encode(chunk).decode()})
                                    offset += len(chunk)
                                    if not chunk:
                                        break
                            if offset != message['size']:
                                raise ValueError('HTTP body file is incomplete')
                            marker.write_text(str(offset))
                    post(server, {'records':records})
                    self.upload_error = None
                    for f in batch:
                        f.unlink()
                    # A completed flow no longer needs its local uploaded body copies.
                    for record in records:
                        if not (record.get('response') or record.get('error')):
                            continue
                        for message in (record.get('request'), record.get('response')):
                            if message and message.get('body_id'):
                                body = root.parent / 'bodies' / message['body_id']
                                body.unlink(missing_ok=True); body.with_suffix('.sent').unlink(missing_ok=True)
                    sent += 1
                if sent:
                    self.stop.wait(0.05)
                    continue
            except (OSError, ValueError):
                # Retry archive uploads only, never the original target request.
                self.upload_error = '流量归档上传失败；完整正文保留在 Worker 等待恢复，尚未归档到服务器。'
            self.stop.wait(0.2)


addons = [Capture()]
