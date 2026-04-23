import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Play,
  Square,
  Save,
  Terminal,
  Activity,
  Settings,
  LayoutList,
  AlertCircle,
  Moon,
  Sun,
  FileCode2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Card } from '@/src/components/Card';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';
import {
  clearEngineLogs,
  DISCONNECTED_STATUS,
  getEngineSnapshot,
  isBridgeConnected,
  startEnginePolling,
  stopEnginePolling,
  subscribeToEngine,
  type EngineLogEntry,
} from '@/src/bridge/engine';

type TelemetryTone = 'emerald' | 'slate' | 'amber' | 'sky' | 'red';

const TELEMETRY_VALUE_CLASS: Record<TelemetryTone, string> = {
  emerald: 'text-emerald-500/80',
  slate: 'text-slate-500/80',
  amber: 'text-amber-500/80',
  sky: 'text-sky-500/80',
  red: 'text-red-500/80',
};

function getTelemetryValueClass(value: number | '--', color: TelemetryTone): string {
  return value === '--' ? 'text-slate-600' : TELEMETRY_VALUE_CLASS[color];
}

function getLogColor(type: EngineLogEntry['type']) {
  switch (type) {
    case '429':
      return 'text-amber-400';
    case 'ERR':
      return 'text-red-400';
    case 'DOM':
      return 'text-sky-400';
    default:
      return 'text-slate-400';
  }
}

function useEngineState() {
  return useSyncExternalStore(subscribeToEngine, getEngineSnapshot, getEngineSnapshot);
}

function DisabledOverlay({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-slate-950/70 backdrop-blur-[1px]">
      <div className="rounded-md border border-amber-500/20 bg-slate-900/90 px-3 py-2 text-center text-[10px] font-black uppercase tracking-[0.2em] text-amber-400">
        {label}
      </div>
    </div>
  );
}

function StaticToggle({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 opacity-55">
      <div className={`w-7 h-3.5 rounded-full p-0.5 ${enabled ? 'bg-emerald-700/70' : 'bg-slate-800'}`}>
        <div className={`w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-[14px]' : ''}`} />
      </div>
      <span className="text-[10px] text-slate-500 font-bold uppercase tracking-tight">{label}</span>
    </div>
  );
}

interface AppProps {
  embedded?: boolean;
}

export default function App({ embedded = false }: AppProps) {
  const engine = useEngineState();
  const bridgeConnected = isBridgeConnected();
  const [lang, setLang] = useState<'ZH' | 'EN'>('ZH');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [showDocs, setShowDocs] = useState(false);
  const [nsfwMode, setNsfwMode] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const t = (en: string, zh: string) => (lang === 'ZH' ? zh : en);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [engine.logs]);

  const pollMs = engine.pollIntervalMs;
  const timeoutS = engine.generationTimeoutMs > 0 ? Math.round(engine.generationTimeoutMs / 1000) : 0;
  const total = engine.counts.success + engine.counts.c429 + engine.counts.dom + engine.counts.err;
  const statusToneClass = engine.statusType === 'error'
    ? 'text-red-400 border-red-500/20 bg-red-500/10'
    : engine.isPolling
      ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10'
      : 'text-slate-400 border-slate-700/50 bg-slate-800/50';
  const busyText = !engine.generateButtonFound
    ? t('Generate button missing', 'Generate 按钮未找到')
    : engine.generateButtonBusy === null
      ? t('Unknown', '未知')
      : engine.generateButtonBusy
        ? t('Busy', '忙碌中')
        : t('Ready', '空闲');
  const shellClassName = embedded
    ? `w-full text-slate-200 transition-colors duration-500 ${theme === 'light' ? 'theme-light' : ''}`
    : `min-h-screen bg-slate-950 p-4 md:p-8 flex items-center justify-center transition-colors duration-500 ${theme === 'light' ? 'theme-light' : ''}`;
  const panelClassName = embedded
    ? 'w-[min(100vw-48px,80rem)] max-w-5xl bg-slate-900 rounded-xl border border-slate-800 shadow-2xl overflow-hidden flex flex-col pointer-events-auto'
    : 'w-full max-w-5xl bg-slate-900 rounded-xl border border-slate-800 shadow-2xl overflow-hidden flex flex-col';
  const floatingStatusClassName = embedded
    ? 'fixed bottom-6 right-6 flex flex-col items-end gap-2 pointer-events-none'
    : 'fixed bottom-6 right-6 flex flex-col items-end gap-2';

  if (showDocs) {
    return (
      <div className="min-h-screen bg-white transition-colors duration-500">
        <div className="bg-slate-900 px-6 py-4 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 bg-emerald-500/10 rounded border border-emerald-500/20">
              <FileCode2 className="w-4 h-4 text-emerald-400" />
            </div>
            <h1 className="text-slate-200 font-black font-mono tracking-widest">API DOCS {t('(OAS 3.0)', '(OpenAPI 规范)')}</h1>
          </div>
          <button
            onClick={() => setShowDocs(false)}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs uppercase tracking-widest rounded transition-colors cursor-pointer border border-slate-700"
          >
            {t('Back to Console', '返回控制台')}
          </button>
        </div>
        <div className="p-4 md:p-8">
          <SwaggerUI url="/openapi.yaml" />
        </div>
      </div>
    );
  }

  return (
    <div className={shellClassName}>
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        className={panelClassName}
        id="control-panel"
      >
        <div className="bg-slate-800 px-5 py-3 flex items-center justify-between border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-6 h-6 bg-emerald-500/10 rounded border border-emerald-500/20">
              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <span className="font-mono text-xs font-black tracking-[0.2em] text-slate-200">
              NAI FAST POLLER // {t('CONTROL CENTER', '控制中心')}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex p-0.5 bg-slate-950 border border-slate-800 rounded-md">
              <button
                onClick={() => setTheme('dark')}
                className={`px-2 py-0.5 text-[9px] font-black rounded transition-all cursor-pointer flex items-center justify-center ${theme === 'dark' ? 'bg-slate-800 text-emerald-400 border border-slate-700 shadow-sm' : 'text-slate-600 hover:text-slate-400 border border-transparent'}`}
                title={t('Dark Mode', '暗黑模式')}
              >
                <Moon className="w-3 h-3" />
              </button>
              <button
                onClick={() => setTheme('light')}
                className={`px-2 py-0.5 text-[9px] font-black rounded transition-all cursor-pointer flex items-center justify-center ${theme === 'light' ? 'bg-slate-800 text-emerald-400 border border-slate-700 shadow-sm' : 'text-slate-600 hover:text-slate-400 border border-transparent'}`}
                title={t('Light Mode', '白色模式')}
              >
                <Sun className="w-3 h-3" />
              </button>
            </div>
            <div className="flex p-0.5 bg-slate-950 border border-slate-800 rounded-md">
              <button
                onClick={() => setLang('EN')}
                className={`px-2 py-0.5 text-[9px] font-black uppercase rounded transition-all cursor-pointer ${lang === 'EN' ? 'bg-slate-800 text-emerald-400 border border-slate-700 shadow-sm' : 'text-slate-600 hover:text-slate-400 border border-transparent'}`}
              >
                EN
              </button>
              <button
                onClick={() => setLang('ZH')}
                className={`px-2 py-0.5 text-[9px] font-black uppercase rounded transition-all cursor-pointer ${lang === 'ZH' ? 'bg-slate-800 text-emerald-400 border border-slate-700 shadow-sm' : 'text-slate-600 hover:text-slate-400 border border-transparent'}`}
              >
                中
              </button>
            </div>
            <div className="flex gap-1.5 px-2 py-1 bg-slate-950/50 rounded border border-slate-800">
              <div className={`w-1.5 h-1.5 rounded-full ${bridgeConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              <span className={`text-[10px] font-mono font-bold uppercase tracking-widest ${bridgeConnected ? 'text-emerald-500/80' : 'text-red-400/90'}`}>
                {bridgeConnected ? t('Bridge: Connected', '桥接: 已连接') : t('Bridge: Disconnected', '桥接: 未连接')}
              </span>
            </div>
          </div>
        </div>

        <div className="p-4 grid grid-cols-1 md:grid-cols-12 gap-4 bg-slate-950/40">
          <Card
            title={t('Runtime / Status', '运行状态 / 概览')}
            icon={Activity}
            className="md:col-span-12 lg:col-span-5"
          >
            <div className="space-y-4">
              <div className={`rounded-lg border px-3 py-2 ${statusToneClass}`}>
                <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em]">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>{t('Bridge Status', '桥接状态')}</span>
                </div>
                <div className="mt-2 text-sm font-bold break-words">
                  {bridgeConnected ? engine.statusText : DISCONNECTED_STATUS}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">{t('Current State', '当前状态')}</span>
                <AnimatePresence mode="wait">
                  <motion.span
                    key={engine.isPolling ? 'run' : 'idle'}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={`px-3 py-1 rounded-md text-[10px] font-black uppercase tracking-[0.1em] ${statusToneClass}`}
                  >
                    {engine.isPolling ? t('RUNNING', '运行中') : t('STOPPED', '已停止')}
                  </motion.span>
                </AnimatePresence>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">{t('Operation Phase', '运行阶段')}</span>
                <span className="font-mono text-sm text-emerald-500/80 font-bold">{engine.phase}</span>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg">
                  <label className="block text-[10px] uppercase text-slate-500 font-black mb-1 tracking-wider">{t('poll_interval', '轮询间隔')}</label>
                  <div className="flex items-center gap-2">
                    <div className="w-full text-lg font-mono text-emerald-400">{pollMs || '--'}</div>
                    <span className="text-[10px] text-slate-600 font-bold">MS</span>
                  </div>
                </div>
                <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg">
                  <label className="block text-[10px] uppercase text-slate-500 font-black mb-1 tracking-wider">{t('timeout_limit', '超时限制')}</label>
                  <div className="flex items-center gap-2">
                    <div className="w-full text-lg font-mono text-slate-300">{timeoutS || '--'}</div>
                    <span className="text-[10px] text-slate-600 font-bold">SEC</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-1">
                <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg">
                  <label className="block text-[10px] uppercase text-slate-500 font-black mb-1 tracking-wider">{t('generate_button', 'Generate 按钮')}</label>
                  <div className={`text-sm font-mono font-bold ${engine.generateButtonFound ? 'text-emerald-400' : 'text-red-400'}`}>
                    {engine.generateButtonFound ? t('FOUND', '已找到') : t('MISSING', '未找到')}
                  </div>
                </div>
                <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg">
                  <label className="block text-[10px] uppercase text-slate-500 font-black mb-1 tracking-wider">{t('button_busy_state', '按钮忙碌状态')}</label>
                  <div className="text-sm font-mono font-bold text-slate-300">{busyText}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-0 pt-4 border-t border-slate-800/50">
                <div className="space-y-2 pr-4 border-r border-slate-800/50">
                  <StaticToggle enabled={false} label={t('Overlay Lock', '覆盖层锁定')} />
                  <div className="flex items-center gap-2">
                    <div
                      onClick={() => setNsfwMode(!nsfwMode)}
                      className={`w-7 h-3.5 rounded-full p-0.5 cursor-pointer transition-colors duration-200 ${nsfwMode ? 'bg-rose-600' : 'bg-slate-800'}`}
                    >
                      <motion.div
                        animate={{ x: nsfwMode ? 14 : 0 }}
                        className="w-2.5 h-2.5 bg-white rounded-full shadow-sm"
                      />
                    </div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">{t('NSFW Stealth', 'NSFW 隐蔽')}</span>
                  </div>
                  <StaticToggle enabled={false} label={t('Jump Disable', '禁用跳转')} />
                </div>

                <div className="space-y-3 pl-4 flex flex-col justify-start">
                  <StaticToggle enabled={false} label={t('429 Backoff', '429 退避')} />
                  <div className="p-2 bg-slate-900/50 border border-slate-800 rounded-md opacity-55">
                    <label className="block text-[8px] uppercase text-slate-600 font-black mb-0.5 tracking-tighter">{t('backoff_delay', '退避时长')}</label>
                    <div className="flex items-center gap-2">
                      <div className="w-full text-sm font-mono text-slate-400">--</div>
                      <span className="text-[8px] text-slate-700 font-bold">SEC</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card
            title={t('Generation Parameters', '生成参数')}
            icon={Settings}
            className="md:col-span-12 lg:col-span-7"
          >
            <div className="relative">
              <DisabledOverlay label={t('Pending wire-up', '待抓包接线')} />
              <div className="flex flex-col gap-5 opacity-45 select-none">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-slate-950/30 rounded-lg border border-slate-800/50">
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{t('Burst Count', '生成数量')}</label>
                    <input type="number" value={12} readOnly disabled className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm font-mono text-emerald-400 outline-none" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{t('Items / Batch', '每批项数')}</label>
                    <input type="number" value={3} readOnly disabled className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1.5 text-sm font-mono text-slate-300 outline-none" />
                  </div>
                  <div className="flex flex-col justify-end pb-1.5">
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked readOnly disabled className="w-3.5 h-3.5 accent-emerald-500" />
                      <label className="text-[10px] text-slate-400 font-bold uppercase">{t('Auto Loop', '自动循环')}</label>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{t('Placeholder Slot', '替换占位符')}</label>
                      <input type="text" value="[替换位]" readOnly disabled className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-sm font-mono text-slate-300" />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{t('Target Layer', '目标层级')}</label>
                      <div className="flex p-1 bg-slate-950 border border-slate-800 rounded-lg">
                        <button disabled className="flex-1 py-1 text-[9px] font-black uppercase rounded bg-slate-800 text-emerald-400 border border-slate-700">{t('System', '系统提示层')}</button>
                        <button disabled className="flex-1 py-1 text-[9px] font-black uppercase rounded text-slate-600">{t('Character', '角色提示层')}</button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{t('Rotation Logic', '轮换逻辑')}</label>
                      <div className="flex p-1 bg-slate-950 border border-slate-800 rounded-lg">
                        <button disabled className="flex-1 py-1 text-[9px] font-black uppercase rounded bg-slate-800 text-emerald-400 border border-slate-700">{t('Linear', '线性顺序')}</button>
                        <button disabled className="flex-1 py-1 text-[9px] font-black uppercase rounded text-slate-600">{t('Entropy', '随机乱序')}</button>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5 h-full">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex justify-between">
                      <span>{t('Replacement Pool', '替换池')}</span>
                      <span className="text-slate-700 normal-case">4 {t('tags', '条项')}</span>
                    </label>
                    <textarea value={'角色A\n角色B\n角色C\n角色D'} readOnly disabled className="w-full flex-1 min-h-[140px] bg-slate-950 border border-slate-800 rounded px-3 py-2 text-[11px] font-mono resize-none" />
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card
            title={t('System Registry / Event Logs', '系统注册表 / 事件日志')}
            icon={LayoutList}
            className="md:col-span-12 lg:col-span-8"
            headerExtra={
              <button
                onClick={() => bridgeConnected && clearEngineLogs()}
                disabled={!bridgeConnected}
                className={`text-[10px] font-black uppercase tracking-tighter transition-colors ${bridgeConnected ? 'text-slate-500 hover:text-emerald-400 cursor-pointer' : 'text-slate-700 cursor-not-allowed'}`}
              >
                {t('Flush Logs', '清空日志')}
              </button>
            }
          >
            <div
              ref={logContainerRef}
              className={`h-64 bg-slate-950/50 border border-slate-900 rounded-lg p-3 overflow-y-auto font-mono text-[11px] leading-relaxed scroll-smooth shadow-inner transition-all duration-500 ${nsfwMode ? 'blur-md grayscale opacity-20 select-none pointer-events-none' : ''}`}
            >
              {engine.logs.length === 0 && (
                <div className="h-full flex items-center justify-center text-slate-800 font-black tracking-widest uppercase text-xs italic text-center px-4">
                  - {bridgeConnected ? t('SYSLOG IDLE', '日志空闲') : t('BRIDGE DISCONNECTED', '桥接未连接')} -
                </div>
              )}
              {engine.logs.map((log) => (
                <motion.div
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  key={log.id}
                  className="flex gap-3 py-1 border-b border-slate-800/50 last:border-0 hover:bg-emerald-500/[0.02]"
                >
                  <span className="text-slate-700 shrink-0 font-bold">{log.time}</span>
                  <span className={`font-black shrink-0 w-12 text-center rounded-[2px] bg-slate-900/80 border border-slate-800 shadow-sm ${getLogColor(log.type)}`}>
                    {log.type}
                  </span>
                  <span className="text-slate-400 break-all">{log.message}</span>
                </motion.div>
              ))}
            </div>
          </Card>

          <Card
            title={t('Telemetric Summary', '遥测数据汇总')}
            icon={Activity}
            className="md:col-span-12 lg:col-span-4"
          >
            <div className="flex flex-col h-full justify-between">
              <div className="grid grid-cols-1 gap-2">
                {([
                  { label: t('Successful Gen', '成功生成'), value: engine.counts.success, color: 'emerald' },
                  { label: t('Access Denied (403)', '访问拒绝 (403)'), value: '--', color: 'slate' },
                  { label: t('Rate Limited (429)', '触发限流 (429)'), value: engine.counts.c429, color: 'amber' },
                  { label: t('Server Error (503)', '服务器错误 (503)'), value: '--', color: 'slate' },
                  { label: t('DOM Intercepts', 'DOM 拦截'), value: engine.counts.dom, color: 'sky' },
                  { label: t('IO Exceptions', 'IO 异常'), value: engine.counts.err, color: 'red' },
                ] satisfies Array<{ label: string; value: number | '--'; color: TelemetryTone }>).map((item) => (
                  <div key={item.label} className="group flex justify-between items-center px-4 py-2 bg-slate-900/30 border border-slate-800/50 rounded-lg hover:bg-slate-900/80 hover:border-slate-700 transition-all">
                    <span className="text-[10px] text-slate-500 group-hover:text-slate-400 font-black uppercase tracking-tight">{item.label}</span>
                    <span className={`font-mono font-black ${getTelemetryValueClass(item.value, item.color)}`}>{item.value}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-slate-800/50">
                <div className="flex justify-between items-end px-2">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">{t('Aggregate', '聚合总数')}</span>
                    <span className="text-2xl font-mono text-slate-100 font-black tracking-tighter">{total}</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">{t('Efficiency', '运行效率')}</span>
                    <span className="text-xs font-mono text-slate-600 font-black">{t('Pending wire-up', '待接线')}</span>
                  </div>
                </div>
                <div className="mt-2 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: engine.isPolling ? '100%' : bridgeConnected ? '40%' : '0%' }}
                    className="h-full bg-gradient-to-r from-emerald-600 via-emerald-500 to-emerald-400"
                  />
                </div>
              </div>
            </div>
          </Card>
        </div>

        <div className="px-6 py-5 bg-slate-900 border-t border-slate-800 flex flex-wrap gap-6 items-center justify-between">
          <div className="flex gap-4 flex-wrap">
            {!engine.isPolling ? (
              <button
                onClick={() => startEnginePolling()}
                disabled={!bridgeConnected || !engine.engineReady}
                className={`relative group flex items-center gap-3 px-8 py-3 rounded-lg font-black text-sm tracking-[0.2em] transition-all overflow-hidden shadow-xl ${bridgeConnected && engine.engineReady ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/40 cursor-pointer' : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'}`}
                id="btn-start"
              >
                <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                <Play className="w-5 h-5 fill-current relative z-10" />
                <span className="relative z-10">{t('INITIALIZE', '启动任务')}</span>
              </button>
            ) : (
              <button
                onClick={() => stopEnginePolling()}
                disabled={!bridgeConnected}
                className={`flex items-center gap-3 px-8 py-3 rounded-lg font-black text-sm tracking-[0.2em] transition-all border shadow-xl ${bridgeConnected ? 'bg-slate-800 hover:bg-red-600 text-slate-400 hover:text-white border-slate-700 border-dashed hover:border-solid hover:shadow-red-950/40 cursor-pointer' : 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed'}`}
                id="btn-stop"
              >
                <Square className="w-5 h-5 fill-current" />
                {t('TERMINATE', '停止')}
              </button>
            )}

            <button
              disabled
              className="flex items-center gap-3 px-6 py-3 bg-slate-900 text-slate-700 rounded-lg font-black text-sm tracking-[0.2em] border border-slate-800 cursor-not-allowed"
              id="btn-save"
            >
              <Save className="w-5 h-5" />
              {t('ARCHIVE', '存档配置')}
            </button>

            <button
              onClick={() => setShowDocs(true)}
              className="flex items-center gap-3 px-6 py-3 bg-slate-900 hover:bg-slate-800 text-sky-500/70 hover:text-sky-400 rounded-lg font-black text-sm tracking-[0.2em] transition-all border border-slate-800 active:scale-95 cursor-pointer"
              id="btn-docs"
            >
              <FileCode2 className="w-5 h-5" />
              {t('API DOCS', '接口文档')}
            </button>
          </div>

          <div className="flex items-center gap-8 text-[10px] font-mono font-black text-slate-700 tracking-tighter">
            <div className="flex flex-col items-end">
              <span>NODE_LATENCY</span>
              <span className="text-slate-600">--</span>
            </div>
            <div className="flex flex-col items-end">
              <span>BUFFER_LOAD</span>
              <span className="text-slate-600">--</span>
            </div>
            <div className="hidden lg:flex flex-col items-end border-l border-slate-800 pl-8">
              <span>CORE_TEMP</span>
              <span className="text-slate-600">--</span>
            </div>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {engine.isPolling && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className={floatingStatusClassName}
          >
            <div className="px-4 py-2 bg-emerald-500 text-slate-950 rounded-lg shadow-2xl font-black text-xs tracking-widest flex items-center gap-3 border border-emerald-400">
              <Activity className="w-4 h-4" />
              {t('ACTIVE_UPLINK', '链路活跃')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        .animate-spin-slow {
          animation: spin-slow 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
      `}</style>
    </div>
  );
}
