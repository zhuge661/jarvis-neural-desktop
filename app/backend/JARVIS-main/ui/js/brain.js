/* ============================================================
   brain.js — talks to the local JARVIS core (core/server.py)
   Health-checks the brain, streams chat token-by-token, and shows
   the conversation in a draggable holographic panel. If the core
   API isn't running (e.g. launched via start.bat), it stays offline
   gracefully. Exposed globally as `Brain`.
   ============================================================ */
(function () {
  "use strict";

  let online = false, model = "", busy = false, history = [];
  let configured = null, preparing = false;
  let voiceMode = false;
  window.addEventListener("jarvis-microphone", event => {
    voiceMode = Boolean(event.detail);
    if (voiceMode) document.getElementById("chat-panel")?.remove();
  });
  function voiceCaption(role, text) {
    HUD.caption(role === "user" ? "听到：" + text : window.ReplyCard ? '贾维斯正在回复 · 请看右下角' : text);
    window.dispatchEvent(new CustomEvent("jarvis-voice-transcript", { detail: { role, text } }));
  }
  function message(role, text, quiet) {
    if (!quiet) return addMsg(role, text).querySelector(".txt");
    const target = document.createElement("span"); target.textContent = text; return target;
  }
  let retryTimer = null, lastConnectionNotice = "";
  let conversation;
  try {
    conversation = sessionStorage.getItem("jarvis-third-conversation") || crypto.randomUUID();
    sessionStorage.setItem("jarvis-third-conversation", conversation);
  } catch (error) { conversation = "tab-" + Date.now() + "-" + Math.random().toString(36).slice(2); }

  async function init() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try {
      const r = await fetch("api/health", { cache: "no-store" });
      const h = await r.json();
      configured = typeof h.configured === 'boolean' ? h.configured : (h.ok ? true : null);
      preparing = Boolean(h.starting || (configured && !h.ok));
      model = (h.model || "").toString();
      if (!h.ok) {
        online = false;
        setState(h.configured ? "连接中" : "待配置模型");
        const notice = h.error || "请点击“模型 API 设置”完成连接。";
        if (notice !== lastConnectionNotice) HUD.log(notice, "warn");
        lastConnectionNotice = notice;
        if (h.configured) retryTimer = setTimeout(init, 3000);
        return;
      }
      const changed = !online;
      online = true;
      preparing = false;
      lastConnectionNotice = "";
      setState("模型 API · " + model);
      if (changed) {
        HUD.log(`模型 API 后端已连接：${model}`);
        HUD.say("已连接 模型 API。可在底部输入一句话回车，验证模型 API 并开始对话。");
      }
    } catch (e) {
      setState("OFFLINE");
      online = false;
      configured = null;
      preparing = false;
      const notice = "后端暂未连接，界面和手势仍可使用。";
      if (notice !== lastConnectionNotice) HUD.log(notice, "warn");
      lastConnectionNotice = notice;
      retryTimer = setTimeout(init, 5000);
    }
  }

  function setState(s) { if (HUD.setBrain) HUD.setBrain(s); }

  function builtin(text, kind, target = null, quiet = false) {
    const reply = BuiltinReplies.replies[kind];
    if (!target) {
      message("user", text, quiet);
      target = message("jarvis", reply.text, quiet);
    } else target.textContent = reply.text;
    window.dispatchEvent(new CustomEvent("jarvis-chat-start", { detail: { builtin: kind } }));
    if (quiet) voiceCaption("jarvis", reply.text); else HUD.say(reply.text);
    window.dispatchEvent(new CustomEvent("jarvis-chat-done", { detail: reply.text }));
    scroll();
  }

  function feedback(text, reply, target = null, quiet = false) {
    if (!target) { message('user', text, quiet); target = message('jarvis', reply, quiet); }
    else target.textContent = reply;
    // Speak the actual connection status through the existing Yunjian queue.
    window.dispatchEvent(new CustomEvent('jarvis-chat-start'));
    if (quiet) voiceCaption('jarvis', reply); else HUD.say(reply);
    window.dispatchEvent(new CustomEvent('jarvis-chat-done', { detail: reply }));
    scroll();
  }

  async function send(text, options = {}) {
    if (busy) return;
    window.dispatchEvent(new CustomEvent('jarvis-chat-question',{detail:text}));
    const quiet = voiceMode || options.source === "voice";
    if (BuiltinReplies.isWake(text)) {
      builtin(text, "wake", null, quiet);
      return;
    }
    if (!online) {
      await init();
      if (!online) {
        if (configured === false) builtin(text, 'configure-api', null, quiet);
        else feedback(text, preparing ? '模型已经配置，连接正在准备中，请稍后再试。' : '暂时无法连接本机模型服务，请稍后重试。', null, quiet);
        return;
      }
    }
    busy = true;
    window.dispatchEvent(new CustomEvent("jarvis-chat-start"));
    message("user", text, quiet);
    const txt = message("jarvis", "…", quiet);
    history.push({ role: "user", content: text });
    try {
      const r = await fetch("api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversation, history: history.slice(0, -1) }),
      });
      if (!r.ok || !r.body) {
        let msg = "请求失败";
        try { msg = (await r.json()).error || msg; } catch (e) { /* not json */ }
        txt.textContent = "⚠ " + msg;
        HUD.log("模型错误：" + msg, "err");
        throw new Error(msg);
      }
      // stream tokens as they generate
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      txt.textContent = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        txt.textContent = acc;
        if (quiet) voiceCaption("jarvis", acc);
        window.dispatchEvent(new CustomEvent("jarvis-chat-delta", { detail: acc }));
        scroll();
      }
      acc += dec.decode();
      txt.textContent = acc || "…";
      if (quiet) voiceCaption("jarvis", acc);
      if (!acc) txt.textContent = "…";
      history.push({ role: "assistant", content: acc });
      HUD.log("模型已回复");
      window.dispatchEvent(new CustomEvent("jarvis-chat-done", { detail: acc }));
    } catch (e) {
      HUD.log("对话失败：" + e.message, "err");
      window.dispatchEvent(new CustomEvent("jarvis-chat-error"));
      await init();
      if (configured === false) builtin(text, 'configure-api', txt, quiet);
      else feedback(text, preparing ? '模型已经配置，连接正在准备中，请稍后再试。' : '模型暂时无法回复：' + e.message, txt, quiet);
    }
    if (history.length > 20) history = history.slice(-20);
    busy = false;
  }

  // ---- conversation panel ------------------------------------------
  function panel() {
    let p = document.getElementById("chat-panel");
    if (p) return p;
    p = document.createElement("div");
    p.className = "holo-panel chat-panel";
    p.id = "chat-panel";
    p.innerHTML =
      '<div class="holo-bar"><span class="holo-title">贾维斯 — 对话</span>' +
      '<button class="holo-x" title="关闭">&times;</button></div>' +
      '<div class="chat-log" id="chat-log"></div>';

    const bar = p.querySelector(".holo-bar");
    let dx = 0, dy = 0, drag = false;
    bar.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("holo-x")) return;
      drag = true; dx = e.clientX - p.offsetLeft; dy = e.clientY - p.offsetTop; p.style.zIndex = 41;
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return; p.style.left = (e.clientX - dx) + "px"; p.style.top = (e.clientY - dy) + "px";
    });
    window.addEventListener("mouseup", () => { drag = false; });
    p.querySelector(".holo-x").addEventListener("click", () => p.remove());

    document.getElementById("panels").append(p);
    return p;
  }

  function addMsg(role, text) {
    const log = panel().querySelector("#chat-log");
    const d = document.createElement("div");
    d.className = "chat-msg " + role;
    const who = document.createElement("span"); who.className = "who";
    who.textContent = role === "user" ? "你" : "贾维斯";
    const txt = document.createElement("span"); txt.className = "txt"; txt.textContent = text;
    d.append(who, txt);
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function scroll() {
    const log = document.getElementById("chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  async function memories() {
    try {
      const r = await fetch("api/memories", { cache: "no-store" });
      const d = await r.json();
      const list = d.memories || [];
      addMsg("jarvis", list.length
        ? "已保存的记忆：\n• " + list.map((m) => m.text).join("\n• ")
        : "暂无已保存的记忆。");
      HUD.log(`已保存记忆：${d.count || 0} 条`);
    } catch (e) {
      HUD.log("读取记忆失败：" + e.message, "err");
    }
  }

  function realtimeTurn() {
    window.dispatchEvent(new CustomEvent('jarvis-realtime-turn-start'));
    let result = "";
    return {
      question(text) { if (text) voiceCaption("user", text); },
      answer(text, final) { result = final ? text : result + text; voiceCaption("jarvis", result); },
    };
  }
  window.Brain = { init, send, memories, realtimeTurn, isOnline: () => online, isBusy: () => busy };
})();
