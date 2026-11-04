/* Analyse the bundled music directly; no screen or system-audio capture. */
(function () {
  "use strict";
  let ctx, analyser, source, output, boost, limiter, media, data, raf = 0, on = false;
  const MUSIC_BOOST = 4;
  let lastBeat = 0, prevLow = 0, fluxAvg = 0, level = 0;
  function attach(audio, volume) {
    if (media) { if (media !== audio) throw new Error("背景音乐音源已连接"); return; }
    ctx = new AudioContext(); media = audio;
    source = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .8;
    output = ctx.createGain(); output.gain.value = volume;
    boost = ctx.createGain(); boost.gain.value = MUSIC_BOOST;
    limiter = ctx.createWaveShaper();
    const curve = new Float32Array(65537);
    for (let i = 0; i < curve.length; i++) {
      const x = 2 * i / (curve.length - 1) - 1, amplitude = Math.abs(x);
      curve[i] = amplitude <= .85 ? x : Math.sign(x) * (.85 + .13 * Math.tanh((amplitude - .85) / .13));
    }
    limiter.curve = curve; limiter.oversample = "4x";
    source.connect(analyser).connect(boost).connect(output).connect(limiter).connect(ctx.destination);
    data = new Uint8Array(analyser.frequencyBinCount);
    media.addEventListener("playing", () => { resume(); activate(); });
    media.addEventListener("pause", stop);
    window.addEventListener("pagehide", () => { stop(); ctx.close().catch(() => {}); });
  }
  function activate() {
    if (!media || media.paused || ctx.state !== "running" || on) return;
    on = true; HUD.setMusic("LIVE"); loop();
    window.dispatchEvent(new CustomEvent("jarvis-music-ready"));
  }
  function resume() {
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().then(activate).catch(() => {});
    else activate();
  }
  function stop() {
    on = false; level = 0; prevLow = fluxAvg = 0;
    cancelAnimationFrame(raf); raf = 0;
    if (window.Hologram) Hologram.reactAudio(null);
    if (window.HUD) HUD.setMusic("OFF");
  }
  function band(lo, hi) {
    let total = 0, count = 0;
    for (let i = lo; i < hi && i < data.length; i++) { total += data[i]; count++; }
    return count ? total / count / 255 : 0;
  }
  function loop() {
    if (!on) return;
    raf = requestAnimationFrame(loop); analyser.getByteFrequencyData(data);
    const bass = band(1, 8), mid = band(8, 40), treble = band(40, 120);
    level = (bass * 1.3 + mid + treble * .7) / 3;
    const low = band(1, 16), flux = Math.max(0, low - prevLow); prevLow = low;
    fluxAvg = fluxAvg * .9 + flux * .1;
    const now = performance.now();
    const beat = flux > fluxAvg * 1.6 + .012 && low > .22 && now - lastBeat > 200;
    if (beat) lastBeat = now;
    Hologram.reactAudio({ level, bass, mid, treble, beat });
  }
  window.AudioViz = { init() {}, attach, resume, stop, isOn: () => on,
    suspended: () => ctx?.state === "suspended",
    setVolume(value) { if (output) output.gain.value = value; },
    snapshot: () => ({ on, level, gain: output?.gain.value, boost: boost?.gain.value,
      contextState: ctx?.state }) };
})();
