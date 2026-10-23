import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[2] / 'docker/traffic' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


routing = load('traffic-routing')
guard = load('traffic-guard')


class RoutingTests(unittest.TestCase):
    def test_only_http_proxy_variables_are_injected(self):
        env = {'NO_PROXY': 'private.test', 'SSL_CERT_FILE': '/custom/ca.pem'}
        self.assertTrue(routing.configure(env, [{'host': 'model.test'}], 'run:a', 'step b', '/ca.pem'))
        self.assertEqual(env['https_proxy'], 'http://run%3Aa:step%20b@127.0.0.1:8081')
        self.assertEqual(env['NO_PROXY'], 'private.test,model.test')
        self.assertEqual(env['SSL_CERT_FILE'], '/custom/ca.pem')
        for name in ('LD_PRELOAD', 'PROXYCHAINS_CONF_FILE', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'):
            self.assertNotIn(name, env)

    def test_existing_proxy_or_preload_is_preserved(self):
        for key in (*routing.PROXIES, 'LD_PRELOAD', 'PROXYCHAINS_CONF_FILE'):
            env = {key: 'user-value'}
            self.assertFalse(routing.configure(env, [], 'run', 'step', '/ca.pem'))
            self.assertEqual(env, {key: 'user-value'})

    def test_explicit_bypass_preserves_pinning_and_mtls_route(self):
        env = {'TESSERA_CAPTURE_BYPASS': 'pinned.test,mtls.test'}
        routing.configure(env, [], 'run', 'step', '/ca.pem')
        self.assertEqual(env['no_proxy'], 'pinned.test,mtls.test')

    def test_upstreams_use_explicit_http_listener(self):
        self.assertEqual(routing.upstream_mode(''), 'regular@127.0.0.1:8081')
        self.assertEqual(routing.upstream_mode('http://user:pass@proxy.test:3128'), 'upstream:http://proxy.test:3128@127.0.0.1:8081')
        self.assertEqual(routing.upstream_mode('socks5://proxy.test:1080'), 'upstream:http://127.0.0.1:8083@127.0.0.1:8081')
        self.assertEqual(routing.upstream_mode('https://[::1]:8443'), 'upstream:https://[::1]:8443@127.0.0.1:8081')
        for url in ('ftp://proxy:21', 'http://proxy', 'socks5://proxy:1080/path'):
            with self.assertRaises(ValueError): routing.upstream_mode(url)

    def test_legacy_cleanup_only_detaches_our_chains(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return types.SimpleNamespace(returncode=1)
        with patch.object(guard.shutil, 'which', side_effect=lambda name: name), patch.object(guard.subprocess, 'run', side_effect=run):
            guard.bypass()
        self.assertEqual(len(calls), 8)
        self.assertTrue(all(args[-1] == 'TESSERA_CAPTURE' for args in calls))
        self.assertTrue(all('-D' in args or '-F' in args for args in calls))

    def test_internal_endpoints_are_excluded(self):
        self.assertEqual(guard.endpoints({'server':'http://server:8000','model':{'base_url':'https://model/v1'}}),
                         [{'host':'server','port':8000},{'host':'model','port':443}])


if __name__ == '__main__':
    unittest.main()
