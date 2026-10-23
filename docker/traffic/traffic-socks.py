"""Loopback HTTP-to-SOCKS5 gateway for the recorder's optional upstream.

Only mitmproxy connects here. DNS is resolved by SOCKS; no retries or direct fallback.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import select
import socket
import struct
from urllib.parse import unquote, urlsplit


def read_exact(sock, size):
    result = b''
    while len(result) < size:
        part = sock.recv(size - len(result))
        if not part:
            raise OSError('SOCKS upstream closed during handshake')
        result += part
    return result


def connect(host, port):
    upstream = urlsplit(os.environ['TESSERA_CAPTURE_UPSTREAM'])
    sock = socket.create_connection((upstream.hostname, upstream.port), timeout=15)
    try:
        auth = upstream.username is not None
        sock.sendall(b'\x05\x01' + (b'\x02' if auth else b'\x00'))
        if read_exact(sock, 2) != (b'\x05\x02' if auth else b'\x05\x00'):
            raise OSError('SOCKS upstream rejected authentication method')
        if auth:
            user = unquote(upstream.username).encode()
            password = unquote(upstream.password or '').encode()
            sock.sendall(b'\x01' + bytes([len(user)]) + user + bytes([len(password)]) + password)
            if read_exact(sock, 2) != b'\x01\x00':
                raise OSError('SOCKS upstream authentication failed')
        address = host.encode('idna')
        sock.sendall(b'\x05\x01\x00\x03' + bytes([len(address)]) + address + struct.pack('!H', port))
        reply = read_exact(sock, 4)
        if reply[:3] != b'\x05\x00\x00':
            raise OSError('SOCKS upstream rejected connection')
        length = {1: 4, 4: 16}.get(reply[3])
        if reply[3] == 3:
            length = read_exact(sock, 1)[0]
        if length is None:
            raise OSError('Invalid SOCKS address type')
        read_exact(sock, length + 2)
        return sock
    except Exception:
        sock.close()
        raise


class Gateway(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    # Unbuffered reads ensure CONNECT tunnel bytes cannot be consumed ahead of relay.
    rbufsize = 0

    def log_message(self, *_args):
        pass

    def do_CONNECT(self):
        self.forward(True)

    def forward(self, tunnel=False):
        remote = None
        established = False
        self.close_connection = True
        try:
            target = urlsplit('//' + self.path) if tunnel else urlsplit(self.path)
            if not target.hostname or (not tunnel and target.scheme != 'http'):
                self.send_error(400)
                return
            remote = connect(target.hostname, target.port or (443 if tunnel else 80))
            if tunnel:
                self.send_response(200, 'Connection established')
                self.end_headers()
            else:
                path = target.path or '/'
                if target.query:
                    path += '?' + target.query
                head = f'{self.command} {path} {self.request_version}\r\n'
                head += ''.join(f'{key}: {value}\r\n' for key, value in self.headers.items()
                                if key.lower() not in ('proxy-authorization', 'proxy-connection', 'connection'))
                # One request per upstream connection; never forward the next absolute-form request as origin-form.
                remote.sendall((head + 'Connection: close\r\n\r\n').encode('iso-8859-1'))
            established = True
            sockets = [self.connection, remote]
            while sockets:
                ready, _, _ = select.select(sockets, [], [], 60)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(65536)
                    destination = remote if source is self.connection else self.connection
                    if data:
                        destination.sendall(data)
                    else:
                        sockets.remove(source)
                        destination.shutdown(socket.SHUT_WR)
        except (OSError, ValueError, OverflowError):
            if not established:
                self.send_error(502, 'SOCKS upstream unavailable')
        finally:
            if remote:
                remote.close()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = forward


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8083), Gateway).serve_forever()
