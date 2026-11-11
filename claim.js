(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const token = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  let expiryTimer = null;

  function setHeader(title, message) {
    $("title").textContent = title;
    $("message").textContent = message;
  }

  function showLoading(show) {
    $("loading").hidden = !show;
  }

  function showExpired(message) {
    showLoading(false);
    $("work").hidden = true;
    $("actions").hidden = true;
    setHeader("作品已过期", message || "这个领取链接已经过期。请联系现场工作人员重新获取。");
    $("expiry").textContent = "";
    $("retry").hidden = false;
  }

  function showError(title, message) {
    showLoading(false);
    $("work").hidden = true;
    $("actions").hidden = true;
    setHeader(title, message);
    $("retry").hidden = false;
  }

  function showReady(data) {
    showLoading(false);
    $("work").hidden = false;
    $("actions").hidden = false;
    $("retry").hidden = true;
    setHeader("作品已准备好", "下载 GIF，或者直接分享给朋友。");
    $("word").textContent = data.word || "表情";
    $("gif").src = data.gif_url + "?t=" + Date.now();
    const download = $("download");
    download.href = data.gif_url;
    download.setAttribute("download", "sticker.gif");
    $("share").onclick = async () => {
      const shareData = {
        title: "我的表情包作品",
        text: "我在旗袍表情工坊做了一张表情包。",
        url: location.href
      };
      if (navigator.share) {
        try { await navigator.share(shareData); return; } catch (e) {}
      }
      try {
        await navigator.clipboard.writeText(location.href);
        $("message").textContent = "领取链接已复制，可以发给朋友。";
      } catch (e) {
        $("message").textContent = "复制失败，请手动复制浏览器地址。";
      }
    };

    clearInterval(expiryTimer);
    const end = data.expires_at ? new Date(data.expires_at).getTime() : 0;
    const tick = () => {
      if (!end) { $("expiry").textContent = ""; return; }
      const left = Math.max(0, Math.floor((end - Date.now()) / 1000));
      if (left <= 0) {
        $("expiry").textContent = "作品已过期";
        return;
      }
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      const s = left % 60;
      $("expiry").textContent = "作品有效期至：" + new Date(end).toLocaleString() +
        "（剩余 " + (h ? h + " 小时 " : "") + m + " 分 " + s + " 秒）";
    };
    tick();
    expiryTimer = setInterval(tick, 1000);
  }

  async function load() {
    if (!token) {
      showError("领取链接无效", "地址里没有作品编号。请重新扫码，或联系现场工作人员。");
      return;
    }
    try {
      const response = await fetch("/api/claims/" + encodeURIComponent(token), { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (response.status === 410) { showExpired(data.error); return; }
      if (response.status === 409) {
        showLoading(false);
        setHeader("作品还在生成", "后台还在处理这张 GIF，稍等一下再打开。");
        $("retry").hidden = false;
        return;
      }
      if (!response.ok) {
        showError("没有找到作品", data.error || "领取链接可能已经失效，请联系现场工作人员。");
        return;
      }
      showReady(data);
    } catch (e) {
      showError("连接失败", "网络不稳定，或者后台暂时不可用。请重试，或联系现场工作人员。");
    }
  }

  $("retry").addEventListener("click", () => location.reload());
  showLoading(true);
  load();
})();
