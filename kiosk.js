(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SCREENS = {
    PREVIEW: "screen-preview",
    PROCESS: "screen-process",
    CHARACTER: "screen-character",
    ACTION: "screen-action",
    GIF: "screen-gif",
    QR: "screen-qr",
    ERROR: "screen-error"
  };
  const ACTIONS = [
    { id: "receive", word: "收到", caption: "收到", action: "站直，连续点头两次，最后竖起大拇指大笑" },
    { id: "ok", word: "好的", caption: "好的", action: "坐在桌子上，脸颊比 OK 手势，歪头微笑" },
    { id: "thanks", word: "谢谢", caption: "谢谢", action: "双手合十放在胸前，微微鞠躬，头顶冒出小星星" },
    { id: "love", word: "爱你", caption: "爱你", action: "双手捧一颗大红心，从左下划过头顶到右下，再沿原路回落" },
    { id: "night", word: "晚安", caption: "晚安", action: "抱着小枕头，打哈欠，挥手晚安，闭眼轻晃" },
    { id: "laugh", word: "哈哈哈", caption: "哈哈哈", action: "仰头大笑，手拍大腿，眼泪飞出来" }
  ];

  let state = "PREVIEW";
  let session = null;
  let photoData = null;
  let selectedIndex = 0;
  let pollTimer = null;
  let countdownTimer = null;
  let countdownValue = 30 * 60;
  let startedAt = 0;
  let pollFailures = 0;
  let characterLocked = false;
  let gifLocked = false;
  let audioContext = null;
  let stream = null;
  let counting = false;
  let portraitMode = "bust";

  const query = new URLSearchParams(location.search);
  const SOFT_TIMEOUT = Math.max(1, Number(query.get("softTimeout")) || 180);
  const HARD_TIMEOUT = Math.max(SOFT_TIMEOUT + 1, Number(query.get("hardTimeout")) || 300);

  const camera = $("camera");
  const canvas = $("captureCanvas");
  const flash = $("flash");
  const countdown = $("countdown");
  const toast = $("toast");

  function setState(next) {
    state = next;
    Object.keys(SCREENS).forEach((key) => {
      const node = $(SCREENS[key]);
      if (node) node.hidden = key !== next;
    });
    document.body.dataset.state = next;
    const step = next === "PREVIEW" || next === "PROCESS" ? 1 : next === "CHARACTER" ? 2 : next === "ACTION" ? 3 : 4;
    document.querySelectorAll("#steps li").forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle("is-active", n === step);
      li.classList.toggle("is-done", n < step);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toastMessage(message) {
    toast.textContent = message;
    toast.classList.add("is-show");
    clearTimeout(toastMessage.timer);
    toastMessage.timer = setTimeout(() => toast.classList.remove("is-show"), 2200);
  }

  function beep(frequency = 660, duration = 0.05) {
    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.value = 0.035;
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
      osc.stop(audioContext.currentTime + duration + 0.01);
    } catch (e) {}
  }

  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function startCamera() {
    const label = $("cameraState");
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      label.textContent = "浏览器没有摄像头权限，请用示例照片";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false
      });
      camera.srcObject = stream;
      label.classList.add("is-ok");
    } catch (e) {
      label.textContent = "摄像头未连接，请用示例照片继续";
      label.classList.remove("is-ok");
    }
  }

  function drawCapture() {
    const size = 1024;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f5edde";
    ctx.fillRect(0, 0, size, size);
    if (camera.videoWidth && camera.videoHeight) {
      const vw = camera.videoWidth;
      const vh = camera.videoHeight;
      const side = Math.min(vw, vh);
      const sx = (vw - side) / 2;
      const sy = (vh - side) / 2;
      ctx.drawImage(camera, sx, sy, side, side, 0, 0, size, size);
    }
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  async function samplePhoto() {
    try {
      const response = await fetch("assets/character.webp");
      if (!response.ok) throw new Error("sample missing");
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      throw new Error("示例照片读取失败");
    }
  }

  function countdownStart() {
    if (counting || state !== "PREVIEW") return;
    counting = true;
    let n = 3;
    countdown.hidden = false;
    countdown.querySelector("span").textContent = String(n);
    beep(720, 0.08);
    const timer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        countdown.querySelector("span").textContent = String(n);
        beep(720, 0.08);
      } else {
        clearInterval(timer);
        countdown.hidden = true;
        flash.classList.add("is-on");
        setTimeout(() => flash.classList.remove("is-on"), 450);
        triggerCapture();
      }
    }, 850);
  }

  async function triggerCapture() {
    if (state !== "PREVIEW") return;
    counting = false;
    let data;
    try {
      data = camera.videoWidth ? drawCapture() : await samplePhoto();
    } catch (e) {
      showError("没有拿到照片", e.message || "请重拍，或叫现场工作人员。", [
        { label: "重拍", action: () => resetToPreview() }
      ]);
      return;
    }
    await uploadPhoto(data);
  }

  async function uploadPhoto(data) {
    photoData = data;
    setState("PROCESS");
    startedAt = Date.now();
    $("processTitle").textContent = "照片上传中，请稍候";
    $("processSub").textContent = "上传完成后会开始 AI 卡通化。";
    setProcessStage("upload", 8, 0);
    try {
      const created = await request("/api/kiosk/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo: data, portraitMode: portraitMode })
      });
      session = created;
      pollSession();
    } catch (e) {
      showError("上传失败", "照片没有传上去：" + (e.message || "网络错误") + "。如果当前地址是 file://，请用 start-studio.bat 启动后端后再打开。", [
        { label: "重试上传", action: () => uploadPhoto(photoData) },
        { label: "重拍", action: () => resetToPreview() }
      ]);
    }
  }

  function setProcessStage(stage, percent, elapsed) {
    const order = ["upload", "parse", "cartoon", "cutout"];
    const current = order.indexOf(stage);
    document.querySelectorAll("#processSteps li").forEach((li) => {
      const index = order.indexOf(li.dataset.stage);
      li.classList.toggle("is-active", index === current);
      li.classList.toggle("is-done", index < current);
    });
    $("processBar").style.width = Math.max(4, Math.min(96, percent)) + "%";
    $("processPct").textContent = Math.round(percent) + "%";
    $("processElapsed").textContent = elapsed + "s";
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollSession, 1000);
  }

  async function pollSession() {
    if (!session) return;
    try {
      const data = await request(`/api/kiosk/sessions/${session.id}`);
      session = data;
      pollFailures = 0;
      applySession(data);
    } catch (e) {
      pollFailures += 1;
      if (pollFailures >= 4) {
        clearInterval(pollTimer);
        showError("连接中断", "后台可能还在处理。请重试，或叫现场工作人员。", [
          { label: "继续等待", action: () => { pollFailures = 0; startPolling(); } },
          { label: "重拍", action: () => resetToPreview() }
        ]);
      }
    }
  }

  function elapsedSeconds() {
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }

  function applySession(data) {
    const status = data.status;
    if (status === "character_queued" || status === "character_processing") {
      if (state !== "PROCESS") setState("PROCESS");
      const elapsed = elapsedSeconds();
      if (elapsed >= HARD_TIMEOUT) {
        clearInterval(pollTimer);
        showError("生成超时", "已经等待 " + elapsed + " 秒，角色还没有生成完。可以重新生成，或者重拍一张。", [
          { label: "重新生成", action: () => retryCharacter() },
          { label: "重拍", action: () => resetToPreview() }
        ]);
        return;
      }
      const soft = elapsed >= SOFT_TIMEOUT;
      const percent = status === "character_queued" ? 12 : soft ? Math.min(92, 60 + Math.floor((elapsed - SOFT_TIMEOUT) / 4)) : Math.min(84, 28 + Math.floor(elapsed / 2));
      const stage = status === "character_queued" ? "upload" : elapsed < 8 ? "parse" : elapsed < 22 ? "cartoon" : "cutout";
      $("processTitle").textContent = soft ? "还在生成，请再等一下" : (status === "character_queued" ? "正在排队解析人物" : "正在生成你的卡通角色…");
      $("processSub").textContent = soft
        ? "已经超过 " + Math.round(SOFT_TIMEOUT / 60) + " 分钟，AI 还在处理。不要离开，最多再等到 " + Math.round(HARD_TIMEOUT / 60) + " 分钟。"
        : (status === "character_queued" ? "马上开始，请稍候。" : "AI 正在努力创作，不要走开。");
      setProcessStage(stage, percent, elapsed);
      startPolling();
      return;
    }
    if (status === "character_ready") {
      clearInterval(pollTimer);
      showCharacter(data);
      return;
    }
    if (status === "character_failed") {
      clearInterval(pollTimer);
      showError("角色生成失败", data.error || "这次没有生成好。可以重新生成，或者重拍一张。", [
        { label: "重新生成", action: () => retryCharacter() },
        { label: "重拍", action: () => resetToPreview() }
      ]);
      return;
    }
    if (status === "gif_queued" || status === "gif_generating") {
      if (state !== "GIF") setState("GIF");
      const elapsed = elapsedSeconds();
      if (elapsed >= HARD_TIMEOUT) {
        clearInterval(pollTimer);
        showError("GIF 生成超时", "已经等待 " + elapsed + " 秒，GIF 还没有生成完。可以重新生成，或者返回动作选择。", [
          { label: "重新生成 GIF", action: () => startGif() },
          { label: "返回动作", action: () => { setState("ACTION"); renderActions(); } }
        ]);
        return;
      }
      const soft = elapsed >= SOFT_TIMEOUT;
      const percent = status === "gif_queued" ? 12 : soft ? Math.min(94, 60 + Math.floor((elapsed - SOFT_TIMEOUT) / 4)) : Math.min(88, 32 + Math.floor(elapsed / 2));
      $("gifSub").textContent = soft
        ? "已经超过 " + Math.round(SOFT_TIMEOUT / 60) + " 分钟，还在处理，请再等一下。"
        : (status === "gif_queued" ? "正在准备动作模板，请稍候。" : "正在把角色放进动作里，请稍候。");
      $("gifBar").style.width = percent + "%";
      $("gifPct").textContent = Math.round(percent) + "%";
      $("gifElapsed").textContent = elapsed + "s";
      startPolling();
      return;
    }
    if (status === "gif_ready") {
      clearInterval(pollTimer);
      showQr(data);
      return;
    }
    if (status === "gif_failed") {
      clearInterval(pollTimer);
      showError("GIF 生成失败", data.error || "这次没有生成好。可以重新生成，或返回动作选择。", [
        { label: "重新生成 GIF", action: () => startGif() },
        { label: "返回动作", action: () => { setState("ACTION"); renderActions(); } }
      ]);
      return;
    }
    if (status === "expired") {
      clearInterval(pollTimer);
      showQr(data, true);
    }
  }

  function showCharacter(data) {
    setState("CHARACTER");
    characterLocked = false;
    $("confirmCharacter").disabled = false;
    $("characterImg").src = data.character_url + "?t=" + Date.now();
  }

  async function retryCharacter() {
    if (!session) return;
    setState("PROCESS");
    startedAt = Date.now();
    $("processTitle").textContent = "正在重新生成角色…";
    $("processSub").textContent = "这次会重新解析人物和透明底。";
    setProcessStage("parse", 18, 0);
    try {
      await request(`/api/kiosk/sessions/${session.id}/retry-character`, { method: "POST", body: "{}" });
      pollFailures = 0;
      startPolling();
    } catch (e) {
      showError("重试失败", e.message || "请重拍一张。", [
        { label: "重拍", action: () => resetToPreview() }
      ]);
    }
  }

  function confirmCharacter() {
    if (characterLocked || !session) return;
    characterLocked = true;
    $("confirmCharacter").disabled = true;
    beep(880, 0.08);
    setState("ACTION");
    selectedIndex = 0;
    renderActions();
  }

  function actionPrompt(action) {
    return "Use the character in the reference image exactly: same face, same hair, same outfit, same accessories, same line style. Do not redesign the character.\n\n" +
      "Draw ONE square image: exactly 4 columns x 4 rows = 16 equal square cells. Each cell is the next frame of one short looping animation. No grid lines, no borders, no numbers. Every cell must contain the character.\n\n" +
      "Background must be truly transparent (PNG alpha). Do not paint a checkerboard, beige background, floor, or props.\n\n" +
      "The character stays the same size and on the same ground line, fully inside each cell with at least 8% margin. No cropped feet, no duplicated limbs, no extra people.\n\n" +
      "Animation: " + action.action + ". Start and end with the same pose so it loops.\n\n" +
      "Every cell has the exact Simplified Chinese caption \"" + action.word + "\" at the bottom, with a thick white sticker outline around the character and caption. No other text, no wrong characters, no English.\n\n" +
      "All 16 frames must depict the exact same character model. Only pose, facial expression and small action-related props may change. Do not generate 16 different character interpretations.\n\n" +
      "Art direction: premium Japanese anime-inspired chibi, soft painterly rendering, refined cel shading, thick clean dark brown outlines, detailed wavy hair, warm nostalgic palette, high-quality commercial LINE sticker. No watermark, logo or signature.";
  }

  function renderActions() {
    const grid = $("actionGrid");
    grid.innerHTML = ACTIONS.map((action, index) => {
      return '<button type="button" class="action-card' + (index === selectedIndex ? " is-selected" : "") + '" data-index="' + index + '">' +
        "<b>" + action.word + "</b><span>" + String(index + 1).padStart(2, "0") + " / " + action.action.slice(0, 12) + "</span></button>";
    }).join("");
    grid.querySelectorAll(".action-card").forEach((card) => {
      card.addEventListener("click", () => {
        selectedIndex = Number(card.dataset.index);
        updateActionSelection();
        beep(520, 0.04);
      });
    });
    updateActionSelection();
  }

  function updateActionSelection() {
    const action = ACTIONS[selectedIndex];
    $("actionName").textContent = action.word;
    $("knobIndex").textContent = String(selectedIndex + 1).padStart(2, "0");
    document.querySelectorAll(".action-card").forEach((card) => {
      card.classList.toggle("is-selected", Number(card.dataset.index) === selectedIndex);
    });
    const knob = $("knob");
    knob.classList.remove("is-turn");
    void knob.offsetWidth;
    knob.classList.add("is-turn");
  }

  function rotateAction(delta) {
    if (state !== "ACTION") return;
    selectedIndex = (selectedIndex + delta + ACTIONS.length) % ACTIONS.length;
    updateActionSelection();
    beep(delta > 0 ? 620 : 540, 0.035);
  }

  async function startGif() {
    if (!session || gifLocked) return;
    gifLocked = true;
    setState("GIF");
    startedAt = Date.now();
    $("gifSub").textContent = "正在把角色放进动作里，请稍候。";
    $("gifBar").style.width = "8%";
    $("gifPct").textContent = "8%";
    $("gifElapsed").textContent = "0s";
    try {
      const action = ACTIONS[selectedIndex];
      const data = await request(`/api/kiosk/sessions/${session.id}/gif`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: {
            id: action.id,
            word: action.word,
            caption: action.caption,
            action: action.action,
            prompt: actionPrompt(action)
          }
        })
      });
      session = data;
      pollFailures = 0;
      startPolling();
    } catch (e) {
      gifLocked = false;
      showError("GIF 生成失败", e.message || "服务没有接住这个任务。", [
        { label: "重新生成 GIF", action: () => startGif() },
        { label: "返回动作", action: () => { setState("ACTION"); renderActions(); } }
      ]);
    }
  }

  function showQr(data, expired = false) {
    gifLocked = false;
    document.body.dataset.token = data.token || "";
    setState("QR");
    $("gifImg").src = data.gif_url ? data.gif_url + "?t=" + Date.now() : "";
    $("qrImg").src = data.qr_url ? data.qr_url + "?t=" + Date.now() : "";
    $("claimCode").textContent = (data.token || "").slice(0, 6).toUpperCase();
    $("printNote").textContent = "有打印机时可直接打印，没有打印机会自动跳过。";
    $("printGif").disabled = false;
    countdownValue = 0;
    if (data.expires_at) {
      const end = new Date(data.expires_at).getTime();
      countdownValue = Math.max(0, Math.floor((end - Date.now()) / 1000));
    }
    updateCountdown();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
    const claimHost = data.claim_url ? new URL(data.claim_url).hostname : location.hostname;
    $("qrNote").textContent = expired || countdownValue <= 0
      ? "二维码已过期，请点击「重新获取」。"
      : (["127.0.0.1", "localhost"].indexOf(claimHost) !== -1
        ? "本机演示二维码。手机扫码前，请到运营台把手机访问地址改成局域网 IP。"
        : "二维码绑定唯一作品 ID，过期后需要重新获取。");
  }

  function updateCountdown() {
    const label = $("qrCountdown");
    if (!label) return;
    if (countdownValue <= 0) {
      label.textContent = "已过期";
      return;
    }
    const minutes = Math.floor(countdownValue / 60);
    const seconds = countdownValue % 60;
    label.textContent = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    countdownValue -= 1;
  }

  async function printGif() {
    if (!session || !session.gif_url) {
      $("printNote").textContent = "还没有作品，暂时不能打印。";
      return;
    }
    const button = $("printGif");
    button.disabled = true;
    $("printNote").textContent = "正在连接打印机…";
    const imageUrl = new URL(session.gif_url, location.origin).href;
    try {
      const health = await fetch("http://127.0.0.1:8788/health", { cache: "no-store" });
      if (!health.ok) throw new Error("device offline");
      const created = await fetch("http://127.0.0.1:8788/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, imageUrl, copies: 1, source: "kiosk" })
      });
      const job = await created.json();
      if (!created.ok) throw new Error(job.error || "print failed");
      $("printNote").textContent = "已发送打印，请到取片口等候…";
      for (let i = 0; i < 30; i += 1) {
        await sleep(1000);
        const response = await fetch("http://127.0.0.1:8788/print/" + encodeURIComponent(job.id), { cache: "no-store" });
        const current = await response.json();
        if (current.status === "printed") {
          $("printNote").textContent = "已出片，请从取片口取走。";
          button.disabled = false;
          return;
        }
        if (current.status === "failed") throw new Error(current.error || "printer failed");
      }
      $("printNote").textContent = "打印超时，请叫现场工作人员。";
    } catch (e) {
      const message = (e && e.message) || "";
      $("printNote").textContent = message && !/fetch|network|offline/i.test(message)
        ? "打印失败：" + message + "，请叫现场工作人员。"
        : "打印未连接或失败，可先用手机扫码领取。";
    } finally {
      button.disabled = false;
    }
  }

  async function refreshQr() {
    if (!session) return;
    try {
      const data = await request(`/api/kiosk/sessions/${session.id}/refresh`, { method: "POST", body: "{}" });
      session = data;
      showQr(data);
      toastMessage("二维码已刷新");
    } catch (e) {
      toastMessage("刷新失败，请叫现场工作人员");
    }
  }

  function resetToPreview() {
    clearInterval(pollTimer);
    clearInterval(countdownTimer);
    session = null;
    photoData = null;
    selectedIndex = 0;
    characterLocked = false;
    gifLocked = false;
    counting = false;
    countdownValue = 30 * 60;
    $("printNote").textContent = "有打印机时可直接打印，没有打印机会自动跳过。";
    setState("PREVIEW");
    startCamera();
  }

  function showError(title, text, actions) {
    gifLocked = false;
    counting = false;
    setState("ERROR");
    $("errorTitle").textContent = title;
    $("errorText").textContent = text;
    const box = $("errorActions");
    box.innerHTML = "";
    (actions || []).forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.className = item.primary === false ? "text-btn" : "primary";
      button.addEventListener("click", item.action);
      box.appendChild(button);
    });
  }

  function bindEvents() {
    $("shutterBtn").addEventListener("click", () => {
      if (state === "PREVIEW") countdownStart();
    });
    $("sampleBtn").addEventListener("click", async () => {
      try {
        const data = await samplePhoto();
        await uploadPhoto(data);
      } catch (e) {
        toastMessage(e.message);
      }
    });
    $("portraitPick").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        portraitMode = button.dataset.mode;
        $("portraitPick").querySelectorAll("button").forEach((item) => {
          item.classList.toggle("is-on", item.dataset.mode === portraitMode);
        });
        $("framingHint").textContent = portraitMode === "bust"
          ? "近景自拍选半身，只做到胸口，不会乱造身体。"
          : "全身模式请退后，确认头和鞋子都在画面里。";
        beep(520, 0.04);
      });
    });
    $("processRetake").addEventListener("click", resetToPreview);
    $("confirmCharacter").addEventListener("click", confirmCharacter);
    $("retakeCharacter").addEventListener("click", resetToPreview);
    $("regenerateCharacter").addEventListener("click", retryCharacter);
    $("actionPrev").addEventListener("click", () => rotateAction(-1));
    $("actionNext").addEventListener("click", () => rotateAction(1));
    $("actionConfirm").addEventListener("click", startGif);
    $("gifBack").addEventListener("click", () => { setState("ACTION"); renderActions(); });
    $("printGif").addEventListener("click", printGif);
    $("refreshQr").addEventListener("click", refreshQr);
    $("newSession").addEventListener("click", resetToPreview);

    document.addEventListener("keydown", (event) => {
      if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.key === " " || event.key === "Enter") {
        if (state === "PREVIEW") { event.preventDefault(); countdownStart(); }
        else if (state === "CHARACTER") { event.preventDefault(); confirmCharacter(); }
        else if (state === "ACTION") { event.preventDefault(); startGif(); }
      }
      if (state === "ACTION" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        rotateAction(event.key === "ArrowRight" ? 1 : -1);
      }
    });

    $("screen-action").addEventListener("wheel", (event) => {
      if (state !== "ACTION") return;
      event.preventDefault();
      rotateAction(event.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    window.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type !== "kiosk-hardware") return;
      if (data.action === "shutter" && state === "PREVIEW") countdownStart();
      if (data.action === "confirm" && state === "CHARACTER") confirmCharacter();
      if (data.action === "confirm" && state === "ACTION") startGif();
      if (data.action === "rotate" && state === "ACTION") rotateAction(Number(data.delta) || 1);
    });

    document.addEventListener("kiosk:shutter", () => {
      if (state === "PREVIEW") countdownStart();
    });
    document.addEventListener("kiosk:confirm", () => {
      if (state === "CHARACTER") confirmCharacter();
      else if (state === "ACTION") startGif();
    });
    document.addEventListener("kiosk:rotate", (event) => {
      rotateAction(Number(event.detail && event.detail.delta) || 1);
    });
  }

  function applyHardwareAction(action, delta) {
    if (action === "shutter" && state === "PREVIEW") countdownStart();
    if (action === "confirm" && state === "CHARACTER") confirmCharacter();
    if (action === "confirm" && state === "ACTION") startGif();
    if (action === "rotate" && state === "ACTION") rotateAction(Number(delta) || 1);
  }

  function connectDeviceAgent() {
    if (window.__deviceAgentStarted) return;
    window.__deviceAgentStarted = true;
    let source = null;
    let retry = null;
    function connect() {
      try {
        source = new EventSource("http://127.0.0.1:8788/events");
      } catch (e) {
        retry = setTimeout(connect, 5000);
        return;
      }
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "kiosk-hardware") applyHardwareAction(data.action, data.delta);
        } catch (e) { /* ignore malformed events */ }
      };
      source.onerror = () => {
        if (source) source.close();
        source = null;
        clearTimeout(retry);
        retry = setTimeout(connect, 5000);
      };
    }
    connect();
  }

  async function checkBackend() {
    try {
      await request("/api/health");
      return true;
    } catch (e) {
      showError("后端没有连接", "请先用 start-studio.bat 启动后端，再打开 http://127.0.0.1:8787/kiosk.html。不要直接双击 kiosk.html。", [
        { label: "重新尝试", action: () => location.reload() }
      ]);
      return false;
    }
  }

  function init() {
    bindEvents();
    setState("PREVIEW");
    startCamera();
    checkBackend();
    connectDeviceAgent();
    window.KioskHardware = {
      shutter: () => document.dispatchEvent(new CustomEvent("kiosk:shutter")),
      confirm: () => document.dispatchEvent(new CustomEvent("kiosk:confirm")),
      rotate: (delta) => document.dispatchEvent(new CustomEvent("kiosk:rotate", { detail: { delta: Number(delta) || 1 } }))
    };
  }

  init();
})();
