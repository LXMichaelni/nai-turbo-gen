// ==UserScript==
// @name         NovelAI 极速轮询点击生图按钮
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  在 https://novelai.net/image 页面极速轮询检测 Generate（生图）按钮：一旦可点立刻点击，等待生成结束后继续下一轮。无随机等待，最大化点击速率。
// @author       vvd
// @match        https://novelai.net/image
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // ========= 配置 =========
  const POLL_INTERVAL_MS = 80;     // 轮询间隔（越小越快，但太小会卡；50-120ms比较稳）
  const GENERATION_TIMEOUT_MS = 120000; // 单次生成最长等待（ms）；超时会继续轮询
  const DEFAULT_POS = { top: 70, left: null }; // left 为 null 时按视口宽度计算默认值

  // ========= Web Worker 计时器（绕过后台标签页节流）=========
  // 浏览器对后台标签页的 setTimeout 会节流到 1s 甚至 60s，
  // 但 Web Worker 内的 setTimeout 不受此限制。
  const workerBlob = new Blob([`
    self.onmessage = function(e) {
      const { id, ms } = e.data;
      setTimeout(() => self.postMessage({ id }), ms);
    };
  `], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const timerWorker = new Worker(workerUrl);

  // 用递增 ID 管理多个并发 sleep
  let _sleepId = 0;
  const _sleepCallbacks = new Map();

  timerWorker.onmessage = (e) => {
    const cb = _sleepCallbacks.get(e.data.id);
    if (cb) {
      _sleepCallbacks.delete(e.data.id);
      cb();
    }
  };

  // ========= 工具 =========
  /** 不受后台节流影响的 sleep */
  const sleep = (ms) => new Promise((resolve) => {
    const id = ++_sleepId;
    _sleepCallbacks.set(id, resolve);
    timerWorker.postMessage({ id, ms });
  });

  // ========= 429 Rate Limited 检测（MutationObserver 被动监听）=========
  // NovelAI 的错误提示是类似 toast 的弹窗，动态插入 DOM 后自动消失。
  // 用 MutationObserver 监听新增节点，匹配 "429" + "Rate limited" 文本。
  // 仅检测速率限流（429 Rate limited），不匹配其他类型的 429。
  let isRateLimited = false;
  let rateLimitCount = 0;

  function updateRateLimitDisplay() {
    const el = document.getElementById('nai-fast-ratelimit');
    if (!el) return;
    if (rateLimitCount > 0) {
      el.textContent = `⚠️ 429 Rate Limited ×${rateLimitCount}`;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }

  function initRateLimitDetector() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const text = node.textContent || '';
          // 必须同时包含 429 和 Rate limited
          if (text.includes('429') && text.includes('Rate limited')) {
            isRateLimited = true;
            rateLimitCount++;
            updateRateLimitDisplay();
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ========= 核心：找按钮 =========
  function findGenerateButton() {
    // NovelAI 页面按钮文字一般以 Generate 开头
    return Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').trim().toLowerCase().startsWith('generate')) || null;
  }

  function isGenerateBusy(btn) {
    if (!btn) return true;
    const t = (btn.textContent || '').toLowerCase();
    // 复用你原脚本的判断：disabled 或 cancelling
    return !!btn.disabled || t.includes('cancelling');
  }

  // ========= 等待一次生成结束（按钮先变灰，再恢复可点）=========
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

  // ========= 轮询循环 =========
  let isPolling = false;

  async function startPolling() {
    if (isPolling) return;
    isPolling = true;
    setStatus('运行中：极速轮询点击 Generate…', 'info');
    setBtnState(true);

    while (isPolling) {
      try {
        const btn = findGenerateButton();
        if (!btn) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        if (isGenerateBusy(btn)) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        // 一旦可点：立刻点击
        btn.click();

        // 等待这次生成结束（避免连点导致队列异常）
        await waitForGeneration();

        // 立刻进入下一轮（无任何冷却）
      } catch (e) {
        setStatus(`异常：${e.message}（继续轮询）`, 'error');
        await sleep(200);
      }
    }

    setStatus('已停止', 'info');
    setBtnState(false);
  }

  function stopPolling() {
    isPolling = false;
  }

  // ========= 简易 UI =========
  function createUI() {
    const panel = document.createElement('div');
    panel.id = 'nai-fast-poll-panel';
    panel.innerHTML = `
      <div class="title">极速生图轮询</div>
      <button id="nai-fast-toggle">▶️ 开始</button>
      <div id="nai-fast-ratelimit" style="display:none"></div>
      <div id="nai-fast-status">状态：等待</div>
    `;
    document.body.appendChild(panel);

    // 读取持久化位置，无则使用默认值（right:25px 等价的 left）
    const panelWidth = 220; // 与 CSS 中 width 一致
    const defaultLeft = window.innerWidth - panelWidth - 25;
    const savedPos = GM_getValue('nai_panel_pos', null);
    const pos = savedPos || { top: DEFAULT_POS.top, left: defaultLeft };

    // 边界修正（防止保存的位置在当前视口外）
    pos.top = clampTop(pos.top, panel);
    pos.left = clampLeft(pos.left, panel);

    panel.style.top = pos.top + 'px';
    panel.style.left = pos.left + 'px';

    // 绑定拖拽
    initDrag(panel);

    const toggle = panel.querySelector('#nai-fast-toggle');
    toggle.addEventListener('click', () => {
      if (isPolling) stopPolling();
      else startPolling();
    });
  }

  // ========= 拖拽逻辑 =========
  /** 限制 top 不超出视口 */
  function clampTop(top, panel) {
    const maxTop = window.innerHeight - (panel.offsetHeight || 120);
    return Math.max(0, Math.min(top, maxTop));
  }

  /** 限制 left 不超出视口 */
  function clampLeft(left, panel) {
    const maxLeft = window.innerWidth - (panel.offsetWidth || 220);
    return Math.max(0, Math.min(left, maxLeft));
  }

  function initDrag(panel) {
    const titleBar = panel.querySelector('.title');
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    titleBar.addEventListener('mousedown', (e) => {
      // 仅左键触发拖拽
      if (e.button !== 0) return;
      isDragging = true;
      offsetX = e.clientX - panel.offsetLeft;
      offsetY = e.clientY - panel.offsetTop;
      // 拖拽期间禁止文本选中
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const newLeft = clampLeft(e.clientX - offsetX, panel);
      const newTop = clampTop(e.clientY - offsetY, panel);
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      document.body.style.userSelect = '';
      // 持久化当前位置
      GM_setValue('nai_panel_pos', {
        top: parseInt(panel.style.top, 10),
        left: parseInt(panel.style.left, 10),
      });
    });
  }

  function setBtnState(running) {
    const toggle = document.getElementById('nai-fast-toggle');
    if (!toggle) return;
    toggle.textContent = running ? '⏹️ 停止' : '▶️ 开始';
    toggle.className = running ? 'running' : '';
  }

  function setStatus(text, type = 'info') {
    const el = document.getElementById('nai-fast-status');
    if (!el) return;
    el.textContent = `状态：${text}`;
    el.className = type;
  }

  GM_addStyle(`
    #nai-fast-poll-panel{
      position:fixed; z-index:99999; width:220px;
      background:#1c1f26; color:#c8ccd4;
      border:1px solid #3a414f; border-radius:12px;
      font-family:sans-serif; padding:12px;
      display:flex; flex-direction:column; gap:10px;
    }
    #nai-fast-poll-panel .title{
      font-weight:700; color:#82aaff; font-size:14px;
      border-bottom:1px solid #3a414f; padding-bottom:8px;
      cursor:move; /* 提示可拖拽 */
    }
    #nai-fast-toggle{
      background:#82aaff; color:#fff; font-weight:700;
      padding:10px; border:none; border-radius:8px;
      cursor:pointer;
    }
    #nai-fast-toggle.running{ background:#e06c75; }
    #nai-fast-status{
      font-size:12px; padding:8px; background:#282c34;
      border-radius:8px; text-align:center;
    }
    #nai-fast-status.error{ color:#e06c75; border:1px solid #e06c75; }
    #nai-fast-ratelimit{
      font-size:12px; padding:6px 8px; background:#3d2020;
      border:1px solid #e06c75; border-radius:8px;
      color:#e06c75; font-weight:700; text-align:center;
    }
  `);

  // ========= 初始化：等页面出现 Generate 按钮再挂 UI =========
  (function waitForNAI() {
    const itv = setInterval(() => {
      if (findGenerateButton()) {
        clearInterval(itv);
        createUI();
        initRateLimitDetector();
        setStatus('等待（检测到 Generate 按钮）', 'info');
      }
    }, 500);
  })();
})();
