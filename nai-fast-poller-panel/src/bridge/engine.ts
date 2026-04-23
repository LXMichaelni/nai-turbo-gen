export type EnginePhase =
  | 'BOOTING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_START'
  | 'WAITING_FINISH'
  | 'STOPPING'
  | 'ERROR';

export type EngineStatusType = 'info' | 'error';

export type EngineLogType = 'INFO' | 'DOM' | '429' | 'ERR';

export interface EngineLogEntry {
  id: string;
  time: string;
  type: EngineLogType;
  message: string;
}

export interface EngineCounts {
  success: number;
  c429: number;
  dom: number;
  err: number;
}

export interface EngineSnapshot {
  engineReady: boolean;
  isPolling: boolean;
  phase: EnginePhase;
  statusText: string;
  statusType: EngineStatusType;
  pollIntervalMs: number;
  generationTimeoutMs: number;
  generateButtonFound: boolean;
  generateButtonBusy: boolean | null;
  lastError: string | null;
  counts: EngineCounts;
  logs: EngineLogEntry[];
}

export interface FastPollerBridge {
  getSnapshot: () => EngineSnapshot;
  startPolling: () => void | Promise<void>;
  stopPolling: () => void;
  clearLogs: () => void;
}

export const FAST_POLLER_BRIDGE_KEY = '__NAI_FAST_POLLER_BRIDGE__';
export const FAST_POLLER_STATE_EVENT = 'nai-fast-poller:state';
export const FAST_POLLER_LOGS_EVENT = 'nai-fast-poller:logs';

const DISCONNECTED_STATUS = '脚本未接入 / Bridge Disconnected';

const ENGINE_PHASE_ALLOWLIST: readonly EnginePhase[] = [
  'BOOTING',
  'READY',
  'RUNNING',
  'WAITING_START',
  'WAITING_FINISH',
  'STOPPING',
  'ERROR',
];
const ENGINE_STATUS_TYPE_ALLOWLIST: readonly EngineStatusType[] = ['info', 'error'];
const ENGINE_LOG_TYPE_ALLOWLIST: readonly EngineLogType[] = ['INFO', 'DOM', '429', 'ERR'];

const fallbackSnapshot: EngineSnapshot = {
  engineReady: false,
  isPolling: false,
  phase: 'ERROR',
  statusText: DISCONNECTED_STATUS,
  statusType: 'error',
  pollIntervalMs: 0,
  generationTimeoutMs: 0,
  generateButtonFound: false,
  generateButtonBusy: null,
  lastError: DISCONNECTED_STATUS,
  counts: {
    success: 0,
    c429: 0,
    dom: 0,
    err: 0,
  },
  logs: [],
};

let cachedSnapshot: EngineSnapshot = cloneFallbackSnapshot();
let hasCachedSnapshot = false;

declare global {
  interface Window {
    __NAI_FAST_POLLER_BRIDGE__?: FastPollerBridge;
  }
}

function cloneFallbackSnapshot(): EngineSnapshot {
  return {
    ...fallbackSnapshot,
    counts: { ...fallbackSnapshot.counts },
    logs: [...fallbackSnapshot.logs],
  };
}

function getBridge(): FastPollerBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const bridge = window[FAST_POLLER_BRIDGE_KEY as '__NAI_FAST_POLLER_BRIDGE__'];
  if (
    !bridge ||
    typeof bridge.getSnapshot !== 'function' ||
    typeof bridge.startPolling !== 'function' ||
    typeof bridge.stopPolling !== 'function' ||
    typeof bridge.clearLogs !== 'function'
  ) {
    return null;
  }

  return bridge;
}

function normalizeSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
  return {
    engineReady: Boolean(snapshot?.engineReady),
    isPolling: Boolean(snapshot?.isPolling),
    phase: ENGINE_PHASE_ALLOWLIST.includes(snapshot?.phase as EnginePhase)
      ? snapshot.phase
      : 'ERROR',
    statusText: snapshot?.statusText ?? DISCONNECTED_STATUS,
    statusType: ENGINE_STATUS_TYPE_ALLOWLIST.includes(snapshot?.statusType as EngineStatusType)
      ? snapshot.statusType
      : 'error',
    pollIntervalMs: Number(snapshot?.pollIntervalMs ?? 0),
    generationTimeoutMs: Number(snapshot?.generationTimeoutMs ?? 0),
    generateButtonFound: Boolean(snapshot?.generateButtonFound),
    generateButtonBusy:
      typeof snapshot?.generateButtonBusy === 'boolean' ? snapshot.generateButtonBusy : null,
    lastError: snapshot?.lastError ?? null,
    counts: {
      success: Number(snapshot?.counts?.success ?? 0),
      c429: Number(snapshot?.counts?.c429 ?? 0),
      dom: Number(snapshot?.counts?.dom ?? 0),
      err: Number(snapshot?.counts?.err ?? 0),
    },
    logs: Array.isArray(snapshot?.logs)
      ? snapshot.logs.map((log) => ({
          id: String(log.id),
          time: String(log.time),
          type: ENGINE_LOG_TYPE_ALLOWLIST.includes(log?.type as EngineLogType) ? log.type : 'ERR',
          message: String(log.message),
        }))
      : [],
  };
}

function swallowPollingStartError(): void {
  return;
}

function areSnapshotsEqual(nextSnapshot: EngineSnapshot, prevSnapshot: EngineSnapshot): boolean {
  if (
    nextSnapshot.engineReady !== prevSnapshot.engineReady ||
    nextSnapshot.isPolling !== prevSnapshot.isPolling ||
    nextSnapshot.phase !== prevSnapshot.phase ||
    nextSnapshot.statusText !== prevSnapshot.statusText ||
    nextSnapshot.statusType !== prevSnapshot.statusType ||
    nextSnapshot.pollIntervalMs !== prevSnapshot.pollIntervalMs ||
    nextSnapshot.generationTimeoutMs !== prevSnapshot.generationTimeoutMs ||
    nextSnapshot.generateButtonFound !== prevSnapshot.generateButtonFound ||
    nextSnapshot.generateButtonBusy !== prevSnapshot.generateButtonBusy ||
    nextSnapshot.lastError !== prevSnapshot.lastError ||
    nextSnapshot.counts.success !== prevSnapshot.counts.success ||
    nextSnapshot.counts.c429 !== prevSnapshot.counts.c429 ||
    nextSnapshot.counts.dom !== prevSnapshot.counts.dom ||
    nextSnapshot.counts.err !== prevSnapshot.counts.err ||
    nextSnapshot.logs.length !== prevSnapshot.logs.length
  ) {
    return false;
  }

  for (let index = 0; index < nextSnapshot.logs.length; index += 1) {
    const nextLog = nextSnapshot.logs[index];
    const prevLog = prevSnapshot.logs[index];

    if (
      nextLog.id !== prevLog.id ||
      nextLog.time !== prevLog.time ||
      nextLog.type !== prevLog.type ||
      nextLog.message !== prevLog.message
    ) {
      return false;
    }
  }

  return true;
}

export function isBridgeConnected(): boolean {
  return getBridge() !== null;
}

export function getEngineSnapshot(): EngineSnapshot {
  const bridge = getBridge();
  if (!bridge) {
    if (!hasCachedSnapshot || cachedSnapshot.statusText !== DISCONNECTED_STATUS) {
      cachedSnapshot = cloneFallbackSnapshot();
      hasCachedSnapshot = true;
    }
    return cachedSnapshot;
  }

  try {
    const nextSnapshot = normalizeSnapshot(bridge.getSnapshot());

    if (hasCachedSnapshot && areSnapshotsEqual(nextSnapshot, cachedSnapshot)) {
      return cachedSnapshot;
    }

    cachedSnapshot = nextSnapshot;
    hasCachedSnapshot = true;
    return cachedSnapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : DISCONNECTED_STATUS;
    cachedSnapshot = {
      ...cloneFallbackSnapshot(),
      statusText: message,
      lastError: message,
    };
    hasCachedSnapshot = true;
    return cachedSnapshot;
  }
}

export function subscribeToEngine(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleChange = () => {
    callback();
  };

  window.addEventListener(FAST_POLLER_STATE_EVENT, handleChange);
  window.addEventListener(FAST_POLLER_LOGS_EVENT, handleChange);

  return () => {
    window.removeEventListener(FAST_POLLER_STATE_EVENT, handleChange);
    window.removeEventListener(FAST_POLLER_LOGS_EVENT, handleChange);
  };
}

export function startEnginePolling(): void {
  const result = getBridge()?.startPolling();
  if (result instanceof Promise) {
    result.catch(swallowPollingStartError);
  }
}

export function stopEnginePolling(): void {
  getBridge()?.stopPolling();
}

export function clearEngineLogs(): void {
  getBridge()?.clearLogs();
}
