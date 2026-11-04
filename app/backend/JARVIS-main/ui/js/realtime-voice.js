/* Browser mic <-> private loopback relay <-> Volcengine Seeduplex. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  let socket, stream, context, capture, input, sink, player, running = false, ready = false;
  let generation = 0, panel, config, turn = null, canceled = false, previewing = false;
  let readyTimer, previewTimer, closeTimer, frames = 0, audioChunks = 0;
  const status = text => { $("voice-status").textContent = text; };
  async function api(path, body) {
    const response = await fetch("api/voice/realtime/" + path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "实时语音请求失败");
    return value;
  }
  function send(event) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); }
  function button() {
    $("btn-voice").textContent = running ? "🎙 关闭语音对话" : "🎙 开启语音对话";
    $("btn-voice").classList.toggle("active", running);
  }
  async function start(preview = false) {
    if (running) throw new Error("请先关闭当前语音通话");
    const current = ++generation;
    running = true; ready = false; canceled = false; previewing = preview; turn = null; frames = audioChunks = 0;
    button(); status(preview ? "正在连接火山音色试听…" : "正在连接火山全双工语音…");
    try {
      context = new AudioContext({ latencyHint: "interactive" });
      await context.resume();
      if (!preview) {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        }, video: false });
        if (current !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired;
        await context.audioWorklet.addModule("js/realtime-capture.js");
        input = context.createMediaStreamSource(stream);
        capture = new AudioWorkletNode(context, "jarvis-realtime-capture");
        sink = context.createGain(); sink.gain.value = 0;
        input.connect(capture).connect(sink).connect(context.destination);
        capture.port.onmessage = event => {
          if (!ready || current !== generation || socket?.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > 32000) { fail(new Error("上行网络积压，请重新连接")); return; }
          const bytes = new Uint8Array(event.data);
          send({ type: "input_audio_buffer.append", audio: btoa(String.fromCharCode(...bytes)) }); frames++;
        };
        window.dispatchEvent(new CustomEvent("jarvis-microphone", { detail: true }));
      }
      player = new VoiceAudio.PCMPlayer(context, config.mechanical);
      const connection = await api("start", {});
      if (current !== generation) return;
      socket = new WebSocket(connection.url);
      socket.onmessage = event => {
        if (current !== generation) return;
        try { receive(JSON.parse(event.data)); } catch (error) { fail(error); }
      };
      socket.onerror = () => { if (current === generation) fail(new Error("实时语音通道连接失败")); };
      socket.onclose = () => {
        if (current !== generation || !running) return;
        if (!ready) fail(new Error("火山未建立语音会话，请检查语音 Key 和全双工服务权限"));
        else { release(); status("实时语音已断开 · 点击重新开启"); }
      };
      readyTimer = setTimeout(() => { if (current === generation && !ready) fail(new Error("实时语音连接超时，请检查 Key、网络和服务权限")); }, 25000);
    } catch (error) { if (current === generation) { await release(); throw error; } }
  }
  function receive(event) {
    const kind = event.type;
    if (kind === "session.created") {
      clearTimeout(readyTimer); ready = true;
      status(previewing ? "正在试听云端音色…" : "火山全双工已连接 · 可直接说话或插话");
      HUD.log("火山 Seeduplex 实时语音已连接");
      if (previewing) { send({ type: "input_audio_mute.commit" }); send({ type: "speech_text_buffer.commit", text: "我已准备就绪，随时能为您服务" }); }
      return;
    }
    if (kind === "local.error" || kind === "error") {
      if (event.log_id) HUD.log("火山诊断 Log ID：" + event.log_id, "warn");
      fail(new Error(event.message || "火山实时语音调用失败")); return;
    }
    if (kind === "session.closed") { release(); status("实时语音已关闭"); return; }
    const text = [event.text, event.delta, event.transcript, event.content].find(x => typeof x === "string") || "";
    if (kind === "conversation.item.input_audio_transcription.started") {
      player.clear(); canceled = false; turn = Brain.realtimeTurn(); status("正在聆听 · 可随时插话");
    } else if (kind === "conversation.item.input_audio_transcription.delta") {
      if (!turn) turn = Brain.realtimeTurn(); turn.question(text);
    } else if (kind === "conversation.item.input_audio_transcription.completed") {
      if (!turn) turn = Brain.realtimeTurn(); if (text) turn.question(text); status("火山正在实时回复…");
    } else if (kind === "response.output_text.delta" && !canceled) {
      if (!turn) turn = Brain.realtimeTurn(); turn.answer(text, false);
    } else if (kind === "response.output_text.done" && !canceled) {
      if (turn && text) turn.answer(text, true);
    } else if (kind === "response.output_audio.delta" && !canceled) {
      if (previewing || $("voice-replies").checked) player.enqueue(event.delta);
      audioChunks++; status("贾维斯正在说话 · 可直接插话");
    } else if (kind === "response.output_audio.done" && previewing) {
      previewTimer = setTimeout(stop, Math.max(50, (player.next - context.currentTime) * 1000 + 100));
    } else if (kind === "response.canceled") {
      player.clear(); status("已打断 · 继续说话即可");
    }
  }
  function interrupt() { canceled = true; player?.clear(); send({ type: "response.cancel" }); status("已停止回复 · 可以继续说话"); }
  async function release() {
    generation++; running = ready = false; previewing = false;
    clearTimeout(readyTimer); clearTimeout(previewTimer); clearTimeout(closeTimer);
    if (capture) { capture.port.onmessage = null; capture.disconnect(); }
    input?.disconnect(); sink?.disconnect();
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    player?.close(); player = null;
    const previousContext = context;
    context = capture = input = sink = null;
    if (socket) { socket.onclose = socket.onerror = socket.onmessage = null; socket.close(); socket = null; }
    window.dispatchEvent(new CustomEvent("jarvis-microphone", { detail: false })); button();
    if (previousContext && previousContext.state !== "closed") await previousContext.close().catch(() => {});
  }
  function stop() {
    ready = false;
    // Release capture immediately; keep the socket briefly for session.closed.
    stream?.getTracks().forEach(track => track.stop()); player?.clear();
    send({ type: "session.close" });
    closeTimer = setTimeout(release, 1800); status("正在结束实时语音…");
  }
  function fail(error) {
    HUD.log("实时语音：" + error.message, "warn");
    if (panel && panel.style.display !== "none") $("realtime-status").textContent = error.message;
    release().then(() => status(error.message));
  }
  async function startIfConfigured() {
    try { config = await api("config"); }
    catch (_) { if(config && !config.enabled)return false;throw new Error('无法读取实时语音连接，请稍后重试。'); }
    if (!config.configured || !config.enabled) return false;
    await start(); return true;
  }
  async function previewIfConfigured() {
    try { config = await api("config"); }
    catch (_) { if(config && !config.enabled)return false;throw new Error('无法读取实时语音连接，请稍后重试。'); }
    if (!config.configured || !config.enabled) return false;
    await Voice.stopLocal(); await start(true); return true;
  }
  function createPanel() {
    if (panel) return;
    panel = document.createElement("div"); panel.id = "realtime-overlay";
    panel.innerHTML = `<section class="backend-dialog" role="dialog" aria-modal="true" aria-labelledby="realtime-title">
      <button class="backend-close" type="button" aria-label="关闭实时语音设置">×</button>
      <h2 id="realtime-title">火山实时语音设置</h2>
      <p>端到端全双工通话，声音直接发送到火山。Key 保存在本机后端；麦克风由“开启语音对话”控制。</p>
      <p>先在<a href="https://console.volcengine.com/speech/new/overview?projectName=default" target="_blank" rel="noopener noreferrer">火山豆包语音控制台</a>的“开通管理”开通端到端实时语音服务，服务与 Key 须属于同一项目。</p>
      <form id="realtime-form"><label for="realtime-key">豆包语音 API Key</label>
      <input id="realtime-key" type="password" autocomplete="off" placeholder="填写语音控制台的 Key" />
      <label for="realtime-voice">男声音色</label><select id="realtime-voice"></select>
      <label for="realtime-speed">语速（-50 到 100）</label><input id="realtime-speed" type="number" min="-50" max="100" required />
      <label for="realtime-mechanical">机械感（0 原声，100 较强）</label><input id="realtime-mechanical" type="number" min="0" max="100" required />
      <label class="backend-check"><input id="realtime-enabled" type="checkbox" /> 使用火山全双工语音</label>
      <div class="backend-note">默认云舟男声，搭配本机金属质感处理。无 Key 时保留本机语音与两句内置回复。火山调用消耗账户额度。</div>
      <div id="realtime-status" role="status"></div><button id="realtime-save" type="submit" class="hud-btn">保存设置</button>
      <button id="realtime-preview" type="button" class="hud-btn">保存并试听当前音色</button></form></section>`;
    document.body.append(panel);
    panel.querySelector(".backend-close").onclick = () => { panel.style.display = "none"; $("realtime-key").value = ""; };
    panel.onclick = e => { if (e.target === panel) panel.querySelector(".backend-close").click(); };
    $("realtime-form").onsubmit = e => { e.preventDefault(); save(false); };
    $("realtime-preview").onclick = () => save(true);
  }
  async function show() {
    createPanel(); panel.style.display = "grid";
    try {
      config = await api("config");
      $("realtime-voice").replaceChildren(...Object.entries(config.voices).map(([id, name]) => new Option(name, id)));
      for (const field of ["voice", "speed", "mechanical"]) $("realtime-" + field).value = config[field];
      $("realtime-enabled").checked = config.enabled; $("realtime-key").value = "";
      $("realtime-key").placeholder = config.configured ? "已保存 Key，不更换时留空" : "填写豆包语音控制台 API Key";
      $("realtime-status").textContent = config.configured ? "Key 已保存，开启语音对话后可验证连接。" : "填写 Key 后保存，即可开启实时通话。";
    } catch (error) { $("realtime-status").textContent = "无法读取设置，请重新启动桌面版。"; }
  }
  async function save(preview) {
    $("realtime-save").disabled = $("realtime-preview").disabled = true;
    try {
      if (running) throw new Error("请先关闭正在进行的语音通话");
      const body = { enabled: $("realtime-enabled").checked, voice: $("realtime-voice").value,
        speed: Number($("realtime-speed").value), mechanical: Number($("realtime-mechanical").value) };
      if ($("realtime-key").value.trim()) body.api_key = $("realtime-key").value.trim();
      const result = await api("config", body); $("realtime-key").value = "";
      config = await api("config"); $("realtime-status").textContent = result.message;
      updateModeNote();
      if (config.enabled && config.configured) status(config.voices[config.voice] + " · 实时语音待机");
      if (preview) { await Voice.stopLocal(); await start(true); }
    } catch (error) { $("realtime-status").textContent = error.message; }
    finally { $("realtime-save").disabled = $("realtime-preview").disabled = false; }
  }
  function init() {
    $("btn-realtime").onclick = show;
    api("config").then(value => {
      config = value;
      updateModeNote();
      if (!running && value.configured && value.enabled) status(value.voices[value.voice] + " · 实时语音待机");
    }).catch(() => {});
    $("voice-replies").addEventListener("change", () => { if (!$("voice-replies").checked) player?.clear(); });
    window.addEventListener("pagehide", () => { send({ type: "session.close" }); release(); });
  }
  function updateModeNote(){
    const note=document.querySelector('#voice-controls .voice-note');
    if(note)note.textContent=config?.configured&&config.enabled?'实时模型直接发声 · 支持插话':'本机识别 → 大模型 → 云健朗读';
  }
  window.RealtimeVoice = { init, show, startIfConfigured, previewIfConfigured, stop, interrupt, isActive: () => running,
    snapshot: () => ({ running, ready, frames, audioChunks, bufferedSources: player?.sources.size || 0 }) };
})();
