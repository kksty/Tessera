"""Trust the project's public CA and launch a job. Routing lives outside this container."""
import base64
import fcntl
from importlib.util import spec_from_file_location, module_from_spec
import json
import os
from pathlib import Path
import subprocess

job = json.loads(base64.b64decode(os.environ['TESSERA_JOB']))
config = json.loads(base64.b64decode(os.environ['TESSERA_RUN_CONFIG']))
gateway = os.environ['TESSERA_GATEWAY_IP']
# Avoid the embedded Docker resolver's external-forwarding restriction on internal networks.
Path('/etc/resolv.conf').write_text(f'nameserver {gateway}\noptions timeout:2 attempts:2\n')
if config.get('capture_enabled', True):
    ca = Path('/etc/tessera-ca/project-ca.crt')
    if not ca.exists(): raise RuntimeError('Project gateway CA is unavailable; refusing to start a Run')
    with open('/tmp/tessera-ca.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        system = Path('/usr/local/share/ca-certificates/tessera-project.crt')
        if not system.exists() or system.read_bytes() != ca.read_bytes():
            system.write_bytes(ca.read_bytes())
            subprocess.run(['update-ca-certificates'], check=True, stdout=subprocess.DEVNULL)
            nss = Path.home()/'.pki/nssdb'; nss.mkdir(parents=True, exist_ok=True)
            if not (nss/'cert9.db').exists():
                subprocess.run(['certutil', '-N', '-d', f'sql:{nss}', '--empty-password'], check=True)
            subprocess.run(['certutil', '-A', '-d', f'sql:{nss}', '-n', 'Tessera project CA', '-t', 'C,,', '-i', str(ca)], check=True)
    bundle = '/etc/ssl/certs/ca-certificates.crt'
    for name in ('SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'):
        os.environ.setdefault(name, bundle)
    if job['kind'] in ('execute', 'peer'):
        spec = spec_from_file_location('routing', '/opt/tessera/traffic/traffic-routing.py')
        routing = module_from_spec(spec); spec.loader.exec_module(routing)
        from urllib.parse import urlsplit
        server = urlsplit(config['server'])
        routing.configure(os.environ, [{'host': server.hostname}], job.get('run_id') or job['worker'],
                          job.get('step_id') or job.get('peer_id') or 'unknown', bundle, proxy_host=gateway)
os.execvp('node', ['node', '/opt/tessera/dist/runner.mjs'])
