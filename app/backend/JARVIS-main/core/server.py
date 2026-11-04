#!/usr/bin/env python3
"""
core/server.py — JARVIS orchestrator (Phase 1)

Serves the holographic UI AND a tiny local API that talks to your local Ollama
model — with STREAMING replies and long-term MEMORY. Everything stays on
localhost; no cloud, no accounts.

    python core/server.py       # or double-click run_jarvis.bat
    # then open http://localhost:8000

Endpoints:
    GET  /api/health        -> brain reachable? which model? memories + reminders count
    GET  /api/memories      -> list of stored facts
    POST /api/chat          -> { message, history } -> streamed plain-text tokens
    GET  /api/reminders     -> { pending, done, count }
    GET  /api/notifications -> { due } reminders that have fired, awaiting acknowledgement
    POST /api/reminders          -> { raw } -> parse + store a reminder
    POST /api/reminders/dismiss  -> { id }  (one-off: done; recurring: roll to next)
    POST /api/reminders/snooze   -> { id, minutes }
    POST /api/reminders/delete   -> { id }
    POST /api/search             -> { query } -> { answer, sources[] }  (opt-in web lookup, cited)
    POST /api/search/suggest     -> { message } -> { suggest, query }   (auto-offer check)
    GET  /api/youtube?q=         -> { videoId, title, url }             (resolve top match)

Memory:
    • explicit: "remember …", "store this: …", "note …", "don't forget …"
    • automatic: after each message a background pass asks the model to extract
      any durable fact and stores it (skipped for questions / short messages).
    • stored locally in data/memory.json, recalled by embedding similarity.

Config via environment (all optional):
    JARVIS_MODEL        (default "llama3")
    JARVIS_EMBED_MODEL  (default "nomic-embed-text")   # used by core/memory.py
    OLLAMA_URL          (default "http://127.0.0.1:11434")
    JARVIS_PORT         (default 8000)
    JARVIS_AUTOMEM      (default "1"; set "0" to disable auto-remember)
"""
import functools
import json
import os
import sys
import threading
import time
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory  # noqa: E402  (local module, same folder)
import reminders  # noqa: E402  (local module, same folder)
import websearch  # noqa: E402  (local module, same folder)
import openclaw_backend  # noqa: E402
import voice_backend  # noqa: E402
import realtime_voice  # noqa: E402
import knowledge  # noqa: E402

ROOT     = os.path.dirname(os.path.abspath(__file__))
UI_DIR   = os.path.abspath(os.path.join(ROOT, "..", "ui"))
DATA_DIR = os.environ["JARVIS_DATA_DIR"]

MODEL      = os.environ.get("JARVIS_MODEL", "llama3")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
PORT       = int(os.environ.get("JARVIS_PORT", "8000"))
AUTOMEM    = os.environ.get("JARVIS_AUTOMEM", "1") != "0"
REMINDER_TICK = int(os.environ.get("JARVIS_REMINDER_TICK", "20"))  # seconds between due-checks

SYSTEM_PROMPT = (
    "你是贾维斯，通过用户电脑上的全息网页与用户对话。默认用简体中文，清楚、简洁地回答。"
    "模型通过用户自行选择的 API 连接调用；不要猜测厂商或部署位置。"
    "手势和摄像头由浏览器处理，你没有收到摄像头图像。不要编造已执行的操作或联网搜索结果。"
)

REMEMBER_PREFIXES = (
    "remember that ", "remember to ", "remember ", "note that ", "make a note that ",
    "make a note ", "keep in mind that ", "keep in mind ", "don't forget that ",
    "don't forget ", "store this: ", "store this ", "store this", "save this: ",
    "save this ", "save this", "for the record ", "for future reference ",
)

QUESTION_WORDS = ("what", "who", "where", "when", "why", "how", "which",
                  "is", "are", "was", "were", "can", "could", "do", "does",
                  "did", "will", "would", "should")

EXTRACT_PROMPT = (
    "You maintain a memory of durable facts about the user. From the user's message, "
    "extract ONE concise, standalone fact worth remembering long-term (their name, "
    "location, file/folder paths, projects, people, preferences, deadlines). "
    "If there is nothing durable to remember, reply with exactly: NONE\n\n"
    "User message: {msg}\nFact:"
)


def load_profile():
    path = os.path.join(DATA_DIR, "profile.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            p = json.load(f)
        bits = [f"{k}: {v}" for k, v in p.items()]
        return "Known about the user: " + "; ".join(bits) if bits else ""
    except Exception:
        return ""


def is_question(m):
    m = m.strip().lower()
    if m.endswith("?"):
        return True
    return m.split(" ")[0] in QUESTION_WORDS if m else False


def detect_remember(message):
    low = message.strip().lower()
    for pre in REMEMBER_PREFIXES:
        if low.startswith(pre):
            fact = message.strip()[len(pre):].strip(" :\"'")
            if not fact or fact.endswith("?"):
                return None
            return fact
    return None


def build_messages(message, history):
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    prof = load_profile()
    if prof:
        msgs.append({"role": "system", "content": prof})
    try:
        mems = memory.recall(message, k=5)
    except Exception:
        mems = []
    if mems:
        msgs.append({"role": "system",
                     "content": "Facts you remember about the user:\n- " + "\n- ".join(mems)})
    for turn in (history or [])[-10:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            msgs.append({"role": turn["role"], "content": turn["content"]})
    msgs.append({"role": "user", "content": message})
    return msgs


def ollama_generate(prompt):
    payload = json.dumps({"model": MODEL, "prompt": prompt, "stream": False,
                          "options": {"temperature": 0}}).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL + "/api/generate", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r).get("response", "")


def auto_extract(message):
    """Background: ask the model for a durable fact and store it."""
    if not AUTOMEM or is_question(message) or len(message.strip()) < 8:
        return
    try:
        out = ollama_generate(EXTRACT_PROMPT.format(msg=message)).strip()
    except Exception:
        return
    fact = out.splitlines()[0].strip(" :\"'-") if out else ""
    if fact and fact.upper() != "NONE" and 3 < len(fact) < 200:
        if memory.add(fact):
            print(f"  memory (auto) + {fact}")


def health():
    status = openclaw_backend.public_status()
    status.update({"memories": memory.count(), "reminders": reminders.count(),
                   "search": websearch.backend_name()})
    return status


class JarvisHandler(SimpleHTTPRequestHandler):
    def _reject_api(self, message, code):
        # Drain a bounded rejected POST before closing: leaving its body unread
        # can reset the TCP connection before the browser receives the error.
        if self.command == "POST":
            try:
                length = int(self.headers.get("Content-Length", 0))
            except ValueError:
                length = -1
            if 0 < length <= 1024 * 1024:
                self.rfile.read(length)
        return self._json({"error": message}, code)

    def _trusted_api(self, mutation=False):
        allowed_hosts = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        if self.headers.get("Host") not in allowed_hosts:
            self._reject_api("只允许通过本机地址访问。", 403)
            return False
        if mutation:
            origins = {"http://" + host for host in allowed_hosts}
            if self.headers.get("Origin") not in origins:
                self._reject_api("请求来源不匹配，请从第三个项目页面操作。", 403)
                return False
            if self.headers.get_content_type() != "application/json":
                self._reject_api("请求必须为 JSON。", 415)
                return False
        return True

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/") and not self._trusted_api():
            return
        if path.startswith("/api/knowledge/"):
            # A private vault must also reject cross-site fetches from a local
            # browser. No CORS, no arbitrary filesystem path accepted.
            origin = self.headers.get("Origin")
            allowed = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
            if self.headers.get('Sec-Fetch-Site') == 'cross-site' or (origin and origin not in allowed):
                return self._json({'error': '只允许本机控制台读取知识库。'}, 403)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                if path == '/api/knowledge/graph':
                    return self._json(knowledge.graph(refresh=query.get('refresh') == ['1']))
                if path == '/api/knowledge/note':
                    return self._json(knowledge.note(query.get('id', [''])[0]))
                return self._json({'error': 'not found'}, 404)
            except (ValueError, OSError, UnicodeError) as exc:
                return self._json({'error': str(exc)}, 400)
        if path == "/api/voice/realtime/config":
            return self._json(realtime_voice.public_config())
        if path == "/api/voice/events":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return self._json(voice_backend.microphone.poll(
                    query.get("token", [""])[0], int(query.get("after", ["0"])[0])))
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
        if path == "/api/backend/config":
            return self._json(openclaw_backend.public_status())
        if path == "/api/health":
            return self._json(health())
        if path == "/api/memories":
            return self._json({"count": memory.count(), "memories": memory.list_all()})
        if path == "/api/reminders":
            return self._json(reminders.list_all())
        if path == "/api/notifications":
            return self._json({"due": reminders.pending_notifications()})
        if path == "/api/youtube":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return self._json(websearch.youtube_search((qs.get("q") or [""])[0]))
        return super().do_GET()

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if not 0 <= length <= 1024 * 1024:
            raise ValueError("请求过大。")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return {}

    def _reminder_post(self, path):
        data = self._read_json()
        if path == "/api/reminders":
            raw = (data.get("raw") or data.get("text") or "").strip()
            if not raw:
                return self._json({"ok": False, "error": "empty request"}, 400)
            res = reminders.create(raw)
            if res.get("ok"):
                r = res["reminder"]
                print(f"  reminder + {r['text']}  ({r['when']})")
            return self._json(res, 200 if res.get("ok") else 400)
        if path == "/api/reminders/dismiss":
            return self._json(reminders.dismiss(data.get("id", "")))
        if path == "/api/reminders/snooze":
            return self._json(reminders.snooze(data.get("id", ""), data.get("minutes", 10)))
        if path == "/api/reminders/delete":
            return self._json(reminders.delete(data.get("id", "")))
        return self._json({"error": "not found"}, 404)

    def _search_post(self):
        data = self._read_json()
        q = (data.get("query") or data.get("q") or "").strip()
        if not q:
            return self._json({"ok": False, "error": "empty query"}, 400)
        print(f"  web lookup: {q}")
        res = websearch.answer(q)
        if res.get("ok"):
            print(f"    -> {len(res.get('sources', []))} sources")
        return self._json(res, 200 if res.get("ok") else 502)

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._trusted_api(mutation=True):
            return
        if path.startswith("/api/voice/"):
            try:
                data = self._read_json()
                if not isinstance(data, dict):
                    raise ValueError("语音请求格式无效。")
                if path == "/api/voice/realtime/config":
                    return self._json(realtime_voice.save_config(data))
                if path == "/api/voice/realtime/start":
                    return self._json(realtime_voice.manager.start(PORT))
                if path == "/api/voice/start":
                    return self._json(voice_backend.microphone.start())
                if path == "/api/voice/control":
                    return self._json(voice_backend.microphone.command(data.get("token"), data.get("action")))
                if path == "/api/voice/speak":
                    audio = voice_backend.synthesize(data.get("text"))
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/mpeg")
                    self.send_header("Content-Length", str(len(audio)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(audio)
                    return
                return self._json({"error": "not found"}, 404)
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                return self._json({"error": "语音服务暂不可用，请检查麦克风或网络后重试。"}, 502)
        if path == "/api/backend/config":
            try:
                return self._json(openclaw_backend.save_settings(self._read_json()))
            except ValueError as exc:
                return self._json({"ok": False, "error": str(exc)}, 400)
        if path.startswith("/api/reminders"):
            return self._reminder_post(path)
        if path == "/api/search":
            return self._search_post()
        if path == "/api/search/suggest":
            return self._json(websearch.needs_web(self._read_json().get("message", "")))
        if path != "/api/chat":
            return self._json({"error": "not found"}, 404)

        started = False
        try:
            data = self._read_json()
            message = (data.get("message") or "").strip()
            if not message:
                return self._json({"error": "请输入对话内容。"}, 400)
            if len(message) > 32000:
                return self._json({"error": "消息过长，请缩短后重试。"}, 400)
            conversation = data.get("conversation", "default")
            if not isinstance(conversation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", conversation):
                return self._json({"error": "会话标识无效。"}, 400)
            # OpenClaw keeps conversation history itself. Forward only the new
            # user message, so prior turns are not duplicated on every request.
            history = data.get("history", [])
            if not isinstance(history, list):
                raise ValueError("对话记录格式无效。")
            previous = [{"role": turn["role"], "content": turn["content"]} for turn in history[-20:]
                        if isinstance(turn, dict) and turn.get("role") in ("user", "assistant")
                        and isinstance(turn.get("content"), str) and len(turn["content"]) <= 32000]
            req = openclaw_backend.chat_request([
                {"role": "system", "content": SYSTEM_PROMPT}, *previous,
                {"role": "user", "content": message},
            ], conversation)
            upstream = urllib.request.urlopen(req, timeout=300)

            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            started = True

            with upstream:
                for tok in openclaw_backend.iter_content(upstream):
                    self.wfile.write(tok.encode("utf-8"))
                    self.wfile.flush()
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                payload = json.load(exc)
                error = payload.get("error", {})
                detail = error.get("message", "") if isinstance(error, dict) else str(error)
            except Exception:
                pass
            msg = openclaw_backend.safe_error(detail or f"OpenClaw 返回错误（HTTP {exc.code}），请检查当前模型的 API 地址、Key 与可用额度。")
            if not started:
                return self._json({"error": msg}, 502)
        except urllib.error.URLError as exc:
            if not started:
                return self._json({"error": "无法连接第三个的 OpenClaw 后端，请稍等后重试或重新启动第三个。"}, 502)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            message = openclaw_backend.safe_error(exc)
            if not started:
                return self._json({"error": message}, 400 if isinstance(exc, ValueError) else 502)
            self.wfile.write(("\n\n⚠ " + message).encode("utf-8"))
            self.wfile.flush()

    def log_message(self, fmt, *args):
        return  # keep the console clean; we print our own status


def main(stop_event=None):
    os.makedirs(DATA_DIR, exist_ok=True)
    openclaw_backend.start()
    handler = functools.partial(JarvisHandler, directory=UI_DIR)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    print("=" * 56)
    print("  J.A.R.V.I.S core online")
    print(f"  UI:      http://localhost:{PORT}")
    print(f"  Backend: 当前用户配置的模型 API ({openclaw_backend.GATEWAY_URL})")
    print(f"  Memory:  {memory.MEM_PATH}")
    print(f"  Remind:  {reminders.REM_PATH}")
    print(f"  Web:     {websearch.backend_name()}  (opt-in; only on explicit request)")
    h = health()
    if not h["ok"]:
        print("  ! " + h.get("error", "后端正在准备"))
    elif not h.get("model_installed"):
        print(f"  ! Model '{MODEL}' not found. Installed: {', '.join(h.get('models') or []) or 'none'}")
        print(f"    Run:  ollama pull {MODEL}")
    else:
        print(f"  + Brain ready. Memories stored: {h.get('memories', 0)}  (auto-remember: {'on' if AUTOMEM else 'off'})")
    print(f"  Remind:  {reminders.count()} pending  ·  checker every {REMINDER_TICK}s")
    print("  Ctrl+C to stop.")
    print("=" * 56)

    def reminder_loop():
        while True:
            try:
                for r in reminders.check_and_fire():
                    print(f"  reminder due: {r['text']}")
            except Exception:
                pass
            time.sleep(REMINDER_TICK)
    threading.Thread(target=reminder_loop, daemon=True).start()
    if stop_event is not None:
        def desktop_shutdown():
            stop_event.wait()
            httpd.shutdown()
        threading.Thread(target=desktop_shutdown, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nJARVIS core offline.")
    finally:
        httpd.server_close()
        voice_backend.microphone.stop()
        realtime_voice.manager.stop()
        openclaw_backend.stop()


if __name__ == "__main__":
    main()
