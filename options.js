"use strict";

const DEFAULT_SETTINGS = {
  aiEndpoint: "https://api.aigocode.com",
  aiModel: "gemini-3-pro-preview",
  apiKey: "sk-8b8069ecad1d65ec2bd3298780c75e8df06878905c47c8176199dfedcaf0db84",
  maxChunkChars: 6500,
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

const inputEndpoint = document.getElementById("ai-endpoint");
const inputModel = document.getElementById("ai-model");
const inputApiKey = document.getElementById("api-key");
const inputMaxChunk = document.getElementById("max-chunk-chars");
const inputPromptTemplate = document.getElementById("prompt-template");
const saveBtn = document.getElementById("save-btn");
const resetBtn = document.getElementById("reset-btn");
const statusNode = document.getElementById("status");

init();

async function init() {
  bindEvents();
  await loadSettings();
}

function bindEvents() {
  saveBtn.addEventListener("click", onSave);
  resetBtn.addEventListener("click", onReset);
}

async function loadSettings() {
  const data = await storageGet(Object.keys(DEFAULT_SETTINGS));
  const settings = { ...DEFAULT_SETTINGS, ...data };
  inputEndpoint.value = settings.aiEndpoint;
  inputModel.value = settings.aiModel;
  inputApiKey.value = settings.apiKey;
  inputMaxChunk.value = String(settings.maxChunkChars);
  inputPromptTemplate.value = settings.summaryPromptTemplate;
}

async function onSave() {
  const payload = {
    aiEndpoint: inputEndpoint.value.trim(),
    aiModel: inputModel.value.trim(),
    apiKey: inputApiKey.value.trim(),
    maxChunkChars: Number(
      inputMaxChunk.value || DEFAULT_SETTINGS.maxChunkChars,
    ),
    summaryPromptTemplate: inputPromptTemplate.value.trim(),
  };

  if (
    !payload.aiEndpoint ||
    !payload.aiModel ||
    !payload.summaryPromptTemplate
  ) {
    setStatus("请先补全 Endpoint、Model、Prompt。", true);
    return;
  }
  if (!Number.isFinite(payload.maxChunkChars) || payload.maxChunkChars < 1000) {
    setStatus("Max Chunk Chars 至少为 1000。", true);
    return;
  }

  await storageSet(payload);
  setStatus("配置已保存。");
}

async function onReset() {
  inputEndpoint.value = DEFAULT_SETTINGS.aiEndpoint;
  inputModel.value = DEFAULT_SETTINGS.aiModel;
  inputApiKey.value = DEFAULT_SETTINGS.apiKey;
  inputMaxChunk.value = String(DEFAULT_SETTINGS.maxChunkChars);
  inputPromptTemplate.value = DEFAULT_SETTINGS.summaryPromptTemplate;
  await storageSet(DEFAULT_SETTINGS);
  setStatus("已恢复默认配置。");
}

function setStatus(text, isError) {
  statusNode.textContent = text || "";
  statusNode.style.color = isError ? "#be3f3f" : "#607094";
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(value, () => resolve());
  });
}
