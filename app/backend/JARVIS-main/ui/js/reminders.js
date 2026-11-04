/* ============================================================
   reminders.js — reminders & scheduler client
   Talks to the local core (core/server.py + core/reminders.py).
   Creates reminders from natural language ("remind me …" or
   /remind), polls /api/notifications, and when one is due it:
     • pops a desktop notification (Web Notifications API),
     • speaks it on the HUD line + pulses the core,
     • plays a soft two-tone chime (Web Audio, fully local),
     • lists it in a due panel with Dismiss / Snooze controls.
   /reminders opens a panel of everything scheduled.
   Needs the core running (run_jarvis.bat). Exposed as `Reminders`.
   ============================================================ */
(function () {
  "use strict";

  const POLL_MS = 15000;
  let coreOk = false, polling = false, actx = null;
  const active = new Map();   // id -> reminder currently shown as "due"

  // ---- helpers -----------------------------------------------------
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ cache: "no-store" }, opts));
    if (!r.ok && r.status !== 400) throw new Error("http " + r.status);
    return r.json();
  }
  const H = () => window.HUD || { log() {}, say() {} };

  function looksLikeReminder(t) {
    t = (t || "").trim();
    if (/^\/remind\b/i.test(t)) return true;
    const low = t.toLowerCase();
    if (!/^(remind me|remind|set a reminder|set reminder|nudge me|reminder)\b/.test(low)) return false;
    if (t.endsWith("?")) return false;   // "remind me why …" is a question, not a reminder
    const rest = low.replace(
      /^(remind me to|remind me that|remind me|set a reminder to|set a reminder|set reminder to|nudge me to|nudge me|reminder to|reminder)\b[:,]?\s*/,
      "");
    if (/^(why|what|how|who|when|where|which|is|are|do|does|can|could|will|would)\b/.test(rest)) return false;
    return true;
  }

  // ---- init --------------------------------------------------------
  async function init() {
    try {
      await api("api/reminders");           // 200 only when the core is running
      coreOk = true;
      H().log("提醒功能已就绪，可输入 /reminders 查看列表");
      startPolling();
    } catch (e) {
      coreOk = false;
      H().log("提醒后端未连接", "warn");
    }
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    poll();
    setInterval(poll, POLL_MS);
  }

  // ---- create ------------------------------------------------------
  async function create(raw) {
    raw = (raw || "").trim();
    if (!raw) return;
    if (!coreOk) {
      H().say("提醒功能需要本地后端运行。");
      return;
    }
    ensureAudio();
    requestNotify();
    try {
      const res = await api("api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      if (res.ok) {
        const r = res.reminder;
        H().say(`已记录：${r.text}. ${r.repeat ? "重复提醒：" : ""}${r.when}.`);
        H().log(`提醒已设置：${r.text} · ${r.when}`);
        if (window.Hologram) Hologram.pulse();
        poll();
      } else {
        H().say(res.error || "无法识别提醒时间。");
        H().log("提醒未设置：" + (res.error || "解析失败"), "warn");
      }
    } catch (e) {
      H().say("提醒服务未响应，请检查本地后端。");
      H().log("创建提醒失败：" + e.message, "err");
    }
  }

  // ---- poll for due reminders -------------------------------------
  async function poll() {
    if (!coreOk) return;
    let due;
    try {
      due = (await api("api/notifications")).due || [];
    } catch (e) { return; }

    const seen = new Set(due.map((d) => d.id));
    for (const d of due) {
      if (!active.has(d.id)) { active.set(d.id, d); announce(d); }
    }
    for (const id of Array.from(active.keys())) {
      if (!seen.has(id)) active.delete(id);   // acknowledged elsewhere / rolled forward
    }
    renderDue();
  }

  function announce(r) {
    H().say(`提醒：${r.text}.`);
    H().log("⏰ 提醒到期：" + r.text);
    desktopNotify(r);
    chime();
    if (window.Hologram) { Hologram.pulse(); setTimeout(Hologram.pulse, 260); }
  }

  // ---- desktop notification ---------------------------------------
  function requestNotify() {
    try {
      if ("Notification" in window && Notification.permission === "default")
        Notification.requestPermission();
    } catch (e) { /* ignore */ }
  }
  function desktopNotify(r) {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification("贾维斯 — 提醒", {
          body: r.text + (r.when ? "\n" + r.when : ""), tag: r.id,
        });
        n.onclick = () => { window.focus(); n.close(); };
      }
    } catch (e) { /* ignore */ }
  }

  // ---- chime (Web Audio, no assets) -------------------------------
  function ensureAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
    } catch (e) { /* ignore */ }
  }
  function chime() {
    ensureAudio();
    if (!actx) return;
    try {
      const now = actx.currentTime;
      [880, 1174.66].forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = "sine"; o.frequency.value = f;
        o.connect(g); g.connect(actx.destination);
        const t = now + i * 0.17;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
        o.start(t); o.stop(t + 0.36);
      });
    } catch (e) { /* ignore */ }
  }

  // ---- panels ------------------------------------------------------
  function makeDraggable(p, bar) {
    let dx = 0, dy = 0, drag = false;
    bar.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("holo-x")) return;
      drag = true; dx = e.clientX - p.offsetLeft; dy = e.clientY - p.offsetTop; p.style.zIndex = 42;
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return; p.style.left = (e.clientX - dx) + "px"; p.style.top = (e.clientY - dy) + "px"; p.style.right = "auto";
    });
    window.addEventListener("mouseup", () => { drag = false; });
  }

  function duePanel() {
    let p = document.getElementById("reminder-due");
    if (p) return p;
    p = document.createElement("div");
    p.className = "holo-panel reminder-panel";
    p.id = "reminder-due";
    p.innerHTML =
      '<div class="holo-bar"><span class="holo-title">&#9200; 到期提醒</span>' +
      '<button class="holo-x" title="隐藏">&times;</button></div>' +
      '<div class="rem-body"></div>';
    makeDraggable(p, p.querySelector(".holo-bar"));
    p.querySelector(".holo-x").addEventListener("click", () => p.remove());
    document.getElementById("panels").append(p);
    p.style.left = Math.max(20, window.innerWidth - 360) + "px";
    p.style.top = "92px";
    return p;
  }

  function renderDue() {
    const existing = document.getElementById("reminder-due");
    if (active.size === 0) { if (existing) existing.remove(); return; }
    const p = duePanel();
    const body = p.querySelector(".rem-body");
    body.innerHTML = "";
    for (const r of active.values()) {
      const row = document.createElement("div");
      row.className = "rem-item";
      row.innerHTML =
        `<div class="rem-text">${esc(r.text)}</div>` +
        `<div class="rem-when">${esc(r.when || "")}</div>` +
        '<div class="rem-actions">' +
        '<button class="rem-btn" data-act="dismiss">完成</button>' +
        '<button class="rem-btn" data-act="snooze">10 分钟后提醒</button></div>';
      row.querySelector('[data-act="dismiss"]').addEventListener("click", () => act("dismiss", r.id));
      row.querySelector('[data-act="snooze"]').addEventListener("click", () => act("snooze", r.id));
      body.append(row);
    }
  }

  async function act(kind, id) {
    active.delete(id);
    renderDue();
    try {
      if (kind === "dismiss") await api("api/reminders/dismiss", postBody({ id }));
      else await api("api/reminders/snooze", postBody({ id, minutes: 10 }));
      H().log("reminder " + kind + "ed");
    } catch (e) { H().log("reminder " + kind + " failed: " + e.message, "err"); }
    poll();
  }

  // ---- list panel (/reminders) ------------------------------------
  async function list() {
    if (!coreOk) { H().say("提醒服务尚未连接。"); return; }
    let data;
    try { data = await api("api/reminders"); }
    catch (e) { H().say("无法连接提醒服务。"); return; }
    const p = listPanel();
    const body = p.querySelector(".rem-body");
    const pending = data.pending || [];
    body.innerHTML = "";
    if (!pending.length) {
      body.innerHTML = '<div class="rem-empty">暂无提醒。原版提醒时间解析使用英文，可输入 /remind take a break in 20 min。</div>';
    } else {
      for (const r of pending) {
        const row = document.createElement("div");
        row.className = "rem-item";
        row.innerHTML =
          `<div class="rem-text">${esc(r.text)} ${r.repeat ? '<span class="rem-tag">重复</span>' : ""}</div>` +
          `<div class="rem-when">${esc(r.when || "")}</div>` +
          '<div class="rem-actions"><button class="rem-btn" data-act="delete">删除</button></div>';
        row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
          row.remove();
          try { await api("api/reminders/delete", postBody({ id: r.id })); H().log("提醒已删除"); }
          catch (e) { /* ignore */ }
        });
        body.append(row);
      }
    }
    H().log(`已安排 ${pending.length} 条提醒`);
  }

  function listPanel() {
    let p = document.getElementById("reminder-list");
    if (p) { p.style.display = "block"; return p; }
    p = document.createElement("div");
    p.className = "holo-panel reminder-panel";
    p.id = "reminder-list";
    p.innerHTML =
      '<div class="holo-bar"><span class="holo-title">&#9200; 提醒列表</span>' +
      '<button class="holo-x" title="关闭">&times;</button></div>' +
      '<div class="rem-body"></div>';
    makeDraggable(p, p.querySelector(".holo-bar"));
    p.querySelector(".holo-x").addEventListener("click", () => p.remove());
    document.getElementById("panels").append(p);
    p.style.left = "40px";
    p.style.top = "110px";
    return p;
  }

  // ---- utils -------------------------------------------------------
  function postBody(obj) {
    return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  window.Reminders = { init, create, list, looksLikeReminder, isOnline: () => coreOk };
})();
