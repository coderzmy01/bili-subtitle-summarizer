# Bilibili Subtitle Summarizer (Chrome MV3)

Chrome extension that:

1. Fetches subtitle track metadata from Bilibili APIs.
2. Downloads subtitle JSON (`body[].content`).
3. Rebuilds a readable transcript.
4. Calls an AI endpoint for structured summary output.
5. Shows result in a sidebar with copy support.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `bili-subtitle-summarizer`.

## Configure

1. Open extension **Options** page.
2. Fill:
   - `AI Endpoint` (OpenAI-compatible `/v1/chat/completions`)
   - `Model`
   - `API Key`
3. Save.

## Use

1. Open a Bilibili video page (`https://www.bilibili.com/video/BV...`).
2. In the right sidebar, click **生成摘要**.
3. Wait for completion and click **复制摘要** if needed.

## Notes

- Current version only supports summary generation (no Q&A).
- If a video has no subtitles, extension will show an explicit error.
- API key is stored in `chrome.storage.sync`; avoid using high-risk keys in shared browsers.
