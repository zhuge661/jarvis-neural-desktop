/* ============================================================
   viz.js — holographic panels for local content
   Renders selected files as floating, draggable holo-panels.
   Everything is local: images load via object URLs (no upload,
   no network). Exposed globally as `Viz`.
   ============================================================ */
(function () {
  "use strict";

  const host = () => document.getElementById("panels");
  let offset = 0;   // cascade new panels so they don't stack exactly

  function frame(title) {
    const el = document.createElement("div");
    el.className = "holo-panel";
    el.style.left = `calc(50% - 220px + ${offset}px)`;
    el.style.top  = `calc(46% - 150px + ${offset}px)`;
    offset = (offset + 26) % 130;

    const bar = document.createElement("div");
    bar.className = "holo-bar";
    const t = document.createElement("span");
    t.className = "holo-title"; t.textContent = title;
    const x = document.createElement("button");
    x.className = "holo-x"; x.innerHTML = "&times;";
    bar.append(t, x);
    el.append(bar);

    // drag by the title bar
    let dx = 0, dy = 0, drag = false;
    bar.addEventListener("mousedown", (e) => {
      drag = true; dx = e.clientX - el.offsetLeft; dy = e.clientY - el.offsetTop; el.style.zIndex = 40;
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      el.style.left = (e.clientX - dx) + "px";
      el.style.top  = (e.clientY - dy) + "px";
    });
    window.addEventListener("mouseup", () => { drag = false; });
    x.addEventListener("click", () => destroy(el));

    host().append(el);
    return el;
  }

  function destroy(el) {
    el.querySelectorAll("img[data-url]").forEach((im) => URL.revokeObjectURL(im.dataset.url));
    el.remove();
  }

  function meta(file) {
    const kb = file.size < 1048576 ? (file.size / 1024).toFixed(1) + " KB"
                                   : (file.size / 1048576).toFixed(2) + " MB";
    const mod = file.lastModified ? new Date(file.lastModified).toLocaleString() : "—";
    const path = file.webkitRelativePath || file.name;
    return `<div class="ms"><span>名称</span>${file.name}</div>` +
           `<div class="ms"><span>类型</span>${file.type || "未知"}</div>` +
           `<div class="ms"><span>大小</span>${kb}</div>` +
           `<div class="ms"><span>修改时间</span>${mod}</div>` +
           `<div class="ms"><span>路径</span>${path}</div>`;
  }

  function showImage(file) {
    const el = frame(file.name);
    el.style.width = "560px"; el.style.height = "380px";
    const body = document.createElement("div"); body.className = "holo-body";
    const img = document.createElement("img");
    const u = URL.createObjectURL(file);
    img.src = u; img.dataset.url = u; img.className = "holo-img";
    img.onerror = () => { img.replaceWith(Object.assign(document.createElement("div"),
      { className: "holo-info", textContent: "无法显示此图片" })); };
    const side = document.createElement("div"); side.className = "holo-side"; side.innerHTML = meta(file);
    body.append(img, side);
    el.append(body);
    if (window.HUD) HUD.log("显示图片 → " + file.name);
    return el;
  }

  function showInfo(file) {
    const el = frame(file.name);
    const d = document.createElement("div");
    d.className = "holo-info";
    const kb = (file.size / 1024).toFixed(1);
    d.innerHTML =
      `<div><span>类型</span> ${file.type || "未知"}</div>` +
      `<div><span>大小</span> ${kb} KB</div>` +
      `<div><span>路径</span> ${file.webkitRelativePath || file.name}</div>`;
    el.append(d);
    if (window.HUD) HUD.log("查看文件 → " + file.name);
    return el;
  }

  function clearAll() {
    host().querySelectorAll(".holo-panel").forEach(destroy);
  }

  window.Viz = { showImage, showInfo, clearAll };
})();
