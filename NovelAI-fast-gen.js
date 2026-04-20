// ==UserScript==
// @name         NovelAI 极速轮询点击生图按钮
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  在 https://novelai.net/image 页面极速轮询检测 Generate（生图）按钮：一旦可点立刻点击，等待生成结束后继续下一轮。无随机等待，最大化点击速率。
// @author       vvd
// @match        https://novelai.net/image
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  // ========= 配置 =========
  const POLL_INTERVAL_MS = 80;     // 轮询间隔（越小越快，但太小会卡；50-120ms比较稳）
  const GENERATION_TIMEOUT_MS = 120000; // 单次生成最长等待（ms）；超时会继续轮询
  const UI_TOP = '70px';
  const UI_RIGHT = '25px';

  // ========= 工具 =========
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      <div id="nai-fast-status">状态：等待</div>
    `;
    document.body.appendChild(panel);

    const toggle = panel.querySelector('#nai-fast-toggle');
    toggle.addEventListener('click', () => {
      if (isPolling) stopPolling();
      else startPolling();
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
      position:fixed; top:${UI_TOP}; right:${UI_RIGHT};
      z-index:99999; width:220px;
      background:#1c1f26; color:#c8ccd4;
      border:1px solid #3a414f; border-radius:12px;
      font-family:sans-serif; padding:12px;
      display:flex; flex-direction:column; gap:10px;
    }
    #nai-fast-poll-panel .title{
      font-weight:700; color:#82aaff; font-size:14px;
      border-bottom:1px solid #3a414f; padding-bottom:8px;
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
  `);

  // ========= 初始化：等页面出现 Generate 按钮再挂 UI =========
  (function waitForNAI() {
    const itv = setInterval(() => {
      if (findGenerateButton()) {
        clearInterval(itv);
        createUI();
        setStatus('等待（检测到 Generate 按钮）', 'info');
      }
    }, 500);
  })();
})();
