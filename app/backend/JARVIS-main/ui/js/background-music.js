/* Bundled 48-second loop with automatic visualization and independent gain. */
(function () {
  "use strict";
  let audio, button, wanted = true, blocked = false, pending, mediaURL;
  let speaking = false, microphone = false, ramp, volumeControl, currentVolume = .10;
  function paint() {
    button.disabled = !!pending;
    button.classList.toggle("active", wanted && !audio.paused && !blocked);
    button.textContent = pending ? "♪ 正在加载音乐…" : !wanted ? "♪ 开启背景音乐" : audio.paused || blocked ? "▶ 开启背景音乐" : "♪ 关闭背景音乐";
    volumeControl.show(wanted);
  }
  function mix() {
    clearInterval(ramp);
    const target = volumeControl.value() * Math.min(1, speaking ? .12 : 1, microphone ? .05 : 1);
    ramp = setInterval(() => {
      currentVolume += (target - currentVolume) * (currentVolume > target ? .65 : .08);
      if (Math.abs(currentVolume - target) < .0002) { currentVolume = target; clearInterval(ramp); }
      AudioViz.setVolume(currentVolume);
    }, 16);
  }
  async function start() {
    if (!wanted || pending) return;
    AudioViz.resume();
    pending = (async () => {
      if (!mediaURL) {
        const response = await fetch("audio/bgm/supercluster-first-48s.wav");
        if (!response.ok) throw new Error("内置背景音乐读取失败");
        // The local static server has no byte-range support. A complete local
        // Blob lets the decoder seek and wrap the loop without an HTTP seek.
        mediaURL = URL.createObjectURL(await response.blob()); audio.src = mediaURL;
      }
      // Let the media element obtain playback permission before attaching a
      // Web Audio graph; a suspended graph can otherwise leave play() pending.
      if (!AudioViz.snapshot().contextState) audio.volume = currentVolume;
      await audio.play();
      AudioViz.attach(audio, currentVolume); audio.volume = 1; AudioViz.resume();
    })();
    paint();
    try { await pending; blocked = AudioViz.suspended(); if (!wanted) audio.pause(); }
    catch (error) {
      blocked = error.name === "NotAllowedError";
      if (!blocked) HUD.log("背景音乐暂不可用，请检查内置音频文件。", "warn");
    } finally { pending = null; paint(); }
  }
  function init() {
    button = document.getElementById("btn-bgm");
    volumeControl = AudioVolumes.bind("bgm", 10, mix); currentVolume = volumeControl.value();
    try { wanted = localStorage.getItem("jarvis-bgm-enabled") !== "false"; } catch (_) {}
    audio = document.createElement("audio"); audio.id = "background-music";
    audio.loop = true; audio.preload = "auto"; audio.volume = 1; audio.hidden = true;
    document.body.append(audio);
    audio.addEventListener("playing", paint); audio.addEventListener("pause", paint);
    button.addEventListener("click", () => {
      // A blocked automatic start is resumed by this first click.
      wanted = blocked || !wanted;
      try { localStorage.setItem("jarvis-bgm-enabled", String(wanted)); } catch (_) {}
      if (wanted) start(); else { audio.pause(); AudioViz.stop(); } paint();
    });
    const unlock = event => {
      if (wanted) AudioViz.resume();
      if (wanted && blocked && !button.contains(event.target)) start();
    };
    window.addEventListener("pointerdown", unlock); window.addEventListener("keydown", unlock);
    window.addEventListener("jarvis-music-ready", () => { blocked = false; paint(); });
    window.addEventListener("jarvis-voice-playback", event => { speaking = Boolean(event.detail); mix(); });
    window.addEventListener("jarvis-microphone", event => { microphone = Boolean(event.detail); mix(); });
    window.addEventListener("pagehide", () => {
      audio.pause(); clearInterval(ramp);
      if (mediaURL) URL.revokeObjectURL(mediaURL);
    });
    paint(); if (wanted) start();
  }
  window.BackgroundMusic = { init, snapshot: () => ({ enabled: wanted, playing: !!audio && !audio.paused,
    loop: audio?.loop, blocked, loading: !!pending, volume: currentVolume, settingVolume: volumeControl?.value(),
    visualizing: !!window.AudioViz?.isOn(), time: audio?.currentTime, duration: audio?.duration }) };
})();
