"""Explicit recorder integration check, only in a disposable worker container.

Run with /qa mounted and current traffic sources at /opt/tessera/traffic.
Exercises actual launcher, trusted HTTPS on arbitrary ports, bypass, proxychains and SOCKS upstream.
"""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import ssl
import struct
import subprocess
import threading
import time
import urllib.request

assert os.environ.get('TESSERA_TEST_DISPOSABLE_CONTAINER') == '1' and Path('/.dockerenv').exists()
records=[]; hits=[]; upstream_hits=[]; bodies={}
class Target(BaseHTTPRequestHandler):
 def handle(self):
  try:super().handle()
  except (BrokenPipeError,ConnectionResetError):pass
 def do_POST(self):
  data=self.rfile.read(int(self.headers.get('Content-Length','0')))
  hits.append(self.path)
  assert not self.headers.get('Proxy-Authorization')
  self.send_response(201); self.send_header('Content-Length',str(len(b'reply:'+data))); self.end_headers(); self.wfile.write(b'reply:'+data)
 def log_message(self,*_):pass
class Sink(BaseHTTPRequestHandler):
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  if '/bodies/' in self.path:
   body=bodies.setdefault(self.path.rsplit('/',1)[-1],bytearray());chunk=base64.b64decode(data['data_base64']);offset=data['offset']
   if offset==len(body):body.extend(chunk)
   else:assert body[offset:offset+len(chunk)]==chunk
  else:records.extend(data.get('records',[]))
  self.send_response(200);self.end_headers();self.wfile.write(b'{}')
 def log_message(self,*_):pass

def serve(server):
 threading.Thread(target=server.serve_forever,daemon=True).start()
 return server
sink=serve(ThreadingHTTPServer(('127.0.0.1',0),Sink))
plain=serve(ThreadingHTTPServer(('127.0.0.1',0),Target))
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout','/tmp/key.pem','-out','/tmp/cert.pem','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path('/usr/local/share/ca-certificates/qa.crt').write_bytes(Path('/tmp/cert.pem').read_bytes())
subprocess.run(['update-ca-certificates'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
secure=ThreadingHTTPServer(('127.0.0.1',0),Target)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain('/tmp/cert.pem','/tmp/key.pem')
secure.socket=context.wrap_socket(secure.socket,server_side=True);serve(secure)

# A real SOCKS5 fixture; requests must traverse this listener in socks mode.
def exact(sock,n):
 data=b''
 while len(data)<n:
  part=sock.recv(n-len(data))
  if not part:raise OSError('EOF')
  data+=part
 return data
class Socks(socketserver.BaseRequestHandler):
 def handle(self):
  remote=None
  try:
   assert exact(self.request,3)==b'\x05\x01\x02'
   self.request.sendall(b'\x05\x02')
   assert exact(self.request,1)==b'\x01'
   user=exact(self.request,exact(self.request,1)[0]);password=exact(self.request,exact(self.request,1)[0])
   assert (user,password)==(b'user',b'pass')
   self.request.sendall(b'\x01\x00')
   assert exact(self.request,4)==b'\x05\x01\x00\x03'
   host=exact(self.request,exact(self.request,1)[0]).decode();port=struct.unpack('!H',exact(self.request,2))[0]
   upstream_hits.append((host,port))
   remote=socket.create_connection((host,port),5)
   self.request.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
   sockets=[remote,self.request]
   while sockets:
    ready,_,_=select.select(sockets,[],[],10)
    if not ready:break
    for source in ready:
     dest=remote if source is self.request else self.request
     data=source.recv(65536)
     if data:dest.sendall(data)
     else:sockets.remove(source);dest.shutdown(socket.SHUT_WR)
  except OSError:pass
  finally:
   if remote:remote.close()
class SocksServer(socketserver.ThreadingTCPServer):
 daemon_threads=True
socks=serve(SocksServer(('127.0.0.1',0),Socks))

# HTTP upstream fixture is mitmproxy itself, so its absolute HTTP / CONNECT behavior is real.
mode=os.environ.get('QA_UPSTREAM','direct')
env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy','no_proxy')}
if mode=='socks':env['TESSERA_CAPTURE_UPSTREAM']=f'socks5://user:pass@127.0.0.1:{socks.server_address[1]}'
if mode=='http':
 upstream=subprocess.Popen(['mitmdump','--listen-host','127.0.0.1','--listen-port','8099','--set','confdir=/tmp/upstream-ca','--set','ssl_insecure=true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 env['TESSERA_CAPTURE_UPSTREAM']='http://127.0.0.1:8099'
 time.sleep(2)
 # Trust its CA: recorder validates the HTTPS connection to the HTTP upstream's MITM.
 Path('/usr/local/share/ca-certificates/upstream.crt').write_bytes(Path('/tmp/upstream-ca/mitmproxy-ca-cert.pem').read_bytes())
 subprocess.run(['update-ca-certificates'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
job={'kind':'execute','project_id':'qa','worker':'qa','run_id':'run-qa','step_id':'step-qa'}
config={'server':f'http://127.0.0.1:{sink.server_port}','model':{'base_url':f'http://localhost:{sink.server_port}'}}
env.update(TESSERA_JOB=base64.b64encode(json.dumps(job).encode()).decode(),TESSERA_RUN_CONFIG=base64.b64encode(json.dumps(config).encode()).decode(),TESSERA_WORKER_TOKEN='fixture')
Path('/opt/tessera/dist/runner.mjs').write_text("import fs from 'node:fs'; fs.writeFileSync('/tmp/launched-env.json',JSON.stringify(process.env));")
result=subprocess.run(['python3','/opt/tessera/traffic/traffic-launch.py'],env=env,capture_output=True,text=True,timeout=45)
assert result.returncode==0,result.stderr
launched=json.loads(Path('/tmp/launched-env.json').read_text())
assert launched.get('http_proxy'),result.stderr+'\n'+Path('/var/lib/tessera-proxy/proxy.log').read_text()
assert 'LD_PRELOAD' not in launched
assert not Path('/var/lib/tessera-capture/network-pid').exists()
assert not Path('/etc/chromium/policies/managed/tessera-capture.json').exists()
payload=bytes(range(256))*8192+b'last-bytes'
Path('/tmp/qa-body.bin').write_bytes(payload)
for scheme,port in [('http',plain.server_port),('https',secure.server_port)]:
 response=subprocess.run(['curl','--silent','--show-error','--fail','--noproxy','','--data-binary','@/tmp/qa-body.bin',f'{scheme}://localhost:{port}/{scheme}'],env=launched,capture_output=True,timeout=20)
 assert response.returncode==0,(scheme,response.stderr,Path('/var/lib/tessera-proxy/proxy.log').read_text())
 assert response.stdout==b'reply:'+payload
# Bypass intentionally, no automatic replay or recording.
response=subprocess.run(['curl','--silent','--noproxy','*','--data','once',f'http://localhost:{plain.server_port}/bypass'],env=launched,capture_output=True,text=True,timeout=10)
assert response.returncode==0 and response.stdout=='reply:once'
# Pinning failure is surfaced once. The recorder must not replay the HTTP request directly.
pinned=subprocess.run(['curl','--silent','--noproxy','','--pinnedpubkey','sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=','--data','once',f'https://localhost:{secure.server_port}/pinned'],env=launched,capture_output=True,text=True,timeout=10)
assert pinned.returncode==90,pinned.stderr
assert '/pinned' not in hits,hits
# User proxychains invocation drops only recorder-owned HTTP proxy variables.
check=subprocess.run(['/bin/sh','/opt/tessera/traffic/proxychains4-wrapper','/usr/bin/env'],env=launched,capture_output=True,text=True)
assert check.returncode==0 and 'http_proxy=' not in check.stdout and 'https_proxy=' not in check.stdout,check.stderr
# Even non-HTTP bytes on port 443 must retain their original direct path.
raw=socket.socket();raw.bind(('127.0.0.1',443));raw.listen()
def echo():
 client,_=raw.accept()
 with client:client.sendall(b'SSH-2.0-test\r\n')
threading.Thread(target=echo,daemon=True).start()
with socket.create_connection(('127.0.0.1',443),timeout=3) as client:assert client.recv(100)==b'SSH-2.0-test\r\n'
deadline=time.time()+10
while time.time()<deadline and len([r for r in records if r.get('response')])<2:time.sleep(.1)
completed={r['url']:r for r in records if r.get('response')}
assert len(completed)==2,records
for row in completed.values():
 assert row['capture_kind']=='http' and row['status']==201 and row['run_id']=='run-qa'
 assert bodies[row['request']['body_id']]==payload
 assert bodies[row['response']['body_id']]==b'reply:'+payload
assert hits.count('/bypass')==1 and hits.count('/http')==1 and hits.count('/https')==1,hits
if mode=='socks':
 assert upstream_hits[:2]==[('localhost',plain.server_port),('localhost',secure.server_port)],upstream_hits
 # Pinning may close either before or after the upstream TLS handshake; no HTTP request is replayed.
 assert upstream_hits[2:] in ([],[('localhost',secure.server_port)]),upstream_hits
print('PASS explicit HTTP/HTTPS launcher, arbitrary ports, direct SSH:443, bypass, proxychains, upstream='+mode)
