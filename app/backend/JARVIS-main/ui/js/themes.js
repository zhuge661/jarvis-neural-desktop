/* ============================================================
   themes.js — recolour the whole interface + core
   Sets --cyan / --gold CSS variables (the HUD derives its soft
   tints from them via color-mix) and shifts the hologram's base
   hue to match. Choice persists in localStorage.
   Button ◈ THEME cycles; /theme <name> picks. Exposed as `Themes`.
   ============================================================ */
(function () {
  "use strict";

  const THEMES = {
    cyan:    { name: "电弧青蓝",      cyan: "#35e0ff", gold: "#ffb648", hue: 0.52 },
    gold:    { name: "能量金", cyan: "#ffc861", gold: "#35e0ff", hue: 0.11 },
    crimson: { name: "装甲赤红",cyan: "#ff5a6a", gold: "#ffcf6b", hue: 0.99 },
    stealth: { name: "隐形银灰",       cyan: "#b8c6d4", gold: "#7aa0b8", hue: 0.57 },
  };
  const order = ["cyan", "gold", "crimson", "stealth"];
  let current = "cyan";

  function apply(key) {
    if (!(key in THEMES)) key = "cyan";
    current = key;
    const t = THEMES[key];
    const r = document.documentElement.style;
    r.setProperty("--cyan", t.cyan);
    r.setProperty("--gold", t.gold);
    if (window.Hologram && Hologram.setAccentBase) Hologram.setAccentBase(t.hue);
    try { localStorage.setItem("jarvis-theme", key); } catch (e) {}
    if (window.HUD) { HUD.log("配色切换 → " + t.name); HUD.say(`${t.name} 配色已启用。`); }
  }

  function set(name) {
    const q = (name || "").toLowerCase().trim();
    const key = order.find((k) => k === q || THEMES[k].name.toLowerCase().indexOf(q) === 0);
    apply(key || current);
  }
  function cycle() { apply(order[(order.indexOf(current) + 1) % order.length]); }

  function init() {
    let saved = "gold";
    try { saved = localStorage.getItem("jarvis-theme") || "gold"; } catch (e) {}
    apply(saved);
    const b = document.getElementById("btn-theme");
    if (b) b.addEventListener("click", cycle);
  }

  window.Themes = { init, set, cycle };
})();
