"use strict";

const MESSAGE_TYPES = {
  GENERATE_SUMMARY: "GENERATE_SUMMARY",
};

const ERROR_CODES = {
  INVALID_VIDEO_URL: "INVALID_VIDEO_URL",
  BILIBILI_API_FAILED: "BILIBILI_API_FAILED",
  SUBTITLE_NOT_FOUND: "SUBTITLE_NOT_FOUND",
  SUBTITLE_PARSE_FAILED: "SUBTITLE_PARSE_FAILED",
  TRANSCRIPT_EMPTY: "TRANSCRIPT_EMPTY",
  AI_CONFIG_MISSING: "AI_CONFIG_MISSING",
  AI_REQUEST_FAILED: "AI_REQUEST_FAILED",
  YOUTUBE_SUBTITLE_NOT_CAPTURED: "YOUTUBE_SUBTITLE_NOT_CAPTURED",
};

const DEFAULT_SETTINGS = {
  aiEndpoint: "https://api.aigocode.com",
  aiModel: "gemini-3-pro-preview",
  apiKey: "",
  summaryPromptTemplate:
    "请根据以下视频字幕文档，生成一份详细的结构化学习笔记。只输出 JSON，不要 markdown。\n" +
    "字段固定为：theme(string), background(string), key_points(string[]), insights(string[]), conclusion(string), follow_ups(string[])\n" +
    "要求：\n" +
    "1) 使用简体中文\n" +
    "2) theme：一句话概括视频核心主题\n" +
    "3) background：视频涉及的背景知识、应用场景或前提，2-3句话\n" +
    "4) key_points：6-10条核心知识点，每条用2-4句话详细阐述，包含具体细节、数据、原理或例子，避免空洞概括\n" +
    "5) insights：2-4条深层洞见、独特观点或反直觉结论，区别于 key_points 的表面描述\n" +
    "6) conclusion：综合总结与核心收获，3-5句话\n" +
    "7) follow_ups：3-5个延伸学习方向或值得深入研究的问题\n" +
    "8) 不杜撰，不确定时明确说明\n\n" +
    "视频标题：{{title}}\n\n" +
    "字幕文档：\n{{transcript}}",
};

class ExtensionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
    this.details = details || null;
  }
}

// Key: tabId, Value: { url, capturedAt, platform }
const capturedSubtitleUrls = {};

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId > 0) {
      capturedSubtitleUrls[details.tabId] = {
        url: details.url,
        capturedAt: Date.now(),
        platform: "bilibili",
      };
    }
  },
  { urls: ["https://aisubtitle.hdslb.com/bfs/ai_subtitle/*"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId > 0) {
      capturedSubtitleUrls[details.tabId] = {
        url: details.url,
        capturedAt: Date.now(),
        platform: "youtube",
      };
    }
  },
  { urls: ["https://www.youtube.com/api/timedtext*"] }
);

chrome.runtime.onInstalled.addListener(async () => {
  const current = await storageGet("sync", Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (current[key] === undefined || current[key] === null) {
      patch[key] = value;
    }
  }
  if (Object.keys(patch).length > 0) {
    await storageSet("sync", patch);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPES.GENERATE_SUMMARY) {
    return false;
  }

  const tabId = sender.tab?.id ?? -1;
  handleGenerateSummary(message.payload || {}, tabId)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({ ok: false, error: normalizeError(error) }),
    );

  return true;
});

async function handleGenerateSummary(payload, tabId) {
  const pageUrl = payload.url || "";
  const title = (payload.title || "").trim();
  const settings = await getSettings();

  if (isYouTubeUrl(pageUrl)) {
    const result = await handleYouTubeSummary(pageUrl, title, tabId, settings);
    await storageSet("local", { lastSummaryResult: result });
    return result;
  }

  const { bvid, page } = parseVideoContext(pageUrl);

  const CAPTURED_MAX_AGE_MS = 5 * 60 * 1000;
  const captured = capturedSubtitleUrls[tabId];
  const useCaptured =
    captured &&
    captured.platform === "bilibili" &&
    Date.now() - captured.capturedAt < CAPTURED_MAX_AGE_MS;

  let subtitleFile;
  let subtitleLang = "unknown";
  let cid;

  if (useCaptured) {
    delete capturedSubtitleUrls[tabId];
    subtitleFile = await fetchSubtitleFile(captured.url);
    const cidResult = await resolveCidByPage(bvid, page);
    cid = cidResult.cid;
  } else {
    const cidResult = await resolveCidByPage(bvid, page);
    cid = cidResult.cid;
    const subtitleMeta = await resolveSubtitleMeta(bvid, cid, pageUrl);
    subtitleLang = subtitleMeta.lan || subtitleMeta.lan_doc || "unknown";
    subtitleFile = await fetchSubtitleFile(subtitleMeta.subtitle_url);
  }

  const transcript = buildTranscript(subtitleFile.body || []);
  const summaryResult = await generateSummary(transcript, title, settings);
  const result = {
    bvid,
    page,
    cid,
    subtitleLang,
    title,
    transcriptText: transcript,
    transcriptLength: transcript.length,
    chunkCount: summaryResult.chunkCount,
    summaryText: summaryResult.summaryText,
    summaryStructured: summaryResult.summaryStructured,
    generatedAt: new Date().toISOString(),
    usedCapturedSubtitle: useCaptured,
  };

  await storageSet("local", { lastSummaryResult: result });
  return result;
}

function isYouTubeUrl(url) {
  return /^https:\/\/(www\.)?youtube\.com\/watch/.test(String(url || ""));
}

async function handleYouTubeSummary(pageUrl, title, tabId, settings) {
  const videoId = parseYouTubeVideoId(pageUrl);

  const CAPTURED_MAX_AGE_MS = 5 * 60 * 1000;
  const captured = capturedSubtitleUrls[tabId];
  const useCaptured =
    captured &&
    captured.platform === "youtube" &&
    Date.now() - captured.capturedAt < CAPTURED_MAX_AGE_MS;

  if (!useCaptured) {
    throw new ExtensionError(
      ERROR_CODES.YOUTUBE_SUBTITLE_NOT_CAPTURED,
      '请先在YouTube播放器中开启CC字幕（点击播放器右下角\u201c字幕\u201d按钮），再点击\u201c生成摘要\u201d。',
    );
  }

  delete capturedSubtitleUrls[tabId];
  const subtitleData = await fetchYouTubeSubtitle(captured.url);
  const transcript = buildYouTubeTranscript(subtitleData);
  const summaryResult = await generateSummary(transcript, title, settings);

  return {
    videoId,
    platform: "youtube",
    title,
    transcriptText: transcript,
    transcriptLength: transcript.length,
    chunkCount: summaryResult.chunkCount,
    summaryText: summaryResult.summaryText,
    summaryStructured: summaryResult.summaryStructured,
    generatedAt: new Date().toISOString(),
  };
}

function parseYouTubeVideoId(url) {
  try {
    const parsed = new URL(url);
    const videoId = parsed.searchParams.get("v");
    if (!videoId) {
      throw new ExtensionError(
        ERROR_CODES.INVALID_VIDEO_URL,
        "YouTube URL 中未找到视频 ID。",
      );
    }
    return videoId;
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(
      ERROR_CODES.INVALID_VIDEO_URL,
      "Unable to parse YouTube URL.",
      error.message,
    );
  }
}

async function fetchYouTubeSubtitle(subtitleUrl) {
  let response;
  try {
    response = await fetch(subtitleUrl, {
      method: "GET",
      credentials: "include",
    });
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      "Failed to fetch YouTube subtitle.",
      error.message,
    );
  }

  if (!response.ok) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      `YouTube subtitle request failed: HTTP ${response.status}`,
      await safeText(response),
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      "YouTube subtitle response is not valid JSON.",
      error.message,
    );
  }

  if (!json || !Array.isArray(json.events)) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      "YouTube subtitle JSON is missing events[] field.",
    );
  }

  return json;
}

function buildYouTubeTranscript(data) {
  const events = Array.isArray(data.events) ? data.events : [];
  const lines = [];
  let lastText = "";
  let lastEndMs = 0;

  for (const event of events) {
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs
      .map((s) => String(s.utf8 || "").replace(/\n/g, " "))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === lastText) continue;

    const startMs = Number(event.tStartMs || 0);
    if (lines.length > 0 && startMs - lastEndMs >= 2500) {
      lines.push("");
    }
    lines.push(text);
    lastText = text;
    lastEndMs = startMs + Number(event.dDurationMs || 0);
  }

  const transcript = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!transcript) {
    throw new ExtensionError(
      ERROR_CODES.TRANSCRIPT_EMPTY,
      "YouTube subtitle has no usable text.",
    );
  }
  return transcript;
}

function parseVideoContext(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!match) {
      throw new ExtensionError(
        ERROR_CODES.INVALID_VIDEO_URL,
        "Invalid Bilibili video URL.",
      );
    }
    const bvid = match[1];
    const pageRaw = Number(parsed.searchParams.get("p") || "1");
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    return { bvid, page };
  } catch (error) {
    if (error instanceof ExtensionError) {
      throw error;
    }
    throw new ExtensionError(
      ERROR_CODES.INVALID_VIDEO_URL,
      "Unable to parse video URL.",
      error.message,
    );
  }
}

async function resolveCidByPage(bvid, page) {
  const endpoint = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
  const data = await fetchBilibiliApi(endpoint);
  const pages = Array.isArray(data) ? data : [];

  if (pages.length === 0) {
    throw new ExtensionError(
      ERROR_CODES.BILIBILI_API_FAILED,
      "No pages found for this BVID.",
    );
  }

  let selected = pages.find((item) => Number(item.page) === Number(page));
  if (!selected) {
    selected = pages[Math.max(0, Math.min(page - 1, pages.length - 1))];
  }
  if (!selected || !selected.cid) {
    throw new ExtensionError(
      ERROR_CODES.BILIBILI_API_FAILED,
      "Unable to resolve CID.",
    );
  }

  return {
    cid: selected.cid,
    page: selected.page || page,
    part: selected.part || "",
  };
}

async function resolveSubtitleMeta(bvid, cid, pageUrl) {
  const endpoint = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
  const data = await fetchBilibiliApi(endpoint, pageUrl);
  const subtitles = data?.subtitle?.subtitles;
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_NOT_FOUND,
      "No subtitle track found for this video.",
    );
  }

  const available = subtitles.filter((item) => String(item.subtitle_url || "").trim());
  if (available.length === 0) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_NOT_FOUND,
      "Subtitle tracks found but all URLs are empty.",
    );
  }

  const preferred = available.find((item) => {
    const lan = String(item.lan || "").toLowerCase();
    const doc = String(item.lan_doc || "").toLowerCase();
    return (
      lan.includes("zh") || doc.includes("chinese") || doc.includes("中文")
    );
  });

  return preferred || available[0];
}

async function fetchSubtitleFile(subtitleUrl) {
  const normalizedUrl = normalizeSubtitleUrl(subtitleUrl);
  let response;
  try {
    response = await fetch(normalizedUrl, {
      method: "GET",
      credentials: "omit",
      headers: {
        accept: "application/json, text/plain, */*",
        origin: "https://www.bilibili.com",
        referer: "https://www.bilibili.com/",
      },
    });
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      "Failed to fetch subtitle file.",
      error.message,
    );
  }

  if (!response.ok) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      `Subtitle request failed: HTTP ${response.status}`,
      await safeText(response),
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      "Subtitle file is not valid JSON.",
      error.message,
    );
  }

  if (!json || !Array.isArray(json.body)) {
    throw new ExtensionError(
      ERROR_CODES.SUBTITLE_PARSE_FAILED,
      "Subtitle JSON is missing body[] field.",
    );
  }

  return json;
}

function normalizeSubtitleUrl(url) {
  const raw = String(url || "").trim();
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return raw;
  }
  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }
  if (raw.startsWith("/")) {
    return `https://aisubtitle.hdslb.com${raw}`;
  }
  throw new ExtensionError(
    ERROR_CODES.SUBTITLE_PARSE_FAILED,
    "Invalid subtitle URL.",
  );
}

function buildTranscript(body) {
  const items = [...body].sort(
    (a, b) => Number(a.from || 0) - Number(b.from || 0),
  );
  const lines = [];
  let lastLine = "";
  let lastTo = 0;

  for (const item of items) {
    const line = normalizeLine(item?.content);
    if (!line) {
      continue;
    }
    if (line === lastLine) {
      continue;
    }

    const from = Number(item?.from || 0);
    const to = Number(item?.to || from);
    if (lines.length > 0 && from - lastTo >= 2.5) {
      lines.push("");
    }
    lines.push(line);
    lastLine = line;
    lastTo = to;
  }

  const transcript = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!transcript) {
    throw new ExtensionError(
      ERROR_CODES.TRANSCRIPT_EMPTY,
      "Subtitle body has no usable text.",
    );
  }
  return transcript;
}

function normalizeLine(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .replace(/[。]{2,}/g, "。")
    .replace(/[，]{2,}/g, "，")
    .trim();
}

async function generateSummary(transcript, title, settings) {
  if (!settings.aiEndpoint || !settings.aiModel || !settings.apiKey) {
    throw new ExtensionError(
      ERROR_CODES.AI_CONFIG_MISSING,
      "AI settings are incomplete. Configure endpoint, model, and key.",
    );
  }

  const finalPrompt = renderSummaryPrompt(
    settings.summaryPromptTemplate || DEFAULT_SETTINGS.summaryPromptTemplate,
    title || "未命名视频",
    transcript,
  );
  const summaryText = await callAiChat(settings, finalPrompt);
  const summaryStructured = parseStructuredSummary(summaryText);

  return {
    summaryText,
    summaryStructured,
    chunkCount: 1,
  };
}

function renderSummaryPrompt(template, title, transcript) {
  return String(template)
    .replaceAll("{{title}}", title)
    .replaceAll("{{transcript}}", transcript);
}

async function callAiChat(settings, userPrompt) {
  const baseEndpoint = String(settings.aiEndpoint).trim();
  const model = String(settings.aiModel).trim();
  const apiKey = String(settings.apiKey).trim();
  const url = `${baseEndpoint}/${model}:generateContent`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.2,
        },
        systemInstruction: {
          parts: [{ text: "你是一个严谨的视频字幕总结助手。" }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
      }),
    });
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.AI_REQUEST_FAILED,
      "Failed to call AI endpoint.",
      error.message,
    );
  }

  if (!response.ok) {
    throw new ExtensionError(
      ERROR_CODES.AI_REQUEST_FAILED,
      `AI request failed: HTTP ${response.status}`,
      await safeText(response),
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.AI_REQUEST_FAILED,
      "AI response is not JSON.",
      error.message,
    );
  }

  const parts = json?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find((p) => !p.thought && typeof p.text === "string");
  const text = textPart?.text || "";

  if (!text || typeof text !== "string") {
    throw new ExtensionError(
      ERROR_CODES.AI_REQUEST_FAILED,
      "AI response does not contain text.",
      json,
    );
  }

  return text.trim();
}

function parseStructuredSummary(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      theme: String(parsed.theme || "").trim(),
      background: String(parsed.background || "").trim(),
      key_points: normalizeStringArray(parsed.key_points),
      insights: normalizeStringArray(parsed.insights),
      conclusion: String(parsed.conclusion || "").trim(),
      follow_ups: normalizeStringArray(parsed.follow_ups),
    };
  } catch (_error) {
    return {
      theme: "",
      background: "",
      key_points: [],
      insights: [],
      conclusion: "",
      follow_ups: [],
    };
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

async function fetchBilibiliApi(url, referer) {
  const headers = { accept: "application/json, text/plain, */*" };
  if (referer) {
    headers.referer = referer;
  }
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers,
    });
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.BILIBILI_API_FAILED,
      "Failed to call Bilibili API.",
      error.message,
    );
  }

  if (!response.ok) {
    throw new ExtensionError(
      ERROR_CODES.BILIBILI_API_FAILED,
      `Bilibili API failed: HTTP ${response.status}`,
      await safeText(response),
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    throw new ExtensionError(
      ERROR_CODES.BILIBILI_API_FAILED,
      "Bilibili API returned invalid JSON.",
      error.message,
    );
  }

  if (Number(json?.code) !== 0) {
    throw new ExtensionError(
      ERROR_CODES.BILIBILI_API_FAILED,
      "Bilibili API returned non-zero code.",
      json,
    );
  }
  return json.data;
}

function normalizeError(error) {
  if (error instanceof ExtensionError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details || null,
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: error?.message || "Unknown error",
    details: null,
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (_error) {
    return "";
  }
}

async function getSettings() {
  const stored = await storageGet("sync", Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

function storageGet(area, keys) {
  return new Promise((resolve) => {
    chrome.storage[area].get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(area, value) {
  return new Promise((resolve) => {
    chrome.storage[area].set(value, () => resolve());
  });
}
