/* Real Obsidian notes in the inner core; local, read-only and text-safe. */
(function () {
  "use strict";
  let group, camera, canvas, points, linksMesh, halo, graphData, glowPoints, glowLines;
  let networkEdges = [], focusKey = "", focused = -1, glowing = [];
  const noteCache = new Map();
  let entries = [], active = -1, opened = -1, dismissed = -1, requestSerial = 0;
  let handPoint = null, mousePoint = null, locked = false, controller = null;
  let cardAnimation = null;
  let swipe = null, docked = null, mouseDragging = false, lastHandAt = 0;
  let attachmentURL = null, loadSerial = 0;
  const $ = (id) => document.getElementById(id);
  const projected = new THREE.Vector3();
  const colors = [0xb697ff, 0x55e3ff, 0xffd58a, 0xf19dff, 0x78f5d8, 0x91b9ff, 0xffa79d];

  function layout(data) {
    const folders = [...new Set(data.nodes.map(n => n.folder))].sort();
    const nodes = data.nodes.map((note, i) => {
      const f = folders.indexOf(note.folder), a = i * 2.399963229728653;
      const y = 1 - 2 * (i + .5) / data.nodes.length;
      const r = Math.sqrt(1 - y * y);
      return { note, degree: 0, color: new THREE.Color(note.hasContent === false ? 0x334457 : colors[f % colors.length]),
        position: new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(.9) };
    });
    const ids = new Map(nodes.map((n, i) => [n.note.id, i]));
    const edges = data.links.map(e => [ids.get(e.source), ids.get(e.target)])
      .filter(([a, b]) => a !== undefined && b !== undefined);
    for (const [a, b] of edges) { nodes[a].degree++; nodes[b].degree++; }
    for (let step = 0; step < 110; step++) {
      const forces = nodes.map(n => n.position.clone().multiplyScalar(-.006));
      for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
        const v = nodes[a].position.clone().sub(nodes[b].position);
        const strength = .003 / Math.max(.02, v.lengthSq());
        v.normalize().multiplyScalar(strength);
        forces[a].add(v); forces[b].sub(v);
      }
      for (const [a, b] of edges) {
        const v = nodes[b].position.clone().sub(nodes[a].position);
        const length = v.length();
        v.multiplyScalar(.025 * (length - .5) / Math.max(.001, length));
        forces[a].add(v); forces[b].sub(v);
      }
      for (let i = 0; i < nodes.length; i++) nodes[i].position.add(forces[i].clampLength(0, .05));
    }
    const radius = Math.max(1, ...nodes.map(n => n.position.length()));
    nodes.forEach(n => n.position.multiplyScalar(1.2 / radius));
    return { nodes, edges };
  }

  function build(data) {
    closeReader();
    const result = layout(data);
    entries = result.nodes; graphData = data; networkEdges = result.edges;
    noteCache.clear(); focusKey = ""; focused = -1; glowing = [];
    for (const child of [...group.children]) {
      group.remove(child); child.geometry?.dispose(); child.material?.dispose();
    }
    active = opened = dismissed = -1; clearPointer();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(entries.flatMap(n => n.position.toArray()), 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(entries.flatMap(n => n.color.toArray()), 3));
    geometry.setAttribute("nodeSize", new THREE.Float32BufferAttribute(entries.map(n => n.note.hasContent === false ? .05 : .135 + Math.min(8, n.degree) * .006), 1));
    points = new THREE.Points(geometry, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 color; attribute float nodeSize; varying vec3 vColor;
        void main(){vColor=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;
        gl_PointSize=clamp(nodeSize*460./max(.1,-p.z),5.,24.);}`,
      fragmentShader: `varying vec3 vColor;void main(){float d=length(gl_PointCoord-.5)*2.;
        if(d>1.)discard; float a=pow(1.-d,1.2);gl_FragColor=vec4(vColor+vec3(pow(1.-d,8.)*.6),a);}`,
    }));
    group.add(points);
    const connections = result.edges.flatMap(([a, b]) => [...entries[a].position.toArray(), ...entries[b].position.toArray()]);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(connections, 3));
    linksMesh = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
      color: 0xa79fff, transparent: true, opacity: .42, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    group.add(linksMesh);
    // Only real document nodes participate in the hover glow.
    glowPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 } },
      vertexShader: `attribute vec3 color; attribute float nodeSize; varying vec3 vColor;
        void main(){vColor=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;
        gl_PointSize=clamp(nodeSize*460./max(.1,-p.z),16.,60.);}`,
      fragmentShader: `uniform float time;varying vec3 vColor;
        void main(){float d=length(gl_PointCoord-.5)*2.;if(d>1.)discard;
        float glow=pow(1.-d,2.)*.85+pow(1.-d,8.);float breathe=.85+.15*sin(time*3.);
        gl_FragColor=vec4(vColor+vec3(pow(1.-d,10.)*.4),glow*breathe);}`,
    }));
    glowPoints.frustumCulled = false; glowPoints.visible = false; group.add(glowPoints);
    glowLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: 0xffdf9c, transparent: true, opacity: .8, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    glowLines.frustumCulled = false; glowLines.visible = false; group.add(glowLines);
    halo = new THREE.Mesh(new THREE.IcosahedronGeometry(.055, 1), new THREE.MeshBasicMaterial({
      color: 0xffe7ac, transparent: true, opacity: .9, wireframe: true, depthTest: false,
    }));
    halo.visible = false; group.add(halo);
    $("knowledge-count").textContent = `${data.vault} · ${data.noteCount ?? entries.length} 篇笔记` + (data.importCount ? ` ＋ ${data.importCount} 份导入资料` : '') + ` · ${data.links.length} 条链接`;
    $("knowledge-legend").textContent = "指向后周边亮起 = 文档可读 · 亮起后向右滑展开";
    if (data.skipped) $("knowledge-count").textContent += ` · ${data.skipped} 篇未读取`;
    HUD.log(`Obsidian「${data.vault}」已接入：${data.noteCount ?? entries.length} 篇笔记，${data.links.length} 条真实链接` + (data.importCount ? `；另有 ${data.importCount} 份导入资料` : ''));
  }

  async function load(refresh = false) {
    const serial = ++loadSerial;
    $("knowledge-count").textContent = "正在读取 Obsidian 知识库…";
    try {
      let data, failure;
      try {
        const response = await fetch("api/knowledge/graph" + (refresh ? "?refresh=1" : ""), { cache: "no-store" });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || "知识库读取失败");
      } catch (error) { failure = error; data = { vault:'本机资料', nodes:[], links:[] }; }
      let imported = [];
      try { if (window.NeuralImports) imported = await NeuralImports.graph(); }
      catch (error) { HUD.log(error.message, 'warn'); }
      if (failure && !imported.length) throw failure;
      data = { ...data, noteCount:data.nodes.length, importCount:imported.length, nodes:[...data.nodes, ...imported] };
      if (serial !== loadSerial) return null;
      build(data);
      return data;
    } catch (error) {
      $("knowledge-count").textContent = "知识库未连接 · 点击刷新重试";
      HUD.log("知识库：" + error.message, "warn");
      return null;
    }
  }

  function create(parent, sceneCamera, sceneCanvas) {
    camera = sceneCamera; canvas = sceneCanvas;
    group = new THREE.Group(); group.name = "obsidian-knowledge"; parent.add(group);
    $("btn-knowledge-refresh").addEventListener("click", () => load(true));
    window.addEventListener('jarvis-imports-changed', () => load());
    $("btn-knowledge-lock").addEventListener("click", () => {
      const next = !Hologram.isLocked();
      if (window.HandTracking) HandTracking.setLocked(next); else Hologram.setLocked(next);
    });
    $("knowledge-close").addEventListener("click", closeReader);
    $("knowledge-prev").addEventListener("click", () => turnPage(-1));
    $("knowledge-next").addEventListener("click", () => turnPage(1));
    $("knowledge-note-content").addEventListener("scroll", updatePage);
    window.addEventListener("keydown", e => { if (e.key === "Escape") closeReader(); });
    canvas.addEventListener("mousemove", e => { mousePoint = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener("mouseleave", () => { mousePoint = null; });
    let clickStart = null;
    canvas.addEventListener('pointerdown', event => { if (event.button === 0) clickStart = { x:event.clientX, y:event.clientY }; });
    canvas.addEventListener('pointerup', event => {
      const start = clickStart; clickStart = null;
      if (!start || Math.hypot(start.x-event.clientX,start.y-event.clientY) > 6 || swipe?.started) return;
      const index = pick(event.clientX, event.clientY);
      if (index >= 0 && entries[index].note.source === 'import' && entries[index].note.kind !== 'image') openById(entries[index].note.id).catch(error => HUD.log(error.message,'warn'));
    });
    canvas.addEventListener("mousedown", e => {
      if (e.button !== 0 || !locked || handPoint || (active < 0 && !docked)) return;
      mouseDragging = true;
      mousePoint = { x: e.clientX, y: e.clientY };
      if (docked) docked.gesture = readingGesture(mousePoint, "mouse");
      else if (isReadable(active)) swipe = candidate(active, mousePoint, "mouse");
    });
    for (const heading of [$("knowledge-note-title"), document.querySelector("#knowledge-reader .knowledge-label")]) {
      heading.addEventListener("mousedown", e => {
        if (e.button !== 0 || !locked || !docked || handPoint) return;
        e.preventDefault(); mouseDragging = true;
        mousePoint = { x: e.clientX, y: e.clientY };
        docked.gesture = readingGesture(mousePoint, "mouse");
      });
    }
    window.addEventListener("mousemove", e => { if (mouseDragging) mousePoint = { x: e.clientX, y: e.clientY }; });
    window.addEventListener("mouseup", () => {
      if (mouseDragging) { if (swipe?.source === "mouse") finishSwipe(); mouseDragging = false; }
      if (docked?.gesture?.source === "mouse") docked.gesture = null;
    });
    window.addEventListener("resize", () => finishSwipe());
    return { load, update, group };
  }

  function closeReader() {
    if (!$("knowledge-reader").hidden && swipe?.direction !== "close" && window.SoundFX) SoundFX.cue("close");
    swipe = docked = null;
    dismissed = active;
    if (cardAnimation) { cardAnimation.cancel(); cardAnimation = null; }
    $("knowledge-reader").hidden = true;
    clearAttachment();
    $("knowledge-reader").style.transform = "";
    $("knowledge-reader").style.opacity = "";
    $("knowledge-reader").style.pointerEvents = "";
    document.body.classList.remove("knowledge-reading");
    opened = -1; requestSerial++;
    if (controller) controller.abort();
    updateMode();
  }

  async function openNote(index) {
    const entry = entries[index];
    if (!entry || !isReadable(index) || opened === index) return;
    opened = index;
    const serial = ++requestSerial;
    if (controller) controller.abort();
    controller = new AbortController();
    const reader = $("knowledge-reader");
    reader.hidden = false;
    document.body.classList.add("knowledge-reading");
    $("knowledge-note-title").textContent = entry.note.title;
    $("knowledge-note-path").textContent = entry.note.path;
    $("knowledge-note-content").textContent = "正在读取笔记…";
    clearAttachment();
    $("knowledge-note-content").hidden = false;
    document.querySelector('#knowledge-reader .knowledge-navigation').hidden = false;
    document.querySelector('#knowledge-reader .knowledge-label').textContent = entry.note.source === 'import' ? '导入资料 · 本机保存' : 'OBSIDIAN · 本机只读';
    $("knowledge-note-content").scrollTop = 0;
    updatePage();
    try {
      const note = await readNote(index);
      if (serial === requestSerial) {
        if (note.kind === 'image' || note.kind === 'pdf') {
          $("knowledge-note-content").hidden = true;
          document.querySelector('#knowledge-reader .knowledge-navigation').hidden = true;
          const host = $('knowledge-attachment'); host.hidden = false;
          attachmentURL = URL.createObjectURL(note.blob);
          const media = document.createElement(note.kind === 'image' ? 'img' : 'iframe');
          if (note.kind === 'image') media.alt = entry.note.title;
          else media.title = entry.note.title;
          media.src = attachmentURL; host.append(media);
          const download = document.createElement('a'); download.href = attachmentURL;
          download.download = entry.note.title; download.textContent = '保存原文件'; host.append(download);
        } else $("knowledge-note-content").textContent = note.content;
        $("knowledge-note-content").scrollTop = 0;
        updatePage();
      }
    } catch (error) {
      if (serial === requestSerial && error.name !== "AbortError") {
        $("knowledge-note-content").textContent = error.message; opened = -1;
      }
    }
  }

  function declaredReadable(index) { return entries[index] && entries[index].note.hasContent !== false; }
  function isReadable(index) { return declaredReadable(index) && noteCache.get(entries[index].note.id)?.status === "ready"; }

  async function readNote(index) {
    const entry = entries[index];
    if (!entry || !declaredReadable(index)) throw new Error("此知识点暂无可读正文");
    const id = entry.note.id, cached = noteCache.get(id);
    if (cached && performance.now() - cached.at < 20000) {
      if (cached.status === "ready") return cached.note;
      if (cached.status === "loading") return cached.promise;
      throw new Error(cached.error);
    }
    const item = { status: "loading", at: performance.now() };
    noteCache.set(id, item);
    item.promise = (async () => {
      try {
        let note;
        if (entry.note.source === 'import') note = await NeuralImports.read(id);
        else {
          const response = await fetch("api/knowledge/note?id=" + encodeURIComponent(id), { cache: "no-store" });
          note = await response.json();
          if (!response.ok) throw new Error(note.error || "文档暂时无法读取");
        }
        const body = (note.content || "").replace(/^---\s*\n[\s\S]*?\n---(?:\n|$)/, "").replace(/<!--[\s\S]*?-->/g, "");
        const hasBody = note.hasContent !== false && body.split("\n").some(line => line.trim() && !/^\s*(?:#{1,6}\s+.*|[-*_]{3,})\s*$/.test(line));
        if (!hasBody && !['image','pdf'].includes(note.kind)) throw new Error("此知识点暂无可读正文");
        item.status = "ready"; item.note = note; item.at = performance.now();
        return note;
      } catch (error) {
        item.status = "unavailable"; item.error = error.message; item.at = performance.now();
        throw error;
      }
    })();
    return item.promise;
  }

  function clearAttachment() {
    const host = $('knowledge-attachment');
    if (host) { host.replaceChildren(); host.hidden = true; }
    if (attachmentURL) { URL.revokeObjectURL(attachmentURL); attachmentURL = null; }
  }
  async function openById(id) {
    const index = entries.findIndex(entry => entry.note.id === id);
    if (index < 0) throw new Error('网络正在更新，请稍后再点。');
    await readNote(index);
    swipe = null;
    docked = { index, anchor:screenPosition(index), offset:{x:0,y:0}, travel:200, gesture:null };
    await openNote(index); updateMode();
  }

  function showDocumentGlow(index) {
    const selected = isReadable(index) ? index : -1;
    const key = String(selected);
    if (halo) {
      halo.visible = selected >= 0;
      if (selected >= 0) halo.position.copy(entries[selected].position);
    }
    if (!glowPoints || focusKey === key) return;
    focusKey = key; focused = selected; glowing = [];
    glowPoints.visible = glowLines.visible = selected >= 0;
    if (selected < 0) return;
    const neighborhood = new Set([selected]);
    for (const [a,b] of networkEdges) if (a === selected || b === selected) {
      if (declaredReadable(a)) neighborhood.add(a);
      if (declaredReadable(b)) neighborhood.add(b);
    }
    entries.forEach((entry, i) => {
      if (declaredReadable(i) && entry.position.distanceTo(entries[selected].position) < .5) neighborhood.add(i);
    });
    glowing = [...neighborhood];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(glowing.flatMap(i => entries[i].position.toArray()), 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(glowing.flatMap(i => new THREE.Color(i === selected ? 0xffe6a1 : 0x83edff).toArray()), 3));
    geometry.setAttribute("nodeSize", new THREE.Float32BufferAttribute(glowing.map(i => i === selected ? .55 : .35), 1));
    glowPoints.geometry.dispose(); glowPoints.geometry = geometry;
    const lines = new THREE.BufferGeometry();
    lines.setAttribute("position", new THREE.Float32BufferAttribute(networkEdges
      .filter(([a,b]) => neighborhood.has(a) && neighborhood.has(b) && declaredReadable(a) && declaredReadable(b))
      .flatMap(([a,b]) => [...entries[a].position.toArray(), ...entries[b].position.toArray()]), 3));
    glowLines.geometry.dispose(); glowLines.geometry = lines;
  }

  function pick(x, y, radius = 24) {
    if (!group || !camera) return -1;
    group.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    let best = -1, score = radius * radius;
    entries.forEach((entry, i) => {
      projected.copy(entry.position); group.localToWorld(projected); projected.project(camera);
      if (projected.z < -1 || projected.z > 1) return;
      const px = (projected.x + 1) * innerWidth / 2;
      const py = (1 - projected.y) * innerHeight / 2;
      const d2 = (px - x) ** 2 + (py - y) ** 2;
      if (d2 < score) { best = i; score = d2; }
    });
    return best;
  }

  function screenPosition(index) {
    group.updateWorldMatrix(true, false); camera.updateMatrixWorld();
    const p = group.localToWorld(entries[index].position.clone()).project(camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  }

  function candidate(index, pointer, source) {
    return { index, source, direction: "open", origin: { ...pointer }, anchor: screenPosition(index),
      since: performance.now(), stableSince: performance.now(), last: { ...pointer },
      ready: source === "mouse", started: false, progress: 0 };
  }

  function beginSwipe() {
    if (window.SoundFX) SoundFX.cue("open");
    const current = swipe;
    if (cardAnimation) { cardAnimation.cancel(); cardAnimation = null; }
    const reader = $("knowledge-reader");
    // Read the final docking rectangle before applying the node transform.
    reader.style.transform = ""; reader.style.opacity = "";
    openNote(current.index);
    const rect = reader.getBoundingClientRect();
    current.offset = { x: current.anchor.x - rect.x - rect.width / 2,
      y: current.anchor.y - rect.y - rect.height / 2 };
    current.travel = Math.max(140, Math.min(240, innerWidth * .15));
    current.started = true;
    docked = null;
    reader.style.pointerEvents = "none";
    drawSwipe(0);
  }

  function drawSwipe(progress) {
    if (!swipe?.started) return;
    const reader = $("knowledge-reader"), p = Math.max(0, Math.min(1, progress));
    swipe.progress = p;
    // Progress follows horizontal hand displacement, not a timed entrance.
    reader.style.transform = `translate(${swipe.offset.x * (1 - p)}px, ${swipe.offset.y * (1 - p)}px) scale(${.08 + .92 * p})`;
    reader.style.opacity = String(.35 + .65 * p);
  }

  function finishSwipe() {
    if (!swipe) return;
    if (!swipe.started) { swipe = null; return; }
    if (swipe.progress < (swipe.direction === "close" ? .45 : .55)) { closeReader(); return; }
    const reader = $("knowledge-reader"), from = { transform: reader.style.transform, opacity: reader.style.opacity };
    dockCard(swipe.lastPointer || swipe.origin);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cardAnimation = reader.animate([from, { transform: "none", opacity: 1 }],
        { duration: 160, easing: "cubic-bezier(.22, 1, .36, 1)" });
    }
  }

  function dockCard(pointer) {
    if (!swipe) return;
    const current = swipe;
    docked = { index: current.index, anchor: current.anchor, offset: current.offset,
      travel: current.travel, gesture: pointer ? readingGesture(pointer, current.source) : null };
    swipe = null;
    const reader = $("knowledge-reader");
    reader.style.transform = ""; reader.style.opacity = ""; reader.style.pointerEvents = "";
    updatePage(); updateMode();
  }

  function readingGesture(pointer, source) {
    return { origin: { ...pointer }, last: { ...pointer }, source, axis: null, lastMove: performance.now() };
  }

  function pageState() {
    const content = $("knowledge-note-content");
    const step = Math.max(80, content.clientHeight - 32);
    const max = Math.max(0, content.scrollHeight - content.clientHeight);
    const count = Math.ceil(max / step) + 1;
    return { step, max, top: content.scrollTop, count,
      page: content.scrollTop >= max - 1 ? count : Math.min(count, Math.round(content.scrollTop / step) + 1) };
  }

  function updatePage() {
    const p = pageState();
    $("knowledge-page").textContent = `${p.page} / ${p.count}`;
    $("knowledge-prev").disabled = p.top <= 1;
    $("knowledge-next").disabled = p.top >= p.max - 1;
  }

  function turnPage(direction) {
    if ($("knowledge-reader").hidden) return;
    const p = pageState();
    const targetPage = Math.max(0, Math.min(p.count - 1, p.page - 1 + direction));
    $("knowledge-note-content").scrollTo({ top: Math.min(p.max, targetPage * p.step),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }

  function updateReading(pointer, source) {
    if (!docked) return;
    if (cardAnimation) { cardAnimation.cancel(); cardAnimation = null; }
    // Each vertical stroke changes one page. Re-arm after the finger pauses,
    // so holding at an edge cannot repeatedly turn pages.
    if (!docked.gesture || docked.gesture.source !== source) docked.gesture = readingGesture(pointer, source);
    const gesture = docked.gesture, now = performance.now();
    if (Math.hypot(pointer.x - gesture.last.x, pointer.y - gesture.last.y) > 2) {
      gesture.lastMove = now; gesture.last = { ...pointer };
    }
    if (gesture.axis === "page") {
      if (now - gesture.lastMove > 220) docked.gesture = readingGesture(pointer, source);
      return;
    }
    if (now - gesture.lastMove > 220) {
      docked.gesture = readingGesture(pointer, source); return;
    }
    const dx = pointer.x - gesture.origin.x, dy = pointer.y - gesture.origin.y;
    if (Math.abs(dy) > 62 && Math.abs(dy) > Math.abs(dx) * 1.4) {
      turnPage(dy < 0 ? 1 : -1); gesture.axis = "page";
    } else if (dx < -32 && -dx > Math.abs(dy) * 1.3) {
      if (window.SoundFX) SoundFX.cue("close");
      // Reverse the very same node-to-card path, retaining the source note.
      swipe = { ...docked, direction: "close", source, started: true, progress: 1,
        origin: { ...gesture.origin }, lastPointer: { ...pointer } };
      docked = null;
      $("knowledge-reader").style.pointerEvents = "none";
      drawSwipe(1 - (-dx - 22) / swipe.travel);
    }
  }

  function updateSwipe(pointer, index, source) {
    if (!locked || !pointer || (source === "mouse" && !mouseDragging)) {
      if (swipe && performance.now() - lastHandAt > 180) finishSwipe();
      if (docked && performance.now() - lastHandAt > 180) docked.gesture = null;
      return;
    }
    if (docked) { updateReading(pointer, source); return; }
    if (swipe && swipe.source !== source) finishSwipe();
    if (!swipe && index >= 0 && dismissed !== index && isReadable(index)) swipe = candidate(index, pointer, source);
    if (!swipe) return;
    if (!swipe.started && !isReadable(swipe.index)) { swipe = null; return; }
    if (!swipe.started && !swipe.ready) {
      if (index !== swipe.index) {
        swipe = index >= 0 && dismissed !== index && isReadable(index) ? candidate(index, pointer, source) : null;
        return;
      }
      if (Math.hypot(pointer.x - swipe.last.x, pointer.y - swipe.last.y) > 3) swipe.stableSince = performance.now();
      swipe.last = { ...pointer };
      if (performance.now() - swipe.stableSince >= 120) {
        swipe.ready = true; swipe.origin = { ...pointer };
      }
      return;
    }
    const dx = pointer.x - swipe.origin.x, dy = pointer.y - swipe.origin.y;
    if (!swipe.started) {
      if ((source === "mouse" || performance.now() - swipe.since >= 100) && dx > 22 && dx > Math.abs(dy) * 1.25) beginSwipe();
      else if (index !== swipe.index) {
        swipe = index >= 0 && dismissed !== index && isReadable(index) ? candidate(index, pointer, source) : null;
        return;
      }
    }
    if (!swipe?.started) return;
    swipe.lastPointer = { ...pointer };
    if (swipe.direction === "close") {
      drawSwipe(1 - (-dx - 22) / swipe.travel);
      if (swipe.progress <= .01) closeReader();
      else if (swipe.progress >= 1) dockCard(pointer);
    } else {
      drawSwipe((dx - 22) / swipe.travel);
      if (swipe.progress >= 1) dockCard(pointer);
      else if (dx < 8 || Math.abs(dy) > Math.max(180, dx * 1.5)) closeReader();
    }
  }

  function clearPointer() {
    handPoint = null;
    if ($("knowledge-cursor")) $("knowledge-cursor").hidden = true;
  }

  function point(nx, ny, present = true) {
    handPoint = present ? { x: nx * innerWidth, y: ny * innerHeight } : null;
    if (handPoint) lastHandAt = performance.now();
  }

  function setLocked(value) {
    if (!value) finishSwipe();
    swipe = null;
    if (docked) docked.gesture = null;
    locked = value; clearPointer();
    $("btn-knowledge-lock").textContent = value ? "🔒 已锁定 · 点击解锁" : "◇ 锁定球体";
    $("btn-knowledge-lock").classList.toggle("active", value);
    updateMode();
  }

  function updateMode() {
    $("knowledge-mode").textContent = !locked ? "张掌旋转 · 双手缩放 · OK 保持半秒锁定"
      : docked ? "卡片已展开 · 上滑下一页 / 下滑上一页 · 左滑缩小收回"
      : "大小与角度已固定 · 指向后周边亮起表示有文档，再向右滑展开";
  }

  function update() {
    const pointer = handPoint || mousePoint;
    const cursor = $("knowledge-cursor"), tip = $("knowledge-tip");
    cursor.hidden = !handPoint;
    if (handPoint) { cursor.style.left = handPoint.x + "px"; cursor.style.top = handPoint.y + "px"; }
    const source = handPoint ? "hand" : "mouse";
    let index = pointer ? pick(pointer.x, pointer.y) : -1;
    if (index >= 0 && declaredReadable(index) && !docked && !swipe?.started) readNote(index).catch(() => {});
    updateSwipe(pointer, index, source);
    if (swipe?.started) index = swipe.index;
    if (docked) index = docked.index;
    if (index !== active) { active = index; dismissed = -1; }
    showDocumentGlow(index);
    if (glowPoints) glowPoints.material.uniforms.time.value = performance.now() * .001;
    tip.hidden = index < 0 || Boolean(docked);
    if (index < 0 || !pointer) { tip.hidden = true; return; }
    const availability = noteCache.get(entries[index].note.id);
    const hint = !declaredReadable(index) ? "暂无正文 · 不可展开"
      : availability?.status === "unavailable" ? "文档暂不可读 · 请刷新知识库"
      : !isReadable(index) ? "正在确认文档…"
      : locked && !swipe?.started ? "有文档 · 右滑展开" : "有文档";
    tip.textContent = entries[index].note.title + " · " + hint;
    tip.style.left = Math.min(innerWidth - Math.min(300, tip.offsetWidth) - 16, Math.max(16, pointer.x + 18)) + "px";
    tip.style.top = Math.max(16, Math.min(innerHeight - 100, pointer.y - 38)) + "px";
  }

  window.Knowledge = { create, point, clearPointer, setLocked, pick, openById,
    // Snapshot used by interaction diagnostics; returns real IDs and projections.
    snapshot() {
      group?.updateWorldMatrix(true, false); camera?.updateMatrixWorld();
      return { locked, active: entries[active]?.note.id || null, count: entries.length,
        glow: { active: focused >= 0, id: entries[focused]?.note.id || null,
          nodes: glowing.map(i => entries[i].note.id), edgeCount: (glowLines?.geometry.attributes.position?.count || 0) / 2 },
        swipe: swipe ? { id: entries[swipe.index]?.note.id, direction: swipe.direction, ready: swipe.ready,
          started: swipe.started, progress: swipe.progress, anchor: swipe.anchor, origin: swipe.origin } : null,
        card: { id: entries[opened]?.note.id || null, docked: Boolean(docked),
          returning: swipe?.direction === "close", ...pageState() },
        links: graphData?.links.length || 0, nodes: entries.map(entry => {
          const p = group.localToWorld(entry.position.clone()).project(camera);
          return { id: entry.note.id, title: entry.note.title, source:entry.note.source || 'obsidian', kind:entry.note.kind || 'text', hasContent: entry.note.hasContent !== false,
            readable: isReadable(entries.indexOf(entry)), x: (p.x + 1) * innerWidth / 2,
            y: (1 - p.y) * innerHeight / 2 };
        }) };
    } };
})();
