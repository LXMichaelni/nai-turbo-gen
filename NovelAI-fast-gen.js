// ==UserScript==
// @name         NovelAI 极速轮询 v2.6 (原始响应捕获版)
// @namespace    http://tampermonkey.net/
// @version      0.2.6
// @description  直接截获并显示 429 响应的原始内容，不做分类，不干预轮询逻辑，支持后台保活。
// @author       vvd
// @match        https://novelai.net/image
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // ========= 原始配置 =========
  const POLL_INTERVAL_MS = 80;          // 轮询间隔 80ms
  const GENERATION_TIMEOUT_MS = 60000; // 超时设置 60s
  const DEFAULT_POS = { top: 70, left: null };

  // ========= 工具：Web Worker 计时器 (保持原样) =========
  const workerBlob = new Blob([`
    self.onmessage = function(e) {
      const { id, ms } = e.data;
      setTimeout(() => self.postMessage({ id }), ms);
    };
  `], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const timerWorker = new Worker(workerUrl);

  let _sleepId = 0;
  const _sleepCallbacks = new Map();
  timerWorker.onmessage = (e) => {
    const cb = _sleepCallbacks.get(e.data.id);
    if (cb) { _sleepCallbacks.delete(e.data.id); cb(); }
  };

  const sleep = (ms) => new Promise((resolve) => {
    const id = ++_sleepId;
    _sleepCallbacks.set(id, resolve);
    timerWorker.postMessage({ id, ms });
  });

  // ========= 保活：Web Audio API =========
  let audioCtx = null;
  function initKeepAlive() {
    if (audioCtx) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioContextClass();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
    } catch (e) {}
  }

  // ========= 核心：原始信息截获逻辑 =========
  function addRawLog(content) {
    const container = document.getElementById('nai-raw-logs');
    if (!container) return;

    const time = new Date().toLocaleTimeString();
    const logItem = document.createElement('div');
    logItem.className = 'log-item';
    logItem.innerHTML = `<span class="log-time">[${time}]</span> <code class="log-content">${content}</code>`;
    
    // 插入到最前面
    container.insertBefore(logItem, container.firstChild);
    
    // 限制显示数量，防止 DOM 过重
    if (container.children.length > 20) {
      container.removeChild(container.lastChild);
    }

    document.getElementById('nai-fast-ratelimit').style.display = 'block';
  }

  // 1. 网络拦截：直接截获原始 Body 内容
  const originFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await originFetch(...args);
    if (res.status === 429) {
      try {
        const clone = res.clone();
        const rawBody = await clone.text();
        addRawLog(rawBody || "Empty 429 Body");
      } catch (e) {
        addRawLog("Error reading 429 body");
      }
    }
    return res;
  };

  // 2. DOM 监控：截获弹窗内的原始文本
  function isOwnPanelNode(node) {
    return node instanceof Element && !!node.closest('#nai-fast-poll-panel, #nai-raw-logs');
  }

  function getRelevantDomLogText(node) {
    if (!(node instanceof Element) || isOwnPanelNode(node)) return '';

    const text = (node.innerText || '').trim();
    if (!text) return '';

    const lowerText = text.toLowerCase();
    const is429Text = /(^|\D)429(\D|$)/.test(lowerText);
    const isRateLimitText = lowerText.includes('rate limit') || lowerText.includes('too many requests');

    return (is429Text || isRateLimitText) ? text : '';
  }

  function initGlobalObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length) {
          m.addedNodes.forEach(node => {
            const text = getRelevantDomLogText(node);
            if (text) {
              addRawLog(`[DOM] ${text}`);
            }
          });
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ========= 原始点击与等待逻辑 =========
  function findGenerateButton() {
    return Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').trim().toLowerCase().startsWith('generate')) || null;
  }

  function isGenerateBusy(btn) {
    if (!btn) return true;
    const t = (btn.textContent || '').toLowerCase();
    return !!btn.disabled || t.includes('cancelling');
  }

  async function waitForGeneration() {
    const interval = 100;
    const timeout = GENERATION_TIMEOUT_MS;
    let elapsed = 0;
    let hasStarted = false;

    while (elapsed < timeout) {
      const btn = findGenerateButton();
      if (!btn) throw new Error('Generate 按钮消失');
      if (btn.disabled || (btn.textContent || '').toLowerCase().includes('cancelling')) {
        hasStarted = true;
      }
      if (!btn.disabled && hasStarted) return;
      await sleep(interval);
      elapsed += interval;
    }
    throw new Error('生成超时');
  }

  // ========= 轮询循环 (保持 80ms 节奏) =========
  let isPolling = false;

  async function startPolling() {
    if (isPolling) return;
    isPolling = true;
    initKeepAlive();
    setStatus('运行中：极速轮询中…', 'info');
    setBtnState(true);

    while (isPolling) {
      try {
        const btn = findGenerateButton();
        if (!btn || isGenerateBusy(btn)) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        btn.click();
        await waitForGeneration();
      } catch (e) {
        setStatus(`异常：${e.message}`, 'error');
        await sleep(200);
      }
    }

    setStatus('已停止', 'info');
    setBtnState(false);
  }

  function stopPolling() { isPolling = false; }

  // ========= UI 布局 (针对长文本优化) =========
  function createUI() {
    const panel = document.createElement('div');
    panel.id = 'nai-fast-poll-panel';
    panel.innerHTML = `
      <div class="title">NAI 极速轮询 v2.6 (原始捕获)</div>
      <button id="nai-fast-toggle">▶️ 开始轮询</button>
      <div id="nai-fast-ratelimit" style="display:none">
        <div style="font-size:10px; opacity:0.8; margin-bottom:4px;">最近截获的原始消息：</div>
        <div id="nai-raw-logs"></div>
      </div>
      <div id="nai-fast-status">状态：准备就绪</div>
    `;
    document.body.appendChild(panel);

    const saved = GM_getValue('nai_panel_pos', null);
    const pos = saved || { top: 70, left: window.innerWidth - 245 };
    panel.style.top = pos.top + 'px';
    panel.style.left = pos.left + 'px';

    initDrag(panel);
    panel.querySelector('#nai-fast-toggle').onclick = () => isPolling ? stopPolling() : startPolling();
  }

  function initDrag(panel) {
    const titleBar = panel.querySelector('.title');
    let dragging = false, ox = 0, oy = 0;
    titleBar.onmousedown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
      document.body.style.userSelect = 'none';
    };
    document.onmousemove = (e) => { if (dragging) { panel.style.left = (e.clientX - ox) + 'px'; panel.style.top = (e.clientY - oy) + 'px'; } };
    document.onmouseup = () => { if (dragging) { dragging = false; document.body.style.userSelect = ''; GM_setValue('nai_panel_pos', { top: panel.offsetTop, left: panel.offsetLeft }); } };
  }

  function setBtnState(running) {
    const toggle = document.getElementById('nai-fast-toggle');
    if (toggle) toggle.textContent = running ? '⏹️ 停止' : '▶️ 开始轮询';
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById('nai-fast-status');
    if (el) { el.textContent = `状态：${text}`; el.className = type; }
  }

  GM_addStyle(`
    #nai-fast-poll-panel{ position:fixed; z-index:99999; width:230px; background:#1c1f26; color:#c8ccd4; border:1px solid #3a414f; border-radius:12px; font-family:sans-serif; padding:12px; display:flex; flex-direction:column; gap:10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
    #nai-fast-poll-panel .title{ font-weight:700; color:#82aaff; font-size:13px; border-bottom:1px solid #3a414f; padding-bottom:8px; cursor:move; }
    #nai-fast-toggle{ background:#82aaff; color:#fff; font-weight:700; padding:10px; border:none; border-radius:8px; cursor:pointer; }
    #nai-fast-status{ font-size:11px; padding:6px; background:#282c34; border-radius:8px; text-align:center; }
    #nai-fast-ratelimit{ font-size:11px; padding:8px; background:#2d1a1a; border:1px solid #e06c75; border-radius:8px; color:#e06c75; }
    #nai-raw-logs{ max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; scrollbar-width: thin; }
    .log-item{ font-size: 10px; padding: 4px; background: rgba(0,0,0,0.2); border-radius: 4px; word-break: break-all; border-left: 2px solid #e06c75; }
    .log-time{ color: #abb2bf; margin-right: 4px; font-weight: bold; }
    .log-content{ color: #e06c75; }
  `);

  (function init() {
    const itv = setInterval(() => {
      if (findGenerateButton()) {
        clearInterval(itv);
        createUI();
        initGlobalObserver();
      }
    }, 500);
  })();
})();