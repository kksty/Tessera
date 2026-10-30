"""Start an explicit HTTP/HTTPS recorder; other protocols retain their original route."""
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from importlib.util import spec_from_file_location,module_from_spec

job=json.loads(base64.b64decode(os.environ['TESSERA_JOB']))
config=json.loads(base64.b64decode(os.environ['TESSERA_RUN_CONFIG']))
if job['kind'] not in ('execute','peer'):os.execvp('node',['node','/opt/tessera/dist/runner.mjs'])
root=Path('/var/lib/tessera-proxy');control=Path('/var/lib/tessera-capture')
root.mkdir(mode=0o700,exist_ok=True);control.mkdir(mode=0o700,exist_ok=True)
os.environ.update(TESSERA_PROXY_DIR=str(root),TESSERA_CAPTURE_SERVER=config['server'],TESSERA_CAPTURE_PROJECT=job['project_id'])
spec=spec_from_file_location('capture_guard','/opt/tessera/traffic/traffic-guard.py');guard=module_from_spec(spec);spec.loader.exec_module(guard)
if not config.get('capture_enabled', True):
    # A previous Run may have left the recorder running in this worker container.
    for file in (root/'pid',control/'guard-pid',control/'upstream-pid',control/'network-pid'):
        try:os.kill(int(file.read_text()),signal.SIGTERM)
        except (OSError,ValueError):pass
    try:guard.bypass()
    except Exception:pass
    os.execvp('node',['node','/opt/tessera/dist/runner.mjs'])
items=guard.endpoints(config)
spec=spec_from_file_location('routing','/opt/tessera/traffic/traffic-routing.py');routing=module_from_spec(spec);spec.loader.exec_module(routing)
original_env=dict(os.environ)
upstream=os.environ.get('TESSERA_CAPTURE_UPSTREAM','')
os.environ['TESSERA_PROXY_BYPASS']=json.dumps(items)
os.environ['TESSERA_PROXY_EXCLUDE']=''
ca=root/'mitmproxy-ca-cert.pem'
def alive(file,port=None,marker=None):
    try:
        pid=int(file.read_text())
        # 僵尸进程仍然响应 os.kill(pid,0)，但已经不工作了；同时用 cmdline 排除 pid 复用。
        if Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0]=='Z':return False
        if marker and marker not in Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8','replace'):return False
        os.kill(pid,0)
    except (OSError,ValueError,IndexError):return False
    if port:
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=.3):pass
        except OSError:return False
    return True

def stop(file):
    if file.exists():
        try:os.kill(int(file.read_text()),signal.SIGTERM)
        except (OSError,ValueError):pass

def reap(file,wait=3):
    """收掉旧采集子进程：先 SIGTERM，仍未退出就 SIGKILL。僵尸进程会直接判定为已退出。"""
    if not file.exists():return
    try:pid=int(file.read_text())
    except (OSError,ValueError):return
    for number in [signal.SIGTERM,signal.SIGKILL]:
        try:os.kill(pid,number)
        except OSError:return
        deadline=time.time()+wait
        while time.time()<deadline:
            try:state=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0]
            except (OSError,IndexError):return
            if state=='Z':return
            time.sleep(.1)

def status(state,error=None):
    url=config['server'].rstrip('/')+'/api/projects/'+job['project_id']+'/traffic/status'
    data={'state':state,'guard':False,**({'error':str(error)[:2000]} if error else {})}
    req=urllib.request.Request(url,json.dumps(data).encode(),{'content-type':'application/json','x-tessera-project-token':os.environ.get('TESSERA_PROJECT_TOKEN') or os.environ.get('TESSERA_WORKER_TOKEN','')})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=3):pass
try:
    with (control/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        # Previous capture losses remain visible, but never block a new task.
        account=pwd.getpwnam('tessera-proxy')
        os.chown(root,account.pw_uid,account.pw_gid)
        spool=root/'spool';spool.mkdir(mode=0o700,exist_ok=True);os.chown(spool,account.pw_uid,account.pw_gid)
        scan=pwd.getpwnam('tessera-scan');os.chown(control,0,scan.pw_gid);control.chmod(0o750)
        tls_max=routing.tls_max_version(os.environ.get('TESSERA_CAPTURE_TLS_MAX'))
        signature=hashlib.sha256(json.dumps(['explicit-http-v1',config['server'],items,upstream,tls_max,os.environ.get('TESSERA_PROJECT_TOKEN') or os.environ.get('TESSERA_WORKER_TOKEN','')]).encode()).hexdigest()
        same=(control/'signature').exists() and (control/'signature').read_text()==signature
        if not same:
            reap(control/'guard-pid');reap(root/'pid');reap(control/'upstream-pid');reap(control/'network-pid')
            (control/'ready').unlink(missing_ok=True)
            (control/'network-ready').unlink(missing_ok=True)
            for _ in range(50):
                if not alive(root/'pid',8081):break
                time.sleep(.1)
        # Clean up legacy transparent routing and packet observers before using explicit HTTP.
        guard.bypass()
        reap(control/'network-pid')
        (control/'config.json').write_text(json.dumps(config));(control/'config.json').chmod(0o600)
        if not alive(control/'guard-pid',marker='traffic-guard.py'):
            with (control/'guard.log').open('ab') as log:
                process=subprocess.Popen(['python3','/opt/tessera/traffic/traffic-guard.py'],stdout=log,stderr=log,start_new_session=True)
            (control/'guard-pid').write_text(str(process.pid))
        if not alive(root/'pid',8081,marker='mitmdump'):
            patterns=[]
            for endpoint in items:
                host=re.escape(endpoint['host']);patterns.append(f'{host}:{endpoint["port"]}')
            mode=routing.upstream_mode(upstream)
            if upstream.startswith('socks5://'):
                reap(control/'upstream-pid')
                with (control/'upstream.log').open('ab') as log:
                    bridge=subprocess.Popen(['setpriv','--reuid',str(account.pw_uid),'--regid',str(account.pw_gid),'--clear-groups','python3','/opt/tessera/traffic/traffic-socks.py'],stdout=log,stderr=log,start_new_session=True)
                (control/'upstream-pid').write_text(str(bridge.pid))
            args=['setpriv','--reuid',str(account.pw_uid),'--regid',str(account.pw_gid),'--clear-groups','mitmdump','--mode',mode,'--set','rawtcp=false','--set',f'confdir={root}','--set','block_global=false','--set','flow_detail=0','--set','termlog_verbosity=error','--set','tls_version_server_min=TLS1_2','--set',f'tls_version_server_max={tls_max}','--ignore-hosts','^('+'|'.join(patterns)+')$', '-s','/opt/tessera/traffic/traffic-addon.py']
            parsed=urllib.parse.urlsplit(upstream)
            if parsed.scheme in ('http','https') and parsed.username is not None:
                args.extend(['--set','upstream_auth='+urllib.parse.unquote(parsed.username)+':'+urllib.parse.unquote(parsed.password or '')])
            with (root/'proxy.log').open('ab') as log:process=subprocess.Popen(args,stdout=log,stderr=log,start_new_session=True)
            (root/'pid').write_text(str(process.pid))
        for _ in range(100):
            if ca.exists() and alive(root/'pid',8081):break
            time.sleep(.1)
        if not ca.exists() or not alive(root/'pid',8081):raise RuntimeError('项目 HTTPS 采集代理启动失败，测试将继续，但流量记录可能缺失。')
        bundle=root/'ca-bundle.pem'
        system_ca=Path('/usr/local/share/ca-certificates/tessera-project.crt')
        if not system_ca.exists() or system_ca.read_bytes()!=ca.read_bytes():
            system_ca.write_bytes(ca.read_bytes());subprocess.run(['update-ca-certificates'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        bundle.write_bytes(Path('/etc/ssl/certs/ca-certificates.crt').read_bytes())
        nss=Path.home()/'.pki/nssdb';nss.mkdir(parents=True,exist_ok=True)
        if not (nss/'cert9.db').exists():subprocess.run(['certutil','-N','-d',f'sql:{nss}','--empty-password'],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['certutil','-A','-d',f'sql:{nss}','-n','Tessera project CA','-t','C,,','-i',str(ca)],check=True,stdout=subprocess.DEVNULL)
        # Remove the old mandatory Chromium policy; explicit browser settings remain user-owned.
        for folder in ['/etc/chromium/policies/managed','/etc/opt/chrome/policies/managed']:
            (Path(folder)/'tessera-capture.json').unlink(missing_ok=True)
        (control/'signature').write_text(signature)
        run=job.get('run_id') or job['worker'];step=job.get('step_id') or job.get('peer_id') or 'unknown'
        routing.configure(os.environ,items,run,step,bundle)
        status('active')
except Exception as error:
    try:status('unavailable',error)
    except Exception:pass
    try:guard.bypass()
    except Exception:pass
    stop(control/'guard-pid')
    os.environ.clear();os.environ.update(original_env)
    print('Capture unavailable; task continues: '+str(error),file=sys.stderr)
os.execvp('node',['node','/opt/tessera/dist/runner.mjs'])
