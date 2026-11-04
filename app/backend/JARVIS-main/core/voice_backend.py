"""Project-local Vosk offline dictation + Microsoft Edge online neural TTS."""
import atexit
import asyncio
from collections import deque
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time

CORE = Path(__file__).resolve().parent
PROJECT = CORE.parents[1]
sys.path.insert(0, str(PROJECT / '语音依赖'))
VOICE = 'zh-CN-YunjianNeural'
_tts_slots = threading.BoundedSemaphore(2)


def synthesize(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 3000:
        raise ValueError('朗读内容须为 1–3000 字。')
    import edge_tts
    async def generate():
        chunks = []
        speech = edge_tts.Communicate(text, VOICE, rate='-8%', pitch='-8Hz',
                                     connect_timeout=10, receive_timeout=20)
        async for item in speech.stream():
            if item['type'] == 'audio':
                chunks.append(item['data'])
        return b''.join(chunks)
    if not _tts_slots.acquire(timeout=2):
        raise ValueError('语音正在合成，请稍后重试。')
    try:
        async def retry():
            for attempt in range(2):
                try:
                    return await asyncio.wait_for(generate(), timeout=25)
                except Exception:
                    if attempt:
                        raise
                    await asyncio.sleep(.6)
        result = asyncio.run(retry())
        if not result:
            raise RuntimeError('语音合成未返回音频。')
        return result
    finally:
        _tts_slots.release()


class Microphone:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.token = None
        self.events = deque(maxlen=100)
        self.sequence = 0
        self.last_seen = 0

    def _emit(self, event):
        with self.lock:
            self.sequence += 1
            self.events.append(dict(event, id=self.sequence))

    def start(self):
        with self.lock:
            if self.process and self.process.poll() is None:
                raise ValueError('语音已在其他页面开启，请先在原页面关闭，或稍后重试。')
            self.stop()
            self.events.clear()
            self.token = secrets.token_urlsafe(24)
            self.last_seen = time.monotonic()
            self.process = subprocess.Popen([
                sys.executable, '-B', '-X', 'utf8', '-u', str(CORE / 'speech_host.py')
            ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            process, token = self.process, self.token
            threading.Thread(target=self._read, args=(process, token), daemon=True).start()
            threading.Thread(target=self._watch, args=(process, token), daemon=True).start()
            return {'ok': True, 'token': token}

    def _read(self, process, token):
        for line in process.stdout:
            try:
                event = json.loads(line)
                with self.lock:
                    if token != self.token:
                        return
                    self._emit(event)
            except (ValueError, TypeError):
                continue
        with self.lock:
            if token == self.token:
                self._emit({'type': 'closed', 'text': '语音识别已停止。'})

    def _watch(self, process, token):
        while process.poll() is None:
            time.sleep(2)
            with self.lock:
                if token != self.token:
                    return
                # Closing/reloading the page must release the microphone, even
                # when the browser cannot deliver its pagehide request.
                if time.monotonic() - self.last_seen > 15:
                    self.stop()
                    return

    def poll(self, token, after):
        with self.lock:
            self._validate(token)
            self.last_seen = time.monotonic()
            return {'ok': True, 'events': [e for e in self.events if e['id'] > after]}

    def _validate(self, token):
        if not self.token or not isinstance(token, str) or not secrets.compare_digest(self.token, token):
            raise ValueError('语音会话已结束，请重新开启。')

    def command(self, token, action):
        with self.lock:
            self._validate(token)
            if action == 'stop':
                self.stop()
            elif action in ('pause', 'resume'):
                if not self.process or self.process.poll() is not None:
                    raise ValueError('识别程序已停止，请重新开启语音。')
                self.process.stdin.write(action + '\n')
                self.process.stdin.flush()
            else:
                raise ValueError('未知语音操作。')
            return {'ok': True}

    def stop(self):
        with self.lock:
            process, self.process = self.process, None
            self.token = None
            if process and process.poll() is None:
                try:
                    process.stdin.write('stop\n')
                    process.stdin.flush()
                    process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=2)
            if process:
                for pipe in (process.stdin, process.stdout):
                    if pipe:
                        pipe.close()


microphone = Microphone()
atexit.register(microphone.stop)
