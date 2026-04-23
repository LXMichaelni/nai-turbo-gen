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
  const POLL_INTERVAL_MS = 80;
  const GENERATION_TIMEOUT_MS = 60000;
  const DEFAULT_POS = { top: 70, left: null };

  // ========= Bridge 常量 =========
  const BRIDGE_KEY = '__NAI_FAST_POLLER_BRIDGE__';
  const BRIDGE_STATE_EVENT = 'nai-fast-poller:state';
  const BRIDGE_LOGS_EVENT = 'nai-fast-poller:logs';
  const REACT_READY_EVENT = 'nai-fast-poller:react-ready';
  const REACT_PANEL_HOST_ID = 'nai-fast-poller-react-host';
  // 默认禁用开发态 React 注入，避免在真实站点页面自动执行本机 3000 端口代码。
  const REACT_DEV_PANEL_ENABLED = false;
  const REACT_DEV_SERVER_ORIGIN = 'http://127.0.0.1:3000';
  const REACT_DEV_CLIENT_PATH = '/@vite/client';
  const REACT_DEV_ENTRY_PATH = '/src/main.tsx';
  const REACT_DEV_BOOT_TIMEOUT_MS = 1500;
  const REACT_DEV_CLIENT_SCRIPT_ID = 'nai-fast-poller-vite-client';
  const REACT_DEV_ENTRY_SCRIPT_ID = 'nai-fast-poller-react-entry';
  const MAX_LOGS = 20;

  // ========= 工具：Web Worker 计时器 (保持原样) =========
  const workerBlob = new Blob([
    `
    self.onmessage = function(e) {
      const { id, ms } = e.data;
      setTimeout(() => self.postMessage({ id }), ms);
    };
  `,
  ], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(workerBlob);
  const timerWorker = new Worker(workerUrl);

  let _sleepId = 0;
  const _sleepCallbacks = new Map();
  timerWorker.onmessage = (e) => {
    const cb = _sleepCallbacks.get(e.data.id);
    if (cb) {
      _sleepCallbacks.delete(e.data.id);
      cb();
    }
  };

  const sleep = (ms) => new Promise((resolve) => {
    const id = ++_sleepId;
    _sleepCallbacks.set(id, resolve);
    timerWorker.postMessage({ id, ms });
  });

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || '未知异常');
  }

  function cloneSnapshot() {
    return {
      ...bridgeSnapshot,
      counts: { ...bridgeSnapshot.counts },
      logs: bridgeSnapshot.logs.map((log) => ({ ...log })),
    };
  }

  function dispatchBridgeEvent(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function emitBridgeState() {
    dispatchBridgeEvent(BRIDGE_STATE_EVENT, cloneSnapshot());
  }

  function emitBridgeLogs() {
    dispatchBridgeEvent(BRIDGE_LOGS_EVENT, cloneSnapshot());
  }

  function setSnapshot(patch) {
    bridgeSnapshot = {
      ...bridgeSnapshot,
      ...patch,
      counts: patch.counts ? { ...patch.counts } : bridgeSnapshot.counts,
      logs: patch.logs ? patch.logs.map((log) => ({ ...log })) : bridgeSnapshot.logs,
    };
    emitBridgeState();
  }

  function setCounts(patch) {
    bridgeSnapshot = {
      ...bridgeSnapshot,
      counts: {
        ...bridgeSnapshot.counts,
        ...patch,
      },
    };
    emitBridgeState();
  }

  function createBridgeLogEntry(type, message) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      time: new Date().toLocaleTimeString(),
      type,
      message,
    };
  }

  function appendBridgeLog(type, message) {
    const entry = createBridgeLogEntry(type, message);

    bridgeSnapshot = {
      ...bridgeSnapshot,
      logs: [...bridgeSnapshot.logs, entry].slice(-MAX_LOGS),
    };

    emitBridgeLogs();
    emitBridgeState();
  }

  function clearBridgeLogs() {
    bridgeSnapshot = {
      ...bridgeSnapshot,
      logs: [],
    };

    const container = document.getElementById('nai-raw-logs');
    if (container) {
      container.innerHTML = '';
    }

    const rateLimitPanel = document.getElementById('nai-fast-ratelimit');
    if (rateLimitPanel) {
      rateLimitPanel.style.display = 'none';
    }

    emitBridgeLogs();
    emitBridgeState();
  }

  function ensureReactPanelHost() {
    let host = document.getElementById(REACT_PANEL_HOST_ID);
    if (host) {
      host.style.position = 'fixed';
      host.style.zIndex = '100000';
      host.style.top = DEFAULT_POS.top + 'px';
      host.style.left = '24px';
      host.style.pointerEvents = 'none';
      return host;
    }

    host = document.createElement('div');
    host.id = REACT_PANEL_HOST_ID;
    host.style.position = 'fixed';
    host.style.zIndex = '100000';
    host.style.top = DEFAULT_POS.top + 'px';
    host.style.left = '24px';
    host.style.pointerEvents = 'none';
    document.body.appendChild(host);
    return host;
  }

  let reactPanelBootState = 'idle';
  let reactPanelBootPromise = null;
  let reactPanelBootStartedAt = 0;
  let reactReadyListenerAttached = false;
  let resolveReactReady = null;

  function hasReactBootTimedOut() {
    return reactPanelBootStartedAt > 0 && (Date.now() - reactPanelBootStartedAt) >= REACT_DEV_BOOT_TIMEOUT_MS;
  }

  function shouldShowLegacyPanelFallback() {
    if (reactPanelBootState === 'disabled' || reactPanelBootState === 'failed' || reactPanelBootState === 'fallback') {
      return true;
    }

    if (reactPanelBootState === 'ready' || reactPanelBootState === 'idle') {
      return false;
    }

    return hasReactBootTimedOut();
  }

  function getLegacyPanelElement() {
    return document.getElementById('nai-fast-poll-panel');
  }

  function attachReactReadyListener() {
    if (reactReadyListenerAttached) {
      return;
    }

    reactReadyListenerAttached = true;
    window.addEventListener(REACT_READY_EVENT, () => {
      if (typeof resolveReactReady === 'function') {
        const finishReady = resolveReactReady;
        resolveReactReady = null;
        finishReady();
      }
    });
  }

  function hideLegacyPanel() {
    const panel = getLegacyPanelElement();
    if (panel) {
      panel.style.display = 'none';
    }
  }

  function showLegacyPanel() {
    const panel = getLegacyPanelElement();
    if (panel) {
      panel.style.display = '';
    }
  }

  function setReactPanelBootState(nextState) {
    reactPanelBootState = nextState;

    if (nextState === 'booting') {
      reactPanelBootStartedAt = Date.now();
      return;
    }

    if (nextState === 'ready') {
      hideLegacyPanel();
      return;
    }

    if (nextState === 'disabled' || nextState === 'failed' || nextState === 'fallback') {
      showLegacyPanel();
    }
  }

  function injectModuleScript(scriptId, src, onLoad, onError) {
    let script = document.getElementById(scriptId);
    if (script) {
      const loaded = script.dataset.naiLoaded === 'true';
      const failed = script.dataset.naiFailed === 'true';

      if (loaded) {
        onLoad();
        return script;
      }

      if (failed) {
        onError();
        return script;
      }

      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      return script;
    }

    script = document.createElement('script');
    script.id = scriptId;
    script.type = 'module';
    script.src = src;
    script.dataset.naiLoaded = 'false';
    script.dataset.naiFailed = 'false';

    script.addEventListener('load', () => {
      script.dataset.naiLoaded = 'true';
      onLoad();
    }, { once: true });

    script.addEventListener('error', () => {
      script.dataset.naiFailed = 'true';
      onError();
    }, { once: true });

    document.head.appendChild(script);
    return script;
  }

  function ensureReactPanelBoot() {
    if (!REACT_DEV_PANEL_ENABLED) {
      setReactPanelBootState('disabled');
      return Promise.resolve('disabled');
    }

    attachReactReadyListener();
    ensureReactPanelHost();

    if (reactPanelBootState === 'ready') {
      hideLegacyPanel();
      return Promise.resolve('ready');
    }

    if (reactPanelBootState === 'disabled' || reactPanelBootState === 'failed' || reactPanelBootState === 'fallback') {
      return Promise.resolve(reactPanelBootState);
    }

    if (reactPanelBootPromise) {
      return reactPanelBootPromise;
    }

    setReactPanelBootState('booting');

    reactPanelBootPromise = new Promise((resolve) => {
      let settled = false;

      const finish = (nextState) => {
        if (settled) return;
        settled = true;
        resolveReactReady = null;
        reactPanelBootPromise = null;
        setReactPanelBootState(nextState);
        resolve(nextState);
      };

      const handleClientError = () => {
        finish('failed');
      };

      const handleEntryLoad = () => {
        resolveReactReady = () => {
          finish('ready');
        };
      };

      const handleEntryError = () => {
        finish('failed');
      };

      injectModuleScript(
        REACT_DEV_CLIENT_SCRIPT_ID,
        `${REACT_DEV_SERVER_ORIGIN}${REACT_DEV_CLIENT_PATH}`,
        () => {
          injectModuleScript(
            REACT_DEV_ENTRY_SCRIPT_ID,
            `${REACT_DEV_SERVER_ORIGIN}${REACT_DEV_ENTRY_PATH}`,
            handleEntryLoad,
            handleEntryError,
          );
        },
        handleClientError,
      );
    });

    return reactPanelBootPromise;
  }

  function renderStatus(text, type = 'info') {
    const el = document.getElementById('nai-fast-status');
    if (el) {
      el.textContent = `状态：${text}`;
      el.className = type;
    }
  }

  function setRuntimeState({ phase, statusText, statusType = 'info', lastError = null }) {
    renderStatus(statusText, statusType);
    setSnapshot({
      phase,
      statusText,
      statusType,
      lastError,
    });
  }

  function legacyAddRawLog(content) {
    const container = document.getElementById('nai-raw-logs');
    if (!container) return;

    const time = new Date().toLocaleTimeString();
    const logItem = document.createElement('div');
    const logTime = document.createElement('span');
    const spacer = document.createTextNode(' ');
    const logContent = document.createElement('code');

    logItem.className = 'log-item';
    logTime.className = 'log-time';
    logTime.textContent = `[${time}]`;
    logContent.className = 'log-content';
    logContent.textContent = content;

    logItem.append(logTime, spacer, logContent);
    container.insertBefore(logItem, container.firstChild);

    if (container.children.length > MAX_LOGS) {
      container.removeChild(container.lastChild);
    }

    const rateLimitPanel = document.getElementById('nai-fast-ratelimit');
    if (rateLimitPanel) {
      rateLimitPanel.style.display = 'block';
    }
  }

  function addTypedLog(type, message, legacyContent = null) {
    if (legacyContent) {
      legacyAddRawLog(legacyContent);
    }

    const counts = { ...bridgeSnapshot.counts };

    if (type === '429') {
      counts.c429 += 1;
    } else if (type === 'DOM') {
      counts.dom += 1;
    } else if (type === 'ERR') {
      counts.err += 1;
    }

    const entry = createBridgeLogEntry(type, message);

    bridgeSnapshot = {
      ...bridgeSnapshot,
      counts,
      logs: [...bridgeSnapshot.logs, entry].slice(-MAX_LOGS),
    };

    emitBridgeLogs();
    emitBridgeState();
  }

  function getGenerateButtonSnapshot(btn) {
    if (!btn) {
      return {
        generateButtonFound: false,
        generateButtonBusy: null,
      };
    }

    return {
      generateButtonFound: true,
      generateButtonBusy: isGenerateBusy(btn),
    };
  }

  function syncGenerateButtonSnapshot(btn = findGenerateButton()) {
    const next = getGenerateButtonSnapshot(btn);
    if (
      bridgeSnapshot.generateButtonFound !== next.generateButtonFound
      || bridgeSnapshot.generateButtonBusy !== next.generateButtonBusy
    ) {
      setSnapshot(next);
    }
    return btn;
  }

  let bridgeSnapshot = {
    engineReady: false,
    isPolling: false,
    phase: 'BOOTING',
    statusText: '等待 Generate 按钮...',
    statusType: 'info',
    pollIntervalMs: POLL_INTERVAL_MS,
    generationTimeoutMs: GENERATION_TIMEOUT_MS,
    generateButtonFound: false,
    generateButtonBusy: null,
    lastError: null,
    counts: {
      success: 0,
      c429: 0,
      dom: 0,
      err: 0,
    },
    logs: [],
  };

  window[BRIDGE_KEY] = {
    getSnapshot: () => cloneSnapshot(),
    startPolling: () => startPolling(),
    stopPolling: () => stopPolling(),
    clearLogs: () => clearBridgeLogs(),
  };

  emitBridgeState();
  emitBridgeLogs();

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
  const originFetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await originFetch(...args);
    if (res.status === 429) {
      try {
        const clone = res.clone();
        const rawBody = await clone.text();
        const message = rawBody || 'Empty 429 Body';
        addTypedLog('429', message, message);
      } catch (error) {
        const message = 'Error reading 429 body';
        addTypedLog('429', message, message);
      }
    }
    return res;
  };

  // 2. DOM 监控：截获弹窗内的原始文本
  function isOwnPanelNode(node) {
    return node instanceof Element && !!node.closest('#nai-fast-poll-panel, #nai-raw-logs, #nai-fast-poller-react-host');
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
      for (const mutation of mutations) {
        if (!mutation.addedNodes.length) continue;

        mutation.addedNodes.forEach((node) => {
          const text = getRelevantDomLogText(node);
          if (!text) return;

          addTypedLog('DOM', text, `[DOM] ${text}`);
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ========= 原始点击与等待逻辑 =========
  function findGenerateButton() {
    return Array.from(document.querySelectorAll('button'))
      .find((button) => (button.textContent || '').trim().toLowerCase().startsWith('generate')) || null;
  }

  function isGenerateBusy(btn) {
    if (!btn) return true;
    const text = (btn.textContent || '').toLowerCase();
    return !!btn.disabled || text.includes('cancelling');
  }

  async function waitForGeneration() {
    const interval = 100;
    const timeout = GENERATION_TIMEOUT_MS;
    let elapsed = 0;
    let hasStarted = false;

    while (elapsed < timeout) {
      const btn = syncGenerateButtonSnapshot();
      if (!btn) {
        throw new Error('Generate 按钮消失');
      }

      if (!isPolling) {
        return false;
      }

      const busy = isGenerateBusy(btn);
      if (!hasStarted) {
        if (bridgeSnapshot.phase !== 'STOPPING') {
          setRuntimeState({
            phase: 'WAITING_START',
            statusText: '等待生成开始...',
            statusType: 'info',
          });
        }
      }

      if (busy) {
        hasStarted = true;
        if (bridgeSnapshot.phase !== 'STOPPING') {
          setRuntimeState({
            phase: 'WAITING_FINISH',
            statusText: '等待生成完成...',
            statusType: 'info',
          });
        }
      }

      if (!busy && hasStarted) {
        return true;
      }

      await sleep(interval);
      elapsed += interval;
    }

    throw new Error('生成超时');
  }

  function applyReadyState() {
    if (
      bridgeSnapshot.isPolling
      || (
        bridgeSnapshot.phase === 'READY'
        && bridgeSnapshot.statusText === '准备就绪'
        && bridgeSnapshot.statusType === 'info'
        && bridgeSnapshot.lastError === null
      )
    ) {
      return;
    }

    setRuntimeState({
      phase: 'READY',
      statusText: '准备就绪',
      statusType: 'info',
      lastError: null,
    });
  }

  function applyBootingState() {
    if (
      bridgeSnapshot.isPolling
      || bridgeSnapshot.engineReady
      || (
        bridgeSnapshot.phase === 'BOOTING'
        && bridgeSnapshot.statusText === '等待 Generate 按钮...'
        && bridgeSnapshot.statusType === 'info'
        && bridgeSnapshot.lastError === null
      )
    ) {
      return;
    }

    setRuntimeState({
      phase: 'BOOTING',
      statusText: '等待 Generate 按钮...',
      statusType: 'info',
      lastError: null,
    });
  }

  function refreshIdleBridgeState() {
    const btn = syncGenerateButtonSnapshot();

    if (!btn) {
      applyBootingState();
      return null;
    }

    if (!bridgeSnapshot.engineReady) {
      setSnapshot({ engineReady: true });
      appendBridgeLog('INFO', 'Bridge 已连接到真实脚本');
    }

    applyReadyState();
    return btn;
  }

  function finalizeStoppedState() {
    syncGenerateButtonSnapshot();
    setBtnState(false);
    setSnapshot({ isPolling: false });
    setRuntimeState({
      phase: bridgeSnapshot.generateButtonFound ? 'READY' : 'BOOTING',
      statusText: '已停止',
      statusType: 'info',
      lastError: null,
    });
    appendBridgeLog('INFO', '轮询已停止');
  }

  function handlePollingError(error) {
    const message = getErrorMessage(error);
    addTypedLog('ERR', message);
    setRuntimeState({
      phase: 'ERROR',
      statusText: `异常：${message}`,
      statusType: 'error',
      lastError: message,
    });
  }

  function handleGenerationSuccess() {
    setCounts({ success: bridgeSnapshot.counts.success + 1 });
    appendBridgeLog('INFO', '成功完成一次生成');
    setRuntimeState({
      phase: 'RUNNING',
      statusText: '成功完成一次生成',
      statusType: 'info',
      lastError: null,
    });
  }

  function shouldWaitForGenerateButton(btn) {
    return !btn || isGenerateBusy(btn);
  }

  function updateWaitingForButtonState(btn) {
    setRuntimeState({
      phase: 'WAITING_START',
      statusText: btn ? '等待 Generate 按钮空闲...' : '等待 Generate 按钮出现...',
      statusType: 'info',
    });
  }

  function setClickingState() {
    setRuntimeState({
      phase: 'RUNNING',
      statusText: '已点击 Generate，准备等待...',
      statusType: 'info',
    });
  }

  function getPollingButton() {
    const btn = syncGenerateButtonSnapshot();

    if (shouldWaitForGenerateButton(btn)) {
      updateWaitingForButtonState(btn);
      return null;
    }

    return btn;
  }

  function settleAfterIdleTick() {
    if (!bridgeSnapshot.isPolling) {
      applyReadyState();
    }
  }

  function settleAfterMissingButtonTick() {
    if (!bridgeSnapshot.isPolling) {
      applyBootingState();
    }
  }

  function waitPollingInterval() {
    return sleep(POLL_INTERVAL_MS);
  }

  function waitErrorCooldown() {
    return sleep(200);
  }

  function isStopRequested() {
    return !isPolling || bridgeSnapshot.phase === 'STOPPING';
  }

  // ========= 轮询循环 (保持 80ms 节奏) =========
  let isPolling = false;

  async function startPolling() {
    if (isPolling) return;

    isPolling = true;
    initKeepAlive();
    setBtnState(true);
    setSnapshot({ isPolling: true });
    setRuntimeState({
      phase: 'RUNNING',
      statusText: '运行中：极速轮询中…',
      statusType: 'info',
      lastError: null,
    });
    appendBridgeLog('INFO', '已启动极速轮询');

    while (isPolling) {
      try {
        const btn = getPollingButton();

        if (!btn) {
          await waitPollingInterval();
          settleAfterMissingButtonTick();
          settleAfterIdleTick();
          continue;
        }

        setClickingState();
        btn.click();

        const didFinish = await waitForGeneration();
        if (isStopRequested()) {
          continue;
        }

        if (didFinish) {
          handleGenerationSuccess();
        }
      } catch (error) {
        if (isStopRequested()) {
          continue;
        }

        handlePollingError(error);
        await waitErrorCooldown();
      }
    }

    finalizeStoppedState();
  }

  function stopPolling() {
    if (!isPolling) return;
    setRuntimeState({
      phase: 'STOPPING',
      statusText: '停止中...',
      statusType: 'info',
      lastError: null,
    });
    appendBridgeLog('INFO', '收到停止指令');
    isPolling = false;
  }

  // ========= UI 布局 (针对长文本优化) =========
  function createUI() {
    const existingPanel = getLegacyPanelElement();
    if (existingPanel) {
      if (reactPanelBootState === 'ready') {
        hideLegacyPanel();
      } else {
        showLegacyPanel();
      }
      return existingPanel;
    }

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
    const pos = saved || { top: DEFAULT_POS.top, left: DEFAULT_POS.left ?? window.innerWidth - 245 };
    panel.style.top = pos.top + 'px';
    panel.style.left = pos.left + 'px';

    initDrag(panel);
    panel.querySelector('#nai-fast-toggle').onclick = () => (isPolling ? stopPolling() : startPolling());

    if (reactPanelBootState === 'ready') {
      hideLegacyPanel();
    }

    return panel;
  }

  function initDrag(panel) {
    const titleBar = panel.querySelector('.title');
    let dragging = false;
    let ox = 0;
    let oy = 0;

    titleBar.onmousedown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
      document.body.style.userSelect = 'none';
    };

    document.onmousemove = (e) => {
      if (!dragging) return;
      panel.style.left = e.clientX - ox + 'px';
      panel.style.top = e.clientY - oy + 'px';
    };

    document.onmouseup = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      GM_setValue('nai_panel_pos', { top: panel.offsetTop, left: panel.offsetLeft });
    };
  }

  function setBtnState(running) {
    const toggle = document.getElementById('nai-fast-toggle');
    if (toggle) {
      toggle.textContent = running ? '⏹️ 停止' : '▶️ 开始轮询';
    }
  }

  function setStatus(text, type = 'info') {
    renderStatus(text, type);
    setSnapshot({
      statusText: text,
      statusType: type,
    });
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
    let observerStarted = false;

    setInterval(() => {
      const btn = refreshIdleBridgeState();

      if (!btn) {
        return;
      }

      ensureReactPanelBoot();

      if (shouldShowLegacyPanelFallback()) {
        createUI();
      } else if (reactPanelBootState === 'ready') {
        hideLegacyPanel();
      }

      if (!observerStarted) {
        observerStarted = true;
        initGlobalObserver();
      }
    }, 500);
  })();
})();
