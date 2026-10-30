"""Project router: isolated downlink, transparent TCP capture and explicit callback DNAT.

Only this trusted container has NET_ADMIN. No route or private CA is shared with a Worker.
The iptables policy lives in gateway_rules.py; this module only supervises the processes
and installs that policy.
"""
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import time
from importlib.util import module_from_spec, spec_from_file_location
from urllib.parse import urlsplit

ROOT = Path('/var/lib/tessera-proxy')
PUBLIC = Path('/public-ca')


def _load_rules():
    """Import the sibling rules module by path so it also works outside a package import."""
    spec = spec_from_file_location('gateway_rules', Path(__file__).with_name('gateway_rules.py'))
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rules_module = _load_rules()
conntrack_status = rules_module.conntrack_status
interfaces = rules_module.interfaces
rules = rules_module.rules
run = rules_module.run


def main():
    gateway = str(ipaddress.IPv4Address(os.environ['TESSERA_GATEWAY_IP']))
    worker = str(ipaddress.IPv4Address(os.environ['TESSERA_WORKER_IP']))
    down, up = interfaces(gateway)
    if not all(re.fullmatch(r'[a-zA-Z0-9_.-]+', value) for value in [down, up]):
        raise ValueError('Invalid network interface')
    capture = os.environ.get('TESSERA_CAPTURE_ENABLED', '1') == '1'
    ingress = json.loads(os.environ.get('TESSERA_INGRESS', '[]'))
    for entry in ingress:
        if entry['protocol'] not in ('tcp', 'udp') or not isinstance(entry['worker_port'], int) or not 1 <= entry['worker_port'] <= 65535:
            raise ValueError('Invalid callback mapping')
    server = urlsplit(os.environ['TESSERA_CAPTURE_SERVER'])
    control = [(item[4][0], server.port or (443 if server.scheme == 'https' else 80))
               for item in socket.getaddrinfo(server.hostname, None, socket.AF_INET, socket.SOCK_STREAM)]
    ROOT.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (ROOT/'ready').unlink(missing_ok=True)
    # No worker is routed here until startup succeeds. On restart, atomically restore capture,
    # never install a temporary direct-forwarding window.
    subprocess.run(['iptables-restore', '-w', '--noflush'], input=rules(gateway, worker, down, up, ingress, control, capture), text=True, check=True)
    # Install NAT before enabling forwarding. Repeated startup never duplicates hooks.
    for table, chain in [('nat', 'PREROUTING'), ('nat', 'POSTROUTING'), ('filter', 'INPUT'), ('filter', 'FORWARD')]:
        if subprocess.run(['iptables', '-w', '-t', table, '-C', chain, '-j', f'TESSERA_{chain}'], capture_output=True).returncode:
            run('iptables', '-w', '-t', table, '-I', chain, '1', '-j', f'TESSERA_{chain}')
    os.environ['TESSERA_PROXY_DIR'] = str(ROOT)
    os.environ['TESSERA_PROXY_BYPASS'] = json.dumps([{'host': server.hostname, 'port': control[0][1]}])
    children = []
    def shutdown(*_):
        (ROOT/'ready').unlink(missing_ok=True)
        for child in children:
            child.terminate()
        for child in children:
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    dns = subprocess.Popen(['dnsmasq', '--keep-in-foreground', '--conf-file=/dev/null', '--no-resolv',
                            '--server=127.0.0.11', f'--listen-address={gateway}', '--bind-interfaces', '--user=root'])
    children.append(dns)
    if capture:
        tls_max = os.environ.get('TESSERA_CAPTURE_TLS_MAX') or 'UNBOUNDED'
        if tls_max not in ('TLS1_2', 'TLS1_3', 'UNBOUNDED'):
            raise ValueError('Invalid TLS ceiling')
        proxy = subprocess.Popen(['mitmdump', '--mode', f'transparent@{gateway}:8080',
            '--mode', f'regular@{gateway}:8081', '--set', f'confdir={ROOT}', '--set', 'block_global=false',
            '--set', 'connection_strategy=eager', '--set', 'rawtcp=true', '--set', 'flow_detail=0',
            '--set', 'termlog_verbosity=error', '--set', 'tls_version_server_min=TLS1_2',
            '--set', f'tls_version_server_max={tls_max}',
            '-s', '/opt/tessera/traffic/traffic-addon.py', '-s', '/opt/tessera/traffic/gateway-protocols.py'])
        children.append(proxy)
        for _ in range(100):
            if proxy.poll() is not None:
                raise RuntimeError('MITM exited during startup')
            try:
                with socket.create_connection((gateway, 8080), timeout=.2): pass
                ca = ROOT/'mitmproxy-ca-cert.pem'
                if ca.exists(): break
            except OSError: pass
            time.sleep(.1)
        else: raise RuntimeError('MITM failed to become ready')
        temp = PUBLIC/'project-ca.tmp'
        temp.write_bytes(ca.read_bytes()); temp.chmod(0o644); temp.replace(PUBLIC/'project-ca.crt')
    (ROOT/'guard-status.json').write_text(json.dumps({'guard': capture, 'blocked': 0, **conntrack_status()}))
    (ROOT/'ready').write_text('ready')
    while all(child.poll() is None for child in children):
        time.sleep(1)
    # Keep capture redirects installed. A stopped recorder can never turn into direct forwarding.
    (ROOT/'ready').unlink(missing_ok=True)
    for child in children:
        if child.poll() is None: child.terminate()
    raise RuntimeError('Gateway service exited; restarting without direct fallback')


if __name__ == '__main__':
    main()
