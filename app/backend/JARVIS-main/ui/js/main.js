/* ============================================================
   main.js — orchestrates the interface
   Boots the hologram, runs the JARVIS intro, wires the controls.
   ============================================================ */
(function () {
  "use strict";

  // ---- boot ---------------------------------------------------------
  function boot() {
    if (new URLSearchParams(location.search).get("desktop") === "1") {
      const subtitle = document.querySelector(".hud-title .sub");
      if (subtitle) subtitle.textContent = "本机全息控制台";
    }
    const hud = document.getElementById("hud");
    hud.classList.add("booting");

    try {
      Hologram.init(document.getElementById("scene"));
      HUD.setCoreState("ACTIVE");
    } catch (e) {
      HUD.log("渲染器启动失败：" + e.message, "err");
    }

    try { Workspace.init(); } catch (e) { HUD.log("控制台初始化失败：" + e.message, "err"); }
    try { Backend.init(); } catch (e) { HUD.log("模型设置初始化失败：" + e.message, "err"); }
    try { Brain.init(); } catch (e) { HUD.log("模型后端初始化失败：" + e.message, "err"); }
    try { Voice.init(); } catch (e) { HUD.log("语音初始化失败：" + e.message, "err"); }
    try { SoundFX.init(); } catch (e) { HUD.log("交互音效初始化失败：" + e.message, "err"); }
    try { BackgroundMusic.init(); } catch (e) { HUD.log("背景音乐初始化失败：" + e.message, "err"); }
    try { AudioViz.init(); } catch (e) { HUD.log("音频初始化失败：" + e.message, "err"); }
    try { FileMap.init(); } catch (e) { HUD.log("文件星图初始化失败：" + e.message, "err"); }
    try { Themes.init(); } catch (e) { HUD.log("配色初始化失败：" + e.message, "err"); }
    try { Charts.init(); } catch (e) { HUD.log("图表初始化失败：" + e.message, "err"); }
    try { Reminders.init(); } catch (e) { HUD.log("提醒初始化失败：" + e.message, "err"); }
    try { WebSearch.init(); } catch (e) { HUD.log("搜索初始化失败：" + e.message, "err"); }

    // live clock
    setInterval(() => HUD.setClock(new Date()), 1000);
    HUD.setClock(new Date());

    bootSequence();
    wireControls();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Greet by time of day, JARVIS-style
  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return "早上好。";
    if (h < 18) return "下午好。";
    return "晚上好。";
  }

  function bootSequence() {
    const steps = [
      [200,  () => HUD.log("能量核心…已就绪")],
      [700,  () => HUD.log("全息投影…校准完成")],
      [1300, () => HUD.log("手势识别…等待启用")],
      [1900, () => HUD.setCoreState("READY")],
      [2100, () => HUD.say(`${greeting()} 全息界面已启动。`)],
      [4200, () => HUD.say("点击“启用手势识别”，或先用鼠标拖动、滚轮缩放体验。")],
    ];
    steps.forEach(([t, fn]) => setTimeout(fn, t));
  }

  // ---- controls -----------------------------------------------------
  function wireControls() {
    const btnHands = document.getElementById("btn-hands");
    const btnPulse = document.getElementById("btn-pulse");
    const btnReset = document.getElementById("btn-reset");

    btnHands.addEventListener("click", async () => {
      btnHands.classList.add("busy");
      btnHands.disabled = true;
      const on = await HandTracking.toggle();
      btnHands.classList.remove("busy");
      btnHands.disabled = false;
      btnHands.classList.toggle("active", on);
      btnHands.textContent = on ? "◉ 手势识别已开启" : "◉ 启用手势识别";
    });

    btnPulse.addEventListener("click", () => { Hologram.pulse(); HUD.log("手动释放脉冲"); });
    btnReset.addEventListener("click", () => { Hologram.reset(); HUD.log("视角已重置"); HUD.say("已恢复默认视角。"); });

    // keyboard shortcuts — ignored while typing in the deck bar / any field
    window.addEventListener("keydown", (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.code === "Space") { e.preventDefault(); Hologram.pulse(); }
      if (e.key === "r" || e.key === "R") Hologram.reset();
      if (e.key === "h" || e.key === "H") btnHands.click();
    });
  }
})();
