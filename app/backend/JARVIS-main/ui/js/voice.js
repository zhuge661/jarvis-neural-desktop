(function () {
  "use strict";
  let token = null, cursor = 0, timer = null, polling = false;
  let generation = 0, queue = [], working = false, thinking = false, offset = 0;
  let audio = null, request = null, finishAudio = null, spoken = false, starting = false;
  let builtin = null;
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $("voice-status").textContent = text; };
  const enabled = () => $("voice-replies").checked;

  async function post(path, body, signal) {
    const response = await fetch("api/voice/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "语音请求失败");
    }
    return response;
  }
  async function control(action) {
    if (token) await post("control", { token, action });
  }
  function clearPlayback() {
    generation++;
    queue = [];
    if (request) request.abort();
    if (audio) { audio.pause(); audio.removeAttribute("src"); }
    if (finishAudio) finishAudio();
    audio = null;
  }
  async function resume() {
    if (thinking || working || queue.length || starting) return;
    if (token) {
      // Let the speaker's final syllable decay before opening the microphone.
      const current = generation;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (current !== generation || thinking || working || !token) return;
      await control("resume");
      status("正在聆听 · 说完一句后停顿");
    } else status("云健男声 · 待机");
  }
  function clean(text) {
    return text.replace(/```[\s\S]*?```/g, "，代码请看屏幕，")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "链接请看屏幕")
      .replace(/[*#_`~>|「」『』]/g, " ").replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s+/g, " ").trim();
  }
  function enqueue(text, clip = null) {
    text = clean(text);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    // A sentence can contain a long list/code block; keep each request bounded.
    for (let i = 0; i < text.length; i += 500) queue.push({ text: text.slice(i, i + 500), clip });
    pump();
  }
  async function pump() {
    if (working) return;
    working = true;
    const current = generation;
    try {
      while (queue.length && current === generation) {
        const item = queue.shift();
        status(item.clip ? "正在播放内置回复" : "正在合成 · 云健男声");
        request = new AbortController();
        const response = item.clip
          ? await fetch(item.clip, { signal: request.signal })
          : await post("speak", { text: item.text }, request.signal);
        if (!response.ok) throw new Error("内置语音文件读取失败");
        const blob = await response.blob();
        if (current !== generation) break;
        const url = URL.createObjectURL(blob);
        audio = new Audio(url);
        const clip = audio;
        try {
          await new Promise((resolve, reject) => {
            finishAudio = resolve;
            clip.onended = resolve;
            clip.onerror = () => reject(new Error("音频播放失败"));
            clip.play().then(() => {
              window.dispatchEvent(new CustomEvent("jarvis-voice-playback", { detail: true }));
              status("贾维斯正在说话 · 可点击停止朗读");
            }, reject);
          });
        } finally {
          clip.pause(); URL.revokeObjectURL(url); finishAudio = null; audio = null;
          window.dispatchEvent(new CustomEvent("jarvis-voice-playback", { detail: false }));
        }
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        queue = [];
        HUD.log("语音播报失败：" + error.message, "warn");
        status("朗读失败 · 可点击试听重试");
      }
    } finally {
      working = false; request = null;
      if (queue.length) pump();
      else resume().catch(fail);
    }
  }
  function consume(text, final) {
    if (!spoken) return;
    let remaining = text.slice(offset);
    // Read completed sentences while the model continues generating.
    const matches = [...remaining.matchAll(/[。！？!?；;\n]/g)];
    if (matches.length) {
      const length = matches[matches.length - 1].index + 1;
      enqueue(remaining.slice(0, length)); offset += length;
      remaining = text.slice(offset);
    }
    if (final && remaining.trim()) { enqueue(remaining); offset = text.length; }
  }
  async function start() {
    if (starting) return;
    starting = true;
    $("btn-voice").disabled = true;
    clearPlayback();
    try {
      if (window.RealtimeVoice && await RealtimeVoice.startIfConfigured()) return;
      const response = await post("start", {});
      const value = await response.json();
      token = value.token; cursor = 0;
      window.dispatchEvent(new CustomEvent("jarvis-microphone", { detail: true }));
      $("voice-replies").checked = true;
      $("btn-voice").textContent = "🎙 关闭语音对话";
      $("btn-voice").classList.add("active");
      status("正在加载中文识别模型与本机麦克风…");
      timer = setInterval(poll, 450);
      await poll();
    } catch (error) { fail(error); }
    finally { starting = false; $("btn-voice").disabled = false; }
  }
  async function stop() {
    const previous = token;
    token = null;
    window.dispatchEvent(new CustomEvent("jarvis-microphone", { detail: false }));
    if (timer) clearInterval(timer);
    timer = null;
    clearPlayback();
    $("btn-voice").textContent = "🎙 开启语音对话";
    $("btn-voice").classList.remove("active");
    status("语音已关闭 · 麦克风已释放");
    if (previous) await post("control", { token: previous, action: "stop" }).catch(() => {});
  }
  function fail(error) {
    HUD.log(error.message || "语音连接失败", "warn");
    stop().then(() => status(error.message || "语音已停止"));
  }
  async function poll() {
    if (!token || polling) return;
    polling = true;
    const current = token;
    try {
      const response = await fetch("api/voice/events?token=" + encodeURIComponent(current) + "&after=" + cursor, { cache: "no-store" });
      const result = await response.json();
      if (token !== current) return;
      if (!response.ok) throw new Error(result.error);
      for (const event of result.events) {
        cursor = Math.max(cursor, event.id);
        if (event.type === "error") throw new Error(event.text);
        if (event.type === "closed") { await stop(); break; }
        if (event.type === "listening" && !thinking && !working) status("正在聆听 · 说完一句后停顿");
        if (event.type === "partial" && !thinking && !working) status("听到：" + event.text);
        if (event.type === "recognized" && !thinking && !working && !Brain.isBusy()) {
          status("已听到：" + event.text);
          HUD.log("语音输入：" + event.text);
          Brain.send(event.text, { source: "voice" });
        }
      }
    } catch (error) { if (token === current) fail(error); }
    finally { polling = false; }
  }
  function init() {
    if (window.RealtimeVoice) RealtimeVoice.init();
    $("btn-voice").addEventListener("click", () => {
      if (window.RealtimeVoice?.isActive()) RealtimeVoice.stop(); else token ? stop() : start();
    });
    $("btn-voice-preview").addEventListener("click", async () => {
      if (window.RealtimeVoice?.isActive()) { HUD.say("请先关闭实时通话，再试听内置男声。"); return; }
      try { if (window.RealtimeVoice && await RealtimeVoice.previewIfConfigured()) return; }
      catch (error) { fail(error); return; }
      clearPlayback();
      const reply = BuiltinReplies.replies.wake;
      try { await control("pause"); enqueue(reply.text, reply.audio); }
      catch (error) { fail(error); }
    });
    $("btn-voice-stop").addEventListener("click", () => {
      if (window.RealtimeVoice?.isActive()) { RealtimeVoice.interrupt(); return; }
      spoken = false; clearPlayback();
      status(thinking ? "已停止朗读 · 文字回复继续" : "已停止朗读");
      resume().catch(fail);
    });
    $("voice-replies").addEventListener("change", () => {
      if (!enabled()) { spoken = false; clearPlayback(); resume().catch(fail); }
    });
    window.addEventListener("jarvis-chat-start", (event) => {
      if (window.RealtimeVoice?.isActive()) { spoken = false; return; }
      clearPlayback(); thinking = true; offset = 0; spoken = enabled();
      builtin = event.detail?.builtin || null;
      control("pause").catch(fail);
      if (token || spoken) status(builtin ? "正在准备内置回复…" : "贾维斯正在思考…");
    });
    window.addEventListener("jarvis-chat-delta", (event) => consume(event.detail, false));
    window.addEventListener("jarvis-chat-done", (event) => {
      if (builtin) {
        const reply = BuiltinReplies.replies[builtin];
        if (spoken) enqueue(reply.text, reply.audio);
      } else consume(event.detail, true);
      builtin = null; thinking = false; resume().catch(fail);
    });
    window.addEventListener("jarvis-chat-error", () => {
      builtin = null; thinking = false; spoken = false; clearPlayback(); resume().catch(fail);
    });
    window.addEventListener("pagehide", () => {
      if (token) fetch("api/voice/control", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "stop" }), keepalive: true,
      }).catch(() => {});
    });
  }
  window.Voice = { init, stopLocal: stop };
})();
