import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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
  debug: '',
  info: '',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

const LEVEL_TEXT_STYLE: Record<LogLevel, CSSProperties | undefined> = {
  debug: { color: 'var(--af-text-faint)' },
  info: { color: 'var(--af-text-muted)' },
  warn: undefined,
  error: undefined,
};

const LEVEL_CHIP_ACTIVE: Record<LogLevel, string> = {
  debug: 'ring-slate-500/50',
  info: 'ring-indigo-500/50',
  warn: 'bg-amber-600/30 ring-amber-500/50 text-amber-300',
  error: 'bg-red-600/30 ring-red-500/50 text-red-300',
};

const LEVEL_CHIP_ACTIVE_STYLE: Record<LogLevel, CSSProperties | undefined> = {
  debug: { background: 'var(--af-surface-2)', color: 'var(--af-text-muted)' },
  info: { background: 'var(--af-accent-soft-2)', color: 'var(--af-accent)' },
  warn: undefined,
  error: undefined,
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
    const es = new EventSource(`${window.location.origin}/api/logs?token=${TOKEN}`);

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
            <h1 className="text-lg font-semibold" style={{ color: 'var(--af-text-heading)' }}>{t('logs.title')}</h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--af-text-faint)' }}>{t('logs.subtitle')}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <input
              placeholder={t('logs.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-xs rounded-lg px-2.5 py-1.5 focus:outline-none w-36"
              style={{ background: 'var(--af-input-bg)', boxShadow: '0 0 0 1px var(--af-input-ring)', color: 'var(--af-text-base)' }}
            />
            <button
              onClick={() => setPaused((p) => !p)}
              className={`text-xs px-3 py-1.5 rounded-lg ring-1 transition-colors ${paused ? 'bg-amber-600/30 ring-amber-500/50 text-amber-300' : 'ring-1'}`}
              style={paused ? undefined : { background: 'var(--af-surface-2)', boxShadow: '0 0 0 1px var(--af-border)', color: 'var(--af-text-muted)' }}
            >
              {paused ? t('logs.resume') : t('logs.pause')}
            </button>
            <button
              onClick={() => exportAsText(filtered)}
              disabled={filtered.length === 0}
              className="text-xs px-3 py-1.5 rounded-lg ring-1 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--af-surface-2)', boxShadow: '0 0 0 1px var(--af-border)', color: 'var(--af-text-muted)' }}
            >
              {t('logs.export')}
            </button>
            <button
              onClick={() => setEntries([])}
              className="text-xs px-3 py-1.5 rounded-lg ring-1"
              style={{ background: 'var(--af-surface-2)', boxShadow: '0 0 0 1px var(--af-border)', color: 'var(--af-text-muted)' }}
            >
              {t('logs.clear')}
            </button>
          </div>
        </div>

        {/* Per-level chip row — like OpenClaw's chip-row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide mr-1" style={{ color: 'var(--af-text-faint)' }}>{t('logs.levels')}</span>
          {ALL_LEVELS.map((level) => {
            const active = levelFilters[level];
            return (
              <button
                key={level}
                onClick={() => toggleLevel(level)}
                className={`text-[11px] px-2.5 py-1 rounded-full ring-1 transition-all font-medium ${
                  active
                    ? LEVEL_CHIP_ACTIVE[level]
                    : 'ring-1'
                }`}
                style={active
                  ? LEVEL_CHIP_ACTIVE_STYLE[level]
                  : { background: 'transparent', boxShadow: '0 0 0 1px var(--af-border)', color: 'var(--af-text-faint)' }}
              >
                {level}
              </button>
            );
          })}
          <span className="ml-auto text-[10px] tabular-nums" style={{ color: 'var(--af-text-faint)' }}>
            {filtered.length.toLocaleString()} / {entries.length.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl ring-1 p-3 font-mono text-xs min-h-0" style={{ background: 'var(--af-surface-2)', boxShadow: '0 0 0 1px var(--af-border)' }}>
        {filtered.length === 0 && <p className="text-center py-4" style={{ color: 'var(--af-text-faint)' }}>{t('logs.noEntries')}</p>}
        {filtered.map((entry, i) => (
          <div
            key={i}
            className={`flex gap-3 py-0.5 rounded ${LEVEL_TEXT[entry.level ?? 'info']}`}
            style={LEVEL_TEXT_STYLE[entry.level ?? 'info']}
          >
            <span className="shrink-0 tabular-nums" style={{ color: 'var(--af-text-faint)' }}>
              {new Date(entry.ts).toLocaleTimeString()}
            </span>
            <span className="shrink-0 w-12">
              <Badge variant={LEVEL_VARIANT[entry.level ?? 'info'] as 'green'}>
                {entry.level ?? 'info'}
              </Badge>
            </span>
            {entry.name && <span className="shrink-0" style={{ color: 'var(--af-accent)' }}>{entry.name}</span>}
            <span className="flex-1 break-all">{entry.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
