/* ============================================================
   websearch.js — internet lookups (opt-in, cited) + YouTube
   The ONLY part of the UI that reaches the internet, and only
   when you explicitly ask:
     • /search <q> · /web <q> · "search the web for …" · "look up …"
       → a cited answer panel (local model summarises real results).
     • /youtube <q> · /yt <q> · "play <x> on youtube"
       → the top match embedded and playing in a holo-panel.
   It can also *offer* to search mid-chat when the brain looks unsure
   (you always click to confirm — nothing goes out on its own).
   Needs the core running (run_jarvis.bat). Exposed as `WebSearch`.
   ============================================================ */
(function () {
  "use strict";

  let coreOk = false;
  const H = () => window.HUD || { log() {}, say() {} };

  async function init() {
    try {
      const r = await fetch("api/health", { cache: "no-store" });
      if (r.ok) {
        coreOk = true;
        const h = await r.json();
        H().log(`搜索工具已就绪：/web、/youtube（来源：${h.search || "duckduckgo"}）`);
      }
    } catch (e) { coreOk = false; }
  }

  // ---- intent detection (return the query string, or null) ---------
  function looksLikeYouTube(t) {
    t = (t || "").trim();
    let m = t.match(/^\/(?:yt|youtube)\s+(.+)/i);
    if (m) return m[1].trim();
    m = t.match(/^(?:play\s+)?(.+?)\s+on\s+you\s*tube\b/i);   // "play X on youtube"
    if (m) return m[1].replace(/^play\s+/i, "").trim();
    m = t.match(/^you\s*tube\s+(.+)/i);                        // "youtube X"
    if (m) return m[1].trim();
    return null;
  }
  function looksLikeSearch(t) {
    t = (t || "").trim();
    const pats = [
      /^\/(?:search|web|google)\s+(.+)/i,
      /^search the web(?:\s+for)?\s+(.+)/i,
      /^web search(?:\s+for)?\s+(.+)/i,
      /^(?:can you\s+|please\s+)?look\s+up\s+(.+)/i,
      /^google\s+(.+)/i,
      /^search\s+for\s+(.+)/i,
    ];
    for (const p of pats) { const m = t.match(p); if (m) return m[1].trim().replace(/\?$/, ""); }
    return null;
  }

  // ---- web search --------------------------------------------------
  async function search(query) {
    query = (query || "").trim();
    if (!query) return;
    if (!coreOk) { H().say("联网搜索需要本地后端运行。"); return; }
    H().say(`正在搜索“${query}”…`);
    H().log("联网搜索：" + query);
    const p = panel("web-panel", "🌐 " + query);
    const body = p.querySelector(".web-body");
    body.innerHTML = '<div class="web-status">正在搜索…</div>';
    try {
      const res = await fetch("api/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const d = await res.json();
      if (!d.ok) {
        body.innerHTML = "";
        body.append(el("div", "web-status", d.error || "没有找到结果。"));
        H().say(d.error || "没有找到可用结果。");
        return;
      }
      renderAnswer(body, d);
      H().say("搜索完成，信息来源列在下方。");
    } catch (e) {
      body.innerHTML = "";
      body.append(el("div", "web-status", "搜索失败，请检查本地后端。"));
      H().log("联网搜索失败：" + e.message, "err");
    }
  }

  function renderAnswer(body, d) {
    body.innerHTML = "";
    const ans = el("div", "web-answer");
    ans.textContent = d.answer || "";       // textContent: never inject HTML from the web/model
    body.append(ans);
    if (d.sources && d.sources.length) {
      body.append(el("div", "web-src-label", "信息来源"));
      const list = el("div", "web-sources");
      for (const s of d.sources) {
        const row = el("div", "web-src");
        const n = el("span", "web-src-n", "[" + s.n + "]");
        const a = document.createElement("a");
        a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.className = "web-src-link"; a.textContent = s.title || s.url;
        a.title = s.url;
        row.append(n, a);
        list.append(row);
      }
      body.append(list);
    }
  }

  // ---- YouTube -----------------------------------------------------
  async function youtube(query) {
    query = (query || "").trim();
    if (!query) return;
    if (!coreOk) { H().say("YouTube 搜索需要本地后端运行。"); return; }
    H().say(`正在 YouTube 查找“${query}”…`);
    H().log("youtube: " + query);
    try {
      const res = await fetch("api/youtube?q=" + encodeURIComponent(query), { cache: "no-store" });
      const d = await res.json();
      if (!d.ok || !d.videoId) { H().say(d.error || "没有找到该视频。"); return; }
      playVideo(d);
    } catch (e) {
      H().say("YouTube 搜索失败，请检查本地后端。");
      H().log("YouTube 搜索失败：" + e.message, "err");
    }
  }

  function playVideo(d) {
    const p = panel("yt-panel", "▶ " + (d.title || "YouTube"), "media-panel");
    const body = p.querySelector(".web-body");
    body.innerHTML = "";
    const wrap = el("div", "yt-wrap");
    const ifr = document.createElement("iframe");
    ifr.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(d.videoId) + "?autoplay=1&rel=0";
    ifr.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    ifr.setAttribute("allowfullscreen", "");
    ifr.setAttribute("frameborder", "0");
    wrap.append(ifr);
    body.append(wrap);
    H().say(`正在播放：${d.title || "所选视频"}.`);
    if (window.Hologram) Hologram.pulse();
  }

  // ---- auto-offer a search when the brain looks unsure -------------
  async function maybeOffer(message) {
    if (!coreOk) return;
    try {
      const res = await fetch("api/search/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const d = await res.json();
      if (d && d.suggest) addOffer(message);
    } catch (e) { /* silent — offering is best-effort */ }
  }

  function addOffer(message) {
    const log = document.getElementById("chat-log");
    if (!log) return;
    if (log.querySelector('.web-offer[data-for="' + cssEsc(message) + '"]')) return;
    const d = el("div", "chat-msg jarvis web-offer");
    d.setAttribute("data-for", message);
    d.append(el("span", "who", "JARVIS"));
    const t = el("span", "txt", "这可能需要最新信息，要联网搜索吗？");
    const btn = el("button", "offer-btn", "联网搜索");
    btn.addEventListener("click", () => { d.remove(); search(message); });
    const no = el("button", "offer-btn ghost", "暂不");
    no.addEventListener("click", () => d.remove());
    t.append(btn, no);
    d.append(t);
    log.append(d);
    log.scrollTop = log.scrollHeight;
  }

  // ---- shared panel + tiny helpers ---------------------------------
  function panel(id, title, extraClass) {
    let p = document.getElementById(id);
    if (p) { p.querySelector(".holo-title").textContent = title; p.style.display = "flex"; return p; }
    p = document.createElement("div");
    p.className = "holo-panel web-holo " + (extraClass || "");
    p.id = id;
    p.innerHTML =
      '<div class="holo-bar"><span class="holo-title"></span>' +
      '<button class="holo-x" title="关闭">&times;</button></div>' +
      '<div class="web-body"></div>';
    p.querySelector(".holo-title").textContent = title;
    dragify(p, p.querySelector(".holo-bar"));
    p.querySelector(".holo-x").addEventListener("click", () => p.remove());
    document.getElementById("panels").append(p);
    p.style.left = Math.max(24, (window.innerWidth - 520) / 2) + "px";
    p.style.top = "12%";
    return p;
  }
  function dragify(p, bar) {
    let dx = 0, dy = 0, drag = false;
    bar.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("holo-x")) return;
      drag = true; dx = e.clientX - p.offsetLeft; dy = e.clientY - p.offsetTop; p.style.zIndex = 43;
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return; p.style.left = (e.clientX - dx) + "px"; p.style.top = (e.clientY - dy) + "px";
    });
    window.addEventListener("mouseup", () => { drag = false; });
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  window.WebSearch = {
    init, search, youtube, maybeOffer, looksLikeSearch, looksLikeYouTube,
    isOnline: () => coreOk,
  };
})();
