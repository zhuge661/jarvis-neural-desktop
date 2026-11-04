"""Private local WebSocket relay for Volcengine Seeduplex. No audio is persisted."""
import atexit
import base64
import json
import logging
import os
import secrets
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# voice_backend adds the project's bundled dependencies before importing this.
from websockets.sync.client import connect
from websockets.sync.server import serve
from websockets.exceptions import ConnectionClosed

PROJECT = Path(__file__).resolve().parents[2]
SETTINGS = Path(os.environ['JARVIS_USER_ROOT']) / 'realtime-voice.json'
ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
VOICES = {'zh_male_yunzhou_jupiter_bigtts': '云舟男声', 'zh_male_xiaotian_jupiter_bigtts': '小天男声'}
DEFAULTS = {'enabled': True, 'voice': next(iter(VOICES)), 'speed': -8, 'mechanical': 55, 'api_key': ''}
INSTRUCTIONS = (
    '你是贾维斯，用户的人工智能助手。用简体中文，简洁、准确地回答，先给结论。'
    '使用低沉、冷静、克制、清晰的男声，语调平稳，带精密机械助手的感觉，减少气声和夸张情绪。'
    '用户只叫你的名字或说你好贾维斯时，只回复：我已准备就绪，随时能为您服务。'
    '你没有收到摄像头、屏幕或知识库正文，不要假装看到这些内容或执行了电脑操作。'
)
_lock = threading.RLock()


def settings():
    return {**DEFAULTS, **(json.loads(SETTINGS.read_text(encoding='utf-8')) if SETTINGS.exists() else {})}


def public_config():
    value = settings()
    return {k: value[k] for k in ('enabled', 'voice', 'speed', 'mechanical')} | {
        'configured': bool(value['api_key']), 'voices': VOICES, 'model': 'Seeduplex · 1.2.6.1'}


def save_config(data):
    if not isinstance(data, dict):
        raise ValueError('实时语音设置格式无效。')
    with _lock:
        value = settings()
        for name in ('enabled', 'voice', 'speed', 'mechanical'):
            if name in data:
                value[name] = data[name]
        key = data.get('api_key')
        if key is not None:
            if not isinstance(key, str) or len(key) > 2048 or any(c.isspace() for c in key.strip()):
                raise ValueError('语音 API Key 格式无效。')
            if key.strip():
                value['api_key'] = key.strip()
        if type(value['enabled']) is not bool or not isinstance(value['voice'], str) or value['voice'] not in VOICES:
            raise ValueError('请选择有效的实时语音音色。')
        for name, low, high in (('speed', -50, 100), ('mechanical', 0, 100)):
            if type(value[name]) is not int or not low <= value[name] <= high:
                raise ValueError('语速或机械感参数超出范围。')
        if value['enabled'] and not value['api_key']:
            raise ValueError('请填写火山豆包语音控制台的 API Key。')
        if manager.active:
            raise ValueError('请先关闭正在进行的语音通话，再保存设置。')
        SETTINGS.parent.mkdir(parents=True, exist_ok=True)
        temporary = SETTINGS.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(SETTINGS)
    return {'ok': True, 'message': '已保存到本机。点击“开启语音对话”连接火山实时模型。'}


def session_event(value):
    return {'type': 'session.create', 'event_id': uuid.uuid4().hex, 'session': {
        'model': '1.2.6.1', 'instructions': INSTRUCTIONS,
        'audio': {'input': {'format': {'type': 'pcm', 'rate': 16000}},
                  'output': {'format': {'type': 'pcm_s16le', 'rate': 24000},
                             'voice': value['voice'], 'speed': value['speed'], 'loudness': 0}},
    }}


def safe_message(message, key):
    return str(message).replace(key, '[已隐藏]')[:500] if key else str(message)[:500]


def provider_error(payload, key, http_status=None, log_id=''):
    """Surface actionable provider errors without headers or credentials."""
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode('utf-8', errors='replace')
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {'message': payload}
    payload = payload if isinstance(payload, dict) else {}
    error = payload.get('error')
    error = error if isinstance(error, dict) else payload
    code = safe_message(error.get('code', error.get('status_code', '')), key)
    detail = safe_message(error.get('message', '火山未返回具体原因'), key)
    if code == '45000030' or 'requested resource not granted' in detail:
        message = ('火山实时语音未获授权（45000030）。请在豆包语音控制台同一项目开通'
                   '“端到端实时语音”服务，并使用该项目的 Key。')
    elif http_status == 401:
        message = '火山 API Key 认证失败（HTTP 401），请检查是否为豆包语音控制台的有效 Key。'
    elif http_status == 403:
        message = '火山拒绝访问（HTTP 403），请核对语音服务权限及 Key 所属项目。'
    elif http_status == 429:
        message = '火山实时语音达到频率或并发限制，请关闭其他通话后稍后重试。'
    else:
        message = '火山实时语音连接失败：' + detail
    event = {'type': 'local.error', 'message': message, 'code': code}
    if http_status:
        event['http_status'] = http_status
    if log_id:
        event['log_id'] = safe_message(log_id, key)
    return event


class Relay:
    def __init__(self):
        self.server = None
        self.ui_port = None
        self.pending = {}
        self.active = None
        self.thread = None

    def start(self, ui_port):
        with _lock:
            value = settings()
            if not value['enabled'] or not value['api_key']:
                raise ValueError('请先配置火山实时语音 API Key。')
            if self.active or any(time.monotonic() - stamp < 30 for stamp in self.pending.values()):
                raise ValueError('语音已在另一页面连接，请先关闭原通话。')
            self.pending.clear()
            if self.server is None:
                self.ui_port = ui_port
                # Loopback only, same-origin plus a short-lived one-use capability.
                self.server = serve(self.handle, '127.0.0.1', 0,
                    origins=[f'http://127.0.0.1:{ui_port}', f'http://localhost:{ui_port}'],
                    process_request=self.authorize, max_size=100000, max_queue=8,
                    compression=None, close_timeout=2, logger=logging.getLogger('jarvis.realtime'))
                self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
                self.thread.start()
            token = secrets.token_urlsafe(32)
            self.pending[token] = time.monotonic()
            return {'ok': True, 'url': f'ws://127.0.0.1:{self.server.socket.getsockname()[1]}/realtime?token={token}',
                    'mechanical': value['mechanical'], 'voice': VOICES[value['voice']]}

    def authorize(self, connection, request):
        port = self.server.socket.getsockname()[1]
        if request.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            return connection.respond(403, 'Local host required')
        if request.headers.get('Origin') not in (f'http://127.0.0.1:{self.ui_port}', f'http://localhost:{self.ui_port}'):
            return connection.respond(403, 'Local origin required')
        query = parse_qs(urlsplit(request.path).query)
        token = query.get('token', [''])[0]
        with _lock:
            stamp = self.pending.pop(token, None)
            if urlsplit(request.path).path != '/realtime' or stamp is None or time.monotonic() - stamp > 30 or self.active:
                return connection.respond(403, 'Session expired')
            self.active = connection

    def handle(self, browser):
        value = settings()
        upstream = None
        closing = threading.Event()
        closed = threading.Event()

        def send(event):
            browser.send(json.dumps(event, ensure_ascii=False))

        def upload():
            try:
                for raw in browser:
                    event = json.loads(raw)
                    kind = event.get('type')
                    if kind == 'input_audio_buffer.append':
                        pcm = base64.b64decode(event.get('audio', ''), validate=True)
                        if len(pcm) != 640:
                            raise ValueError('音频须按 20ms / 640 字节发送。')
                    elif kind == 'speech_text_buffer.commit':
                        if event.get('text') != '我已准备就绪，随时能为您服务':
                            raise ValueError('试听只支持内置唤醒句。')
                    elif kind not in ('response.cancel', 'input_audio_mute.commit', 'input_audio_unmute.commit', 'session.close'):
                        raise ValueError('不支持的实时语音事件。')
                    upstream.send(json.dumps(event))
                    if kind == 'session.close':
                        closing.set()
                        closed.wait(2)
                        return
            except (ConnectionClosed, OSError):
                pass
            except (ValueError, TypeError):
                try:
                    send({'type': 'local.error', 'message': '本机音频数据格式异常，请重新开启语音。'})
                except ConnectionClosed:
                    pass
            finally:
                if not closing.is_set():
                    closing.set()
                    try:
                        upstream.send(json.dumps({'type': 'session.close'}))
                        closed.wait(2)
                    except (ConnectionClosed, OSError):
                        pass
                upstream.close()

        try:
            with connect(ENDPOINT, additional_headers={'X-Api-Key': value['api_key'],
                    'X-Api-Connect-Id': uuid.uuid4().hex}, proxy=None, open_timeout=15,
                    max_size=2000000, max_queue=16, close_timeout=2, compression=None) as upstream:
                upstream.send(json.dumps(session_event(value), ensure_ascii=False))
                # Don't start sending mic audio until the provider confirms the session.
                first = json.loads(upstream.recv(timeout=20))
                if first.get('type') != 'session.created':
                    send(provider_error(first, value['api_key']))
                    return
                send(first)
                thread = threading.Thread(target=upload, daemon=True)
                thread.start()
                while True:
                    try:
                        event = json.loads(upstream.recv(timeout=1))
                    except TimeoutError:
                        continue
                    if event.get('type') == 'error':
                        event = provider_error(event, value['api_key'])
                    send(event)
                    if event.get('type') in ('session.closed', 'local.error'):
                        closed.set()
                        break
        except ConnectionClosed:
            pass
        except Exception as exc:
            # Never expose upstream headers or a provider credential to the browser.
            try:
                response = getattr(exc, 'response', None)
                if response is not None:
                    send(provider_error(getattr(response, 'body', b''), value['api_key'],
                        getattr(response, 'status_code', None), response.headers.get('X-Tt-Logid', '')))
                else:
                    send({'type': 'local.error', 'message': '火山实时语音连接失败，请检查语音 Key、全双工服务权限和网络。',
                          'detail': safe_message(type(exc).__name__, value['api_key'])})
            except ConnectionClosed:
                pass
        finally:
            closed.set()
            if upstream:
                upstream.close()
            browser.close()
            with _lock:
                if self.active is browser:
                    self.active = None

    def stop(self):
        with _lock:
            active, server = self.active, self.server
            self.active = None
            self.server = None
            self.pending.clear()
        if active:
            active.close()
        if server:
            server.shutdown()


manager = Relay()
atexit.register(manager.stop)
