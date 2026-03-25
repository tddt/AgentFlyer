import { useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { useLocale } from '../context/i18n.js';
import type { LogEntry, LogLevel } from '../types.js';

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_VARIANT: Record<LogLevel, string> = {
  debug: 'gray',
  info: 'blue',
  warn: 'yellow',
  error: 'red',
};

const LEVEL_TEXT: Record<LogLevel, string> = {
  debug: 'text-slate-500',
  info: 'text-slate-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

const LEVEL_CHIP_ACTIVE: Record<LogLevel, string> = {
  debug: 'bg-slate-600/60 ring-slate-500/50 text-slate-300',
  info: 'bg-indigo-600/30 ring-indigo-500/50 text-indigo-300',
  warn: 'bg-amber-600/30 ring-amber-500/50 text-amber-300',
  error: 'bg-red-600/30 ring-red-500/50 text-red-300',
};

const MAX_ENTRIES = 1000;

function exportAsText(entries: LogEntry[]) {
  const lines = entries.map((e) => {
    const time = new Date(e.ts).toLocaleTimeString();
    const name = e.name ? `[${e.name}] ` : '';
    return `${time} ${e.level?.toUpperCase().padEnd(5) ?? 'INFO '} ${name}${e.msg}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `agentflyer-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export function LogsTab() {
  const { t } = useLocale();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [levelFilters, setLevelFilters] = useState<Record<LogLevel, boolean>>({
    debug: true,
    info: true,
    warn: true,
    error: true,
  });
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    const TOKEN = window.__AF_TOKEN__;
    const PORT = window.__AF_PORT__;
    const es = new EventSource(`http://127.0.0.1:${PORT}/api/logs?token=${TOKEN}`);

    es.onmessage = (e: MessageEvent<string>) => {
      if (pausedRef.current) return;
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        setEntries((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
        });
      } catch {
        // skip malformed
      }
    };

    return () => es.close();
  }, []);

  // Auto-scroll to bottom unless paused
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, paused]);

  const toggleLevel = (level: LogLevel) => {
    setLevelFilters((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  const filtered = entries.filter((e) => {
    const levelOk = levelFilters[e.level ?? 'info'];
    const searchOk =
      !search ||
      e.msg.toLowerCase().includes(search.toLowerCase()) ||
      (e.name ?? '').toLowerCase().includes(search.toLowerCase());
    return levelOk && searchOk;
  });

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-0">
      <div className="flex flex-col gap-3 pb-4 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">{t('logs.title')}</h1>
            <p className="text-xs text-slate-500 mt-0.5">{t('logs.subtitle')}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <input
              placeholder={t('logs.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-slate-700 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-36"
            />
            <button
              onClick={() => setPaused((p) => !p)}
              className={`text-xs px-3 py-1.5 rounded-lg ring-1 transition-colors ${paused ? 'bg-amber-600/30 ring-amber-500/50 text-amber-300' : 'bg-slate-700 ring-slate-600 text-slate-300 hover:bg-slate-600'}`}
            >
              {paused ? t('logs.resume') : t('logs.pause')}
            </button>
            <button
              onClick={() => exportAsText(filtered)}
              disabled={filtered.length === 0}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 ring-1 ring-slate-600 text-slate-300 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('logs.export')}
            </button>
            <button
              onClick={() => setEntries([])}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-700 ring-1 ring-slate-600 text-slate-300 hover:bg-slate-600"
            >
              {t('logs.clear')}
            </button>
          </div>
        </div>

        {/* Per-level chip row — like OpenClaw's chip-row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-slate-600 uppercase tracking-wide mr-1">{t('logs.levels')}</span>
          {ALL_LEVELS.map((level) => {
            const active = levelFilters[level];
            return (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={`text-[11px] px-2.5 py-1 rounded-full ring-1 transition-all font-medium ${
                  active
                    ? LEVEL_CHIP_ACTIVE[level]
                    : 'bg-transparent ring-slate-700/50 text-slate-600 hover:text-slate-400'
                }`}
              >
                {level}
              </button>
            );
          })}
          <span className="ml-auto text-[10px] text-slate-600 tabular-nums">
            {filtered.length.toLocaleString()} / {entries.length.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-900/60 rounded-xl ring-1 ring-slate-700/50 p-3 font-mono text-xs min-h-0">
        {filtered.length === 0 && <p className="text-slate-500 text-center py-4">{t('logs.noEntries')}</p>}
        {filtered.map((entry, i) => (
          <div
            key={i}
            className={`flex gap-3 py-0.5 hover:bg-slate-800/40 rounded ${LEVEL_TEXT[entry.level ?? 'info']}`}
          >
            <span className="text-slate-600 shrink-0 tabular-nums">
              {new Date(entry.ts).toLocaleTimeString()}
            </span>
            <span className="shrink-0 w-12">
              <Badge variant={LEVEL_VARIANT[entry.level ?? 'info'] as 'green'}>
                {entry.level ?? 'info'}
              </Badge>
            </span>
            {entry.name && <span className="text-indigo-400 shrink-0">{entry.name}</span>}
            <span className="flex-1 break-all">{entry.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
