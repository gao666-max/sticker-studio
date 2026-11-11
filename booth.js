(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let settingsData = null;
  let refreshTimer = null;
  let boothToken = sessionStorage.getItem("boothToken") || "";

  const STATUS = {
    character_queued: ["排队解析", "active"],
    character_processing: ["生成角色", "active"],
    character_ready: ["角色待确认", "ready"],
    character_failed: ["角色失败", "failed"],
    gif_queued: ["排队 GIF", "active"],
    gif_generating: ["生成 GIF", "active"],
    gif_ready: ["已出片", "ready"],
    gif_failed: ["GIF 失败", "failed"],
    expired: ["已过期", "failed"]
  };

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (boothToken) headers["X-Booth-Token"] = boothToken;
    const response = await fetch(path, Object.assign({}, options, { headers }));
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin();
      throw new Error(data.error || "需要运营 PIN");
    }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function showLogin() {
    $("loginOverlay").hidden = false;
    setTimeout(() => $("loginPin").focus(), 50);
    clearInterval(refreshTimer);
  }

  function hideLogin() {
    $("loginOverlay").hidden = true;
  }

  async function login() {
    const pin = $("loginPin").value.trim();
    if (!pin) { $("loginNote").textContent = "请输入 PIN"; return; }
    try {
      const response = await fetch("/api/booth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "PIN 不正确");
      boothToken = data.token;
      sessionStorage.setItem("boothToken", boothToken);
      $("loginPin").value = "";
      $("loginNote").textContent = "";
      hideLogin();
      await loadAll();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(loadSessions, 10000);
    } catch (e) {
      $("loginNote").textContent = e.message;
    }
  }

  function logout() {
    boothToken = "";
    sessionStorage.removeItem("boothToken");
    showLogin();
  }

  function toast(message) {
    const node = $("toast");
    node.textContent = message;
    node.classList.add("is-show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("is-show"), 2200);
  }

  function formatTime(value) {
    if (!value) return "—";
    try { return new Date(value).toLocaleString(); } catch (e) { return value; }
  }

  function statusPill(status) {
    const item = STATUS[status] || [status, ""];
    return '<span class="pill ' + item[1] + '">' + item[0] + "</span>";
  }

  function renderStats(stats) {
    $("statTotal").textContent = String(stats.total || 0);
    $("statReady").textContent = String(stats.ready || 0);
    $("statActive").textContent = String(stats.active || 0);
    $("statFailed").textContent = String((stats.failed || 0) + (stats.expired || 0));
  }

  function renderSessions(sessions) {
    $("sessionNote").textContent = "显示最近 " + sessions.length + " 条 · 自动刷新 10 秒";
    if (!sessions.length) {
      $("sessionList").innerHTML = '<div class="empty">还没有会话。打开拍照亭，先用示例照片走一遍。</div>';
      return;
    }
    $("sessionList").innerHTML = sessions.map((session) => {
      const action = session.action ? session.action.word || session.action.id : "未选动作";
      const mode = session.portrait_mode === "full" ? "全身" : "半身";
      const error = session.error ? '<div class="session-meta">错误：' + escapeHtml(session.error) + "</div>" : "";
      const links = [];
      if (session.character_url) links.push('<a href="' + session.character_url + '" target="_blank" rel="noopener">角色</a>');
      if (session.gif_url) links.push('<a href="' + session.gif_url + '" target="_blank" rel="noopener">GIF</a>');
      if (session.status === "gif_ready") links.push('<a href="' + session.qr_url + '" target="_blank" rel="noopener">二维码</a>');
      links.push('<button type="button" data-action="copy" data-url="' + escapeHtml(session.claim_url) + '">复制链接</button>');
      if (session.status === "character_failed") links.push('<button type="button" data-action="retry-character">重试角色</button>');
      if (session.status === "gif_failed" || session.status === "expired") links.push('<button type="button" data-action="retry-gif">重试 GIF</button>');
      links.push('<button type="button" class="danger" data-action="delete">删除</button>');
      return '<article class="session" data-id="' + escapeHtml(session.id) + '">' +
        '<div class="session-main">' +
          '<div class="session-top"><b>' + escapeHtml(session.id) + "</b>" + statusPill(session.status) +
            '<span class="pill">' + mode + "</span>" +
            '<span class="pill">' + escapeHtml(action) + "</span></div>" +
          '<div class="session-meta">' + formatTime(session.created_at) + " · 重试 " + (session.retries || 0) + " 次</div>" +
          error +
        "</div>" +
        '<div class="session-actions">' + links.join("") + "</div>" +
      "</article>";
    }).join("");

    $("sessionList").querySelectorAll(".session").forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", () => handleAction(button.dataset.action, id, button.dataset.url));
      });
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function handleAction(action, id, url) {
    if (action === "copy") {
      try { await navigator.clipboard.writeText(url); toast("链接已复制"); }
      catch (e) { toast("复制失败，请手动打开"); }
      return;
    }
    if (action === "delete") {
      if (!window.confirm("删除这个会话和它的照片、角色、GIF？不可恢复。")) return;
      try { await api("/api/kiosk/sessions/" + id, { method: "DELETE" }); toast("已删除"); loadAll(); }
      catch (e) { toast("删除失败：" + e.message); }
      return;
    }
    if (action === "retry-character") {
      try { await api("/api/kiosk/sessions/" + id + "/retry-character", { method: "POST", body: "{}" }); toast("已重新排队"); loadAll(); }
      catch (e) { toast("重试失败：" + e.message); }
      return;
    }
    if (action === "retry-gif") {
      try { await api("/api/kiosk/sessions/" + id + "/retry-gif", { method: "POST", body: "{}" }); toast("已重新排队 GIF"); loadAll(); }
      catch (e) { toast("重试失败：" + e.message); }
    }
  }

  function fillSettings(settings) {
    settingsData = settings;
    const booth = settings.booth || {};
    $("deviceName").value = booth.deviceName || "拍照亭 01";
    $("deviceId").value = booth.deviceId || "";
    $("retentionHours").value = booth.retentionHours || 24;
    $("publicBaseUrl").value = booth.publicBaseUrl || "";
    $("deleteOriginals").checked = booth.deleteOriginals !== false;
    $("boothPin").value = "";
    $("networkNote").textContent = "LAN " + (booth.lanIp || "—") + ":" + (booth.port || 8787) + " · 服务 " + (booth.host || "127.0.0.1");
    $("baseHint").textContent = "二维码会用 " + (booth.effectiveBaseUrl || "自动地址") + " 生成。手机必须和电脑同一 Wi-Fi，防火墙要放行端口。";
  }

  async function loadSettings() {
    const settings = await api("/api/settings");
    fillSettings(settings);
    return settings;
  }

  async function loadSessions() {
    const data = await api("/api/kiosk/sessions?limit=50");
    renderStats(data.stats || {});
    renderSessions(data.sessions || []);
  }

  async function loadAll() {
    try {
      await loadSettings();
      await loadSessions();
    } catch (e) {
      toast("读取失败：" + e.message);
    }
  }

  async function saveSettings() {
    if (!settingsData) return;
    const current = settingsData;
    const payload = {
      provider: current.provider,
      model: current.model,
      endpoint: current.endpoint,
      priceInputUsd: current.prices.inputUsd,
      priceOutputUsd: current.prices.outputUsd,
      usdToCny: current.prices.usdToCny,
      contentStyle: current.content.style,
      captionTone: current.content.tone,
      promptExtra: current.content.extra,
      deviceName: $("deviceName").value.trim(),
      deviceId: $("deviceId").value.trim(),
      retentionHours: Number($("retentionHours").value),
      publicBaseUrl: $("publicBaseUrl").value.trim(),
      deleteOriginals: $("deleteOriginals").checked
    };
    if ($("boothPin").value.trim()) payload.boothPin = $("boothPin").value.trim();
    try {
      const updated = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      fillSettings(updated);
      toast("设置已保存，二维码会使用新地址");
      loadSessions();
    } catch (e) {
      toast("保存失败：" + e.message);
    }
  }

  async function cleanup() {
    if (!window.confirm("删除超过保留时间的会话、照片和作品？")) return;
    try {
      const result = await api("/api/kiosk/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: Number($("retentionHours").value) })
      });
      toast("已清理 " + result.removed + " 条");
      loadSessions();
    } catch (e) { toast("清理失败：" + e.message); }
  }

  function bindEvents() {
    $("openKiosk").addEventListener("click", () => window.open("kiosk.html", "_blank", "noopener"));
    $("refreshBtn").addEventListener("click", loadAll);
    $("saveSettings").addEventListener("click", saveSettings);
    $("cleanupBtn").addEventListener("click", cleanup);
    $("loginBtn").addEventListener("click", login);
    $("loginPin").addEventListener("keydown", (event) => {
      if (event.key === "Enter") login();
    });
    $("logoutBtn").addEventListener("click", logout);
    $("detectBtn").addEventListener("click", () => {
      if (!settingsData) return;
      const booth = settingsData.booth || {};
      $("publicBaseUrl").value = "http://" + (booth.lanIp || "127.0.0.1") + ":" + (booth.port || 8787);
      toast("已填入本机局域网地址");
    });
    $("copyBaseBtn").addEventListener("click", async () => {
      const value = $("publicBaseUrl").value.trim() || (settingsData && settingsData.booth && settingsData.booth.effectiveBaseUrl) || "";
      if (!value) return;
      try { await navigator.clipboard.writeText(value); toast("地址已复制"); }
      catch (e) { toast("复制失败"); }
    });
  }

  function start() {
    bindEvents();
    if (!boothToken) {
      showLogin();
      return;
    }
    hideLogin();
    loadAll();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(loadSessions, 10000);
  }

  start();
})();
