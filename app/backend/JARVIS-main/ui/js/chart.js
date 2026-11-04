/* ============================================================
   chart.js — data → 3D holographic bar chart
   Parses a local .csv/.tsv/.xlsx (SheetJS, vendored) and renders
   it as glowing 3D bars on its own renderer: rows along X, numeric
   columns as series along Z, height = value. Orbit/zoom, hover a
   bar for its value, colours follow the current theme. Escape (or
   toggle) closes. Exposed as `Charts`.
   ============================================================ */
(function () {
  "use strict";

  const EXTRA = ["#7fe0a0", "#c99bff", "#ff8f6b", "#6bd0ff", "#ffd36b"];
  let renderer, scene, camera, group, canvas, tip, legend, raycaster, mouse;
  let raf = 0, active = false, bars = [];
  let dragging = false, px = 0, py = 0, rotX = -0.35, rotY = 0.5, zoom = 18;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const themeColor = (v, fb) => (getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb);

  function ensure() {
    if (renderer) return;
    canvas = document.getElementById("chartview");
    tip = document.getElementById("chart-tip");
    legend = document.getElementById("chart-legend");
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
    raycaster = new THREE.Raycaster(); mouse = new THREE.Vector2();
    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousedown", (e) => { dragging = true; px = e.clientX; py = e.clientY; });
    window.addEventListener("mouseup", () => { dragging = false; });
    window.addEventListener("mousemove", onMove);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoom = clamp(zoom + e.deltaY * 0.015, 6, 60); }, { passive: false });
    window.addEventListener("keydown", (e) => { if (active && e.key === "Escape") hide(); });
  }

  function resize() {
    if (!renderer) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function splitCsv(line, delim) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') q = !q;
      else if (c === delim && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  async function parse(file) {
    const n = file.name.toLowerCase();
    if (n.endsWith(".csv") || n.endsWith(".tsv")) {
      const text = await file.text();
      const d = n.endsWith(".tsv") ? "\t" : ",";
      return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitCsv(l, d));
    }
    if (!window.XLSX) { HUD.log("表格解析器尚未加载", "err"); return null; }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1 });
  }

  function label(text, color) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = color || "#cfe8ff"; x.font = "26px monospace"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(String(text).slice(0, 16), 128, 32);
    const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
    sp.scale.set(2.4, 0.6, 1);
    return sp;
  }

  function build(rows, title) {
    if (group) scene.remove(group);
    group = new THREE.Group(); scene.add(group); bars = [];
    if (!rows || rows.length < 2) { HUD.say("该文件中未找到可用的表格数据。"); return false; }

    const headers = rows[0].map((h) => String(h));
    const data = rows.slice(1).filter((r) => r && r.length);
    const series = [];
    for (let j = 1; j < headers.length; j++) {
      let num = 0;
      for (const r of data) if (r[j] !== "" && r[j] != null && !isNaN(parseFloat(r[j]))) num++;
      if (num >= Math.max(1, data.length * 0.5)) series.push(j);
    }
    if (!series.length) { HUD.say("未找到可绘图的数值列。"); return false; }

    const cats = data.map((r) => r[0]);
    let max = 0;
    for (const r of data) for (const j of series) { const v = Math.abs(parseFloat(r[j]) || 0); if (v > max) max = v; }
    max = max || 1;

    const H = 6, sx = 1.4, sz = 1.4, n = data.length, m = series.length;
    const ox = -(n - 1) * sx / 2, oz = -(m - 1) * sz / 2;
    const pal = [themeColor("--cyan", "#35e0ff"), themeColor("--gold", "#ffb648"), ...EXTRA];

    for (let i = 0; i < n; i++) {
      for (let s = 0; s < m; s++) {
        const val = parseFloat(data[i][series[s]]) || 0;
        const h = Math.max(0.02, Math.abs(val) / max * H);
        const col = new THREE.Color(pal[s % pal.length]);
        const geo = new THREE.BoxGeometry(0.7, 1, 0.7);
        const bar = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 }));
        bar.scale.y = h;
        bar.position.set(ox + i * sx, (h / 2) * (val < 0 ? -1 : 1), oz + s * sz);
        bar.userData = { cat: cats[i], series: headers[series[s]], value: val };
        group.add(bar); bars.push(bar);
        const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, wireframe: true,
          transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
        wire.scale.copy(bar.scale); wire.position.copy(bar.position);
        group.add(wire);
      }
    }

    if (n <= 30) for (let i = 0; i < n; i++) {
      const sp = label(cats[i]); sp.position.set(ox + i * sx, -0.7, oz - sz); group.add(sp);
    }

    legend.innerHTML = `<div class="cl-title">${title || "数据"}</div>` +
      series.map((j, s) => `<div class="cl-row"><span class="cl-sw" style="background:${pal[s % pal.length]}"></span>${headers[j]}</div>`).join("");
    legend.style.display = "block";
    HUD.log(`图表：${n} 行 × ${m} 组数据`);
    return true;
  }

  async function show(file) {
    ensure();
    let rows;
    try { rows = await parse(file); }
    catch (e) { HUD.log("图表解析失败：" + e.message, "err"); HUD.say("无法读取该文件。"); return false; }
    if (!build(rows, file.name)) return false;
    if (window.FileMap && FileMap.isOn()) FileMap.toggle();
    active = true;
    document.getElementById("scene").style.display = "none";
    canvas.style.display = "block";
    HUD.setControlMode("CHART");
    HUD.say(`${file.name}：拖动旋转、滚轮缩放，悬停查看数值，按 Esc 关闭。`);
    loop();
    return true;
  }
  function hide() {
    active = false;
    if (raf) cancelAnimationFrame(raf);
    if (canvas) canvas.style.display = "none";
    if (tip) tip.style.display = "none";
    if (legend) legend.style.display = "none";
    document.getElementById("scene").style.display = "block";
    HUD.setControlMode("MOUSE");
  }
  function toggle() { return active ? (hide(), false) : false; }

  function loop() {
    if (!active) return;
    raf = requestAnimationFrame(loop);
    if (!dragging) rotY += 0.0012;
    group.rotation.x = rotX; group.rotation.y = rotY;
    camera.position.z = zoom;
    renderer.render(scene, camera);
  }

  function onMove(e) {
    if (dragging) {
      rotY += (e.clientX - px) * 0.005;
      rotX = clamp(rotX + (e.clientY - py) * 0.005, -1.4, 1.4);
      px = e.clientX; py = e.clientY;
    }
    if (!active) return;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObjects(bars)[0];
    if (hit) {
      const u = hit.object.userData;
      tip.textContent = `${u.cat} · ${u.series}: ${u.value}`;
      tip.style.display = "block";
      tip.style.left = (e.clientX + 14) + "px";
      tip.style.top = (e.clientY + 14) + "px";
    } else { tip.style.display = "none"; }
  }

  function init() { /* lazy — ensure() runs on first show */ }

  window.Charts = { init, show, toggle, isOn: () => active };
})();
