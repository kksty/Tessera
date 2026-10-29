"""Opaque non-HTTP TLS protocols with an explicit ALPN pass through without decryption.

Without ALPN, TLS must be terminated before HTTP can be distinguished from other TLS payloads.
Only traffic-addon HTTP hooks persist data; generic TCP and TLS streams are never archived.
"""


def tls_clienthello(data):
    protocols = data.client_hello.alpn_protocols
    if protocols and not any(value in (b'h2', b'http/1.1', b'http/1.0') for value in protocols):
        data.ignore_connection = True
