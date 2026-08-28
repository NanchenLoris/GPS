#!/usr/bin/env python3
"""Serve this folder over HTTPS on the LAN.

Phone motion/orientation sensors only fire in a "secure context", so plain
http://<your-ip> will not work from a phone. This starts an HTTPS server with a
self-signed certificate; accept the browser warning once on the phone.

    python serve.py            # https://0.0.0.0:8443
    python serve.py 9000       # custom port

Needs the `cryptography` package for cert generation:  pip install cryptography
(Alternatively deploy the folder to GitHub Pages / Netlify, or use a tunnel such
as `cloudflared tunnel --url http://localhost:8443`.)
"""
import datetime
import http.server
import ipaddress
import shutil
import socket
import ssl
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CERT = HERE / ".devcert.pem"
KEY = HERE / ".devkey.pem"


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def make_cert_openssl() -> bool:
    exe = shutil.which("openssl")
    if not exe:
        return False
    ip = local_ip()
    cmd = [
        exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(KEY), "-out", str(CERT), "-days", "825",
        "-subj", "/CN=deadreckon-dev",
        "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"generated {CERT.name} / {KEY.name} via openssl")
        return True
    except (subprocess.CalledProcessError, OSError):
        return False


def ensure_cert() -> bool:
    """Return True if an HTTPS cert is available, False to fall back to HTTP."""
    if CERT.exists() and KEY.exists():
        return True
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        if make_cert_openssl():
            return True
        print(
            "No HTTPS cert: install `cryptography` (pip install cryptography) or\n"
            "openssl for a self-signed cert. Falling back to plain HTTP — sensors\n"
            "will only work on http://localhost (desktop) or via a tunnel.\n"
        )
        return False

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "deadreckon-dev")])
    alt = x509.SubjectAlternativeName([
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.IPAddress(ipaddress.ip_address(local_ip())),
    ])
    now = datetime.datetime.utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(alt, critical=False)
        .sign(key, hashes.SHA256())
    )
    KEY.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"generated {CERT.name} / {KEY.name}")
    return True


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    https = ensure_cert()

    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(HERE), **k)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)

    scheme = "http"
    if https:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(CERT), keyfile=str(KEY))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    ip = local_ip()
    note = "(accept the cert warning)" if https else "(sensors need HTTPS — use a tunnel)"
    print(f"serving {HERE}")
    print(f"  on this machine : {scheme}://localhost:{port}/")
    print(f"  from your phone : {scheme}://{ip}:{port}/   {note}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
