"""Monitor the explicit HTTP recorder. Never install transparent routing rules."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path('/var/lib/tessera-proxy')
CONTROL = Path('/var/lib/tessera-capture')
CHAIN = 'TESSERA_CAPTURE'

def endpoints(config):
    from urllib.parse import urlsplit
    result=[]
    for url in [config['server'],config['model']['base_url'],(config.get('review_model') or {}).get('base_url')]:
        if not url:continue
        u=urlsplit(url)
        if u.hostname:result.append({'host':u.hostname,'port':u.port or (443 if u.scheme=='https' else 80)})
    return result

def write_status(blocked,error=None):
    data={'blocked':0,'guard':False,**({'error':error} if error else {})}
    tmp=ROOT/'guard-status.tmp';tmp.write_text(json.dumps(data));tmp.chmod(0o644);tmp.replace(ROOT/'guard-status.json')

def stop_child(file):
    try:os.kill(int(file.read_text()),signal.SIGTERM)
    except (OSError,ValueError):pass

def alive(file, marker=None):
    try:
        pid=int(file.read_text())
    except (OSError,ValueError):return False
    try:
        state=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0]
        if state=='Z':return False
        if marker and marker not in Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8','replace'):return False
        os.kill(pid,0)
    except (OSError,ValueError,IndexError):return False
    return True

def bypass():
    """Detach only our routing/filter hooks; leave unrelated firewall rules alone."""
    for binary in ['iptables','ip6tables']:
        if not shutil.which(binary):continue
        for table in ['filter','nat']:
            for _ in range(8):
                result=subprocess.run([binary,'-w','-t',table,'-D','OUTPUT','-j',CHAIN],capture_output=True)
                if result.returncode:break
            subprocess.run([binary,'-w','-t',table,'-F',CHAIN],capture_output=True)

def report(config,error=None,dropped=0):
    try:
        data={'state':'degraded' if error else 'active','guard':False,'blocked':0,'dropped':dropped,**({'error':error} if error else {})}
        req=urllib.request.Request(config['server'].rstrip('/')+'/api/projects/'+os.environ['TESSERA_CAPTURE_PROJECT']+'/traffic/status',json.dumps(data).encode(),{'content-type':'application/json','x-tessera-project-token':os.environ.get('TESSERA_PROJECT_TOKEN') or os.environ.get('TESSERA_WORKER_TOKEN','')})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=3):pass
    except (OSError,ValueError,KeyError):pass

def main():
    config=json.loads((CONTROL/'config.json').read_text())
    bypass()
    (CONTROL/'ready').write_text('ready')
    while True:
        time.sleep(2)
        error=None;dropped=0
        if not alive(ROOT/'pid',marker='mitmdump'):
            error='HTTP 录制代理不可用；显式接入的客户端可能连接失败，可使用原代理或直连，采集不会自动重试请求。'
        loss=ROOT/'capture-loss.json'
        if loss.exists():
            try:
                data=json.loads(loss.read_text());dropped=data.get('dropped',0)
                error=error or data.get('error','部分流量记录未能保存。')
            except (OSError,ValueError):error=error or '采集记录状态不可读；测试继续。'
        write_status(0,error);report(config,error,dropped)

if __name__=='__main__':
    def shutdown(*_):
        bypass();stop_child(ROOT/'pid');stop_child(CONTROL/'upstream-pid');stop_child(CONTROL/'network-pid')
        (CONTROL/'ready').unlink(missing_ok=True)
        raise SystemExit(0)
    signal.signal(signal.SIGTERM,shutdown);signal.signal(signal.SIGINT,shutdown)
    try:main()
    finally:
        bypass();(CONTROL/'ready').unlink(missing_ok=True)
