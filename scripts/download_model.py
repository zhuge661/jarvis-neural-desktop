"""Download the public Vosk Chinese model, without reading any user data."""
import hashlib
from pathlib import Path
from urllib.request import urlopen
import zipfile

ROOT=Path(__file__).resolve().parents[1]
URL='https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip'
SHA256='3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba'
def download():
    cache=ROOT/'.cache';cache.mkdir(exist_ok=True)
    archive=cache/'vosk-model-small-cn-0.22.zip'
    if not archive.exists():
        temporary=archive.with_suffix('.download')
        with urlopen(URL,timeout=90) as response,temporary.open('wb') as out:
            while chunk:=response.read(1024*1024):out.write(chunk)
        temporary.replace(archive)
    assert hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()==SHA256,'Model SHA256 mismatch'
    destination=ROOT/'app/backend/语音模型';destination.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            target=destination/info.filename
            assert target.resolve().is_relative_to(destination.resolve()),'Invalid archive path'
        z.extractall(destination)
    print('Public Vosk model downloaded and verified.')
    return destination/'vosk-model-small-cn-0.22'
if __name__=='__main__':download()
