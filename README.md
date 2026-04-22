# nai-turbo-gen

> Single-file Tampermonkey userscript for [NovelAI Image](https://novelai.net/image) that auto-clicks **Generate** with near-zero idle time between runs.

## Features

- **Fast Generate polling** — checks the page frequently and clicks Generate as soon as it becomes available
- **Two-phase wait logic** — waits for generation to actually start, then waits for it to finish before the next click
- **Floating control panel** — start/stop toggle, live status, and recent 429 logs
- **Raw 429 response capture** — records the original `fetch` 429 response body when available
- **DOM text monitoring** — also watches page text for `429` / `limit` messages and logs the raw text
- **Background-tab friendly timing** — uses a Web Worker timer to reduce throttling impact
- **Web Audio keep-alive** — initializes a silent audio context to help keep polling responsive in background tabs
- **Draggable panel with saved position** — panel position is persisted with Tampermonkey storage

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Create a new userscript
3. Paste the contents of [`NovelAI-fast-gen.js`](./NovelAI-fast-gen.js)
4. Open <https://novelai.net/image>
5. Wait for the floating panel to appear after the page detects the **Generate** button

## Usage

| Action | Effect |
|--------|--------|
| Click **Start** | Begin the polling loop |
| Click **Stop** | Stop the loop after the current wait cycle |

The panel shows the current status and, when rate limiting is detected, the latest raw 429-related messages.

## Configuration

Edit the constants near the top of the script:

```javascript
const POLL_INTERVAL_MS = 80;
const GENERATION_TIMEOUT_MS = 60000;
const DEFAULT_POS = { top: 70, left: null };
```

Notes:

- `POLL_INTERVAL_MS` controls the main polling interval
- `GENERATION_TIMEOUT_MS` sets the maximum wait time for one generation cycle
- `DEFAULT_POS` is only the fallback panel position; after you drag the panel, the saved position in Tampermonkey storage is used instead

## How It Works

1. Find the **Generate** button on the NovelAI Image page
2. Wait until the button is clickable
3. Click immediately
4. Wait for generation to start
5. Wait for generation to finish
6. Repeat without adding an extra cooldown

At the same time, the script monitors both network responses and page text so recent 429 / limit messages can be shown in the panel.

## Requirements

- Tampermonkey or a compatible userscript manager
- Access to NovelAI Image generation

## License

MIT
