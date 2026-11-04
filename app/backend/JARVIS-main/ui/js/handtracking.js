/* ============================================================
   handtracking.js — real-time webcam hand tracking (MediaPipe)
   Palm rotation and latched TWO-HAND zoom with One-Euro smoothing.

   Control scheme:
     • move open hand         → rotate the core (palm-based, steady)
     • two open palms apart / together → zoom in / out
     • release either palm    → keep current size; reacquire relatively
     • hold an OK sign         → lock pose; reopen that hand to unlock
     • one raised index finger → one pulse per gesture (unlocked only)

   Single-hand input never changes zoom. Skeleton rendering is disabled.
   Exposed globally as `HandTracking`.
   ============================================================ */
(function () {
  "use strict";

  const VER = "0.10.35";
  const CDN_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/vision_bundle.mjs`;
  const CDN_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/wasm`;
  const CDN_MODEL  = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

  const NUM_HANDS = 2;

  // rotation
  const ROT_SENS = 1.05, ROT_DEADZONE = 0.04;
  // Relative zoom from two open palm centres; latch on release.
  const ZOOM_NEAR = 3, ZOOM_FAR = 11;
  const ZOOM_DEADZONE = 0.012, ZOOM_ARM_MS = 120;
  const OK_HOLD_MS = 450, PULSE_HOLD_MS = 240;

  const PALM = [0, 5, 9, 13, 17];
  const TIPS = [4, 8, 12, 16, 20];

  const url = (p) => new URL(p, document.baseURI).href;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---- One-Euro filter: low-jitter, low-lag smoothing --------------
  class OneEuro {
    constructor(minCutoff = 1.3, beta = 0.015, dCutoff = 1.0) {
      this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
      this.xPrev = null; this.dxPrev = 0; this.tPrev = null;
    }
    _a(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
    reset() { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
    filter(x, t) {
      if (this.xPrev === null) { this.xPrev = x; this.tPrev = t; return x; }
      let dt = t - this.tPrev; if (dt <= 0) dt = 1 / 60; this.tPrev = t;
      const dx = (x - this.xPrev) / dt;
      const aD = this._a(this.dCutoff, dt);
      const dxHat = aD * dx + (1 - aD) * this.dxPrev; this.dxPrev = dxHat;
      const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
      const a = this._a(cutoff, dt);
      const xHat = a * x + (1 - a) * this.xPrev; this.xPrev = xHat;
      return xHat;
    }
  }
  const fx = new OneEuro(1.3, 0.015), fy = new OneEuro(1.3, 0.015), fz = new OneEuro(0.9, 0.008);

  let landmarker = null, video, overlay, octx;
  let running = false, rafHands = 0, lastSeen = 0;
  let lockCandidate = null, pulseSince = 0, pulseFrames = 0, pulseFired = false;
  let zoomGrip = null;
  let poseLocked = false, lockOwner = null, reopenSince = 0, twoPalmSince = null;
  const fingerX = new OneEuro(2.5, .03), fingerY = new OneEuro(2.5, .03);
  let consumer = null;   // when set (e.g. by the file-map), hand input routes here, not the core

  async function resolveModel() {
    const local = url("vendor/mediapipe/hand_landmarker.task");
    try { const r = await fetch(local, { method: "HEAD" }); if (r.ok) { HUD.log("手势模型：本地文件"); return local; } }
    catch (e) { /* not vendored yet */ }
    HUD.log("手势模型：在线加载，可运行离线资源脚本下载到本机", "warn");
    return CDN_MODEL;
  }

  async function loadLandmarker() {
    let mod;
    try {
      mod = await import(url("vendor/mediapipe/vision_bundle.mjs"));
      HUD.log("手势引擎：本地文件");
    } catch (e) {
      HUD.log("本地手势引擎缺失，正在尝试联网加载", "warn");
      try { mod = await import(CDN_BUNDLE); }
      catch (e2) {
        throw new Error("手势引擎文件缺失，请运行离线资源下载脚本");
      }
    }
    const { FilesetResolver, HandLandmarker } = mod;

    let fileset;
    try { fileset = await FilesetResolver.forVisionTasks(url("vendor/mediapipe/wasm")); }
    catch (e) { HUD.log("本地 WASM 引擎缺失，正在联网加载", "warn"); fileset = await FilesetResolver.forVisionTasks(CDN_WASM); }

    const modelAssetPath = await resolveModel();
    const opts = { baseOptions: { modelAssetPath }, runningMode: "VIDEO", numHands: NUM_HANDS,
                   minHandDetectionConfidence: 0.6, minTrackingConfidence: 0.6 };
    try { opts.baseOptions.delegate = "GPU"; return await HandLandmarker.createFromOptions(fileset, opts); }
    catch (e) {
      HUD.log("GPU 初始化失败，正在切换 CPU", "warn");
      opts.baseOptions.delegate = "CPU";
      try { return await HandLandmarker.createFromOptions(fileset, opts); }
      catch (e2) {
        throw new Error("手势模型初始化失败，请重新下载本地模型和引擎");
      }
    }
  }

  function sizeOverlay() { overlay.width = window.innerWidth; overlay.height = window.innerHeight; }

  async function enable() {
    if (running) return true;
    video = document.getElementById("webcam");
    overlay = document.getElementById("overlay");
    octx = overlay.getContext("2d");
    sizeOverlay();
    window.addEventListener("resize", sizeOverlay);

    if (location.protocol === "file:") {
      HUD.log("请通过启动脚本打开本机网页，直接双击 HTML 会阻止摄像头和引擎", "err");
      HUD.say("请使用“启动第三个中文版.cmd”，不要直接双击 HTML 文件。");
      return false;
    }

    HUD.say("正在启动手势识别；如出现权限提示，请允许使用摄像头…");
    HUD.log("正在初始化手势识别引擎…");

    try { landmarker = await loadLandmarker(); }
    catch (e) {
      const msg = (e && (e.message || e.name)) || String(e) || "unknown error";
      HUD.log("手势引擎加载失败：" + msg, "err");
      HUD.say("手势引擎暂不可用，请检查本地资源；仍可用鼠标操作。");
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      video.srcObject = stream;
      await new Promise((res) => (video.onloadeddata = res));
      video.classList.add("live");
    } catch (e) {
      HUD.log("摄像头被拒绝或不可用：" + e.message, "err");
      HUD.say(e.name === "NotReadableError" || /in use/i.test(e.message)
        ? "摄像头正被其他窗口占用，请先关闭旧网页或其他软件的摄像头，再启用手势识别。"
        : "摄像头未获授权或不可用，暂时改用鼠标操作。");
      return false;
    }

    running = true;
    HUD.setHandsState("LIVE");
    HUD.say("OK 保持半秒锁定后，另一只手指向知识点、右滑拉出卡片，上下滑翻页、左滑收回；原手张掌解锁。未锁定时张掌旋转、双手缩放，食指 1 释放脉冲。");
    HUD.log("双手缩放已开启，手部骨架已隐藏");
    tick();
    return true;
  }

  function disable() {
    running = false;
    Hologram.setHandPresent(false);
    if (rafHands) cancelAnimationFrame(rafHands);
    if (video && video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
    if (video) video.classList.remove("live");
    if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
    resetPulse(); lockCandidate = null; releaseZoom();
    fx.reset(); fy.reset();
    if (window.Knowledge) Knowledge.clearPointer();
    HUD.setHandsState("OFFLINE");
    HUD.setControlMode(poseLocked ? "POSE · LOCKED" : "MOUSE");
    HUD.log("手势识别已关闭");
  }

  function tick() {
    if (!running) return;
    if (video.readyState >= 2) {
      let res = null;
      try { res = landmarker.detectForVideo(video, performance.now()); } catch (e) { /* skip frame */ }
      if (res) handleResults(res);
    }
    rafHands = requestAnimationFrame(tick);
  }

  // average distance of the five fingertips from their centroid, / hand size
  function fingertipSpread(lm, handScale) {
    let cx = 0, cy = 0;
    for (const i of TIPS) { cx += lm[i].x; cy += lm[i].y; }
    cx /= TIPS.length; cy /= TIPS.length;
    let s = 0;
    for (const i of TIPS) s += Math.hypot(lm[i].x - cx, lm[i].y - cy);
    return (s / TIPS.length) / handScale;
  }

  function palmCenter(lm) {
    return PALM.reduce((p, i) => ({ x: p.x + lm[i].x / PALM.length,
      y: p.y + lm[i].y / PALM.length }), { x: 0, y: 0 });
  }

  // Relative bone distances keep this valid when the palm tilts or rotates.
  function isOpenPalm(lm) {
    if (isOK(lm)) return false;
    const scale = Math.max(0.0001, dist(lm[0], lm[9]));
    const extended = [[8, 6], [12, 10], [16, 14], [20, 18]]
      .filter(([tip, pip]) => dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) + scale * 0.15).length;
    return extended >= 3 && fingertipSpread(lm, scale) > 0.5;
  }

  function indexExtended(lm) {
    return dist(lm[8], lm[0]) > dist(lm[6], lm[0]) + dist(lm[0], lm[9]) * .15;
  }

  function isOK(lm) {
    const scale = Math.max(.0001, dist(lm[0], lm[9]));
    const pinch = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y,
      (lm[4].z || 0) - (lm[8].z || 0));
    const otherFingersOpen = [[12, 10], [16, 14], [20, 18]]
      .every(([tip, pip]) => dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) + scale * .12);
    return pinch < scale * .28 && otherFingersOpen;
  }

  function isOne(lm) {
    const scale = Math.max(.0001, dist(lm[0], lm[9]));
    return indexExtended(lm) && [[12, 10], [16, 14], [20, 18]]
      .every(([tip, pip]) => dist(lm[tip], lm[0]) < dist(lm[pip], lm[0]) + scale * .08);
  }

  function resetPulse() { pulseSince = 0; pulseFrames = 0; pulseFired = false; }

  function updateFingerPulse(hands, now) {
    if (hands.length !== 1 || !isOne(hands[0])) { resetPulse(); return false; }
    if (!pulseSince) pulseSince = now;
    pulseFrames++;
    if (!pulseFired && pulseFrames >= 3 && now - pulseSince >= PULSE_HOLD_MS) {
      pulseFired = true; Hologram.pulse(); HUD.setCoreState("PULSE");
      HUD.log("手势：食指 1 → 释放脉冲");
    }
    HUD.setControlMode("PULSE · ONE");
    return true;
  }

  function setLocked(value) {
    poseLocked = Boolean(value); lockOwner = null; reopenSince = 0; twoPalmSince = null;
    releaseZoom(); fx.reset(); fy.reset(); fingerX.reset(); fingerY.reset(); resetPulse(); lockCandidate = null;
    Hologram.setLocked(poseLocked);
    if (window.Knowledge) Knowledge.clearPointer();
    HUD.setControlMode(poseLocked ? "POSE · LOCKED" : "HAND");
  }

  function handleLock(hands, res, now) {
    const label = i => res.handedness?.[i]?.[0]?.categoryName || null;
    // Two deliberate open palms take over zoom even if tracking has lost the
    // original OK hand's identity. A single pointing/open hand keeps the lock.
    if (poseLocked && hands.length === 2 && hands.every(isOpenPalm)) {
      if (twoPalmSince === null) twoPalmSince = now;
      if (now - twoPalmSince >= 300) {
        setLocked(false);
        HUD.log("双手张掌：已接管缩放，向外拉开放大、向内合拢缩小");
        return false;
      }
      HUD.setControlMode("TWO HAND · HOLD");
      return true;
    }
    twoPalmSince = null;
    if (!poseLocked) {
      const ok = hands.findIndex(isOK);
      if (ok < 0) { lockCandidate = null; return false; }
      const wrist = hands[ok][0];
      if (!lockCandidate || (lockCandidate.label && label(ok) && lockCandidate.label !== label(ok)) ||
          dist(wrist, lockCandidate.wrist) > .2) {
        lockCandidate = { label: label(ok), wrist: { ...wrist }, since: now, frames: 0 };
      }
      lockCandidate.wrist = { ...wrist }; lockCandidate.frames++;
      releaseZoom(); resetPulse();
      if (now - lockCandidate.since < OK_HOLD_MS || lockCandidate.frames < 4) {
        HUD.setControlMode("OK · ARMING"); return true;
      }
      setLocked(true);
      lockOwner = { label: label(ok), wrist: { ...wrist } };
      HUD.log("OK 确认：球体已固定；另一只手指向知识点、向右滑展开卡片，原手张掌解锁");
    }
    let ownerIndex = -1;
    if (lockOwner) {
      let nearest = Infinity;
      hands.forEach((lm, i) => {
        if (lockOwner.label && label(i) && lockOwner.label !== label(i)) return;
        const d = dist(lm[0], lockOwner.wrist);
        if (d < nearest && d < .4) { nearest = d; ownerIndex = i; }
      });
      if (ownerIndex >= 0) {
        lockOwner.wrist = { ...hands[ownerIndex][0] };
        if (isOpenPalm(hands[ownerIndex])) {
          if (!reopenSince) reopenSince = now;
          if (now - reopenSince > 300) {
            setLocked(false); HUD.log("原手张掌：已解除球体锁定"); return true;
          }
        } else reopenSince = 0;
      } else reopenSince = 0;
    }
    const pointing = hands.findIndex((lm, i) => i !== ownerIndex && indexExtended(lm) && !isOK(lm));
    if (window.Knowledge) {
      if (pointing >= 0) {
        const tip = hands[pointing][8], t = now * .001;
        Knowledge.point(1 - fingerX.filter(tip.x, t), fingerY.filter(tip.y, t));
      } else { Knowledge.clearPointer(); fingerX.reset(); fingerY.reset(); }
    }
    HUD.setControlMode(pointing >= 0 ? "KNOWLEDGE · POINT" : "POSE · LOCKED");
    return true;
  }

  function releaseZoom() { zoomGrip = null; fz.reset(); }

  function updateTwoHandZoom(hands, now) {
    if (hands.length !== 2 || !hands.every(isOpenPalm)) {
      releaseZoom();
      return false;
    }
    const a = palmCenter(hands[0]), b = palmCenter(hands[1]);
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
    const distance = Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    if (distance < 0.12) { releaseZoom(); return false; }
    const separation = fz.filter(distance, now * 0.001);
    if (!zoomGrip) zoomGrip = { since: now, distance: separation, zoom: Hologram.getZoom() };
    if (now - zoomGrip.since < ZOOM_ARM_MS) {
      zoomGrip.distance = separation;
      zoomGrip.zoom = Hologram.getZoom();
      HUD.setControlMode("TWO HAND · HOLD");
      return true;
    }
    const delta = separation - zoomGrip.distance;
    if (Math.abs(delta) <= ZOOM_DEADZONE) {
      HUD.setControlMode("TWO HAND · HOLD");
      return true;
    }
    const effectiveDistance = separation - Math.sign(delta) * ZOOM_DEADZONE;
    const desired = zoomGrip.zoom * zoomGrip.distance / effectiveDistance;
    const bounded = clamp(desired, ZOOM_NEAR, ZOOM_FAR);
    Hologram.setZoom(bounded);
    HUD.setControlMode(delta > 0 ? "TWO HAND · ZOOM IN" : "TWO HAND · ZOOM OUT");
    if (bounded !== desired) { zoomGrip.distance = separation; zoomGrip.zoom = bounded; }
    return true;
  }

  function handleResults(res) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const hands = res.landmarks || [];
    const now = performance.now(), t = now * 0.001;

    if (!hands.length) {
      twoPalmSince = null;
      lockCandidate = null; resetPulse();
      releaseZoom();
      Hologram.setHandPresent(false);
      HUD.setHandsState("SEARCHING");
      HUD.setControlMode(poseLocked ? "POSE · LOCKED" : "SIZE · LOCKED");
      if (window.Knowledge) Knowledge.clearPointer();
      reopenSince = 0;
      if (now - lastSeen > 300) { fx.reset(); fy.reset(); }
      return;
    }
    lastSeen = now;
    HUD.setHandsState(hands.length === 2 ? "2 TRACKED" : "1 TRACKED");

    const lm = hands[0];
    const handScale = Math.max(0.0001, dist(lm[0], lm[9]));

    // rotation from smoothed palm centre (always live)
    const centres = hands.map(palmCenter);
    const cx = centres.reduce((sum, p) => sum + p.x, 0) / centres.length;
    const cy = centres.reduce((sum, p) => sum + p.y, 0) / centres.length;
    const px = fx.filter(cx, t), py = fy.filter(cy, t);

    // When a consumer (the file-map) is active, hand input drives IT, not the core.
    if (consumer) {
      releaseZoom(); resetPulse(); lockCandidate = null;
      const pinch = (dist(lm[4], lm[8]) / handScale) < 0.34;
      const palm = palmCenter(lm);
      try { consumer({ px: 1 - palm.x, py: palm.y, pinch: pinch, spread: fingertipSpread(lm, handScale) }); }
      catch (e) { /* ignore consumer errors */ }
      HUD.setControlMode("MAP · HAND");
      return;
    }

    if (handleLock(hands, res, now)) { resetPulse(); return; }
    if (window.Knowledge) Knowledge.clearPointer();

    let nx = (0.5 - px) * 2 * ROT_SENS, ny = (py - 0.5) * 2 * ROT_SENS;
    if (Math.abs(nx) < ROT_DEADZONE) nx = 0;
    if (Math.abs(ny) < ROT_DEADZONE) ny = 0;
    if (hands.some(isOpenPalm)) Hologram.setPointer(nx, ny);

    if (updateTwoHandZoom(hands, now)) { resetPulse(); return; }
    if (!updateFingerPulse(hands, now)) HUD.setControlMode("SIZE · LOCKED");
  }

  function toggle() { return running ? (disable(), Promise.resolve(false)) : enable(); }

  function setConsumer(fn) { consumer = fn || null; releaseZoom(); resetPulse(); lockCandidate = null; }

  window.HandTracking = { enable, disable, toggle, isRunning: () => running, setConsumer, setLocked,
    isLocked: () => poseLocked };
})();
