"""Run with Python's unittest; no mitmproxy installation is required for capture-hook tests."""
import base64
import importlib.util
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import os
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('traffic_addon',Path(__file__).parents[2]/'docker/traffic/traffic-addon.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Headers(dict):
 def items(self,multi=False):return super().items()
def flow():
 request=SimpleNamespace(headers=Headers({'Host':'example.test','proxy-authorization':'Basic '+base64.b64encode(b'run_1:s001').decode()}),method='POST',path='/api',http_version='HTTP/1.1',pretty_url='https://example.test/api',host='example.test',timestamp_start=time.time(),raw_content=None)
 return SimpleNamespace(request=request,response=None,error=None,metadata={},client_conn=SimpleNamespace(id='connection1'),id='flow1')
def tcp_flow(identifier='tcp1'):
 return SimpleNamespace(messages=[],server_conn=SimpleNamespace(address=('10.0.0.9',22)),client_conn=SimpleNamespace(id='connection1',peername=('10.0.0.5',51000)),metadata={},id=identifier,error=None)
class CaptureTests(unittest.TestCase):
 def setUp(self):
  self.directory=tempfile.TemporaryDirectory(prefix='tessera-bodies-')
  self.environment=patch.dict(os.environ,{'TESSERA_PROXY_DIR':self.directory.name})
  self.environment.start()
  self.addCleanup(self.environment.stop);self.addCleanup(self.directory.cleanup)
 def test_capture_failure_never_writes_or_stops_forwarding_on_the_hook_thread(self):
  capture=module.Capture()
  shutdown=[]
  capture.loop=SimpleNamespace(call_soon_threadsafe=lambda fn:shutdown.append(fn))
  capture.master=SimpleNamespace(shutdown=lambda:None)
  with patch.object(Path,'write_text',side_effect=AssertionError('disk I/O on proxy hook')):
   capture.fail('storage unavailable')
  self.assertEqual(capture.dropped,1);self.assertEqual(capture.error,'storage unavailable');self.assertEqual(shutdown,[])

 def test_streaming_saves_entire_large_body_and_correlates_without_auth_leak(self):
  capture=module.Capture();f=flow();f.request.headers['X-Large']='a'*70000;capture.requestheaders(f)
  data=bytes(range(256))*(8192+1);self.assertEqual(f.request.stream(data),data)
  capture.request(f);record=capture.queue.get_nowait()
  self.assertEqual(record['run_id'],'run_1');self.assertEqual(record['step_id'],'s001');self.assertNotIn('authorization',record['request']['head'].lower())
  self.assertEqual(record['request']['size'],len(data));self.assertFalse(record['request']['truncated']);self.assertEqual(record['request']['body_base64'],'');self.assertEqual((Path(self.directory.name)/'bodies'/record['request']['body_id']).read_bytes(),data)
  self.assertIsNone(record['response'])
  self.assertEqual(record['capture_kind'],'http')
  self.assertIn('a'*70000,record['request']['head'])
  f.response=SimpleNamespace(headers=Headers({'content-type':'text/plain'}),http_version='HTTP/1.1',status_code=200,reason='OK',timestamp_end=time.time(),raw_content=None)
  capture.responseheaders(f);self.assertEqual(f.response.stream(b'proof'),b'proof');capture.response(f)
  record=capture.queue.get_nowait();self.assertEqual((Path(self.directory.name)/'bodies'/record['response']['body_id']).read_bytes(),b'proof')
  other=flow();other.request.headers.pop('proxy-authorization');capture.identity(other);self.assertEqual(other.metadata['tessera_identity']['run_id'],'run_1')
  capture.client_disconnected(f.client_conn);self.assertEqual(capture.connections,{})
 def test_disk_failure_reports_incomplete_without_changing_forwarded_bytes(self):
  capture=module.Capture();f=flow();capture.requestheaders(f)
  item=f.metadata['tessera_request'];item['file'].close()
  def full(*_):raise OSError('No space left on device')
  item['file']=SimpleNamespace(write=full,closed=True)
  self.assertEqual(f.request.stream(b'still forwarded'),b'still forwarded')
  capture.request(f);record=capture.queue.get_nowait()
  self.assertTrue(record['request']['truncated']);self.assertNotIn('body_id',record['request'])
  self.assertIn('保存失败',record['error']);self.assertEqual(capture.dropped,1)
 def assert_shape(self,record):
  for key in ['id','capture_kind','created_at','method','url','host','protocol','status','duration_ms','request','response']:
   self.assertIn(key,record)
  for key in ['head','body_base64','size','truncated']:self.assertIn(key,record['request'])
  self.assertRegex(record['created_at'],r'Z$')
 def test_non_http_hooks_are_not_registered(self):
  capture=module.Capture()
  for name in ('tcp_start','tcp_message','tcp_end','tcp_error'):
   self.assertFalse(hasattr(capture,name))
 def test_exclusions_and_overflow_do_not_block_capture_hooks(self):
  capture=module.Capture();capture.excluded={'example.test'};f=flow();capture.requestheaders(f);capture.request(f);self.assertTrue(capture.queue.empty())
  capture.excluded=set();f=flow();capture.requestheaders(f)
  shutdown=[];capture.loop=SimpleNamespace(call_soon_threadsafe=lambda fn:shutdown.append(fn));capture.master=SimpleNamespace(shutdown=lambda:None)
  f.kill=lambda: self.fail('recording failure killed the HTTP flow')
  for _ in range(257):capture.request(f)
  self.assertEqual(capture.dropped,1);self.assertEqual(capture.queue.qsize(),256);self.assertEqual(shutdown,[]);self.assertEqual(f.request.stream(b"still forwarded"),b"still forwarded")
 def test_uploader_retries_spooled_records_outside_traffic_hooks(self):
  received=[];bodies={}
  class Handler(BaseHTTPRequestHandler):
   def do_POST(self):
    data=json.loads(self.rfile.read(int(self.headers['content-length'])))
    if '/bodies/' in self.path:
     bodies.setdefault(self.path,bytearray()).extend(base64.b64decode(data['data_base64']));self.send_response(200)
    elif self.path.endswith('/status'):self.send_response(200)
    elif not received:received.append('retry');self.send_response(503)
    else:received.append(data);self.send_response(200)
    self.end_headers();self.wfile.write(b'{}')
   def log_message(self,*args):pass
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  with tempfile.TemporaryDirectory(prefix='tessera-proxy-test-') as root:
   os.environ.update(TESSERA_PROXY_DIR=root,TESSERA_CAPTURE_SERVER=f'http://127.0.0.1:{server.server_port}',TESSERA_CAPTURE_PROJECT='project',TESSERA_WORKER_TOKEN='fixture')
   capture=module.Capture();capture.running();f=flow();capture.requestheaders(f);f.request.stream(b'original');capture.request(f)
   deadline=time.time()+5
   while len(received)<2 and time.time()<deadline:time.sleep(.02)
   capture.done();self.assertIn(b'original',[bytes(value) for value in bodies.values()]);self.assertEqual(len(received),2);self.assertEqual(received[-1]['records'][0]['id'],'flow1');self.assertEqual(list((Path(root)/'spool').glob('*.json')),[])
  server.shutdown();server.server_close()
 def test_uploader_sends_up_to_eight_records_per_request_and_drains_more_batches(self):
  batches=[]
  class Handler(BaseHTTPRequestHandler):
   def do_POST(self):
    data=json.loads(self.rfile.read(int(self.headers['content-length'])))
    if not self.path.endswith('/status'):batches.append([record['id'] for record in data['records']])
    self.send_response(200);self.end_headers();self.wfile.write(b'{}')
   def log_message(self,*args):pass
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  with tempfile.TemporaryDirectory(prefix='tessera-proxy-batch-') as root:
   os.environ.update(TESSERA_PROXY_DIR=root,TESSERA_CAPTURE_SERVER=f'http://127.0.0.1:{server.server_port}',TESSERA_CAPTURE_PROJECT='project',TESSERA_WORKER_TOKEN='fixture')
   capture=module.Capture()
   # 先把 10 条记录落进 spool，再启动上传线程，才能确定性地验证一轮里连续发送多批。
   spool=Path(root)/'spool';spool.mkdir(parents=True,exist_ok=True)
   for index in range(10):(spool/f'{index:04d}.json').write_text(json.dumps({'id':f'flow-{index}'}),encoding='utf-8')
   capture.running()
   deadline=time.time()+5
   while (len(batches)<2 or list((Path(root)/'spool').glob('*.json'))) and time.time()<deadline:time.sleep(.02)
   capture.done()
   self.assertEqual([len(batch) for batch in batches],[8,2])
   self.assertEqual(sorted(record for batch in batches for record in batch),[f'flow-{index}' for index in range(10)])
   self.assertEqual(list((Path(root)/'spool').glob('*.json')),[])
  server.shutdown();server.server_close()
if __name__=='__main__':unittest.main()
