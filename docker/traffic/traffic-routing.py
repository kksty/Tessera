"""Explicit HTTP recorder routing; never intercept arbitrary TCP or replace user proxies."""
from urllib.parse import quote, urlsplit

PROXIES = ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY')
TLS_MAX_VALUES = ('TLS1_2', 'TLS1_3', 'UNBOUNDED')


def tls_max_version(value):
    """Upstream TLS ceiling; TLS 1.2 is the compatibility default for legacy sites."""
    version = (value or 'TLS1_2').strip().upper()
    if version not in TLS_MAX_VALUES:
        raise ValueError('TESSERA_CAPTURE_TLS_MAX must be TLS1_2, TLS1_3 or UNBOUNDED')
    return version


def upstream_mode(value):
    if not value:
        return 'regular@127.0.0.1:8081'
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https', 'socks5') or not parsed.hostname or not parsed.port:
        raise ValueError('TESSERA_CAPTURE_UPSTREAM requires http/https/socks5://host:port')
    if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('Upstream proxy URL must not contain a path, query or fragment')
    if parsed.scheme == 'socks5':
        return 'upstream:http://127.0.0.1:8083@127.0.0.1:8081'
    # Authentication is passed separately, not embedded in mitmproxy mode syntax.
    host = f'[{parsed.hostname}]' if ':' in parsed.hostname else parsed.hostname
    return f'upstream:{parsed.scheme}://{host}:{parsed.port}@127.0.0.1:8081'


def configure(env, items, run, step, bundle, proxy_host='127.0.0.1'):
    """Return whether automatic routing was installed. Existing proxy/preload settings win."""
    if any(env.get(name) for name in (*PROXIES, 'LD_PRELOAD', 'PROXYCHAINS_CONF_FILE')):
        return False
    proxy = f'http://{quote(run, safe="")}:{quote(step, safe="")}@{proxy_host}:8081'
    env['TESSERA_CAPTURE_PROXY_URL'] = proxy
    for name in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'):
        env[name] = proxy
    # Preserve user bypasses. Hosts (rather than ports) are portable across HTTP clients.
    bypass = ','.join(filter(None, [env.get('no_proxy', ''), env.get('NO_PROXY', ''),
                                    ','.join(item['host'] for item in items),
                                    env.get('TESSERA_CAPTURE_BYPASS', '')]))
    env['no_proxy'] = env['NO_PROXY'] = bypass
    for name in ('SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'):
        env.setdefault(name, str(bundle))
    return True
