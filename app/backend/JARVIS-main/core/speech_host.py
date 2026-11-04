"""Offline Chinese dictation worker. Microphone audio is never written to disk."""
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / '语音依赖'))


def emit(kind, text):
    print(json.dumps({'type': kind, 'text': text}, ensure_ascii=False), flush=True)


def normalize(text):
    text = re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])', '', text).strip()
    return text.replace('假为四', '贾维斯')


def main():
    import sounddevice as sd
    from vosk import Model, KaldiRecognizer, SetLogLevel
    SetLogLevel(-1)
    # Vosk's native Windows loader requires a path without Chinese characters.
    # Resolve the project through Python, then use a relative ASCII model path.
    os.chdir(PROJECT / '语音模型/vosk-model-small-cn-0.22')
    model = Model('.')
    rate = int(sd.query_devices(kind='input')['default_samplerate'])
    recognizer = KaldiRecognizer(model, rate)
    events = queue.Queue(maxsize=80)
    active = threading.Event()
    active.set()

    def commands():
        for line in sys.stdin:
            events.put(('command', line.strip()))
        events.put(('command', 'stop'))

    def capture(data, frames, clock, flags):
        if active.is_set():
            try:
                events.put_nowait(('audio', bytes(data)))
            except queue.Full:
                pass

    threading.Thread(target=commands, daemon=True).start()
    with sd.RawInputStream(samplerate=rate, blocksize=int(rate * .16), dtype='int16',
                           channels=1, callback=capture):
        emit('listening', '正在聆听，说完一句后稍作停顿。')
        previous = ''
        while True:
            kind, value = events.get()
            if kind == 'command':
                if value == 'stop':
                    return
                if value == 'pause':
                    active.clear()
                    recognizer.Reset()
                if value == 'resume':
                    recognizer.Reset()
                    previous = ''
                    # Discard audio buffered before pausing or during inference.
                    with events.mutex:
                        events.queue = type(events.queue)(item for item in events.queue if item[0] != 'audio')
                    active.set()
                    emit('listening', '正在聆听，说完一句后稍作停顿。')
            elif active.is_set():
                if recognizer.AcceptWaveform(value):
                    text = normalize(json.loads(recognizer.Result()).get('text', ''))
                    if text:
                        active.clear()
                        emit('recognized', text)
                else:
                    partial = normalize(json.loads(recognizer.PartialResult()).get('partial', ''))
                    if partial and partial != previous:
                        previous = partial
                        emit('partial', partial)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        emit('error', '中文识别启动失败，请检查系统默认麦克风和本项目的语音模型。')
        sys.exit(1)
