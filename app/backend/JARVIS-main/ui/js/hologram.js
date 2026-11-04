/* ============================================================
   hologram.js — the 3D holographic core (Three.js r128)
   Arc-reactor assembly with ambient randomness, THEME-aware accent
   colour (Hologram.setAccentBase), and music reactivity: bass
   swells the core, level lights the particles, mids speed the
   rings, beats fire a pulse.
   Exposed globally as `Hologram`.
   ============================================================ */
(function () {
  "use strict";

  let renderer, scene, camera, canvas;
  let core, particles, synapses, signals;
  const signalPaths = [];
  let neural, knowledge;
  let locked = false;
  let raf = 0;
  let microphoneOn = false, thinking = false;
  const accentMats = [];

  const target = { rotX: 0, rotY: 0, zoom: 6 };
  const cur    = { rotX: 0, rotY: 0, zoom: 6 };
  let pulseBoost = 0;
  const CYAN = 0x35e0ff;

  let accentHue = 0.52, accentHueTarget = 0.52, baseHue = 0.52;
  let flourish = 0, nextFlourish = 6;

  // audio reactivity (music visualizer)
  let aActive = false, aBass = 0, aMid = 0, aLevel = 0;
  let sBass = 0, sMid = 0, sLevel = 0, beatFlash = 0;
  let voiceSpeaking = false, voiceEnergy = 0, voiceEnvelope = 0, voiceBreath = 0, smoothVoiceEnergy = 0;

  let frames = 0, fpsClock = performance.now();

  function glowMat(color, opacity, collect) {
    const m = new THREE.MeshBasicMaterial({
      color, wireframe: true, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    if (collect) accentMats.push(m);
    return m;
  }

  function buildCore() {
    core  = new THREE.Group();

    // PointsMaterial defaults to solid squares; use a soft circular light instead.
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 64;
    const glowContext = glowCanvas.getContext('2d');
    const glow = glowContext.createRadialGradient(32, 32, 0, 32, 32, 30);
    glow.addColorStop(0, 'rgba(255,255,255,1)');
    glow.addColorStop(.18, 'rgba(255,255,255,.9)');
    glow.addColorStop(.5, 'rgba(255,255,255,.25)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    glowContext.fillStyle = glow;
    glowContext.fillRect(0, 0, 64, 64);
    const pointGlow = new THREE.CanvasTexture(glowCanvas);

    neural = NeuralCore(core);
    if (window.Knowledge) {
      knowledge = Knowledge.create(core, camera, canvas);
      knowledge.load().then(data => { if (data) neural.setBackdrop(true); });
    }

    core.add(new THREE.Mesh(new THREE.DodecahedronGeometry(3.4, 0), glowMat(CYAN, 0.12, true)));

    const N = 2400, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random(), v = Math.random();
      const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
      const r = Math.cbrt(1.5 ** 3 + Math.random() * (3.6 ** 3 - 1.5 ** 3));
      pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    particles = new THREE.Points(pg, new THREE.PointsMaterial({
      color: CYAN, size: 0.03, transparent: true, opacity: 0.8,
      map: pointGlow, alphaTest: .01,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    core.add(particles);

    // Short local connections turn the particle cloud into a neural volume.
    // Build once; line and signal geometry share the cloud's rotation.
    const edges = [], used = new Set();
    for (let i = 0; i < N; i++) {
      const near = [];
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.26) near.push({ j, d2 });
      }
      near.sort((a, b) => a.d2 - b.d2);
      for (const { j } of near.slice(0, 2)) {
        const key = Math.min(i, j) * N + Math.max(i, j);
        if (used.has(key)) continue;
        used.add(key);
        const start = new THREE.Vector3().fromArray(pos, i * 3);
        const end = new THREE.Vector3().fromArray(pos, j * 3);
        edges.push(...start.toArray(), ...end.toArray());
        signalPaths.push({ start, end });
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(edges, 3));
    synapses = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({
      color: CYAN, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    core.add(synapses);
    const flow = new THREE.BufferGeometry();
    flow.setAttribute("position", new THREE.BufferAttribute(new Float32Array(160 * 3), 3));
    signals = new THREE.Points(flow, new THREE.PointsMaterial({
      color: 0xc9b2ff, size: 0.045, transparent: true, opacity: 0.85,
      map: pointGlow, alphaTest: .01,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    signals.frustumCulled = false;
    core.add(signals);

    scene.add(core);
  }

  function init(sceneCanvas) {
    canvas = sceneCanvas;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    scene  = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = target.zoom;

    buildCore();
    attachMouse();
    // Only feed the new inner network's activity; original HUD/outer scene stay intact.
    window.addEventListener("jarvis-microphone", e => { microphoneOn = Boolean(e.detail); });
    window.addEventListener("jarvis-chat-start", () => { thinking = true; });
    for (const event of ["jarvis-chat-done", "jarvis-chat-error"]) {
      window.addEventListener(event, () => { thinking = false; });
    }
    window.addEventListener("jarvis-voice-playback", event => {
      voiceSpeaking = Boolean(event.detail); if (!voiceSpeaking) voiceEnergy = 0;
    });
    window.addEventListener("jarvis-voice-level", event => {
      voiceEnergy = Math.max(0, Math.min(1, Number(event.detail) || 0));
    });
    window.addEventListener("resize", resize);
    loop();
  }

  function pulse() {
    if (locked) return;
    pulseBoost = 1.0;
    if (neural) neural.pulse();
    if (window.SoundFX) SoundFX.drop();
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const t = performance.now() * 0.001;

    // smooth audio bands toward targets (0 when music is off)
    sBass  += ((aActive ? aBass : 0)  - sBass)  * 0.25;
    sMid   += ((aActive ? aMid : 0)   - sMid)   * 0.25;
    sLevel += ((aActive ? aLevel : 0) - sLevel) * 0.25;
    voiceEnvelope += ((voiceSpeaking ? 1 : 0) - voiceEnvelope) * .065;
    smoothVoiceEnergy += (voiceEnergy - smoothVoiceEnergy) * .12;
    // A slow breath carries the reply; syllable energy adds a gentle lift.
    voiceBreath = voiceEnvelope * (.30 + .50 * (.5 + .5 * Math.sin(t * 2.6)) + .20 * smoothVoiceEnergy);

    if (!locked) {
      cur.rotX += (target.rotX - cur.rotX) * 0.08;
      cur.rotY += (target.rotY - cur.rotY) * 0.08;
      cur.zoom += (target.zoom - cur.zoom) * 0.10;
    }
    core.rotation.x = cur.rotX;
    core.rotation.y = cur.rotY;
    camera.position.z = cur.zoom;

    if (!locked) particles.rotation.y += 0.0008;
    synapses.rotation.copy(particles.rotation);
    signals.rotation.copy(particles.rotation);
    const flowPos = signals.geometry.attributes.position;
    for (let i = 0; i < flowPos.count && signalPaths.length; i++) {
      const path = signalPaths[(i * 19) % signalPaths.length];
      const k = (t * (0.22 + (i % 7) * 0.025) + i * 0.618) % 1;
      flowPos.setXYZ(i, THREE.MathUtils.lerp(path.start.x, path.end.x, k),
        THREE.MathUtils.lerp(path.start.y, path.end.y, k), THREE.MathUtils.lerp(path.start.z, path.end.z, k));
    }
    flowPos.needsUpdate = true;
    synapses.material.opacity = 0.13 + sLevel * 0.12 + flourish * 0.04 + voiceBreath * .16;

    // ambient flourish (stays near the current theme hue)
    if (t > nextFlourish) {
      flourish = 1.0;
      accentHueTarget = baseHue + (Math.random() * 0.12 - 0.06);
      nextFlourish = t + 10 + Math.random() * 16;
      setTimeout(() => { accentHueTarget = baseHue; }, 1400);
      if (window.HUD) HUD.log("核心：环境光流变化");
    }
    flourish *= 0.95;

    accentHue += (accentHueTarget - accentHue) * 0.03;
    beatFlash *= 0.88;
    const lum = 0.58 + flourish * 0.12 + sLevel * 0.15 + beatFlash * 0.28 + voiceBreath * .18;
    const hue = (((accentHue + beatFlash * 0.06) % 1) + 1) % 1;
    for (const m of accentMats) m.color.setHSL(hue, 0.85, Math.min(0.9, lum));

    particles.material.opacity = Math.min(1, 0.6 + 0.2 * Math.sin(t * 0.6) + flourish * 0.2 + sLevel * 0.35 + voiceBreath * .24);
    particles.material.size = 0.025 + flourish * 0.015 + sLevel * 0.04 + beatFlash * 0.025 + voiceBreath * .018;
    signals.material.size = .045 + voiceBreath * .025;
    if (neural) neural.update(t, sLevel + voiceBreath * .65, locked, voiceBreath, voiceSpeaking ? "speaking" : thinking ? "thinking" : microphoneOn ? "listening" : "idle");

    pulseBoost *= 0.92;
    if (!locked) core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.022 + pulseBoost * 0.25 + flourish * 0.04 + sBass * 0.35 + voiceBreath * .055);

    if (knowledge) knowledge.update();
    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - fpsClock >= 500) {
      if (window.HUD) HUD.setFPS(Math.round((frames * 1000) / (now - fpsClock)));
      frames = 0; fpsClock = now;
    }
  }

  // ---- public control surface --------------------------------------
  function setPointer(nx, ny) {
    if (locked) return;
    target.rotY = nx * 1.4; target.rotX = ny * 0.9;
    if (neural) neural.point(nx, ny, true);
    if (window.SoundFX) SoundFX.height(ny);
  }
  function setHandPresent(present) { if (neural && !present) neural.point(0, 0, false); }
  function cycleFormation() { return neural && !locked ? neural.cycleFormation() : 0; }
  function setLocked(value) {
    value = Boolean(value);
    if (value && !locked) {
      if (window.SoundFX) SoundFX.cue("lock");
      target.rotX = cur.rotX; target.rotY = cur.rotY; target.zoom = cur.zoom;
    }
    locked = value;
    if (window.Knowledge) Knowledge.setLocked(value);
  }
  function nudgeZoom(d)       { setZoom(target.zoom + d); }
  function setZoom(z) {
    if (locked) return;
    const before = target.zoom;
    target.zoom = Math.min(11, Math.max(3, z));
    if (window.SoundFX) SoundFX.zoom(before, target.zoom);
  }
  function getZoom()          { return target.zoom; }
  function setAccentBase(h)   { baseHue = h; accentHueTarget = h; }
  function reactAudio(d) {
    if (!d) { aActive = false; return; }
    aActive = true; aBass = d.bass || 0; aMid = d.mid || 0; aLevel = d.level || 0;
    if (d.beat) beatFlash = 1;   // beats flash colour + kick particles (no big pulse)
  }
  function reset() {
    if (window.HandTracking) HandTracking.setLocked(false); else setLocked(false);
    target.rotX = 0; target.rotY = 0; target.zoom = 6;
  }
  function resize() {
    if (!renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function attachMouse() {
    let dragging = false, px = 0, py = 0;
    canvas.addEventListener("mousedown", (e) => { dragging = true; px = e.clientX; py = e.clientY; });
    window.addEventListener("mouseup", () => { dragging = false; });
    window.addEventListener("mousemove", (e) => {
      if (!dragging || locked) return;
      target.rotY += (e.clientX - px) * 0.005;
      target.rotX += (e.clientY - py) * 0.005;
      px = e.clientX; py = e.clientY;
    });
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); nudgeZoom(e.deltaY * 0.003); },
      { passive: false });
  }

  window.Hologram = { init, setPointer, setHandPresent, cycleFormation, setLocked, isLocked: () => locked,
    nudgeZoom, setZoom, getZoom, setAccentBase, reactAudio, pulse, reset, resize,
    visualSnapshot: () => ({ innerNodes: neural.group.children[0].geometry.attributes.position.count,
      outerParticles: particles.geometry.attributes.position.count,
      cameraZoom: camera.zoom, calls: renderer.info.render.calls }),
    voiceSnapshot: () => ({ speaking: voiceSpeaking, breath: voiceBreath, energy: smoothVoiceEnergy,
      scale: core?.scale.x, locked }) };
})();
