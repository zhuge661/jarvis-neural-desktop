/* Low-latency PCM playback with a dry voice and restrained metallic resonance. */
(function () {
  "use strict";
  function effect(ctx, strength = 55) {
    const input = ctx.createGain(), amount = Math.max(0, Math.min(100, strength)) / 100;
    if (!amount) { input.connect(ctx.destination); return { input, dispose() { input.disconnect(); } }; }
    const high = ctx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = 110;
    const bass = ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 190; bass.gain.value = 4 * amount;
    const low = ctx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = 7000 - 1800 * amount;
    const dry = ctx.createGain(); dry.gain.value = .92;
    const metallic = ctx.createGain(); metallic.gain.value = 0;
    const carrier = ctx.createOscillator(); carrier.frequency.value = 62;
    const depth = ctx.createGain(); depth.gain.value = .19 * amount;
    const compressor = ctx.createDynamicsCompressor(); compressor.threshold.value = -18; compressor.ratio.value = 3;
    input.connect(high).connect(bass).connect(low);
    low.connect(dry).connect(compressor); low.connect(metallic).connect(compressor);
    // Two short, damped resonances add a metal-body texture without delaying
    // the main voice. Keep their return quiet so consonants remain clear.
    const resonance = ctx.createBiquadFilter(); resonance.type = "bandpass";
    resonance.frequency.value = 1150; resonance.Q.value = .65;
    low.connect(resonance);
    const resonators = [];
    for (const seconds of [.0067, .0103]) {
      const delay = ctx.createDelay(.05); delay.delayTime.value = seconds;
      const damping = ctx.createBiquadFilter(); damping.type = "lowpass"; damping.frequency.value = 3400;
      const feedback = ctx.createGain(); feedback.gain.value = .20;
      const wet = ctx.createGain(); wet.gain.value = .16 * amount;
      resonance.connect(delay); delay.connect(damping);
      damping.connect(feedback).connect(delay); damping.connect(wet).connect(compressor);
      resonators.push(delay, damping, feedback, wet);
    }
    carrier.connect(depth).connect(metallic.gain); carrier.start(); compressor.connect(ctx.destination);
    return { input, dispose() { carrier.stop(); [input, high, bass, low, dry, metallic, depth, resonance, ...resonators, compressor].forEach(n => n.disconnect()); } };
  }
  class PCMPlayer {
    constructor(ctx, strength) {
      this.ctx = ctx; this.fx = effect(ctx, strength); this.sources = new Set();
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.fx.input); this.levelFrame = 0;
      this.next = 0; this.bytes = 0; this.started = false;
    }
    enqueue(encoded) {
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      if (!bytes.length || bytes.length % 2) throw new Error("收到的 PCM 音频格式无效");
      if (this.next - this.ctx.currentTime > 15) throw new Error("语音播放积压，请重新连接");
      const buffer = this.ctx.createBuffer(1, bytes.length / 2, 24000);
      const view = new DataView(bytes.buffer), channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = this.ctx.createBufferSource(); source.buffer = buffer; source.connect(this.analyser);
      this.sources.add(source); this.bytes += bytes.length;
      source.onended = () => { this.sources.delete(source); source.disconnect(); if (!this.sources.size) this.notify(false); };
      const at = Math.max(this.ctx.currentTime + .025, this.next);
      source.start(at); this.next = at + buffer.duration; this.notify(true);
    }
    notify(value) {
      if (this.started === value) return;
      this.started = value;
      window.dispatchEvent(new CustomEvent("jarvis-voice-playback", { detail: value }));
      cancelAnimationFrame(this.levelFrame);
      if (value) this.measure();
      else window.dispatchEvent(new CustomEvent("jarvis-voice-level", { detail: 0 }));
    }
    measure() {
      this.analyser.getFloatTimeDomainData(this.samples);
      let energy = 0;
      for (const sample of this.samples) energy += sample * sample;
      window.dispatchEvent(new CustomEvent("jarvis-voice-level", {
        detail: Math.min(1, Math.sqrt(energy / this.samples.length) * 5),
      }));
      if (this.started) this.levelFrame = requestAnimationFrame(() => this.measure());
    }
    clear() {
      for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
      this.sources.clear(); this.next = 0; this.notify(false);
    }
    close() { this.clear(); cancelAnimationFrame(this.levelFrame); this.analyser.disconnect(); this.fx.dispose(); }
  }
  window.VoiceAudio = { effect, PCMPlayer };
})();
