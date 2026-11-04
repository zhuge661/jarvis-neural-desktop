/* ============================================================
   workspace.js — the Command Deck
   A single bottom bar that is both a local-file search and a
   command line. Loading a folder stays 100% on your machine
   (webkitdirectory gives File objects; nothing is uploaded).
   Typing plain text searches; typing /command runs a command.
   Exposed globally as `Workspace`.
   ============================================================ */
(function () {
  "use strict";

  const IMG = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  let files = [], input, results, folderInput;

  function init() {
    input = document.getElementById("deck-input");
    results = document.getElementById("deck-results");
    folderInput = document.getElementById("folder-input");
    const loadBtn = document.getElementById("btn-load");

    if (!input || !folderInput) return;   // deck not present
    loadBtn.addEventListener("click", () => folderInput.click());
    folderInput.addEventListener("change", onFolder);
    input.addEventListener("input", () => render(input.value));
    input.addEventListener("keydown", onKey);

    if (!("webkitdirectory" in document.createElement("input"))) {
      HUD.log("文件夹搜索需要 Chrome 或 Edge 浏览器", "warn");
    }
    HUD.log("命令控制台已就绪，输入 /help 查看命令");
  }

  function onFolder(e) {
    const list = Array.from(e.target.files || []);
    const seen = new Set(files.map((f) => f.path));
    let added = 0;
    for (const f of list) {
      const path = f.webkitRelativePath || f.name;
      if (seen.has(path)) continue;          // accumulate across loads; dedupe by path
      seen.add(path);
      files.push({ name: f.name, path: path, file: f });
      added++;
    }
    HUD.log(`新增 ${added} 个文件，合计 ${files.length} 个`);
    HUD.say(`已添加 ${added} 个文件，工作区现有 ${files.length} 个。`);
    render(input.value);
    if (window.FileMap && FileMap.isOn()) FileMap.rebuild();
  }

  function clearFiles() {
    files = [];
    HUD.log("工作区文件索引已清空");
    HUD.say("工作区文件索引已清空。");
    render(input.value);
    if (window.FileMap && FileMap.isOn()) FileMap.rebuild();
  }

  function onKey(e) {
    if (e.key === "Escape") { input.value = ""; results.innerHTML = ""; return; }
    if (e.key !== "Enter") return;
    const v = input.value.trim();
    if (v.startsWith("/")) { command(v.slice(1)); input.value = ""; results.innerHTML = ""; return; }
    if (window.Reminders && Reminders.looksLikeReminder(v)) { Reminders.create(v); input.value = ""; results.innerHTML = ""; return; }
    if (window.WebSearch) {
      const yq = WebSearch.looksLikeYouTube(v);
      if (yq) { WebSearch.youtube(yq); input.value = ""; results.innerHTML = ""; return; }
      const sq = WebSearch.looksLikeSearch(v);
      if (sq) { WebSearch.search(sq); input.value = ""; results.innerHTML = ""; return; }
    }
    if (window.Brain && Brain.isOnline() && v) { Brain.send(v); input.value = ""; results.innerHTML = ""; return; }
    const first = results.querySelector(".deck-item");
    if (first) first.click();
    else if (v && window.Brain) Brain.send(v);
  }

  function command(c) {
    const [cmd, ...rest] = c.split(/\s+/);
    switch ((cmd || "").toLowerCase()) {
      case "help":  HUD.say("/load 加载文件夹；/map 文件星图；/theme 配色；/music 背景音乐（自动律动）；/pulse 脉冲；/reset 重置；/clear 关闭面板；/clearfiles 清空索引。模型对话和提醒属于扩展功能。"); break;
      case "load":  folderInput.click(); break;
      case "clearfiles": case "clearmap": clearFiles(); break;
      case "remind": if (window.Reminders) { const a = rest.join(" ").trim(); a ? Reminders.create(a) : HUD.say("请输入提醒内容，例如 /remind take a break in 20 min（20 分钟后休息，原版时间解析使用英文）。"); } break;
      case "reminders": case "schedule": if (window.Reminders) Reminders.list(); break;
      case "search": case "web": case "google": if (window.WebSearch) { const a = rest.join(" ").trim(); a ? WebSearch.search(a) : HUD.say("请输入搜索内容，例如 /web 最新人工智能新闻。"); } break;
      case "youtube": case "yt": if (window.WebSearch) { const a = rest.join(" ").trim(); a ? WebSearch.youtube(a) : HUD.say("请输入要查找的视频，例如 /youtube lofi beats。"); } break;
      case "pulse": Hologram.pulse(); break;
      case "reset": Hologram.reset(); HUD.say("已恢复默认视角。"); break;
      case "clear": Viz.clearAll(); HUD.log("全息面板已关闭"); break;
      case "music": document.getElementById("btn-bgm")?.click(); break;
      case "memory": case "memories": if (window.Brain) Brain.memories(); break;
      case "map":   if (window.FileMap) FileMap.toggle(); break;
      case "theme": if (window.Themes) { const a = rest.join(" ").trim(); a ? Themes.set(a) : Themes.cycle(); } break;
      default:      HUD.log("未知命令：/" + cmd, "warn");
    }
  }

  function render(q) {
    q = (q || "").trim().toLowerCase();
    results.innerHTML = "";
    if (!q) return;
    if (!files.length) {
      const e = document.createElement("div");
      e.className = "deck-empty"; e.textContent = "请先点击“加载文件夹”";
      results.append(e); return;
    }
    const hits = files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 40);
    if (!hits.length) {
      const e = document.createElement("div");
      e.className = "deck-empty"; e.textContent = "没有匹配的文件";
      results.append(e); return;
    }
    for (const f of hits) {
      const it = document.createElement("div");
      it.className = "deck-item";
      it.innerHTML = `<span class="di-name">${f.name}</span><span class="di-path">${f.path}</span>`;
      it.addEventListener("click", () => open(f));
      results.append(it);
    }
  }

  function open(f) {
    if (/\.(csv|tsv|xlsx|xls)$/i.test(f.name) && window.Charts) Charts.show(f.file);
    else if (IMG.test(f.name)) Viz.showImage(f.file);
    else Viz.showInfo(f.file);
    results.innerHTML = ""; input.value = "";
  }

  window.Workspace = { init, getFiles: () => files, clearFiles };
})();
