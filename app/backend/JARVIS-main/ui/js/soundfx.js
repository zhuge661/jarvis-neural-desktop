/* Local pink-noise water, C6 drops and four-second reverb. */
(function () {
  "use strict";
  let reverb, waterfallVol, waterfallFilter, waterfallNoise, pulseSynth;
  let preparing = null, ready = false, effects = true, water = false;
  let speaking = false, microphone = false;
  let actionContext, actionMaster, effectsVolume, waterVolume, zoomTone, zoomGain, zoomTimer, lastZoom = 0;
  const counts = { lock: 0, open: 0, close: 0, zoomIn: 0, zoomOut: 0 };
  const $ = (id) => document.getElementById(id);
  async function prepare() {
    if (ready) { await Tone.start(); return; }
    if (preparing) return preparing;
    preparing = (async () => {
      await Tone.start();
      reverb = new Tone.Reverb({ decay: 4, wet: 0.6 }).toDestination();
      await reverb.ready;
      waterfallFilter = new Tone.Filter(400, "lowpass");
      waterfallVol = new Tone.Volume(-100).connect(reverb);
      waterfallFilter.connect(waterfallVol);
      waterfallNoise = new Tone.Noise("pink").connect(waterfallFilter).start();
      pulseSynth = new Tone.MembraneSynth({
        pitchDecay: .03, octaves: 6, oscillator: { type: "sine" },
        envelope: { attack: .001, decay: .6, sustain: 0, release: 1 },
      }).connect(reverb);
      pulseSynth.volume.value = -4;
      ready = true;
      mix();
    })();
    try { await preparing; } finally { preparing = null; }
  }
  function mix() {
    const waterLevel = waterVolume?.value() ?? .5, effectLevel = effectsVolume?.value() ?? .5;
    if (waterfallVol) waterfallVol.volume.rampTo(water && waterLevel > 0 && !speaking && !microphone
      ? -18 + 20 * Math.log10(waterLevel / .5) : -100, .15);
    if (pulseSynth) pulseSynth.volume.rampTo(effects && effectLevel > 0 ? -4 + 20 * Math.log10(effectLevel / .5) : -100, .02);
    if (actionMaster) actionMaster.gain.setTargetAtTime(effects ? effectLevel * 2 : 0, actionContext.currentTime, .01);
  }
  function drop() {
    if (ready && effects && !speaking && !microphone) {
      pulseSynth.triggerAttackRelease("C6", "8n");
    }
  }
  function height(ny) {
    if (waterfallFilter) waterfallFilter.frequency.rampTo(Math.max(200, Math.min(1200, 700 - ny * 500)), .1);
  }
  function unlock() {
    try {
      if (!actionContext) {
        actionContext = new AudioContext({ latencyHint: "interactive" });
        actionMaster = actionContext.createGain(); actionMaster.gain.value = effects ? (effectsVolume?.value() ?? .5) * 2 : 0;
        actionMaster.connect(actionContext.destination);
      }
      if (actionContext.state === "suspended") actionContext.resume().catch(() => {});
    } catch (_) { /* Visual controls still work when audio is unavailable. */ }
  }
  function cue(kind) {
    if (!effects) return;
    unlock();
    if (!actionContext || actionContext.state !== "running") return;
    counts[kind]++;
    const ctx = actionContext, at = ctx.currentTime, gain = ctx.createGain(), osc = ctx.createOscillator();
    const quiet = speaking || microphone ? .3 : 1;
    osc.type = kind === "lock" ? "triangle" : "sine";
    const from = kind === "lock" ? 1500 : kind === "open" ? 330 : 1250;
    const to = kind === "lock" ? 2100 : kind === "open" ? 1400 : 240;
    osc.frequency.setValueAtTime(from, at); osc.frequency.exponentialRampToValueAtTime(to, at + .13);
    gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.09 * quiet, at + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, at + .19);
    osc.connect(gain).connect(actionMaster); osc.start(at); osc.stop(at + .2);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
  function zoom(before, after) {
    if (!effects || Math.abs(after - before) < .004 || performance.now() - lastZoom < 110) return;
    unlock();
    if (!actionContext || actionContext.state !== "running") return;
    lastZoom = performance.now();
    const expanding = after < before, ctx = actionContext, at = ctx.currentTime;
    counts[expanding ? "zoomIn" : "zoomOut"]++;
    if (!zoomTone) {
      zoomTone = ctx.createOscillator(); zoomTone.type = "sine";
      zoomGain = ctx.createGain(); zoomGain.gain.value = 0;
      zoomTone.connect(zoomGain).connect(actionMaster); zoomTone.start();
    }
    zoomTone.frequency.cancelScheduledValues(at);
    zoomTone.frequency.setValueAtTime(expanding ? 520 : 540, at);
    zoomTone.frequency.exponentialRampToValueAtTime(expanding ? 1050 : 260, at + .15);
    zoomGain.gain.cancelScheduledValues(at); zoomGain.gain.setTargetAtTime((speaking || microphone ? .006 : .025), at, .015);
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => { zoomGain.gain.setTargetAtTime(0, ctx.currentTime, .025); }, 160);
  }
  function action(id, fn) {
    $(id).addEventListener("click", async () => {
      const button = $(id); button.disabled = true;
      try { await prepare(); fn(button); }
      catch (error) { HUD.log("音效暂不可用：" + error.message, "warn"); }
      finally { button.disabled = false; }
    });
  }
  function init() {
    effectsVolume = AudioVolumes.bind("effects", 50, mix); effectsVolume.show(effects);
    waterVolume = AudioVolumes.bind("water", 50, mix); waterVolume.show(water);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    action("btn-effects", (button) => {
      effects = !effects;
      effectsVolume.show(effects); mix();
      if (!effects && zoomGain) zoomGain.gain.setTargetAtTime(0, actionContext.currentTime, .01);
      button.textContent = effects ? "♫ 关闭交互音效" : "♫ 开启交互音效";
      button.classList.toggle("active", effects);
      if (effects) drop();
    });
    action("btn-water", (button) => {
      water = !water; waterVolume.show(water); mix();
      button.textContent = water ? "≋ 关闭水声" : "≋ 开启水声";
      button.classList.toggle("active", water);
      if (water && microphone) HUD.say("水声已启用；语音对话期间自动静音，关闭麦克风后恢复。");
    });
    $("btn-formation")?.addEventListener("click", () => {
      const index = Hologram.cycleFormation();
      HUD.say("核心形态：" + ["晶体神经球", "双螺旋网络", "分形神经树"][index]);
    });
    window.addEventListener("jarvis-voice-playback", (event) => { speaking = event.detail; mix(); });
    window.addEventListener("jarvis-microphone", (event) => { microphone = event.detail; mix(); });
    window.addEventListener("pagehide", () => {
      if (waterfallNoise) waterfallNoise.stop();
      clearTimeout(zoomTimer); if (actionContext) actionContext.close().catch(() => {});
    });
  }
  window.SoundFX = { init, drop, height, cue, zoom, snapshot: () => ({ effects, water,
    effectsVolume: effectsVolume?.value(), waterVolume: waterVolume?.value(),
    actionGain: actionMaster?.gain.value, waterDb: waterfallVol?.volume.value, ...counts }) };
})();
