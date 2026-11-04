/* ============================================================
   hud.js — 2D heads-up display controller
   Owns the text overlays: clock, readouts, log feed, JARVIS line.
   Exposed globally as `HUD` (scripts are loaded without modules).
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    clock:   $("clock"),
    fps:     $("fps"),
    core:    $("core-state"),
    hands:   $("hands-state"),
    ctrl:    $("ctrl-mode"),
    brain:   $("brain-state"),
    music:   $("music-state"),
    log:     $("log-feed"),
    jarvis:  $("jarvis-text"),
  };

  const stateLabels = {
    ACTIVE: "运行中", READY: "就绪", IDLE: "待机", OFFLINE: "未连接", LIVE: "已开启",
    SEARCHING: "寻找手部", "1 TRACKED": "已识别单手", MOUSE: "鼠标", HAND: "手势",
    "MAP · HAND": "星图 · 手势", "FILE-MAP": "文件星图", CHART: "数据图表",
    PULSE: "脉冲", "OPEN · ZOOM IN": "张掌 · 放大",
    "CLOSE · ZOOM OUT": "合拢 · 缩小", OFF: "关闭", "NO MODEL": "未安装模型",
    "2 TRACKED": "已识别双手", "SIZE · LOCKED": "保持大小 · 可旋转",
    "TWO HAND · HOLD": "双手 · 保持大小", "TWO HAND · ZOOM IN": "双手拉开 · 放大",
    "TWO HAND · ZOOM OUT": "双手合拢 · 缩小"
    , "POSE · LOCKED": "OK 锁定 · 大小与角度固定", "KNOWLEDGE · POINT": "锁定中 · 食指选笔记",
    "OK · ARMING": "OK 手势 · 保持半秒确认", "PULSE · ONE": "食指 1 · 脉冲"
  };

  // ---- live readouts ------------------------------------------------
  function setClock(d) {
    const p = (n) => String(n).padStart(2, "0");
    els.clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function setFPS(n)        { els.fps.textContent   = `${n} 帧/秒`; }
  function setCoreState(s)  { els.core.textContent  = stateLabels[s] || s; }
  function setHandsState(s) { els.hands.textContent = stateLabels[s] || s; }
  function setControlMode(s){ els.ctrl.textContent  = stateLabels[s] || s; }
  function setBrain(s)      { if (els.brain) els.brain.textContent = stateLabels[s] || s; }
  function setMusic(s)      { if (els.music) els.music.textContent = stateLabels[s] || s; }

  // ---- scrolling log feed ------------------------------------------
  function log(msg, level) {
    const line = document.createElement("div");
    line.className = "log-line" + (level ? " " + level : "");
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
    line.innerHTML = `<span class="t">${stamp}</span>${msg}`;
    els.log.prepend(line);
    while (els.log.children.length > 14) els.log.removeChild(els.log.lastChild);
  }

  // ---- JARVIS "speech" line with a typewriter effect ---------------
  let typing = null;
  function say(text) {
    if (typing) clearInterval(typing);
    els.jarvis.textContent = "";
    let i = 0;
    typing = setInterval(() => {
      els.jarvis.textContent += text[i++] || "";
      if (i >= text.length) { clearInterval(typing); typing = null; }
    }, 22);
  }
  function caption(text) {
    if (typing) { clearInterval(typing); typing = null; }
    els.jarvis.textContent = String(text || "").slice(0, 180);
  }

  window.HUD = { setClock, setFPS, setCoreState, setHandsState, setControlMode, setBrain, setMusic, log, say, caption };
})();
