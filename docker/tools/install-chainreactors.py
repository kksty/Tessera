"""Install pinned upstream Linux binaries; no target operations or runtime downloads."""
import hashlib
import json
import os
import platform
from concurrent.futures import ThreadPoolExecutor
import tempfile
import time
import urllib.request
from pathlib import Path


# Optional GitHub-release prefix for networks where github.com is unreachable
# from the container. The pinned SHA-256 below is still checked after download.
PROXY = os.environ.get("CHAINREACTORS_PROXY", "").strip().rstrip("/")


def source(url: str) -> str:
    return f"{PROXY}/{url}" if PROXY else url


def download(asset):
    # Official release assets support byte ranges. Bound both concurrency and memory;
    # the complete pinned hash is still checked before installing any executable.
    size = asset["size"]
    count = min(8, max(1, (size + 1024 * 1024 - 1) // (1024 * 1024)))

    def part(index):
        start, end = size * index // count, size * (index + 1) // count - 1
        request = urllib.request.Request(source(asset["url"]), headers={
            "User-Agent": "tessera-worker-build", "Range": f"bytes={start}-{end}",
        })
        with urllib.request.urlopen(request, timeout=120) as response:
            expected = f"bytes {start}-{end}/{size}"
            if response.status != 206 or response.headers.get("Content-Range") != expected:
                raise RuntimeError("Unexpected release asset byte range")
            data = response.read(end - start + 2)
        if len(data) != end - start + 1:
            raise RuntimeError("Incomplete release asset byte range")
        return data

    with ThreadPoolExecutor(max_workers=count) as pool:
        return b"".join(pool.map(part, range(count)))


def install():
    manifest = json.loads(Path(__file__).with_name("chainreactors.lock.json").read_text())
    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if arch is None:
        raise RuntimeError(f"Unsupported worker architecture: {platform.machine()}")
    destination = Path("/usr/local/bin")
    for name, release in manifest.items():
        asset = release["assets"][arch]
        for attempt in range(3):
            try:
                data = download(asset)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2)
        digest = hashlib.sha256(data).hexdigest()
        if digest != asset["sha256"]:
            raise RuntimeError(f"SHA-256 mismatch for {name} {release['version']} {arch}")
        with tempfile.NamedTemporaryFile(dir=destination, delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
        try:
            temporary.chmod(0o755)
            os.replace(temporary, destination / name)
        finally:
            temporary.unlink(missing_ok=True)
        print(f"Installed {name} {release['version']} linux/{arch} sha256:{digest}", flush=True)


if __name__ == "__main__":
    install()
