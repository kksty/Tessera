"""Local-only targets for gateway smoke checks. No shell payloads or external targets."""
import http.server
import json
import socket
import socketserver
import ssl
import subprocess
import sys
import threading
import time

records = []


class HTTP(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(records).encode() if self.path == '/records' else b'fixture-http-ok'
        self.send_response(200); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        records.extend(data.get('records', []))
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')

    def log_message(self, *_): pass


class TCP(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.sendall(b'SSH-fixture-banner\r\n')
        self.request.sendall(self.request.recv(100))


def udp(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); sock.bind(('0.0.0.0', port))
    while True:
        data, peer = sock.recvfrom(1024); sock.sendto(data, peer)


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()


if sys.argv[1] == 'target':
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/tmp/key.pem',
                    '-out', '/tmp/cert.pem', '-days', '1', '-subj', '/CN=target', '-addext', 'subjectAltName=DNS:target'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for port in [9000, 9001]: serve(http.server.ThreadingHTTPServer(('0.0.0.0', port), HTTP))
    secure = http.server.ThreadingHTTPServer(('0.0.0.0', 9443), HTTP)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain('/tmp/cert.pem', '/tmp/key.pem')
    secure.socket = context.wrap_socket(secure.socket, server_side=True); serve(secure)
    serve(socketserver.ThreadingTCPServer(('0.0.0.0', 9998), TCP))
    threading.Thread(target=udp, args=(9999,), daemon=True).start()
else:
    for port in map(int, sys.argv[2:]):
        serve(socketserver.ThreadingTCPServer(('0.0.0.0', port), TCP))
        threading.Thread(target=udp, args=(port,), daemon=True).start()
while True: time.sleep(1)
