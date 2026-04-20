# nai-turbo-gen

> Tampermonkey userscript that auto-clicks the **Generate** button on [NovelAI Image](https://novelai.net/image) at maximum speed — zero cooldown between generations.

## Features

- **Instant polling** — detects the Generate button becoming clickable within ~80ms
- **Zero cooldown** — clicks immediately after the previous generation completes, no random wait
- **Two-phase state machine** — reliably waits for generation to start *and* finish before the next click
- **Timeout protection** — 120s per-generation timeout prevents infinite hangs
- **Minimal floating UI** — dark-themed control panel with start/stop toggle and live status
- **Error resilience** — catches exceptions and continues polling automatically

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome / Edge / Firefox)
2. Create a new userscript and paste the contents of [`NovelAI-fast-gen.js`](./NovelAI-fast-gen.js)
3. Navigate to <https://novelai.net/image>
4. The floating panel appears once the Generate button is detected

## Usage

| Action | Effect |
|--------|--------|
| Click **▶️ Start** | Begin auto-generation loop |
| Click **⏹️ Stop** | Gracefully stop after current generation |

The status bar shows real-time state: waiting, running, errors, or stopped.

## Configuration

Edit the constants at the top of the script:

```javascript
const POLL_INTERVAL_MS = 80;          // Polling interval (ms) — lower = faster, 50-120 recommended
const GENERATION_TIMEOUT_MS = 120000; // Max wait per generation (ms)
const UI_TOP = '70px';                // Panel position from top
const UI_RIGHT = '25px';             // Panel position from right
```

## How It Works

```
┌─────────────────────────────────────────────────┐
│                  Polling Loop                     │
│                                                   │
│  1. Find Generate button (querySelectorAll)       │
│  2. Check if busy (disabled / "cancelling")       │
│  3. If ready → click immediately                  │
│  4. Wait for generation to complete:              │
│     Phase 1: button becomes disabled (started)    │
│     Phase 2: button re-enables (finished)         │
│  5. Loop back to step 1 — no delay               │
└─────────────────────────────────────────────────┘
```

## Requirements

- Tampermonkey (or compatible userscript manager)
- Active NovelAI subscription with image generation access

## License

MIT
