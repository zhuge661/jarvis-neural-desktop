"""Fetch only public upstream runtimes. Never package the build workspace."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import urllib.request

CACHE = Path(__file__).resolve().parents[1] / '.cache'
URLS = [
    'https://github.com/electron/electron/releases/download/v45.2.1/electron-v45.2.1-darwin-arm64.zip',
    'https://github.com/electron/electron/releases/download/v45.2.1/electron-v45.2.1-darwin-x64.zip',
    'https://github.com/electron/electron/releases/download/v45.2.1/SHASUMS256.txt',
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz',
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-x86_64-apple-darwin-install_only_stripped.tar.gz',
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/SHA256SUMS',
]

def fetch(url):
    CACHE.mkdir(exist_ok=True)
    target = CACHE / url.rsplit('/',1)[-1]
    if not target.exists():
        temporary = target.with_name(target.name+'.download')
        print('Downloading '+target.name,flush=True)
        with urllib.request.urlopen(url,timeout=90) as r, temporary.open('wb') as out:
            while block:=r.read(1024*1024): out.write(block)
        temporary.replace(target)
    print(target.name+' '+str(target.stat().st_size),flush=True)
    return target

if __name__=='__main__':
    with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(fetch,URLS))
    sums={line.split()[-1].lstrip('*'):line.split()[0] for line in (CACHE/'SHASUMS256.txt').read_text().splitlines() if line.strip()}
    for arch in ('arm64','x64'):
        path=CACHE/f'electron-v45.2.1-darwin-{arch}.zip'
        assert hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==sums[path.name]
    python_sums={line.split()[-1].lstrip('*'):line.split()[0] for line in (CACHE/'SHA256SUMS').read_text().splitlines() if line.strip()}
    for path in CACHE.glob('cpython-*.tar.gz'):
        assert hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==python_sums[path.name]
    print('Upstream Electron and Python SHA256 verified.',flush=True)
