/* Saved model connections. Secrets stay in the project-local backend. */
(function () {
  "use strict";
  let panel, checking = null, current = null;
  const $ = (id) => document.getElementById(id);
  const fields = ["name", "api", "base_url", "model", "context_window", "max_tokens"];
  const hints = {
    "openai-completions": "填写基础地址（通常以 /v1 结尾），不要加 /chat/completions。",
    "openai-responses": "填写基础地址，不要加 /responses。服务需支持 Responses 接口。",
    "anthropic-messages": "填写服务的 Anthropic 基础地址，不要加 /messages。",
    "google-generative-ai": "填写 Gemini 基础地址，例如 https://generativelanguage.googleapis.com/v1beta。",
    "ollama": "填写 Ollama 服务地址，例如 http://127.0.0.1:11434，不要加 /api/chat。",
  };
  async function status() {
    const response = await fetch("api/backend/config", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取本地后端状态，请重启第三个项目。");
    return response.json();
  }
  function createPanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = "backend-overlay";
    panel.innerHTML = `
      <section class="backend-dialog" role="dialog" aria-modal="true" aria-labelledby="backend-title">
        <button class="backend-close" type="button" aria-label="关闭设置">×</button>
        <h2 id="backend-title">模型 API 设置</h2>
        <p>保存不同模型的连接，选中后点击“保存并连接”切换。聊天内容会发送到当前连接的服务；Key 仅保存在本机后端。</p>
        <form id="backend-form">
          <label for="backend-profile">已保存的连接</label>
          <div class="backend-profile-row"><select id="backend-profile"></select><button id="backend-new" type="button" class="hud-btn">＋ 新建</button></div>
          <label for="backend-name">连接名称</label><input id="backend-name" maxlength="256" required placeholder="例如：我的 DeepSeek / 本地模型" />
          <label for="backend-api">接口协议</label><select id="backend-api"></select>
          <label for="backend-base_url">API 基础地址（Base URL）</label><input id="backend-base_url" type="url" required maxlength="2048" spellcheck="false" placeholder="https://你的服务地址/v1" />
          <div id="backend-url-hint" class="backend-note"></div>
          <label for="backend-model">模型 ID</label><input id="backend-model" required maxlength="256" spellcheck="false" placeholder="填写服务商提供的完整模型 ID，支持自定义名称" />
          <label for="backend-key">API Key</label><input id="backend-key" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴此连接的 Key" />
          <label class="backend-check"><input id="backend-no_auth" type="checkbox" /> 此服务不需要 Key（如本地 Ollama）</label>
          <details class="backend-advanced"><summary>高级设置：上下文与输出长度</summary>
            <label for="backend-context_window">模型上下文长度（Token，至少 16000）</label><input id="backend-context_window" type="number" min="16000" max="10000000" required />
            <label for="backend-max_tokens">最大输出长度（Token）</label><input id="backend-max_tokens" type="number" min="1" max="1000000" required />
          </details>
          <div class="backend-note">模型 ID 不设厂商白名单。选择与服务匹配的协议；专有接口需另加适配器。更换地址或协议后，请重新填写 Key。</div>
          <div id="backend-status" role="status" aria-live="polite"></div>
          <button id="backend-save" type="submit" class="hud-btn">保存并连接</button>
        </form>
      </section>`;
    document.body.appendChild(panel);
    panel.querySelector(".backend-close").addEventListener("click", hide);
    panel.addEventListener("click", (event) => { if (event.target === panel) hide(); });
    $("backend-form").addEventListener("submit", save);
    $("backend-profile").addEventListener("change", fillProfile);
    $("backend-new").addEventListener("click", () => { $("backend-profile").value = "new"; fillProfile(); $("backend-name").focus(); });
    $("backend-api").addEventListener("change", updateHints);
    $("backend-base_url").addEventListener("input", updateHints);
    $("backend-no_auth").addEventListener("change", updateHints);
    return panel;
  }
  function populate(value, selected = value.active_profile) {
    current = value;
    const select = $("backend-profile");
    select.replaceChildren();
    value.profiles.forEach((p) => select.add(new Option(p.name + (p.id === value.active_profile ? " · 当前" : ""), p.id)));
    select.add(new Option("＋ 新建自定义连接", "new"));
    select.value = selected;
    const protocol = $("backend-api");
    protocol.replaceChildren();
    Object.entries(value.protocols).forEach(([id, name]) => protocol.add(new Option(name, id)));
    fillProfile();
  }
  function fillProfile() {
    const p = current.profiles.find((item) => item.id === $("backend-profile").value) || {
      name: "", api: "openai-completions", base_url: "", model: "", no_auth: false, context_window: 128000, max_tokens: 8192,
    };
    fields.forEach((field) => { $("backend-" + field).value = p[field]; });
    $("backend-no_auth").checked = p.no_auth;
    $("backend-key").value = "";
    $("backend-key").placeholder = p.key_saved ? "已保存；地址和协议不变时可留空" : "粘贴此连接的 Key";
    updateHints();
  }
  function updateHints() {
    $("backend-url-hint").textContent = hints[$("backend-api").value] || "";
    const p = current?.profiles.find((item) => item.id === $("backend-profile").value);
    const changed = p && (p.base_url !== $("backend-base_url").value.trim().replace(/\/+$/, "") || p.api !== $("backend-api").value);
    $("backend-key").disabled = $("backend-no_auth").checked;
    if (changed) $("backend-key").placeholder = "地址或协议已更换，须填写此服务的 Key";
  }
  function hide() {
    if (panel) panel.style.display = "none";
    if (checking) { clearInterval(checking); checking = null; }
    $("backend-key").value = "";
  }
  async function show() {
    createPanel().style.display = "grid";
    $("backend-status").textContent = "正在读取连接状态…";
    try { const value = await status(); populate(value); updateStatus(value); }
    catch (error) { $("backend-status").textContent = error.message; }
  }
  function updateStatus(value) {
    $("backend-status").textContent = value.ok
      ? `当前连接：${value.connection_name} / ${value.model}。网关已就绪，发送消息可验证模型 API。`
      : value.error || "模型 API 正在准备…";
    if (value.ok && window.Brain) Brain.init();
    return value.ok;
  }
  async function save(event) {
    event.preventDefault();
    const button = $("backend-save");
    button.disabled = true;
    $("backend-status").textContent = "正在保存到本机…";
    try {
      const body = { profile_id: $("backend-profile").value, no_auth: $("backend-no_auth").checked };
      fields.forEach((field) => { body[field] = $("backend-" + field).value.trim(); });
      body.context_window = Number(body.context_window);
      body.max_tokens = Number(body.max_tokens);
      if ($("backend-key").value.trim() && !body.no_auth) body.api_key = $("backend-key").value.trim();
      const response = await fetch("api/backend/config", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "保存失败");
      $("backend-key").value = "";
      const value = await status();
      populate(value);
      $("backend-status").textContent = result.message;
      if (window.Brain) Brain.init();
      if (checking) clearInterval(checking);
      const began = Date.now();
      checking = setInterval(async () => {
        try {
          const done = updateStatus(await status());
          if (done || Date.now() - began > 90000) { clearInterval(checking); checking = null; }
        } catch (error) { $("backend-status").textContent = error.message; }
      }, 2000);
    } catch (error) { $("backend-status").textContent = error.message; }
    finally { button.disabled = false; }
  }
  function init() {
    $("btn-backend").addEventListener("click", show);
  }
  window.Backend = { init, show, status };
})();
