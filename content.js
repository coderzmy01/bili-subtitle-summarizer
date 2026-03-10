"use strict";

const MESSAGE_TYPES = {
  GENERATE_SUMMARY: "GENERATE_SUMMARY",
  FETCH_YOUTUBE_SUBTITLE: "FETCH_YOUTUBE_SUBTITLE"
};

const PANEL_ID = "bss-root-panel";
const STYLE_ID = "bss-style-link";
const PANEL_SCALE_STORAGE_KEY = "bss-panel-scale";
const PANEL_SIZE_STORAGE_KEY = "bss-panel-size";
const PANEL_COLLAPSED_STORAGE_KEY = "bss-panel-collapsed";
const PANEL_SCALE_DEFAULT = 1;
const PANEL_SCALE_STEP = 0.1;
const PANEL_SCALE_MIN = 0.8;
const PANEL_SCALE_MAX = 1.6;
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 960;
const PANEL_MIN_HEIGHT = 220;
const PANEL_MAX_HEIGHT = 1200;

let currentUrl = location.href;
let mounted = false;
let busy = false;
let lastSummaryText = "";
let lastTranscriptText = "";
let lastVideoTitle = "";
let panelScale = loadPanelScale();
let panelBaseSize = loadPanelBaseSize();
let panelCollapsed = loadPanelCollapsed();
let suppressNextOpenClick = false;

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
    applyPanelScale(panel);
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
    <button id="bss-open-btn" class="bss-open-btn" type="button" aria-label="打开字幕摘要面板">打开摘要</button>
    <div class="bss-panel-main">
    <div class="bss-header">
      <div class="bss-title">字幕摘要</div>
      <div class="bss-header-right">
        <div id="bss-status" class="bss-status">待生成</div>
        <div class="bss-zoom-actions" aria-label="面板缩放">
          <button id="bss-zoom-out-btn" class="bss-zoom-btn" type="button" aria-label="缩小面板">－</button>
          <button id="bss-zoom-in-btn" class="bss-zoom-btn" type="button" aria-label="放大面板">＋</button>
          <button id="bss-collapse-btn" class="bss-toggle-btn" type="button" aria-label="收起字幕摘要面板">收起</button>
        </div>
      </div>
    </div>
    <div class="bss-actions">
      <button id="bss-generate-btn" class="bss-btn bss-btn-primary" type="button">生成摘要</button>
      <button id="bss-copy-btn" class="bss-btn bss-btn-secondary" type="button" disabled>复制摘要</button>
      <button id="bss-download-btn" class="bss-btn bss-btn-secondary" type="button" disabled>下载字幕</button>
      <button id="bss-download-summary-btn" class="bss-btn bss-btn-secondary" type="button" disabled>导出摘要</button>
    </div>
    <div id="bss-error" class="bss-error" aria-live="polite"></div>
    <div id="bss-content" class="bss-content">
      <div class="bss-placeholder">${isYouTubeVideo() ? "请先在YouTube播放器中开启CC字幕（点击播放器右下角字幕按钮），再点击“生成摘要”。" : "建议先点击视频播放器里的“AI字幕”生成字幕，再点击“生成摘要”以获得最准确的内容。"}</div>
    </div>
    <div class="bss-resize-handle bss-resize-handle-n" data-dir="n" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-e" data-dir="e" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-s" data-dir="s" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-w" data-dir="w" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-ne" data-dir="ne" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-nw" data-dir="nw" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-se" data-dir="se" aria-hidden="true"></div>
    <div class="bss-resize-handle bss-resize-handle-sw" data-dir="sw" aria-hidden="true"></div>
    </div>
  `;

  document.body.appendChild(panel);
  const generateBtn = document.getElementById("bss-generate-btn");
  const copyBtn = document.getElementById("bss-copy-btn");

  const downloadBtn = document.getElementById("bss-download-btn");
  const downloadSummaryBtn = document.getElementById("bss-download-summary-btn");
  const zoomOutBtn = document.getElementById("bss-zoom-out-btn");
  const zoomInBtn = document.getElementById("bss-zoom-in-btn");
  const collapseBtn = document.getElementById("bss-collapse-btn");
  const openBtn = document.getElementById("bss-open-btn");
  generateBtn?.addEventListener("click", onGenerateClicked);
  copyBtn?.addEventListener("click", onCopyClicked);
  downloadBtn?.addEventListener("click", onDownloadClicked);
  downloadSummaryBtn?.addEventListener("click", onDownloadSummaryClicked);
  zoomOutBtn?.addEventListener("click", onZoomOutClicked);
  zoomInBtn?.addEventListener("click", onZoomInClicked);
  collapseBtn?.addEventListener("click", onCollapseClicked);
  openBtn?.addEventListener("click", onOpenClicked);

  applyPanelScale(panel);
  makePanelDraggable(panel);
  makePanelResizable(panel);
  applyCollapsedState(panel);
}

function makePanelDraggable(panel) {
  const header = panel.querySelector(".bss-header");
  const openBtn = panel.querySelector("#bss-open-btn");
  if (!header && !openBtn) return;

  let isDragging = false;
  let isOpenButtonDrag = false;
  let hasMovedDuringDrag = false;
  let startX, startY, startLeft, startTop;

  const beginDrag = (e, options = {}) => {
    isDragging = true;
    isOpenButtonDrag = Boolean(options.fromOpenButton);
    hasMovedDuringDrag = false;
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
  };

  header?.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    beginDrag(e);
  });

  openBtn?.addEventListener("mousedown", (e) => {
    if (!panel.classList.contains("bss-collapsed")) {
      return;
    }
    beginDrag(e, { fromOpenButton: true });
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      hasMovedDuringDrag = true;
    }
    const newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + e.clientX - startX));
    const newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + e.clientY - startY));
    panel.style.left = newLeft + "px";
    panel.style.top = newTop + "px";
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      panel.classList.remove("bss-dragging");
      if (isOpenButtonDrag && hasMovedDuringDrag) {
        suppressNextOpenClick = true;
        window.setTimeout(() => {
          suppressNextOpenClick = false;
        }, 0);
      }
      isOpenButtonDrag = false;
      hasMovedDuringDrag = false;
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

function onCollapseClicked() {
  setPanelCollapsed(true);
}

function onOpenClicked(event) {
  if (suppressNextOpenClick) {
    suppressNextOpenClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  onExpandClicked();
}

function onExpandClicked() {
  setPanelCollapsed(false);
}

function setPanelCollapsed(nextCollapsed) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    return;
  }
  panelCollapsed = Boolean(nextCollapsed);
  savePanelCollapsed(panelCollapsed);
  applyCollapsedState(panel);
}

function applyCollapsedState(panel) {
  panel.classList.toggle("bss-collapsed", panelCollapsed);
  if (panelCollapsed) {
    panel.classList.remove("bss-resizing");
    return;
  }
  applyPanelScale(panel);
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
  if (panelBaseSize) {
    applyPanelBaseSize(panel);
  } else {
    keepPanelInViewport(panel);
  }
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

function makePanelResizable(panel) {
  const handles = panel.querySelectorAll(".bss-resize-handle");
  if (!handles.length) {
    return;
  }

  let isResizing = false;
  let resizeDir = "";
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let startWidth = 0;
  let startHeight = 0;
  let startRight = 0;
  let startBottom = 0;

  handles.forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      const dir = handle.getAttribute("data-dir");
      if (!dir) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      isResizing = true;
      resizeDir = dir;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      startWidth = rect.width;
      startHeight = rect.height;
      startRight = rect.right;
      startBottom = rect.bottom;

      panel.style.right = "auto";
      panel.style.left = `${startLeft}px`;
      panel.style.top = `${startTop}px`;
      panel.style.width = `${startWidth}px`;
      panel.style.height = `${startHeight}px`;
      panel.classList.add("bss-resizing");
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) {
      return;
    }

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxWidth = getMaxPanelWidth();
    const maxHeight = getMaxPanelHeight();
    let nextLeft = startLeft;
    let nextTop = startTop;
    let nextWidth = startWidth;
    let nextHeight = startHeight;

    if (resizeDir.includes("e")) {
      const limit = Math.min(maxWidth, window.innerWidth - startLeft);
      nextWidth = clampValue(startWidth + dx, PANEL_MIN_WIDTH, Math.max(PANEL_MIN_WIDTH, limit));
    }
    if (resizeDir.includes("s")) {
      const limit = Math.min(maxHeight, window.innerHeight - startTop);
      nextHeight = clampValue(startHeight + dy, PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, limit));
    }
    if (resizeDir.includes("w")) {
      const limit = Math.min(maxWidth, startRight);
      nextWidth = clampValue(startWidth - dx, PANEL_MIN_WIDTH, Math.max(PANEL_MIN_WIDTH, limit));
      nextLeft = startRight - nextWidth;
    }
    if (resizeDir.includes("n")) {
      const limit = Math.min(maxHeight, startBottom);
      nextHeight = clampValue(startHeight - dy, PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, limit));
      nextTop = startBottom - nextHeight;
    }

    panel.style.left = `${Math.round(nextLeft)}px`;
    panel.style.top = `${Math.round(nextTop)}px`;
    panel.style.width = `${Math.round(nextWidth)}px`;
    panel.style.height = `${Math.round(nextHeight)}px`;
    e.preventDefault();
  });

  document.addEventListener("mouseup", () => {
    if (!isResizing) {
      return;
    }
    isResizing = false;
    panel.classList.remove("bss-resizing");
    const baseWidth = roundPanelSize(panel.offsetWidth / panelScale);
    const baseHeight = roundPanelSize(panel.offsetHeight / panelScale);
    panelBaseSize = { width: baseWidth, height: baseHeight };
    savePanelBaseSize(panelBaseSize);
  });
}

function applyPanelBaseSize(panel) {
  if (!panelBaseSize) {
    return;
  }
  const width = clampValue(
    panelBaseSize.width * panelScale,
    PANEL_MIN_WIDTH,
    getMaxPanelWidth()
  );
  const height = clampValue(
    panelBaseSize.height * panelScale,
    PANEL_MIN_HEIGHT,
    getMaxPanelHeight()
  );

  panel.style.width = `${Math.round(width)}px`;
  panel.style.height = `${Math.round(height)}px`;
  keepPanelInViewport(panel);
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

function loadPanelBaseSize() {
  try {
    const raw = localStorage.getItem(PANEL_SIZE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    return {
      width: clampValue(width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
      height: clampValue(height, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT)
    };
  } catch (_error) {
    // Ignore storage access failures.
  }
  return null;
}

function savePanelBaseSize(size) {
  try {
    localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(size));
  } catch (_error) {
    // Ignore storage access failures.
  }
}

function loadPanelCollapsed() {
  try {
    return localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY) === "1";
  } catch (_error) {
    // Ignore storage access failures.
  }
  return false;
}

function savePanelCollapsed(value) {
  try {
    localStorage.setItem(PANEL_COLLAPSED_STORAGE_KEY, value ? "1" : "0");
  } catch (_error) {
    // Ignore storage access failures.
  }
}

function getMaxPanelWidth() {
  const viewportLimit = window.innerWidth - 8;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, viewportLimit));
}

function getMaxPanelHeight() {
  const viewportLimit = window.innerHeight - 8;
  return Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, viewportLimit));
}

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundPanelSize(value) {
  return Math.round(value * 10) / 10;
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
      lastSummaryText = buildSummaryText(summaryStructured, summaryText);
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

function buildSummaryText(structured, raw) {
  const structuredText = buildDisplayText(structured);
  if (structuredText) {
    return structuredText;
  }
  return normalizeRawSummaryText(raw);
}

function normalizeRawSummaryText(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:json|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!cleaned) {
    return "";
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") {
      const lines = formatObjectToLines(parsed);
      const parsedText = lines.join("\n").trim();
      if (parsedText) {
        return parsedText;
      }
    }
  } catch (_error) {
    // Keep original text when AI output is not JSON.
  }

  return cleaned;
}

function formatObjectToLines(value, indent = "") {
  if (!value || typeof value !== "object") {
    return [];
  }

  const lines = [];
  Object.entries(value).forEach(([key, item]) => {
    const label = `${indent}${String(key || "").trim()}`.trim();
    if (!label) {
      return;
    }

    if (Array.isArray(item)) {
      lines.push(`${label}：`);
      item.forEach((entry) => {
        if (entry && typeof entry === "object") {
          lines.push(`${indent}-`);
          lines.push(...formatObjectToLines(entry, `${indent}  `));
          return;
        }
        const text = String(entry || "").trim();
        if (text) {
          lines.push(`${indent}- ${text}`);
        }
      });
      return;
    }

    if (item && typeof item === "object") {
      lines.push(`${label}：`);
      lines.push(...formatObjectToLines(item, `${indent}  `));
      return;
    }

    const text = String(item || "").trim();
    if (text) {
      lines.push(`${label}：${text}`);
    }
  });

  return lines;
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
  const downloadSummaryBtn = document.getElementById("bss-download-summary-btn");
  if (generateBtn) {
    generateBtn.disabled = busy;
  }
  if (copyBtn) {
    copyBtn.disabled = busy || !lastSummaryText;
  }
  if (downloadBtn) {
    downloadBtn.disabled = busy || !lastTranscriptText;
  }
  if (downloadSummaryBtn) {
    downloadSummaryBtn.disabled = busy || !lastSummaryText;
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

function onDownloadSummaryClicked() {
  if (!lastSummaryText) {
    return;
  }
  const safeTitle = lastVideoTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "summary";
  const blob = new Blob([lastSummaryText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeTitle}_summary.txt`;
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
