(function () {
  "use strict";

  var ASSET = "assets/";
  var DELIVER = "assets/deliver/";
  var STORAGE_KEY = "sticker-studio-v2";
  var SAMPLE = ASSET + "character.webp";

  var STATUS = {
    draft: { label: "待生成", cls: "draft" },
    queued: { label: "已提交", cls: "queued" },
    generating: { label: "生成中", cls: "generating" },
    review: { label: "待复核", cls: "review" },
    done: { label: "已完成", cls: "done" },
    failed: { label: "已退回", cls: "failed" }
  };

  var DEFAULT_PACK = {
    name: "蓝花旗袍",
    intro: "穿蓝花旗袍、戴珍珠项链的阿姨，爱笑爱唠，日子过得有滋有味。",
    copyright: "佳慧",
    reward: "请旗袍阿姨喝杯茶"
  };

  var NEW_PACK = {
    name: "我的表情包",
    intro: "把日常聊天，变成一套会动的表情。",
    copyright: "",
    reward: "请我喝杯茶"
  };

  var DEFAULT_STATES = [
    { id: "receive", word: "收到", caption: "收到", cat: "常用", action: "站直，连续点头两次，最后竖起大拇指大笑", asset: "gif-01.gif", status: "done", selected: true, demo: true },
    { id: "ok", word: "好的", caption: "好的", cat: "常用", action: "坐在凳子上，脸颊旁比 OK 手势，歪头微笑", asset: "gif-02.gif", status: "done", selected: true, demo: true },
    { id: "wait", word: "稍等", caption: "稍等", cat: "常用", action: "身体前倾，抬起一只手，看一眼小手表，再点头", asset: "gif-03.gif", status: "done", selected: true, demo: true },
    { id: "laugh", word: "哈哈哈", caption: "哈哈哈", cat: "情绪", action: "仰头大笑，肩膀抖动，拍一下膝盖，擦掉笑出的眼泪", asset: "gif-04.gif", status: "done", selected: true, demo: true },
    { id: "speechless", word: "无语", caption: "无语", cat: "情绪", action: "面无表情，慢慢翻白眼，最后单手捂脸", asset: "gif-05.gif", status: "done", selected: true, demo: true },
    { id: "thanks", word: "谢谢", caption: "谢谢", cat: "情绪", action: "双手合十放在胸前，微微鞠躬，头顶冒出小星星", asset: "gif-06.gif", status: "done", selected: true, demo: true },
    { id: "night", word: "晚安", caption: "晚安", cat: "情绪", action: "抱着小枕头，打哈欠，挥手晚安，闭眼轻晃", asset: "gif-07.gif", status: "done", selected: true, demo: true },
    { id: "tea", word: "喝茶", caption: "喝茶", cat: "动作", action: "坐在小圆桌旁，端起带盖茶杯，吹一吹，闭眼品一口", asset: "gif-08.gif", status: "done", selected: true, demo: true },
    { id: "love", word: "爱你", caption: "爱你", cat: "情绪", action: "双手捧一颗大红心，从左下划过头顶到右下，再沿原路回落", asset: "love-smooth.gif", status: "done", selected: false, demo: true },
    { id: "help", word: "求助", caption: "求助", cat: "情绪", action: "倒抖空钱包，只掉出一枚硬币和一片枯叶，委屈又好笑", asset: "ask.gif", status: "done", selected: false, demo: true },
    { id: "online", word: "在吗", caption: "在吗", cat: "常用", action: "从屏幕边缘探头，举手打招呼，眨一只眼", asset: null, status: "draft", selected: false, demo: false },
    { id: "cheer", word: "加油", caption: "加油", cat: "情绪", action: "握拳加油，周围冒出小火花", asset: null, status: "draft", selected: false, demo: false }
  ];

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function buildPrompt(s) {
    var action = (s.action || "自然微笑，轻轻点头").trim();
    var caption = (s.caption || s.word || "").trim();
    return "Use the character in the reference image exactly: same face, same hair, same outfit, same accessories, same line style. Do not redesign the character.\n\n" +
      "Draw ONE square image: exactly 4 columns x 4 rows = 16 equal square cells. Read left to right, top to bottom, each cell is the next frame of one short looping animation. No grid lines, no borders, no numbers.\n\n" +
      "Background must be truly transparent (PNG alpha). Do NOT paint a grey-and-white checkerboard pattern.\n\n" +
      "In every cell the character stays exactly the same size and on the same ground line, fully inside the cell with at least 8% empty margin on all four sides.\n\n" +
      "Row 1 (frames 1-4): " + action + "，动作开始。\n" +
      "Row 2 (frames 5-8): " + action + "，动作展开。\n" +
      "Row 3 (frames 9-12): " + action + "，情绪最满。\n" +
      "Row 4 (frames 13-16): 回到起始姿势，第 16 帧接回第 1 帧。\n\n" +
      "Every cell has the same bold hand-lettered caption \"" + caption + "\" at the bottom, with a thick white sticker outline around both the caption and the character. No other text.\n\n" +
      "Absolutely no watermark, no logo, no signature, no \"AI generated\" mark anywhere in the image.";
  }

  function freshStates() {
    return DEFAULT_STATES.map(function (s) {
      var copy = Object.assign({}, s);
      copy.prompt = buildPrompt(copy);
      copy.promptCustom = false;
      copy.custom = false;
      return copy;
    });
  }

  function freshApp() {
    return {
      mode: "studio",
      character: { src: SAMPLE, name: "示例角色", isSample: true },
      pack: Object.assign({}, DEFAULT_PACK),
      states: freshStates(),
      submitted: false,
      orderId: null,
      deliveryAssets: { icon: true, cover: true, banner: true, rewards: true }
    };
  }

  function loadApp() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshApp();
      var saved = JSON.parse(raw);
      if (!saved || !Array.isArray(saved.states)) return freshApp();
      var base = freshApp();
      return {
        mode: saved.mode === "client" ? "client" : "studio",
        character: saved.character && saved.character.src ? saved.character : base.character,
        pack: Object.assign({}, DEFAULT_PACK, saved.pack || {}),
        states: saved.states.map(function (s) {
          return {
            id: s.id,
            word: s.word || "表情",
            caption: s.caption || s.word || "表情",
            cat: s.cat || "自定义",
            action: s.action || "",
            asset: s.asset || null,
            assetUrl: s.assetUrl || null,
            error: s.error || null,
            status: STATUS[s.status] ? s.status : "draft",
            selected: Boolean(s.selected),
            demo: Boolean(s.demo),
            custom: Boolean(s.custom),
            prompt: s.prompt || buildPrompt(s),
            promptCustom: Boolean(s.promptCustom)
          };
        }),
        submitted: Boolean(saved.submitted),
        orderId: saved.orderId || null,
        deliveryAssets: Object.assign({ icon: true, cover: true, banner: true, rewards: true }, saved.deliveryAssets || {})
      };
    } catch (e) {
      return freshApp();
    }
  }

  var app = loadApp();
  var backend = {
    enabled: false,
    provider: "",
    model: "",
    keyConfigured: false,
    orderId: app.orderId || null,
    assets: null
  };
  var usage = { enabled: false, data: null };

  var els = {
    body: document.body,
    modeButtons: document.querySelectorAll(".mode-switch button"),
    catalog: document.getElementById("catalog"),
    filters: document.getElementById("filters"),
    search: document.getElementById("searchInput"),
    selectedCount: document.getElementById("selectedCount"),
    totalCount: document.getElementById("totalCount"),
    statDone: document.getElementById("statDone"),
    statReview: document.getElementById("statReview"),
    statDraft: document.getElementById("statDraft"),
    statSelected: document.getElementById("statSelected"),
    progressBar: document.getElementById("progressBar"),
    generateBtn: document.getElementById("generateBtn"),
    approveBtn: document.getElementById("approveBtn"),
    submitBtn: document.getElementById("submitBtn"),
    railNote: document.getElementById("railNote"),
    modeNote: document.getElementById("modeNote"),
    deliveryList: document.getElementById("deliveryList"),
    deliveryCount: document.getElementById("deliveryCount"),
    downloadBtn: document.getElementById("downloadBtn"),
    downloadNote: document.getElementById("downloadNote"),
    copyListingBtn: document.getElementById("copyListingBtn"),
    mobileCount: document.getElementById("mobileCount"),
    mobileBar: document.getElementById("mobileBar"),
    mobileRailBtn: document.getElementById("mobileRailBtn"),
    backendNote: document.getElementById("backendNote"),
    usageBtn: document.getElementById("usageBtn"),
    usageInline: document.getElementById("usageInline"),
    usageModal: document.getElementById("usageModal"),
    orderRef: document.getElementById("orderRef"),
    usageClose: document.getElementById("usageClose"),
    usageCalls: document.getElementById("usageCalls"),
    usageCost: document.getElementById("usageCost"),
    usageToday: document.getElementById("usageToday"),
    usageRate: document.getElementById("usageRate"),
    usageNote: document.getElementById("usageNote"),
    usageMonth: document.getElementById("usageMonth"),
    usageChart: document.getElementById("usageChart"),
    usageKinds: document.getElementById("usageKinds"),
    usageRecent: document.getElementById("usageRecent"),
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    dropEmpty: document.getElementById("dropEmpty"),
    characterPreview: document.getElementById("characterPreview"),
    characterStatus: document.getElementById("characterStatus"),
    sampleBtn: document.getElementById("sampleBtn"),
    removeCharBtn: document.getElementById("removeCharBtn"),
    overlay: document.getElementById("overlay"),
    drawer: document.getElementById("promptDrawer"),
    drawerClose: document.getElementById("drawerClose"),
    drawerTitle: document.getElementById("drawerTitle"),
    drawerStatus: document.getElementById("drawerStatus"),
    promptText: document.getElementById("promptText"),
    stateModal: document.getElementById("stateModal"),
    stateModalClose: document.getElementById("stateModalClose"),
    stateModalTitle: document.getElementById("stateModalTitle"),
    stateWord: document.getElementById("stateWord"),
    stateCaption: document.getElementById("stateCaption"),
    stateCat: document.getElementById("stateCat"),
    stateAction: document.getElementById("stateAction"),
    deleteStateBtn: document.getElementById("deleteStateBtn"),
    submitModal: document.getElementById("submitModal"),
    submitCount: document.getElementById("submitCount"),
    orderNo: document.getElementById("orderNo"),
    devModal: document.getElementById("devModal"),
    toast: document.getElementById("toast"),
    packName: document.getElementById("packName"),
    packIntro: document.getElementById("packIntro"),
    packCopyright: document.getElementById("packCopyright"),
    packReward: document.getElementById("packReward")
  };

  var drawerId = null;
  var editingId = null;
  var generating = false;
  var polling = false;
  var toastTimer = null;

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: app.mode,
        character: app.character,
        pack: app.pack,
        states: app.states,
        submitted: app.submitted,
        orderId: backend.orderId || null,
        deliveryAssets: app.deliveryAssets
      }));
    } catch (e) {
      /* localStorage full or unavailable */
    }
  }

  function resetBackendOrder() {
    backend.orderId = null;
    backend.assets = null;
    app.orderId = null;
    var previews = {
      icon: ASSET + "asset-icon.webp",
      cover: ASSET + "asset-cover.webp",
      banner: ASSET + "asset-banner.webp",
      reward_guide: ASSET + "asset-reward-guide.webp"
    };
    document.querySelectorAll("[data-asset-preview]").forEach(function (img) {
      var key = img.getAttribute("data-asset-preview");
      if (previews[key]) img.src = previews[key];
    });
  }

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add("is-show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      els.toast.classList.remove("is-show");
    }, 2200);
  }

  function copyText(text, okMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMessage || "已复制");
      }).catch(function () {
        fallbackCopy(text, okMessage);
      });
    } else {
      fallbackCopy(text, okMessage);
    }
  }

  function fallbackCopy(text, okMessage) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(okMessage || "已复制");
    } catch (e) {
      toast("复制失败，请手动选择");
    }
    document.body.removeChild(ta);
  }

  function selectedStates() {
    return app.states.filter(function (s) { return s.selected; });
  }

  function doneSelected() {
    return app.states.filter(function (s) {
      return s.selected && s.status === "done" && Boolean(s.asset || s.assetUrl);
    });
  }

  function assetSrc(s) {
    if (s.assetUrl) return s.assetUrl;
    return s.asset ? ASSET + s.asset : "";
  }

  function statusChip(s) {
    var st = STATUS[s.status] || STATUS.draft;
    return '<span class="status ' + st.cls + '">' + st.label + "</span>";
  }

  function showAsset(s) {
    return Boolean(s.assetUrl || s.asset) && ["done", "review", "generating"].indexOf(s.status) !== -1;
  }

  function renderFilters() {
    var cats = ["全部", "常用", "情绪", "动作", "自定义"];
    els.filters.innerHTML = cats.map(function (cat) {
      return '<button type="button" class="filter' + (app.filter === cat ? " is-active" : "") + '" data-filter="' + escapeHtml(cat) + '">' + escapeHtml(cat) + "</button>";
    }).join("");
  }

  function renderCatalog() {
    var query = (els.search.value || "").trim().toLowerCase();
    var list = app.states.filter(function (s) {
      var catOk = !app.filter || app.filter === "全部" || s.cat === app.filter;
      var searchOk = !query || (s.word + s.caption + s.action).toLowerCase().indexOf(query) !== -1;
      return catOk && searchOk;
    });

    els.selectedCount.textContent = String(selectedStates().length);
    els.totalCount.textContent = String(app.states.length);

    if (!list.length) {
      els.catalog.innerHTML = '<div class="empty-state" style="grid-column:1/-1">没有匹配的表情。换一个关键词，或添加自定义表情。</div>';
      return;
    }

    els.catalog.innerHTML = list.map(function (s) {
      var idx = app.states.indexOf(s) + 1;
      var assetHtml = showAsset(s)
        ? '<img src="' + escapeHtml(assetSrc(s)) + '" alt="' + escapeHtml(s.word) + '" loading="lazy">'
        : '<div class="placeholder">' + escapeHtml(s.word) + "</div>";
      var realBackend = backend.enabled && backend.provider === "dashscope" && backend.keyConfigured;
      var demoTag = (showAsset(s) && !app.character.isSample && !realBackend) ? '<span class="demo-tag">演示</span>' : "";
      var actions = app.mode === "studio"
        ? '<div class="state-actions studio-only">' +
            '<button type="button" class="mini-btn" data-action="prompt">提示词</button>' +
            '<button type="button" class="mini-btn" data-action="edit">编辑</button>' +
          "</div>"
        : "";
      return '<article class="state-card' + (s.selected ? " is-selected" : "") + '" data-id="' + escapeHtml(s.id) + '">' +
        '<div class="thumb">' + assetHtml + statusChip(s) +
          '<span class="check" aria-hidden="true"></span>' + demoTag +
        "</div>" +
        '<div class="state-meta"><h3>' + escapeHtml(s.word) + "<span>" + String(idx).padStart(2, "0") + "</span></h3>" +
          "<p>" + escapeHtml(s.action) + "</p></div>" +
        actions +
      "</article>";
    }).join("");
  }

  function renderCharacter() {
    if (app.character && app.character.src) {
      els.characterPreview.src = app.character.src;
      els.characterPreview.hidden = false;
      els.dropEmpty.hidden = true;
      els.characterStatus.textContent = app.character.isSample ? "示例角色" : "已上传 · " + (app.character.name || "客户形象");
      els.removeCharBtn.disabled = false;
    } else {
      els.characterPreview.hidden = true;
      els.characterPreview.removeAttribute("src");
      els.dropEmpty.hidden = false;
      els.characterStatus.textContent = "未上传";
      els.removeCharBtn.disabled = true;
    }
  }

  function renderRail() {
    var selected = selectedStates();
    var done = doneSelected();
    var review = selected.filter(function (s) { return s.status === "review"; });
    var pending = selected.filter(function (s) { return ["draft", "queued", "failed"].indexOf(s.status) !== -1; });
    var ratio = selected.length ? Math.round(done.length / selected.length * 100) : 0;

    els.statDone.textContent = String(done.length);
    els.statReview.textContent = String(review.length);
    els.statDraft.textContent = String(pending.length);
    els.statSelected.textContent = String(selected.length);
    els.progressBar.style.width = ratio + "%";
    els.mobileCount.textContent = String(selected.length);

    var canGenerate = !generating && pending.length > 0;
    els.generateBtn.disabled = !canGenerate;
    els.generateBtn.textContent = generating ? "生成中..." : "开始生成 (" + pending.length + ")";
    els.approveBtn.disabled = review.length === 0 || generating;
    els.approveBtn.textContent = "一键通过复核 (" + review.length + ")";
    els.submitBtn.disabled = generating || selected.length < 4;
    els.submitBtn.textContent = "提交需求 (" + selected.length + ")";

    els.modeNote.textContent = app.mode === "client" ? "客户视图" : "工作室视图";
    if (els.orderRef) {
      els.orderRef.textContent = backend.orderId
        ? "ORDER " + backend.orderId + (generating ? " · 后台生成中" : "")
        : "尚未创建后台订单";
    }
    if (app.mode === "client") {
      els.railNote.textContent = app.submitted
        ? "需求已提交，工作室会在后台排期。"
        : "选好表情后提交需求，工作室会在 24 小时内开始制作。";
    } else if (generating) {
      els.railNote.textContent = "正在生成，状态会实时更新；刷新页面也会继续同步后台进度。";
    } else if (review.length) {
      els.railNote.textContent = "生成完成，" + review.length + " 张待复核。复核后进入交付。";
    } else if (backend.enabled && backend.provider === "dashscope" && backend.keyConfigured) {
      els.railNote.textContent = "生产队列已连接，点击生成会调用 DashScope 真实生成。";
    } else if (backend.enabled) {
      els.railNote.textContent = "演示队列已连接，生成使用示例素材；配置密钥后切换真实生成。";
    } else {
      els.railNote.textContent = "预览模式：生成用示例素材模拟，启动 server.py 后接入队列。";
    }
  }

  function renderDelivery() {
    var done = doneSelected();
    els.deliveryCount.textContent = done.length + " GIF";
    if (!done.length) {
      els.deliveryList.innerHTML = '<div class="delivery-empty">还没有可交付的 GIF。先完成至少一张表情，或把状态改为已完成。</div>';
    } else {
      els.deliveryList.innerHTML = done.map(function (s, i) {
        return '<div class="delivery-item">' +
          '<img src="' + escapeHtml(assetSrc(s)) + '" alt="' + escapeHtml(s.word) + '">' +
          '<span class="name">' + escapeHtml(s.word) + "</span>" +
          '<span class="idx">' + String(i + 1).padStart(2, "0") + "</span>" +
          '<a href="' + escapeHtml(assetSrc(s)) + '" download>GIF</a>' +
        "</div>";
      }).join("");
    }

    var fileMode = window.location.protocol === "file:";
    var realBackend = backend.enabled && backend.provider === "dashscope" && backend.keyConfigured;
    var demoOnly = !app.character.isSample && !realBackend;
    els.downloadBtn.disabled = done.length === 0 || generating || demoOnly || (fileMode && !backend.enabled);
    if (demoOnly) {
      els.downloadNote.textContent = backend.enabled
        ? "示例队列不能用客户本人形象生成最终交付。设置 DASHSCOPE_API_KEY 并切换 dashscope 后开放。"
        : "当前是演示素材，不能作为客户本人交付包。接入后端生成真实角色后，这里才会开放下载。";
    } else if (fileMode && !backend.enabled) {
      els.downloadNote.textContent = "当前是 file://，浏览器不能打包本地文件。请用 start-studio.bat 启动后端后再下载 ZIP。";
    } else if (!done.length) {
      els.downloadNote.textContent = "先完成至少一张表情，才有可交付的 GIF。";
    } else if (backend.enabled) {
      els.downloadNote.textContent = "服务端 ZIP 会包含所选 GIF、PNG 素材、上架文案与 pack.json。";
    } else {
      els.downloadNote.textContent = "包含所选 GIF、ICON、封面、横幅、赞赏图、上架文案与 pack.json。";
    }
  }

  function syncOrderInputs() {
    setValue(els.packName, app.pack.name);
    setValue(els.packIntro, app.pack.intro);
    setValue(els.packCopyright, app.pack.copyright);
    setValue(els.packReward, app.pack.reward);
  }

  function setValue(el, value) {
    if (el && el.value !== value) el.value = value;
  }

  function syncAssetChecks() {
    Array.prototype.forEach.call(document.querySelectorAll("#assetChecks input"), function (input) {
      input.checked = app.deliveryAssets[input.getAttribute("data-asset")] !== false;
    });
  }

  function renderAll() {
    renderCharacter();
    renderFilters();
    renderCatalog();
    renderRail();
    renderDelivery();
    syncOrderInputs();
    syncAssetChecks();
  }

  function setMode(mode) {
    app.mode = mode === "client" ? "client" : "studio";
    els.body.classList.toggle("mode-client", app.mode === "client");
    els.body.classList.toggle("mode-studio", app.mode === "studio");
    Array.prototype.forEach.call(els.modeButtons, function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-mode") === app.mode);
    });
    save();
    renderRail();
    renderCatalog();
  }

  function toggleState(id) {
    if (generating) {
      toast("生成中，先等这一轮结束");
      return;
    }
    var state = app.states.find(function (s) { return s.id === id; });
    if (!state) return;
    state.selected = !state.selected;
    resetBackendOrder();
    save();
    renderAll();
  }

  function openOverlay() {
    els.overlay.classList.add("is-open");
  }

  function closeOverlay() {
    els.overlay.classList.remove("is-open");
  }

  function openDrawer(id) {
    var state = app.states.find(function (s) { return s.id === id; });
    if (!state) return;
    drawerId = id;
    els.drawerTitle.textContent = state.word + " / " + state.caption;
    els.drawerStatus.value = state.status;
    els.promptText.value = state.prompt || buildPrompt(state);
    els.drawer.classList.add("is-open");
    els.drawer.setAttribute("aria-hidden", "false");
    openOverlay();
    els.promptText.focus();
  }

  function closeDrawer() {
    els.drawer.classList.remove("is-open");
    els.drawer.setAttribute("aria-hidden", "true");
    closeOverlay();
    drawerId = null;
  }

  function saveDrawer() {
    if (!drawerId) return;
    var state = app.states.find(function (s) { return s.id === drawerId; });
    if (!state) return;
    state.prompt = els.promptText.value.trim() || buildPrompt(state);
    state.promptCustom = true;
    state.status = els.drawerStatus.value;
    resetBackendOrder();
    save();
    renderAll();
    closeDrawer();
    toast("提示词与状态已保存");
  }

  function openStateModal(id) {
    editingId = id || null;
    var state = id ? app.states.find(function (s) { return s.id === id; }) : null;
    els.stateModalTitle.textContent = state ? "编辑表情" : "自定义表情";
    els.stateWord.value = state ? state.word : "";
    els.stateCaption.value = state ? state.caption : "";
    els.stateCat.value = state ? state.cat : "自定义";
    els.stateAction.value = state ? state.action : "";
    els.deleteStateBtn.hidden = !(state && state.custom);
    els.stateModal.classList.add("is-open");
    els.stateModal.setAttribute("aria-hidden", "false");
    openOverlay();
    els.stateWord.focus();
  }

  function closeStateModal() {
    els.stateModal.classList.remove("is-open");
    els.stateModal.setAttribute("aria-hidden", "true");
    closeOverlay();
    editingId = null;
  }

  function saveState() {
    var word = els.stateWord.value.trim();
    var caption = els.stateCaption.value.trim() || word;
    var action = els.stateAction.value.trim();
    if (!word) { toast("先填含义词"); els.stateWord.focus(); return; }
    if (!action) { toast("先写一句动作描述"); els.stateAction.focus(); return; }

    if (editingId) {
      var state = app.states.find(function (s) { return s.id === editingId; });
      if (!state) return;
      state.word = word;
      state.caption = caption;
      state.cat = els.stateCat.value;
      state.action = action;
      state.prompt = buildPrompt(state);
      state.promptCustom = false;
      toast("表情已更新，提示词已按模板重写");
    } else {
      var id = "custom-" + Date.now();
      var item = {
        id: id,
        word: word,
        caption: caption,
        cat: els.stateCat.value,
        action: action,
        asset: null,
        status: "draft",
        selected: true,
        demo: false,
        custom: true,
        prompt: "",
        promptCustom: false
      };
      item.prompt = buildPrompt(item);
      app.states.push(item);
      toast("已添加自定义表情");
    }
    resetBackendOrder();
    save();
    closeStateModal();
    renderAll();
  }

  function deleteState() {
    if (!editingId) return;
    var state = app.states.find(function (s) { return s.id === editingId; });
    if (!state || !state.custom) return;
    if (!window.confirm("删除「" + state.word + "」？这个动作的提示词也会一起删除。")) return;
    app.states = app.states.filter(function (s) { return s.id !== editingId; });
    save();
    closeStateModal();
    renderAll();
    toast("已删除");
  }

  async function apiGet(path) {
    var response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error("API " + response.status);
    return response.json();
  }

  async function apiPost(path, payload) {
    var response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    if (!response.ok) {
      var text = await response.text();
      throw new Error("API " + response.status + " " + text.slice(0, 120));
    }
    return response.json();
  }

  async function checkBackend() {
    try {
      var response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) throw new Error("no backend");
      var data = await response.json();
      backend.enabled = data.ok === true;
      backend.provider = data.provider || "demo";
      backend.model = data.model || "";
      backend.keyConfigured = Boolean(data.keyConfigured);
    } catch (e) {
      backend.enabled = false;
    }
    updateBackendNote();
    renderRail();
    fetchUsage();
    resumeBackendOrder();
  }

  function updateBackendNote() {
    if (!els.backendNote) return;
    if (!backend.enabled) {
      els.backendNote.innerHTML = "<b>预览模式</b> 生成会用示例素材模拟，启动 server.py 后接入队列。";
    } else if (backend.provider === "dashscope" && backend.keyConfigured) {
      els.backendNote.innerHTML = "<b>生产队列</b> 已连接 · " + escapeHtml(backend.model || "qwen-image-3.0") + "。";
    } else if (backend.provider === "dashscope") {
      els.backendNote.innerHTML = "<b>队列已连接</b> 但 DASHSCOPE_API_KEY 未配置，生成会失败。";
    } else {
      els.backendNote.innerHTML = "<b>演示队列</b> 已连接，生成使用示例素材。";
    }
  }

  function money(value) {
    return "¥" + Number(value || 0).toFixed(2);
  }

  function usageKindLabel(kind) {
    return {
      character: "角色锚定",
      sticker: "表情图",
      asset: "配套素材"
    }[kind] || kind || "调用";
  }

  async function fetchUsage() {
    if (!backend.enabled) {
      usage.enabled = false;
      usage.data = null;
      renderUsage();
      return;
    }
    try {
      usage.data = await apiGet("/api/usage");
      usage.enabled = true;
    } catch (e) {
      usage.enabled = false;
      usage.data = null;
    }
    renderUsage();
  }

  function renderUsage() {
    var data = usage.data;
    var totals = data ? data.totals : { calls: 0, success: 0, failed: 0, costCny: 0 };
    var calls = totals.calls || 0;
    var rate = calls ? Math.round((totals.success || 0) / calls * 100) : 0;

    if (els.usageCalls) els.usageCalls.textContent = String(calls);
    if (els.usageCost) els.usageCost.textContent = money(totals.costCny);
    if (els.usageToday) els.usageToday.textContent = String(data ? data.today.calls : 0);
    if (els.usageRate) els.usageRate.textContent = rate + "%";
    if (els.usageInline) {
      els.usageInline.textContent = "API " + calls + " 次 · 预估 " + money(totals.costCny);
    }
    if (els.usageMonth) {
      els.usageMonth.textContent = data
        ? "本月 " + data.month.calls + " 次 / " + money(data.month.costCny)
        : "本月 0 次 / ¥0.00";
    }
    if (els.usageNote) {
      var packEstimate = data
        ? (data.price.inputUsd + data.price.outputUsd) * data.price.usdToCny * 14
        : 0;
      var packText = packEstimate ? "一套 8 表情约 ¥" + packEstimate.toFixed(2) : "";
      if (!backend.enabled) {
        els.usageNote.textContent = "尚未连接后端，暂无真实用量。";
      } else if (data && data.provider === "demo" && calls === 0) {
        els.usageNote.textContent = "演示队列没有调用模型，API 0 次，花费 ¥0.00。切到 dashscope 后按真实调用累计" +
          (packText ? "；" + packText : "") + "。";
      } else {
        els.usageNote.textContent = "按官方单价估算，失败请求按 0 计" +
          (packText ? "；" + packText : "") + "。实际金额以百炼账单为准。";
      }
    }

    if (els.usageChart) {
      var days = data ? data.byDay : [];
      var totalCalls = days.reduce(function (sum, d) { return sum + d.calls; }, 0);
      if (!totalCalls) {
        els.usageChart.innerHTML = '<div class="usage-chart-empty">近 14 天还没有调用</div>';
      } else {
        var max = Math.max.apply(null, [1].concat(days.map(function (d) { return d.calls; })));
        els.usageChart.innerHTML = days.map(function (d, i) {
          var height = d.calls ? Math.max(4, Math.round(d.calls / max * 100)) : 0;
          var label = i % 3 === 0 ? d.date.slice(5).replace("-", "/") : "";
          var bar = d.calls ? '<i style="height:' + height + '%"></i>' : '<i class="zero"></i>';
          return '<div class="usage-bar" title="' + escapeHtml(d.date + " · " + d.calls + " 次 · " + money(d.costCny)) + '">' +
            bar + '<span>' + escapeHtml(label) + "</span></div>";
        }).join("");
      }
    }

    if (els.usageKinds) {
      var kinds = data ? data.byKind : [];
      els.usageKinds.innerHTML = kinds.length
        ? kinds.map(function (k) {
            return '<div class="usage-row"><span>' + escapeHtml(usageKindLabel(k.kind)) + "</span>" +
              '<b>' + k.calls + " 次</b><span>" + money(k.costCny) + "</span></div>";
          }).join("")
        : '<div class="usage-empty">还没有真实 API 调用。</div>';
    }

    if (els.usageRecent) {
      var recent = data ? data.recent : [];
      els.usageRecent.innerHTML = recent.length
        ? recent.slice(0, 8).map(function (item) {
            var name = usageKindLabel(item.kind) + (item.asset ? " · " + item.asset : item.stateId ? " · " + item.stateId : "");
            var time = item.startedAt ? item.startedAt.slice(11, 16) : "--:--";
            return '<div class="usage-row"><span class="muted">' + escapeHtml(time) + "</span>" +
              '<span class="kind">' + escapeHtml(name) + "</span>" +
              '<span class="' + (item.status === "success" ? "ok" : "bad") + '">' +
              (item.status === "success" ? money(item.costCny) : "失败") + "</span></div>";
          }).join("")
        : '<div class="usage-empty">暂无调用记录。演示队列不产生模型调用。</div>';
    }
  }

  async function openUsage() {
    await fetchUsage();
    els.usageModal.classList.add("is-open");
    els.usageModal.setAttribute("aria-hidden", "false");
    openOverlay();
  }

  function closeUsage() {
    els.usageModal.classList.remove("is-open");
    els.usageModal.setAttribute("aria-hidden", "true");
    closeOverlay();
  }

  function createBackendOrder(states) {
    var source = states && states.length ? states : selectedStates();
    var payloadStates = source.map(function (s) {
      return {
        id: s.id,
        word: s.word,
        caption: s.caption,
        action: s.action,
        prompt: s.prompt || buildPrompt(s)
      };
    });
    return apiPost("/api/orders", {
      character: app.character && app.character.src ? app.character.src : null,
      pack: app.pack,
      states: payloadStates
    }).then(function (order) {
      backend.orderId = order.id;
      app.orderId = order.id;
      save();
      return order;
    });
  }

  function applyBackendOrder(order) {
    backend.orderId = order.id;
    app.orderId = order.id;
    (order.items || []).forEach(function (item) {
      var state = app.states.find(function (s) { return s.id === item.id; });
      if (!state) return;
      state.status = STATUS[item.status] ? item.status : "draft";
      state.assetUrl = item.gif_url || null;
      state.error = item.error || null;
    });
    if (order.assets) {
      backend.assets = order.assets;
      Object.keys(order.assets).forEach(function (key) {
        var img = document.querySelector('[data-asset-preview="' + key + '"]');
        if (img) img.src = order.assets[key];
      });
    }
    save();
    renderAll();
  }

  async function pollBackendOrder(orderId) {
    if (polling) return null;
    polling = true;
    generating = true;
    renderAll();
    try {
      for (var i = 0; i < 1350; i += 1) {
        await sleep(2000);
        var current = await apiGet("/api/orders/" + orderId);
        applyBackendOrder(current);
        if (["review", "done", "failed"].indexOf(current.status) !== -1) {
          var review = current.items.filter(function (item) { return item.status === "review"; }).length;
          var failed = current.items.filter(function (item) { return item.status === "failed"; }).length;
          if (failed) {
            toast("生成完成，" + review + " 张待复核，" + failed + " 张失败");
          } else {
            toast("生成完成，" + review + " 张待复核");
          }
          return current;
        }
      }
      toast("后台仍在生成，稍后刷新页面会继续同步");
      return null;
    } catch (e) {
      toast("连接中断，后台可能仍在生成；刷新页面可继续同步");
      return null;
    } finally {
      generating = false;
      polling = false;
      save();
      renderAll();
      fetchUsage();
    }
  }

  async function resumeBackendOrder() {
    if (!backend.enabled || !backend.orderId || polling) return;
    try {
      var order = await apiGet("/api/orders/" + backend.orderId);
      applyBackendOrder(order);
      if (order.status === "queued" || order.status === "generating") {
        toast("已恢复后台生成进度");
        pollBackendOrder(order.id);
      }
    } catch (e) {
      /* order may be gone; keep local state */
    }
  }

  async function backendGenerate(targets) {
    if (polling) return;
    if (!targets.length) {
      toast("没有待生成的表情");
      return;
    }
    generating = true;
    renderAll();
    try {
      var order = null;
      if (backend.orderId) {
        order = await apiGet("/api/orders/" + backend.orderId);
        var existingIds = (order.items || []).map(function (item) { return item.id; }).sort().join(",");
        var wantedIds = targets.map(function (state) { return state.id; }).sort().join(",");
        if (!order.items || !order.items.length || existingIds !== wantedIds) order = null;
      }
      if (!order) order = await createBackendOrder(targets);
      backend.orderId = order.id;
      app.orderId = order.id;
      save();
      await apiPost("/api/orders/" + order.id + "/generate", {});
      await pollBackendOrder(order.id);
    } catch (e) {
      toast("生成失败：" + (e && e.message ? e.message : "未知错误"));
    } finally {
      if (!polling) {
        generating = false;
        save();
        renderAll();
        fetchUsage();
      }
    }
  }

  async function generateSelected() {
    if (generating) return;
    if (!app.character || !app.character.src) {
      toast("先上传形象，或使用示例角色");
      return;
    }
    var targets = app.states.filter(function (s) {
      return s.selected && ["draft", "queued", "failed"].indexOf(s.status) !== -1;
    });
    if (!targets.length) {
      toast("没有待生成的表情");
      return;
    }
    if (backend.enabled) {
      if (backend.provider === "dashscope" && backend.keyConfigured) {
        var price = usage.data && usage.data.price
          ? usage.data.price
          : { inputUsd: 0.00275, outputUsd: 0.024754, usdToCny: 7.1 };
        var calls = 6 + targets.length;
        var estimate = calls * (price.inputUsd + price.outputUsd) * price.usdToCny;
        if (!window.confirm("真实生成会调用 DashScope，预计 " + calls + " 次，约 ¥" + estimate.toFixed(2) + "。继续？")) return;
      }
      await backendGenerate(targets);
      return;
    }

    generating = true;
    renderAll();
    var reviewed = 0;
    var failed = 0;

    for (var i = 0; i < targets.length; i += 1) {
      var state = targets[i];
      state.status = "generating";
      renderAll();
      await sleep(620);
      if (state.asset) {
        state.status = "review";
        reviewed += 1;
      } else {
        state.status = "failed";
        failed += 1;
      }
      renderAll();
    }

    generating = false;
    save();
    renderAll();
    if (failed) {
      toast("生成完成，" + reviewed + " 张待复核，" + failed + " 张需接入真实生成");
    } else {
      toast("生成完成，" + reviewed + " 张待复核");
    }
  }

  async function approveAll() {
    var review = app.states.filter(function (s) { return s.selected && s.status === "review"; });
    if (!review.length) {
      toast("没有待复核的表情");
      return;
    }
    if (backend.enabled && backend.orderId) {
      try {
        var order = await apiPost("/api/orders/" + backend.orderId + "/review", {
          items: review.map(function (s) { return { id: s.id, status: "done" }; })
        });
        applyBackendOrder(order);
        toast("已通过 " + review.length + " 张，进入交付");
        fetchUsage();
      } catch (e) {
        toast("复核失败：" + (e && e.message ? e.message : "未知错误"));
      }
      return;
    }
    review.forEach(function (s) { s.status = "done"; });
    save();
    renderAll();
    toast("已通过 " + review.length + " 张，进入交付");
  }

  async function submitOrder() {
    var selected = selectedStates();
    if (selected.length < 4) {
      toast("至少选择 4 张表情");
      return;
    }
    if (!app.pack.name.trim()) {
      toast("先填表情包名称");
      return;
    }
    if (backend.enabled) {
      try {
        await createBackendOrder();
      } catch (e) {
        toast("提交失败：" + (e && e.message ? e.message : "未知错误"));
        return;
      }
    }
    selected.forEach(function (s) {
      if (s.status === "draft" || s.status === "failed") s.status = "queued";
    });
    app.submitted = true;
    save();
    renderAll();
    els.submitCount.textContent = String(selected.length);
    els.orderNo.textContent = "ORDER NO. DSH-" + String(Date.now()).slice(-6);
    els.submitModal.classList.add("is-open");
    els.submitModal.setAttribute("aria-hidden", "false");
    openOverlay();
  }

  function closeSubmit() {
    els.submitModal.classList.remove("is-open");
    els.submitModal.setAttribute("aria-hidden", "true");
    closeOverlay();
  }

  function openDev() {
    els.devModal.classList.add("is-open");
    els.devModal.setAttribute("aria-hidden", "false");
    openOverlay();
  }

  function closeDev() {
    els.devModal.classList.remove("is-open");
    els.devModal.setAttribute("aria-hidden", "true");
    closeOverlay();
  }

  function buildListing() {
    var selected = selectedStates();
    var lines = [
      "# " + app.pack.name + " 上架文案",
      "",
      "- 表情名称：" + app.pack.name,
      "- 表情介绍：" + app.pack.intro,
      "- 版权信息：" + app.pack.copyright,
      "- 赞赏引导语：" + app.pack.reward,
      "",
      "| 序号 | 含义词 |",
      "|---|---|"
    ];
    selected.forEach(function (s, i) {
      lines.push("| " + String(i + 1).padStart(2, "0") + " | " + s.word + " |");
    });
    return lines.join("\n") + "\n";
  }

  function buildPackJson() {
    var done = doneSelected();
    return JSON.stringify({
      name: app.pack.name,
      intro: app.pack.intro,
      copyright: app.pack.copyright,
      reward_line: app.pack.reward,
      character: "character.png",
      style: "cute cartoon, thick clean dark outlines, flat colors, warm retro palette",
      frame_ms: 120,
      background: "transparent",
      stickers: done.map(function (s) {
        return { word: s.word, caption: s.caption, action: s.action };
      })
    }, null, 2) + "\n";
  }

  async function downloadZip() {
    var realBackend = backend.enabled && backend.provider === "dashscope" && backend.keyConfigured;
    var demoOnly = !app.character.isSample && !realBackend;
    if (backend.enabled && backend.orderId) {
      if (demoOnly) {
        toast("示例队列不能用客户本人形象交付，配置 DASHSCOPE_API_KEY 后再下载");
        return;
      }
      window.location.href = "/api/orders/" + backend.orderId + "/zip";
      return;
    }
    if (window.location.protocol === "file:") {
      toast("请用 start-studio.bat 启动本地服务器后再下载 ZIP");
      return;
    }
    if (demoOnly) {
      toast("演示素材不能作为客户交付包，接入后端后再下载");
      return;
    }
    var done = doneSelected();
    if (!done.length) {
      toast("还没有可交付的 GIF");
      return;
    }
    els.downloadBtn.disabled = true;
    els.downloadBtn.textContent = "打包中...";

    try {
      var files = [];
      for (var i = 0; i < done.length; i += 1) {
        var s = done[i];
        var res = await fetch(assetSrc(s));
        if (!res.ok) throw new Error("读取 GIF 失败");
        files.push({
          name: "表情图/" + String(i + 1).padStart(2, "0") + ".gif",
          data: new Uint8Array(await res.arrayBuffer())
        });
      }

      if (app.deliveryAssets.icon) {
        files.push({ name: "聊天面板图标.png", data: await fetchBytes(DELIVER + "icon.png") });
      }
      if (app.deliveryAssets.cover) {
        files.push({ name: "封面图.png", data: await fetchBytes(DELIVER + "cover.png") });
      }
      if (app.deliveryAssets.banner) {
        files.push({ name: "详情页横幅.png", data: await fetchBytes(DELIVER + "banner.png") });
      }
      if (app.deliveryAssets.rewards) {
        files.push({ name: "赞赏引导图.png", data: await fetchBytes(DELIVER + "reward-guide.png") });
        files.push({ name: "赞赏致谢图.png", data: await fetchBytes(DELIVER + "reward-thanks.png") });
      }

      files.push({ name: "上架文案.md", data: new TextEncoder().encode(buildListing()) });
      files.push({ name: "pack.json", data: new TextEncoder().encode(buildPackJson()) });

      var blob = makeZip(files);
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "表情包-" + (app.pack.name || "定制") + ".zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast("ZIP 已生成");
    } catch (e) {
      toast("打包失败：" + (e && e.message ? e.message : "未知错误"));
    } finally {
      els.downloadBtn.disabled = false;
      els.downloadBtn.textContent = "下载 ZIP";
      renderDelivery();
    }
  }

  async function fetchBytes(url) {
    var res = await fetch(url);
    if (!res.ok) throw new Error("读取素材失败：" + url);
    return new Uint8Array(await res.arrayBuffer());
  }

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeZip(files) {
    var now = new Date(2026, 10, 9, 12, 0, 0);
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var encoder = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    files.forEach(function (file) {
      var name = encoder.encode(file.name);
      var data = file.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + name.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      localParts.push(local, data);

      var central = new Uint8Array(46 + name.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    });

    var centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(localParts.concat(centralParts, [eocd]), { type: "application/zip" });
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        reject(new Error("请上传图片文件"));
        return;
      }
      if (file.size > 12 * 1024 * 1024) {
        reject(new Error("图片不要超过 12MB"));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 512;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#f5edde";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.86));
        };
        img.onerror = function () { reject(new Error("图片无法读取")); };
        img.src = String(reader.result);
      };
      reader.onerror = function () { reject(new Error("文件读取失败")); };
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(file) {
    try {
      var dataUrl = await readImageFile(file);
      app.character = { src: dataUrl, name: file.name, isSample: false };
      app.states.forEach(function (s) {
        if (s.selected && (s.status === "done" || s.status === "review")) s.status = "draft";
      });
      app.submitted = false;
      resetBackendOrder();
      save();
      renderAll();
      toast("形象已上传，选中表情后点生成");
    } catch (e) {
      toast(e.message || "上传失败");
    }
  }

  function newOrder() {
    if (!window.confirm("新建订单会清空当前选择与提示词修改，继续？")) return;
    var customStates = app.states.filter(function (s) { return s.custom; }).map(function (s) {
      var copy = Object.assign({}, s);
      copy.selected = false;
      copy.status = "draft";
      return copy;
    });
    app = freshApp();
    app.character = { src: null, name: "", isSample: false };
    app.pack = Object.assign({}, NEW_PACK);
    app.states = freshStates().map(function (s) {
      s.selected = false;
      s.status = "draft";
      return s;
    }).concat(customStates);
    resetBackendOrder();
    save();
    renderAll();
    setMode("studio");
    toast("新订单已建立，先上传客户形象");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function useSample() {
    app.character = { src: SAMPLE, name: "示例角色", isSample: true };
    app.submitted = false;
    resetBackendOrder();
    save();
    renderAll();
    toast("已切换到示例角色");
  }

  function removeCharacter() {
    if (!app.character || !app.character.src) return;
    app.character = { src: null, name: "", isSample: false };
    app.states.forEach(function (s) {
      if (s.selected && (s.status === "done" || s.status === "review")) s.status = "draft";
    });
    resetBackendOrder();
    save();
    renderAll();
    toast("已移除形象");
  }

  function bindEvents() {
    Array.prototype.forEach.call(els.modeButtons, function (btn) {
      btn.addEventListener("click", function () { setMode(btn.getAttribute("data-mode")); });
    });

    els.filters.addEventListener("click", function (event) {
      var btn = event.target.closest("button[data-filter]");
      if (!btn) return;
      app.filter = btn.getAttribute("data-filter");
      renderFilters();
      renderCatalog();
    });

    els.search.addEventListener("input", renderCatalog);

    els.catalog.addEventListener("click", function (event) {
      var btn = event.target.closest("button[data-action]");
      var card = event.target.closest(".state-card");
      if (!card) return;
      var id = card.getAttribute("data-id");
      if (btn) {
        event.stopPropagation();
        if (btn.getAttribute("data-action") === "prompt") openDrawer(id);
        else openStateModal(id);
        return;
      }
      toggleState(id);
    });

    document.getElementById("selectAllBtn").addEventListener("click", function () {
      app.states.forEach(function (s) { s.selected = true; });
      resetBackendOrder();
      save(); renderAll();
    });
    document.getElementById("clearBtn").addEventListener("click", function () {
      app.states.forEach(function (s) { s.selected = false; });
      resetBackendOrder();
      save(); renderAll();
    });
    document.getElementById("addStateBtn").addEventListener("click", function () { openStateModal(null); });

    els.generateBtn.addEventListener("click", generateSelected);
    els.approveBtn.addEventListener("click", approveAll);
    els.submitBtn.addEventListener("click", submitOrder);
    els.downloadBtn.addEventListener("click", downloadZip);
    els.copyListingBtn.addEventListener("click", function () { copyText(buildListing(), "上架文案已复制"); });

    Array.prototype.forEach.call(document.querySelectorAll("#assetChecks input"), function (input) {
      input.addEventListener("change", function () {
        app.deliveryAssets[input.getAttribute("data-asset")] = input.checked;
        save();
      });
    });

    ["name", "intro", "copyright", "reward"].forEach(function (key) {
      var map = { name: els.packName, intro: els.packIntro, copyright: els.packCopyright, reward: els.packReward };
      map[key].addEventListener("input", function (event) {
        app.pack[key] = event.target.value;
        resetBackendOrder();
        save();
      });
    });

    els.fileInput.addEventListener("change", function () {
      if (els.fileInput.files && els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
      els.fileInput.value = "";
    });
    ["dragenter", "dragover"].forEach(function (name) {
      els.dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        els.dropzone.style.borderColor = "var(--ink)";
      });
    });
    ["dragleave", "drop"].forEach(function (name) {
      els.dropzone.addEventListener(name, function (event) {
        event.preventDefault();
        els.dropzone.style.borderColor = "";
      });
    });
    els.dropzone.addEventListener("drop", function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    els.sampleBtn.addEventListener("click", useSample);
    els.removeCharBtn.addEventListener("click", removeCharacter);

    els.drawerClose.addEventListener("click", closeDrawer);
    document.getElementById("drawerCancel").addEventListener("click", closeDrawer);
    document.getElementById("drawerSave").addEventListener("click", saveDrawer);
    document.getElementById("rewritePrompt").addEventListener("click", function () {
      if (!drawerId) return;
      var state = app.states.find(function (s) { return s.id === drawerId; });
      if (state) {
        els.promptText.value = buildPrompt(state);
        toast("已按模板重写，记得保存");
      }
    });
    document.getElementById("copyPrompt").addEventListener("click", function () {
      copyText(els.promptText.value, "提示词已复制");
    });

    els.stateModalClose.addEventListener("click", closeStateModal);
    document.getElementById("stateCancel").addEventListener("click", closeStateModal);
    document.getElementById("stateSave").addEventListener("click", saveState);
    els.deleteStateBtn.addEventListener("click", deleteState);

    document.getElementById("submitClose").addEventListener("click", closeSubmit);
    document.getElementById("submitDone").addEventListener("click", closeSubmit);
    document.getElementById("devBtn").addEventListener("click", openDev);
    document.getElementById("devClose").addEventListener("click", closeDev);
    document.getElementById("devDone").addEventListener("click", closeDev);
    els.usageBtn.addEventListener("click", openUsage);
    els.usageInline.addEventListener("click", openUsage);
    els.usageClose.addEventListener("click", closeUsage);

    document.getElementById("newOrderBtn").addEventListener("click", newOrder);
    els.mobileRailBtn.addEventListener("click", function () {
      document.getElementById("rail").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    els.overlay.addEventListener("click", function () {
      if (els.drawer.classList.contains("is-open")) closeDrawer();
      else if (els.stateModal.classList.contains("is-open")) closeStateModal();
      else if (els.submitModal.classList.contains("is-open")) closeSubmit();
      else if (els.usageModal.classList.contains("is-open")) closeUsage();
      else if (els.devModal.classList.contains("is-open")) closeDev();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (els.drawer.classList.contains("is-open")) closeDrawer();
      else if (els.stateModal.classList.contains("is-open")) closeStateModal();
      else if (els.submitModal.classList.contains("is-open")) closeSubmit();
      else if (els.usageModal.classList.contains("is-open")) closeUsage();
      else if (els.devModal.classList.contains("is-open")) closeDev();
    });
  }

  function init() {
    app.filter = app.filter || "全部";
    setMode(app.mode);
    renderAll();
    bindEvents();
    checkBackend();
    if (window.location.protocol === "file:") {
      els.downloadNote.textContent = "当前是 file://，浏览器不能打包本地文件。请用 start-studio.bat 启动后端后再下载 ZIP。";
    }
  }

  init();
})();
