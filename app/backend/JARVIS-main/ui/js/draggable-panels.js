/* Drag each HUD panel by its heading. Store normalized position locally. */
(function () {
  "use strict";
  const key = "jarvis-hud-panel-positions-v1";
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) {}
  if (!saved || typeof saved !== "object") saved = {};
  const panels = [...document.querySelectorAll(".draggable-panel")];
  const spacers = new Map();
  const clamp = (v, max) => Math.max(12, Math.min(Math.max(12, max), v));
  function place(panel, x, y) {
    const box = panel.getBoundingClientRect();
    if (panel.style.position !== "fixed") {
      const spacer = document.createElement("div");
      spacer.style.height = box.height + "px";
      spacer.style.marginBottom = getComputedStyle(panel).marginBottom;
      panel.before(spacer); spacers.set(panel, spacer);
      // A transformed HUD parent makes fixed children relative to itself.
      // Move the floating panel into the viewport coordinate system.
      document.body.appendChild(panel);
    }
    panel.style.position = "fixed"; panel.style.width = box.width + "px";
    panel.style.transform = 'none';
    panel.style.margin = "0"; panel.style.zIndex = "14";
    panel.style.left = clamp(x, innerWidth - box.width - 12) + "px";
    panel.style.top = clamp(y, innerHeight - box.height - 12) + "px";
  }
  function restore(panel) {
    const p = saved[panel.id];
    if (p && Number.isFinite(p.height)) { panel.style.height = Math.max(90,Math.min(innerHeight-24,p.height)) + 'px'; panel.classList.add('user-sized'); }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) place(panel, p.x * innerWidth, p.y * innerHeight);
  }
  function persist(panel) {
    const box = panel.getBoundingClientRect();
    saved[panel.id] = { x: box.left / innerWidth, y: box.top / innerHeight,
      height: panel.classList.contains('user-sized') ? box.height : undefined };
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch (_) {}
  }
  panels.forEach(panel => {
    restore(panel);
    const handle = panel.querySelector(".drag-handle");
    const grip = document.createElement('button'); grip.type = 'button'; grip.className = 'panel-height-grip';
    grip.textContent = '↕'; grip.setAttribute('aria-label', '调整卡片高度'); grip.title = '上下拖动调整高度'; panel.append(grip);
    let resizing = null;
    const height = value => { const box = panel.getBoundingClientRect(); panel.style.height = Math.max(90,Math.min(Math.max(90,innerHeight-box.top-12),value))+'px'; panel.classList.add('user-sized'); };
    grip.addEventListener('pointerdown', e => { if(e.button!==0)return;e.preventDefault();e.stopPropagation();resizing={y:e.clientY,height:panel.getBoundingClientRect().height};grip.setPointerCapture(e.pointerId); });
    grip.addEventListener('pointermove', e => { if(resizing) height(resizing.height+e.clientY-resizing.y); });
    const endResize = () => { if(!resizing)return;resizing=null;persist(panel); };
    grip.addEventListener('pointerup',endResize); grip.addEventListener('pointercancel',endResize); grip.addEventListener('lostpointercapture',endResize);
    grip.addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();height(panel.getBoundingClientRect().height+(e.key==='ArrowDown'?20:-20));persist(panel);}});
    let drag = null;
    handle.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const box = panel.getBoundingClientRect();
      place(panel, box.left, box.top);
      drag = { x: e.clientX - box.left, y: e.clientY - box.top };
      panel.classList.add("dragging"); handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", e => {
      if (!drag) return;
      place(panel, e.clientX - drag.x, e.clientY - drag.y);
    });
    const finish = () => { if (!drag) return; drag = null; panel.classList.remove("dragging"); persist(panel); };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("dblclick", () => {
      delete saved[panel.id];
      try { localStorage.setItem(key, JSON.stringify(saved)); } catch (_) {}
      const spacer = spacers.get(panel);
      if (spacer) { spacer.replaceWith(panel); spacers.delete(panel); }
      panel.removeAttribute("style");
      panel.classList.remove('user-sized');
    });
  });
  window.addEventListener("resize", () => panels.forEach(restore));
})();
