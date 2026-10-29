"""Manage exactly one same-bridge forwarding rule. Never flush host tables or change policies."""
import re
import subprocess
import sys

bridge, operation = sys.argv[1:]
if not re.fullmatch(r'ts[0-9a-f]{12}', bridge) or operation not in ('install', 'remove'):
    raise ValueError('Invalid managed bridge operation')
rule = ['-i', bridge, '-o', bridge, '-m', 'comment', '--comment', 'tessera-project-bridge', '-j', 'ACCEPT']
base = ['iptables', '-w', '10']
# Fail closed on unsupported firewall backends, rather than creating a misleading unused chain.
subprocess.run(base + ['-S', 'DOCKER-USER'], check=True, stdout=subprocess.DEVNULL)
present = subprocess.run(base + ['-C', 'DOCKER-USER'] + rule, capture_output=True).returncode == 0
if operation == 'install' and not present:
    subprocess.run(base + ['-I', 'DOCKER-USER', '1'] + rule, check=True)
elif operation == 'remove' and present:
    subprocess.run(base + ['-D', 'DOCKER-USER'] + rule, check=True)
