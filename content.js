"use strict";

const MESSAGE_TYPES = {
  GENERATE_SUMMARY: "GENERATE_SUMMARY",
  FETCH_YOUTUBE_SUBTITLE: "FETCH_YOUTUBE_SUBTITLE"
};

const PANEL_ID = "bss-root-panel";
const STYLE_ID = "bss-style-link";
const PANEL_SCALE_STORAGE_KEY = "bss-panel-scale";
const PANEL_SCALE_DEFAULT = 1;
const PANEL_SCALE_STEP = 0.1;
const PANEL_SCALE_MIN = 0.8;
const PANEL_SCALE_MAX = 1.6;

let currentUrl = location.href;
let mounted = false;
let busy = false;
let lastSummaryText = "";
let lastTranscriptText = "";
let lastVideoTitle = "";
let panelScale = loadPanelScale();

init();

function init() {
  ensureStyles();
  setupRuntimeMessageListener();
  setupWindowResizeListener();
  syncByUrl();
  setInterval(() => {
    const nextUrl = location.href;
    if (nextUrl !== currentUrl) {
      const previousUrl = currentUrl;
      currentUrl = nextUrl;
      onUrlChanged(previousUrl, nextUrl);
    }
  }, 500);
}

function setupWindowResizeListener() {
  window.addEventListener("resize", () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    keepPanelInViewport(panel);
  });
}

function setupRuntimeMessageListener() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MESSAGE_TYPES.FETCH_YOUTUBE_SUBTITLE) {
      return false;
    }

    fetchYouTubeSubtitleFromPage(message.payload || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: {
            message: error?.message || "Failed to fetch subtitle in page context."
          }
        })
      );

    return true;
  });
}

async function fetchYouTubeSubtitleFromPage(payload) {
  if (!isYouTubeVideo()) {
    throw new Error("Current page is not a YouTube watch page.");
  }

  const subtitleUrl = String(payload.subtitleUrl || "").trim();
  if (!subtitleUrl) {
    throw new Error("Missing YouTube subtitle URL.");
  }

  let response;
  try {
    response = await fetch(subtitleUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "*/*"
      },
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(`Page subtitle fetch failed: ${error?.message || "Network error"}`);
  }

  if (!response.ok) {
    throw new Error(`Page subtitle fetch failed: HTTP ${response.status}`);
  }

  return await response.text();
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const link = document.createElement("link");
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("styles.css");
  document.head.appendChild(link);
}

function isBilibiliVideo(url) {
  return /https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]+/i.test(url);
}

function isYouTubeVideo(url) {
  return /^https:\/\/(www\.)?youtube\.com\/watch/.test(url || location.href);
}

function syncByUrl() {
  if (isBilibiliVideo(location.href) || isYouTubeVideo(location.href)) {
    mountPanel();
  } else {
    unmountPanel();
  }
}

function onUrlChanged(previousUrl, nextUrl) {
  const wasVideo = isBilibiliVideo(previousUrl) || isYouTubeVideo(previousUrl);
  const isVideo = isBilibiliVideo(nextUrl) || isYouTubeVideo(nextUrl);
  if (wasVideo && isVideo) {
    unmountPanel();
    mountPanel();
    return;
  }
  syncByUrl();
}

function mountPanel() {
  if (mounted || document.getElementById(PANEL_ID)) {
    mounted = true;
    return;
  }
  mounted = true;

  const panel = document.createElement("aside");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="bss-header">
      <div class="bss-title">字幕摘要</div>
      <div class="bss-header-right">
        <div id="bss-status" class="bss-status">待生成</div>
        <div class="bss-zoom-actions" aria-label="面板缩放">
          <button id="bss-zoom-out-btn" class="bss-zoom-btn" type="button" aria-label="缩小面板">－</button>
          <button id="bss-zoom-in-btn" class="bss-zoom-btn" type="button" aria-label="放大面板">＋</button>
        </div>
      </div>
    </div>
    <div class="bss-actions">
      <button id="bss-generate-btn" class="bss-btn bss-btn-primary" type="button">生成摘要</button>
      <button id="bss-copy-btn" class="bss-btn bss-btn-secondary" type="button" disabled>复制摘要</button>
      <button id="bss-download-btn" class="bss-btn bss-btn-secondary" type="button" disabled>下载字幕</button>
    </div>
    <div id="bss-error" class="bss-error" aria-live="polite"></div>
    <div id="bss-content" class="bss-content">
      <div class="bss-placeholder">${isYouTubeVideo() ? "请先在YouTube播放器中开启CC字幕（点击播放器右下角字幕按钮），再点击“生成摘要”。" : "建议先点击视频播放器里的“AI字幕”生成字幕，再点击“生成摘要”以获得最准确的内容。"}</div>
    </div>
  `;

  document.body.appendChild(panel);
  const generateBtn = document.getElementById("bss-generate-btn");
  const copyBtn = document.getElementById("bss-copy-btn");

  const downloadBtn = document.getElementById("bss-download-btn");
  const zoomOutBtn = document.getElementById("bss-zoom-out-btn");
  const zoomInBtn = document.getElementById("bss-zoom-in-btn");
  generateBtn?.addEventListener("click", onGenerateClicked);
  copyBtn?.addEventListener("click", onCopyClicked);
  downloadBtn?.addEventListener("click", onDownloadClicked);
  zoomOutBtn?.addEventListener("click", onZoomOutClicked);
  zoomInBtn?.addEventListener("click", onZoomInClicked);

  applyPanelScale(panel);
  makePanelDraggable(panel);
}

function makePanelDraggable(panel) {
  const header = panel.querySelector(".bss-header");
  if (!header) return;

  let isDragging = false;
  let startX, startY, startLeft, startTop;

  header.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    isDragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    panel.style.right = "auto";
    panel.style.left = startLeft + "px";
    panel.style.top = startTop + "px";
    panel.classList.add("bss-dragging");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + e.clientX - startX));
    const newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + e.clientY - startY));
    panel.style.left = newLeft + "px";
    panel.style.top = newTop + "px";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      panel.classList.remove("bss-dragging");
    }
  });
}

function unmountPanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) {
    panel.remove();
  }
  mounted = false;
  busy = false;
  lastSummaryText = "";
  lastTranscriptText = "";
  lastVideoTitle = "";
}

function onZoomOutClicked() {
  adjustPanelScale(-PANEL_SCALE_STEP);
}

function onZoomInClicked() {
  adjustPanelScale(PANEL_SCALE_STEP);
}

function adjustPanelScale(delta) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    return;
  }
  const next = roundScale(panelScale + delta);
  panelScale = clampScale(next);
  savePanelScale(panelScale);
  applyPanelScale(panel);
}

function applyPanelScale(panel) {
  panel.style.setProperty("--bss-panel-scale", String(panelScale));
  keepPanelInViewport(panel);
  updateZoomButtons();
}

function updateZoomButtons() {
  const zoomOutBtn = document.getElementById("bss-zoom-out-btn");
  const zoomInBtn = document.getElementById("bss-zoom-in-btn");
  if (zoomOutBtn) {
    zoomOutBtn.disabled = panelScale <= PANEL_SCALE_MIN;
    zoomOutBtn.title = `当前缩放：${Math.round(panelScale * 100)}%`;
  }
  if (zoomInBtn) {
    zoomInBtn.disabled = panelScale >= PANEL_SCALE_MAX;
    zoomInBtn.title = `当前缩放：${Math.round(panelScale * 100)}%`;
  }
}

function keepPanelInViewport(panel) {
  const hasCustomPosition = panel.style.left && panel.style.top;
  if (!hasCustomPosition) {
    return;
  }
  const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
  const left = Math.min(maxLeft, Math.max(0, parseFloat(panel.style.left) || 0));
  const top = Math.min(maxTop, Math.max(0, parseFloat(panel.style.top) || 0));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function loadPanelScale() {
  try {
    const raw = localStorage.getItem(PANEL_SCALE_STORAGE_KEY);
    const value = Number(raw);
    if (Number.isFinite(value)) {
      return clampScale(roundScale(value));
    }
  } catch (_error) {
    // Ignore storage access failures.
  }
  return PANEL_SCALE_DEFAULT;
}

function savePanelScale(value) {
  try {
    localStorage.setItem(PANEL_SCALE_STORAGE_KEY, String(value));
  } catch (_error) {
    // Ignore storage access failures.
  }
}

function roundScale(value) {
  return Math.round(value * 10) / 10;
}

function clampScale(value) {
  return Math.max(PANEL_SCALE_MIN, Math.min(PANEL_SCALE_MAX, value));
}

function onGenerateClicked() {
  if (busy) {
    return;
  }
  busy = true;
  lastSummaryText = "";
  lastTranscriptText = "";
  lastVideoTitle = getVideoTitle();
  setStatus("生成中...");
  setError("");
  toggleButtons();
  renderLoading();

  chrome.runtime.sendMessage(
    {
      type: MESSAGE_TYPES.GENERATE_SUMMARY,
      payload: {
        url: location.href,
        title: getVideoTitle()
      }
    },
    (response) => {
      busy = false;

      if (chrome.runtime.lastError) {
        toggleButtons();
        setStatus("失败");
        setError(`扩展通信失败：${chrome.runtime.lastError.message}`);
        renderRawText("生成失败，请重试。");
        return;
      }

      if (!response || !response.ok) {
        toggleButtons();
        const error = response?.error || {};
        setStatus("失败");
        setError(formatError(error));
        renderRawText("生成失败，请检查配置或网络。");
        return;
      }

      const data = response.data || {};
      const summaryStructured = data.summaryStructured || {};
      const summaryText = String(data.summaryText || "").trim();
      lastSummaryText = summaryText || buildDisplayText(summaryStructured);
      lastTranscriptText = String(data.transcriptText || "").trim();

      toggleButtons();
      setStatus("已完成");
      setError("");
      renderSummary(summaryStructured, summaryText);
    }
  );
}

async function onCopyClicked() {
  const copyBtn = document.getElementById("bss-copy-btn");
  const text = lastSummaryText || getContentText();
  if (!text) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    const original = copyBtn?.textContent || "复制摘要";
    if (copyBtn) {
      copyBtn.textContent = "已复制";
    }
    setTimeout(() => {
      const node = document.getElementById("bss-copy-btn");
      if (node) {
        node.textContent = original;
      }
    }, 1200);
  } catch (_error) {
    setError("复制失败，请检查浏览器剪贴板权限。");
  }
}

function renderLoading() {
  const content = document.getElementById("bss-content");
  if (!content) {
    return;
  }
  content.innerHTML = `
    <div class="bss-loading">
      <span class="bss-spinner"></span>
      正在抓取字幕并生成摘要...
    </div>
  `;
}

function renderSummary(structured, raw) {
  const content = document.getElementById("bss-content");
  if (!content) {
    return;
  }

  const hasStructured =
    structured &&
    (structured.theme ||
      structured.background ||
      (Array.isArray(structured.key_points) && structured.key_points.length > 0) ||
      structured.conclusion ||
      (Array.isArray(structured.follow_ups) && structured.follow_ups.length > 0));

  if (!hasStructured) {
    renderRawText(raw || "AI 未返回结构化 JSON，已显示原文结果。");
    return;
  }

  content.innerHTML = "";
  content.appendChild(createSection("主题", structured.theme || "未给出"));
  if (structured.background) {
    content.appendChild(createSection("背景", structured.background));
  }
  content.appendChild(createListSection("核心知识点", structured.key_points || []));
  if (Array.isArray(structured.insights) && structured.insights.length > 0) {
    content.appendChild(createListSection("深层洞见", structured.insights));
  }
  content.appendChild(createSection("总结与收获", structured.conclusion || "未给出"));
  content.appendChild(createListSection("延伸学习", structured.follow_ups || []));
}

function createSection(title, text) {
  const section = document.createElement("section");
  section.className = "bss-section";

  const heading = document.createElement("h4");
  heading.className = "bss-section-title";
  heading.textContent = title;

  const paragraph = document.createElement("p");
  paragraph.className = "bss-section-text";
  paragraph.textContent = text;

  section.appendChild(heading);
  section.appendChild(paragraph);
  return section;
}

function createListSection(title, list) {
  const section = document.createElement("section");
  section.className = "bss-section";

  const heading = document.createElement("h4");
  heading.className = "bss-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  const ul = document.createElement("ul");
  ul.className = "bss-list";
  const items = Array.isArray(list) ? list : [];

  if (items.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.textContent = "未给出";
    ul.appendChild(emptyItem);
  } else {
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    });
  }

  section.appendChild(ul);
  return section;
}

function renderRawText(text) {
  const content = document.getElementById("bss-content");
  if (!content) {
    return;
  }
  content.innerHTML = "";
  const block = document.createElement("pre");
  block.className = "bss-raw";
  block.textContent = String(text || "");
  content.appendChild(block);
}

function buildDisplayText(structured) {
  const lines = [];
  if (structured.theme) {
    lines.push(`主题：${structured.theme}`);
  }
  if (structured.background) {
    lines.push(`\n背景：${structured.background}`);
  }
  if (Array.isArray(structured.key_points) && structured.key_points.length > 0) {
    lines.push("\n核心知识点：");
    structured.key_points.forEach((point) => lines.push(`- ${point}`));
  }
  if (Array.isArray(structured.insights) && structured.insights.length > 0) {
    lines.push("\n深层洞见：");
    structured.insights.forEach((item) => lines.push(`- ${item}`));
  }
  if (structured.conclusion) {
    lines.push(`\n总结与收获：${structured.conclusion}`);
  }
  if (Array.isArray(structured.follow_ups) && structured.follow_ups.length > 0) {
    lines.push("\n延伸学习：");
    structured.follow_ups.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join("\n").trim();
}

function setStatus(text) {
  const status = document.getElementById("bss-status");
  if (status) {
    status.textContent = text;
  }
}

function setError(text) {
  const error = document.getElementById("bss-error");
  if (error) {
    error.textContent = text;
  }
}

function toggleButtons() {
  const generateBtn = document.getElementById("bss-generate-btn");
  const copyBtn = document.getElementById("bss-copy-btn");
  const downloadBtn = document.getElementById("bss-download-btn");
  if (generateBtn) {
    generateBtn.disabled = busy;
  }
  if (copyBtn) {
    copyBtn.disabled = busy || !lastSummaryText;
  }
  if (downloadBtn) {
    downloadBtn.disabled = busy || !lastTranscriptText;
  }
}

function onDownloadClicked() {
  if (!lastTranscriptText) {
    return;
  }
  const safeTitle = lastVideoTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "subtitle";
  const blob = new Blob([lastTranscriptText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeTitle}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function getVideoTitle() {
  const titleNode = document.querySelector("h1.video-title");
  if (titleNode && titleNode.textContent) {
    return titleNode.textContent.trim();
  }
  return document.title.replace(/_哔哩哔哩_bilibili$/, "").trim();
}

function getContentText() {
  const content = document.getElementById("bss-content");
  return content?.textContent?.trim() || "";
}

function formatError(error) {
  if (!error || typeof error !== "object") {
    return "未知错误。";
  }
  const code = error.code ? `[${error.code}] ` : "";
  const message = error.message || "请求失败。";
  return `${code}${message}`;
}
