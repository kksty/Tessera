"""Pure routing helpers for the project router.

Interface discovery, conntrack reporting and the complete iptables transaction live
here as small, side-effect-light functions. The process supervisor in gateway.py owns
the lifecycle; this module owns the rules.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def conntrack_status():
    """The table limit is host-wide and /proc/sys is read-only in the container, so warn."""
    try:
        maximum = int(Path('/proc/sys/net/netfilter/nf_conntrack_max').read_text())
        count = int(Path('/proc/sys/net/netfilter/nf_conntrack_count').read_text())
    except (OSError, ValueError):
        return {}
    try:
        minimum = int(os.environ.get('TESSERA_CONNTRACK_MIN', '262144'))
    except ValueError:
        minimum = 262144
    if maximum < minimum:
        print(f'WARNING: nf_conntrack_max={maximum} < {minimum}; raise it on the Docker host: '
              f'sysctl -w net.netfilter.nf_conntrack_max={minimum}', file=sys.stderr)
    return {'conntrack_max': maximum, 'conntrack_count': count}


def interfaces(gateway):
    items = json.loads(run('ip', '-j', '-4', 'addr'))
    down = next(item['ifname'] for item in items if any(addr['local'] == gateway for addr in item['addr_info']))
    routes = json.loads(run('ip', '-j', '-4', 'route', 'show', 'default'))
    up = next(item['dev'] for item in routes if item['dev'] != down)
    return down, up


def rules(gateway, worker, down, up, ingress, control, capture):
    """Use a complete restore transaction in our own namespace; callback replies never enter capture."""
    lines = ['*filter', ':INPUT DROP [0:0]', ':FORWARD DROP [0:0]', ':OUTPUT ACCEPT [0:0]',
             '-A INPUT -i lo -j ACCEPT', '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
             f'-A INPUT -i {down} -s {worker} -p udp --dport 53 -j ACCEPT',
             f'-A INPUT -i {down} -s {worker} -p tcp -m multiport --dports 53,8080,8081 -j ACCEPT',
             f'-A INPUT -i {down} -s {worker} -p icmp -j ACCEPT',
             '-A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
             f'-A FORWARD -i {down} -s {worker} -o {up} -j ACCEPT']
    # Reject QUIC so HTTP/3-capable clients can fall back to captured HTTP/2 or HTTP/1.
    # Other UDP protocols remain untouched. This rule precedes the general allow.
    if capture:
        lines.insert(-1, f'-A FORWARD -i {down} -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable')
    for entry in ingress:
        lines.append(f'-A FORWARD -i {up} -o {down} -d {worker} -p {entry["protocol"]} --dport {entry["worker_port"]} -m conntrack --ctstate DNAT -j ACCEPT')
    lines += ['COMMIT', '*nat', ':PREROUTING ACCEPT [0:0]', ':INPUT ACCEPT [0:0]', ':OUTPUT ACCEPT [0:0]', ':POSTROUTING ACCEPT [0:0]']
    for entry in ingress:
        # Docker maps host_port to worker_port on the uplink first.
        lines.append(f'-A PREROUTING -i {up} -p {entry["protocol"]} --dport {entry["worker_port"]} -j DNAT --to-destination {worker}:{entry["worker_port"]}')
    # Requests to the router's own DNS and explicit proxy must not be redirected to transparent mode.
    lines.append(f'-A PREROUTING -i {down} -d {gateway} -j RETURN')
    for address, port in control:
        lines.append(f'-A PREROUTING -i {down} -d {address} -p tcp --dport {port} -j RETURN')
    if capture:
        lines.append(f'-A PREROUTING -i {down} -s {worker} -p tcp -m conntrack --ctdir ORIGINAL -j REDIRECT --to-ports 8080')
    # Keep callback return traffic symmetric, including peers on another Docker bridge.
    # Otherwise the host's own MASQUERADE can rewrite the source between our two NAT hops.
    lines += [f'-A POSTROUTING -o {down} -d {worker} -m conntrack --ctstate DNAT -j SNAT --to-source {gateway}',
              f'-A POSTROUTING -s {worker} -o {up} -j MASQUERADE', 'COMMIT', '']
    # Docker's embedded DNS owns OUTPUT/POSTROUTING rules too. Only replace our
    # chains; flushing the table silently breaks DNS after the initial lookup.
    output = []
    for line in lines:
        if line.startswith(':'):
            chain = line[1:].split()[0]
            if chain == 'OUTPUT' or chain == 'INPUT' and '*nat' in output:
                continue
            if chain in ('INPUT', 'FORWARD'):
                output.append(f':{chain} DROP [0:0]')
            output.extend([f':TESSERA_{chain} - [0:0]', f'-F TESSERA_{chain}'])
        elif line.startswith('-A '):
            output.append(line.replace('-A ', '-A TESSERA_', 1))
        else:
            output.append(line)
    return '\n'.join(output)
