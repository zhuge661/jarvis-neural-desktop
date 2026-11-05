"""Reject truncated, mono, or substituted background music before packaging."""
import hashlib
from pathlib import Path
import wave

ROOT = Path(__file__).resolve().parents[1]
BGM = ROOT / 'app/backend/JARVIS-main/ui/audio/bgm/supercluster-first-48s.wav'
EXPECTED_SHA256 = 'a05ab122a4e9b662018b33a50f492783593089ae903ffabbfc1517b725d202d7'


def check_bgm(path=BGM):
    with wave.open(str(path), 'rb') as audio:
        actual = (audio.getframerate(), audio.getnchannels(),
                  audio.getsampwidth(), audio.getnframes(), audio.getcomptype())
    expected = (48000, 2, 2, 2304000, 'NONE')
    if actual != expected:
        raise ValueError(f'Background music must be 48s, 48kHz, stereo PCM16: {actual}')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if digest != EXPECTED_SHA256:
        raise ValueError(f'Background music differs from the approved original: {digest}')
    print('Background music: original SHA256 verified; 48s, 48kHz, stereo PCM16.')


if __name__ == '__main__':
    check_bgm()
