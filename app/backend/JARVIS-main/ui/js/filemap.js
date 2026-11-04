/* ============================================================
   filemap.js — fly-through 3D map of your loaded folders (v2)
   • NESTED: builds a real recursive tree from full paths (folders
     inside folders inside folders), not just the top level.
   • ACCUMULATES: maps every folder you've loaded (Workspace keeps
     appending); rebuilds live when you add/clear folders.
   • HAND CONTROL: with hand tracking on, a reticle follows your
     hand — pinch to select a node, open your hand to OPEN it
     (file → panel/chart, folder → dive in), close your hand to
     back out. Mouse still orbits/zooms/clicks as before.
   • THEMED: node + link colours follow the active theme (--cyan/--gold).
   Own Three.js renderer so it never disturbs the core.
   Toggle with the ⧉ 文件星图 button or /map. Exposed as `FileMap`.
   ============================================================ */
(function () {
  "use strict";

  const IMG = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  const CHART = /\.(csv|tsv|xlsx|xls)$/i;
  const MAX_CHILDREN = 60;     // per node, keeps huge folders sane
  const NODE_CAP = 1200;       // total rendered nodes

  let renderer, scene, camera, group, canvas, tip, raycaster, mouse;
  let raf = 0, active = false, pickable = [], placed = 0;
  let dragging = false, moved = false, px = 0, py = 0, rotX = -0.2, rotY = 0, zoom = 18;
  let cursorEl = null, hovered = null, selected = null;
  let prevPinch = false, prevSpread = 0;
  let COL = null, linkPts = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---- theme colours (read the live CSS vars, like the charts do) ----
  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const cyan = (cs.getPropertyValue("--cyan") || "#35e0ff").trim();
    const gold = (cs.getPropertyValue("--gold") || "#ffb648").trim();
    let c, g;
    try { c = new THREE.Color(cyan); } catch (e) { c = new THREE.Color(0x35e0ff); }
    try { g = new THREE.Color(gold); } catch (e) { g = new THREE.Color(0xffb648); }
    return { cyan: c, gold: g, link: c.clone().lerp(g, 0.35) };
  }

  function mat(color, opacity) {
    return new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false });
  }

  // ---- geometry helpers ----
  function fibDir(i, n) {
    const phi = Math.acos(1 - 2 * (i + 0.5) / n);
    const th = Math.PI * (1 + Math.sqrt(5)) * i;
    return new THREE.Vector3(Math.cos(th) * Math.sin(phi), Math.sin(th) * Math.sin(phi), Math.cos(phi));
  }
  function basis(dir) {
    const a = Math.abs(dir.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, a).normalize();
    const v = new THREE.Vector3().crossVectors(dir, u).normalize();
    return [u, v];
  }

  // ---- build a nested tree from flat {name,path,file} records ----
  function buildTree(files) {
    const root = { name: "workspace", type: "folder", path: "", kids: {} };
    for (const f of files) {
      const parts = (f.path || f.name).split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const key = parts[i];
        if (i === parts.length - 1) {
          node.kids[key] = { name: key, type: "file", path: f.path || f.name, wrap: f };
        } else {
          if (!node.kids[key] || node.kids[key].type !== "folder")
            node.kids[key] = { name: key, type: "folder", path: parts.slice(0, i + 1).join("/"), kids: {} };
          node = node.kids[key];
        }
      }
    }
    (function finalize(n) {
      if (n.type === "file") { n.count = 1; return 1; }
      n.list = Object.values(n.kids).sort((a, b) => (a.type === b.type)
        ? a.name.localeCompare(b.name) : (a.type === "folder" ? -1 : 1));
      let c = 0;
      for (const ch of n.list) c += finalize(ch);
      n.count = c;
      return c;
    })(root);
    return root;
  }

  // ---- shared geometry (scaled per-mesh) ----
  const folderGeo = new THREE.IcosahedronGeometry(1, 0);
  const fileGeo = new THREE.SphereGeometry(0.085, 8, 8);

  function addNode(node, pos, depth) {
    let m;
    if (depth === 0) {
      m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), mat(COL.cyan, 0.98));
    } else if (node.type === "folder") {
      const s = clamp(0.46 * Math.pow(0.72, depth - 1), 0.15, 0.46);
      m = new THREE.Mesh(folderGeo, mat(COL.gold, 0.95));
      m.scale.setScalar(s);
    } else {
      m = new THREE.Mesh(fileGeo, mat(COL.cyan, 0.9));
    }
    m.position.copy(pos);
    m.userData = { type: node.type, name: node.name, path: node.path, count: node.count,
                   wrap: node.wrap, base: m.scale.x, baseColor: m.material.color.clone(),
                   folder: node.type === "folder" || depth === 0 };
    group.add(m);
    pickable.push(m);
    return m;
  }

  // ---- recursively place nodes (cone-branch layout) ----
  function place(node, pos, dir, radius, spread, depth) {
    addNode(node, pos, depth);
    if (node.type === "file") return;
    const kids = node.list.slice(0, MAX_CHILDREN);
    const n = kids.length;
    const [u, v] = basis(dir);
    for (let i = 0; i < n; i++) {
      if (placed >= NODE_CAP) break;
      placed++;
      let cdir;
      if (depth === 0) {
        cdir = fibDir(i, Math.max(n, 1));
      } else {
        const th = n > 1 ? (2 * Math.PI * i / n) : 0;
        const s = Math.sin(spread), c = Math.cos(spread);
        cdir = dir.clone().multiplyScalar(c)
          .add(u.clone().multiplyScalar(Math.cos(th) * s))
          .add(v.clone().multiplyScalar(Math.sin(th) * s)).normalize();
      }
      const cpos = pos.clone().add(cdir.clone().multiplyScalar(radius));
      linkPts.push(pos.x, pos.y, pos.z, cpos.x, cpos.y, cpos.z);
      place(kids[i], cpos, cdir, Math.max(radius * 0.6, 1.7), Math.max(spread * 0.82, 0.35), depth + 1);
    }
  }

  function build() {
    COL = themeColors();
    if (group) {                                   // free GPU memory on rebuild
      group.traverse((o) => {
        if (o.material) o.material.dispose();
        if (o.geometry && o.geometry !== folderGeo && o.geometry !== fileGeo) o.geometry.dispose();
      });
      scene.remove(group);
    }
    group = new THREE.Group(); scene.add(group);
    pickable = []; placed = 0; linkPts = []; hovered = null; selected = null;

    const files = (window.Workspace && Workspace.getFiles) ? Workspace.getFiles() : [];
    if (!files.length) { HUD.say("请先加载文件夹，再打开文件星图。"); return false; }

    const tree = buildTree(files);
    place(tree, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 6.5, 1.0, 0);

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(linkPts, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: COL.link, transparent: true, opacity: 0.28 })));

    const folders = pickable.filter((m) => m.userData.folder).length;
    HUD.log(`文件星图：${placed} 个节点、${files.length} 个文件、${folders} 个文件夹`
      + (placed >= NODE_CAP ? "（已达节点上限）" : ""));
    return true;
  }

  // ---- renderer plumbing ----
  function ensure() {
    if (renderer) return;
    canvas = document.getElementById("filemap");
    tip = document.getElementById("map-tip");
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 800);
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    resize();
    window.addEventListener("resize", resize);
    canvas.addEventListener("mousedown", (e) => { dragging = true; moved = false; px = e.clientX; py = e.clientY; });
    window.addEventListener("mouseup", () => { dragging = false; });
    window.addEventListener("mousemove", onMove);
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoom = clamp(zoom + e.deltaY * 0.012, 5, 80); }, { passive: false });
    canvas.addEventListener("click", onClick);
  }

  function resize() {
    if (!renderer) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  function show() {
    if (active) return true;
    ensure();
    if (!build()) return false;
    if (window.Charts && Charts.isOn()) Charts.toggle();
    active = true;
    document.getElementById("scene").style.display = "none";
    canvas.style.display = "block";
    if (window.HandTracking && HandTracking.setConsumer) HandTracking.setConsumer(onHand);
    HUD.say("文件星图：拖动旋转、滚轮缩放、点击文件打开，也可用手势控制。");
    HUD.setControlMode("FILE-MAP");
    loop();
    return true;
  }
  function hide() {
    active = false;
    if (raf) cancelAnimationFrame(raf);
    if (canvas) canvas.style.display = "none";
    if (tip) tip.style.display = "none";
    if (cursorEl) cursorEl.style.display = "none";
    if (window.HandTracking && HandTracking.setConsumer) HandTracking.setConsumer(null);
    document.getElementById("scene").style.display = "block";
    HUD.setControlMode(window.HandTracking && HandTracking.isRunning() ? "HAND" : "MOUSE");
  }
  function toggle() { return active ? (hide(), false) : show(); }
  function rebuild() { if (active) build(); }

  function loop() {
    if (!active) return;
    raf = requestAnimationFrame(loop);
    if (!dragging) rotY += 0.0014;
    group.rotation.x = rotX;
    group.rotation.y = rotY;
    camera.position.z = zoom;
    renderer.render(scene, camera);
  }

  // ---- picking + hover ----
  function pickAt(nx, ny) {
    mouse.x = nx; mouse.y = ny;
    raycaster.setFromCamera(mouse, camera);
    return raycaster.intersectObjects(pickable, false)[0];
  }
  function setHover(obj) {
    if (hovered === obj) return;
    if (hovered && hovered !== selected) {
      hovered.material.color.copy(hovered.userData.baseColor);
      hovered.scale.setScalar(hovered.userData.base);
    }
    hovered = obj;
    if (hovered && hovered !== selected) {
      hovered.material.color.copy(COL.cyan).lerp(new THREE.Color(0xffffff), 0.5);
      hovered.scale.setScalar(hovered.userData.base * 1.5);
    }
  }
  function setSelected(obj) {
    if (selected && selected !== hovered) {
      selected.material.color.copy(selected.userData.baseColor);
      selected.scale.setScalar(selected.userData.base);
    }
    selected = obj;
    if (selected) {
      selected.material.color.copy(COL.gold).lerp(new THREE.Color(0xffffff), 0.35);
      selected.scale.setScalar(selected.userData.base * 1.9);
    }
  }

  function showTip(u, sx, sy) {
    if (!u) { tip.style.display = "none"; return; }
    tip.textContent = u.type === "folder" ? `${u.name}/  (${u.count} 个文件)` : u.name;
    tip.style.display = "block";
    tip.style.left = (sx + 14) + "px";
    tip.style.top = (sy + 14) + "px";
  }

  function onMove(e) {
    if (dragging) {
      moved = true;
      rotY += (e.clientX - px) * 0.005;
      rotX = clamp(rotX + (e.clientY - py) * 0.005, -1.4, 1.4);
      px = e.clientX; py = e.clientY;
    }
    if (!active) return;
    const hit = pickAt((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    setHover(hit ? hit.object : null);
    showTip(hit ? hit.object.userData : null, e.clientX, e.clientY);
    canvas.style.cursor = hit ? "pointer" : "grab";
  }

  function onClick(e) {
    if (!active || moved) return;
    const hit = pickAt((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    if (hit) openNode(hit.object);
  }

  function openNode(m) {
    if (!m) return;
    const u = m.userData;
    if (u.type === "file") {
      if (CHART.test(u.name) && window.Charts) Charts.show(u.wrap.file);
      else if (IMG.test(u.name)) Viz.showImage(u.wrap.file);
      else Viz.showInfo(u.wrap.file);
      HUD.log("已打开 " + u.name);
    } else {
      HUD.say(`${u.name} — ${u.count} 个文件。`);
      zoom = clamp(zoom - 5, 5, 80);     // dive in
    }
  }

  // ---- hand control (consumer fed by handtracking.js) ----
  function ensureCursor() {
    if (cursorEl) return;
    cursorEl = document.createElement("div");
    cursorEl.id = "map-cursor";
    document.body.appendChild(cursorEl);
  }
  function onHand(d) {
    if (!active) return;
    ensureCursor();
    const sx = d.px * window.innerWidth, sy = d.py * window.innerHeight;
    cursorEl.style.display = "block";
    cursorEl.style.left = sx + "px";
    cursorEl.style.top = sy + "px";
    cursorEl.classList.toggle("pinch", !!d.pinch);

    const hit = pickAt(d.px * 2 - 1, -(d.py * 2 - 1));
    setHover(hit ? hit.object : null);
    showTip(hit ? hit.object.userData : null, sx, sy);

    if (d.pinch && !prevPinch) {                    // pinch → select
      setSelected(hovered);
      if (hovered) { HUD.log("手势：捏合选中 " + hovered.userData.name); if (window.Hologram) Hologram.pulse(); }
    }
    if (d.spread > 0.5 && prevSpread <= 0.5) {       // open hand → open
      openNode(selected || hovered);
    }
    if (d.spread < 0.22 && prevSpread >= 0.22) {     // close hand → back out
      setSelected(null);
      zoom = clamp(zoom + 6, 5, 80);
      HUD.log("手势：合拢返回");
    }
    prevPinch = !!d.pinch; prevSpread = d.spread;
  }

  function init() {
    const b = document.getElementById("btn-map");
    if (b) b.addEventListener("click", () => {
      const on = toggle();
      b.classList.toggle("active", on);
      b.textContent = on ? "⧉ 文件星图已开启" : "⧉ 文件星图";
    });
  }

  window.FileMap = { init, toggle, rebuild, isOn: () => active };
})();
