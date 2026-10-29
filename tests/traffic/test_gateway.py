import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[2]/'docker/traffic'/f'{name}.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


gateway = load('gateway')
protocols = load('gateway-protocols')


class GatewayTests(unittest.TestCase):
    def test_callbacks_are_dnat_and_reply_direction_is_not_intercepted(self):
        config = gateway.rules('172.20.0.2', '172.20.0.3', 'eth1', 'eth0',
                               [{'protocol': 'tcp', 'worker_port': 20000}, {'protocol': 'udp', 'worker_port': 20000}],
                               [('172.19.0.2', 8000)], True)
        self.assertIn('-i eth0 -p tcp --dport 20000 -j DNAT --to-destination 172.20.0.3:20000', config)
        self.assertIn('-i eth0 -p udp --dport 20000 -j DNAT --to-destination 172.20.0.3:20000', config)
        self.assertIn('--ctdir ORIGINAL -j REDIRECT', config)
        self.assertIn(':INPUT DROP', config)
        self.assertIn(':FORWARD DROP', config)
        self.assertLess(config.index('-d 172.19.0.2'), config.index('-j REDIRECT'))
        self.assertNotIn('--dport 443 -j REDIRECT', config, 'custom HTTP ports must also be intercepted')

    def test_capture_disabled_keeps_callbacks_routing_and_dns(self):
        config = gateway.rules('172.20.0.2', '172.20.0.3', 'eth1', 'eth0', [], [], False)
        self.assertNotIn('REDIRECT', config)
        self.assertNotIn('REJECT', config)
        self.assertIn('MASQUERADE', config)
        self.assertIn('--dport 53', config)

    def test_explicit_non_http_tls_alpn_remains_opaque(self):
        for alpn, ignored in [([b'h2'], False), ([b'http/1.1'], False), ([b'mqtt'], True), ([], False)]:
            data = SimpleNamespace(client_hello=SimpleNamespace(alpn_protocols=alpn), ignore_connection=False)
            protocols.tls_clienthello(data)
            self.assertEqual(data.ignore_connection, ignored)


if __name__ == '__main__': unittest.main()
