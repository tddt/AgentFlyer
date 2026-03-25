import { useMemo, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type {
  DisplayMessage,
  SessionListResult,
  SessionMessagesResult,
  SessionMetaInfo,
} from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function statusVariant(status: string): 'green' | 'blue' | 'red' | 'gray' {
  if (status === 'active') return 'green';
  if (status === 'idle') return 'blue';
  if (status === 'error') return 'red';
  return 'gray';
}

function sessionToMarkdown(session: SessionMetaInfo, messages: DisplayMessage[]): string {
  const header = `# Session: ${session.sessionKey}\nAgent: ${session.agentId} | Thread: ${session.threadKey}\nCreated: ${fmtDate(session.createdAt)} | Messages: ${session.messageCount}\n\n---\n\n`;
  const body = messages
    .map((m) => {
      const role = m.role === 'user' ? '👤 **User**' : '🤖 **Assistant**';
      const time = fmtDate(m.timestamp);
      let out = `### ${role} — ${time}\n\n${m.text}`;
      if (m.tools && m.tools.length > 0) {
        out += `\n\n**Tool calls:**\n${m.tools.map((t) => `- \`${t.name}\`\n\`\`\`json\n${t.input}\n\`\`\``).join('\n')}`;
      }
      return out;
    })
    .join('\n\n---\n\n');
  return header + body;
}

// ── Single message bubble ─────────────────────────────────────────────────────

interface MsgBubbleProps {
  msg: DisplayMessage;
}

function MsgBubble({ msg }: MsgBubbleProps) {
  const { t } = useLocale();
  const [toolOpen, setToolOpen] = useState(false);
  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-indigo-600/30 ring-1 ring-indigo-500/40 text-slate-100'
            : 'bg-slate-800/60 ring-1 ring-slate-700/40 text-slate-200'
        }`}
      >
        <div
          className={`flex items-center gap-2 mb-2 text-[11px] ${isUser ? 'text-indigo-300' : 'text-slate-500'}`}
        >
          <span className="font-semibold">{isUser ? t('sessions.userRole') : t('sessions.assistantRole')}</span>
          <span>·</span>
          <span>{fmtDate(msg.timestamp)}</span>
        </div>
        {msg.text ? <MarkdownView content={msg.text} /> : null}
        {msg.tools && msg.tools.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setToolOpen((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-amber-400/80 hover:text-amber-400 transition-colors"
            >
              <span>{toolOpen ? '▾' : '▸'}</span>
              <span>
                {t(msg.tools.length > 1 ? 'sessions.toolCalls' : 'sessions.toolCall', { n: String(msg.tools.length) })}
              </span>
            </button>
            {toolOpen && (
              <div className="mt-2 flex flex-col gap-1.5">
                {msg.tools.map((t, i) => (
                  <details
                    key={i}
                    className="bg-slate-900/70 ring-1 ring-slate-700/40 rounded-lg px-3 py-1.5"
                  >
                    <summary className="cursor-pointer text-[11px] font-mono text-amber-300">
                      {t.name}
                    </summary>
                    <pre className="mt-1.5 text-[10px] text-slate-400 overflow-x-auto whitespace-pre-wrap">
                      {t.input}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Session detail panel ──────────────────────────────────────────────────────

interface SessionDetailProps {
  session: SessionMetaInfo;
  onClear: () => void;
}

function SessionDetail({ session, onClear }: SessionDetailProps) {
  const { t } = useLocale();
  const { toast } = useToast();
  const { data, loading, refetch } = useQuery<SessionMessagesResult>(
    () => rpc<SessionMessagesResult>('session.messages', { sessionKey: session.sessionKey }),
    [session.sessionKey],
  );

  const handleClear = async () => {
    try {
      await rpc('session.clear', { sessionKey: session.sessionKey });
      toast('Session cleared', 'success');
      onClear();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Clear failed', 'error');
    }
  };

  const handleExport = () => {
    if (!data) return;
    const md = sessionToMarkdown(session, data.messages);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.sessionKey}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Session exported', 'success');
  };

  const handleCopy = async () => {
    if (!data) return;
    const md = sessionToMarkdown(session, data.messages);
    await navigator.clipboard.writeText(md);
    toast('Copied to clipboard', 'success');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-xs font-mono text-slate-500 break-all">{session.sessionKey}</span>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" onClick={refetch} disabled={loading}>
            ↺
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleCopy()} disabled={!data}>
            {t('sessions.copy')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleExport} disabled={!data}>
            {t('sessions.export')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void handleClear()}>
            {t('sessions.clear')}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs">
        {(
          [
            [t('sessions.messages'), session.messageCount],
            [t('sessions.tokens'), session.contextTokensEstimate],
            [t('sessions.compactions'), session.compactionCount],
            [t('sessions.lastActive'), timeAgo(session.lastActivity)],
          ] as [string, string | number][]
        ).map(([k, v]: [string, string | number]) => (
          <div
            key={k}
            className="bg-slate-800/60 rounded-lg px-3 py-2 text-center ring-1 ring-slate-700/40"
          >
            <div className="text-slate-500 mb-0.5">{k}</div>
            <div className="text-slate-200 font-semibold">{v}</div>
          </div>
        ))}
      </div>

      {session.contextTokensEstimate > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[11px] text-slate-500">
            <span>{t('sessions.contextUsage')}</span>
            <span>{session.contextTokensEstimate.toLocaleString()} tokens</span>
          </div>
          <div className="h-1.5 bg-slate-700/60 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all"
              style={{
                width: `${Math.min(100, (session.contextTokensEstimate / 200_000) * 100)}%`,
              }}
            />
          </div>
          <div className="text-[10px] text-slate-600">{t('sessions.maxContext')}</div>
        </div>
      )}

      {loading && (
        <p className="text-xs text-slate-500 animate-pulse py-4 text-center">{t('sessions.loadingMessages')}</p>
      )}
      {!loading && data && data.messages.length === 0 && (
        <p className="text-xs text-slate-500 italic text-center py-4">{t('sessions.noMessages')}</p>
      )}
      {!loading && data && data.messages.length > 0 && (
        <div className="flex flex-col gap-3 max-h-[65vh] overflow-y-auto pr-1">
          {data.messages.map((msg) => (
            <MsgBubble key={msg.id} msg={msg} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Session list row ──────────────────────────────────────────────────────────

interface SessionRowProps {
  session: SessionMetaInfo;
  expanded: boolean;
  onToggle: () => void;
  onCleared: () => void;
}

function SessionRow({ session, expanded, onToggle, onCleared }: SessionRowProps) {
  return (
    <div
      className={`rounded-xl ring-1 overflow-hidden transition-all ${
        expanded
          ? 'bg-slate-800/60 ring-indigo-500/30'
          : 'bg-slate-800/30 ring-slate-700/40 hover:ring-slate-600/60'
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
      >
        <span className="text-slate-500 text-xs">{expanded ? '▾' : '▸'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-indigo-300 font-medium">{session.agentId}</span>
            <span className="text-slate-600">·</span>
            <span className="font-mono text-xs text-slate-400 truncate">{session.threadKey}</span>
            <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-slate-500">
            <span>{session.messageCount} msgs</span>
            <span>·</span>
            <span>~{session.contextTokensEstimate.toLocaleString()} tok</span>
            <span>·</span>
            <span>{timeAgo(session.lastActivity)}</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-700/40">
          <SessionDetail session={session} onClear={onCleared} />
        </div>
      )}
    </div>
  );
}

// ── Main SessionsTab ──────────────────────────────────────────────────────────

export function SessionsTab() {
  const { t } = useLocale();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterAgent, setFilterAgent] = useState('all');
  const [sortBy, setSortBy] = useState<'recent' | 'messages' | 'tokens'>('recent');

  const { data, loading, refetch } = useQuery<SessionListResult>(
    () => rpc<SessionListResult>('session.list'),
    [],
  );

  const allSessions: SessionMetaInfo[] = data?.sessions ?? [];

  const agentIds = useMemo(() => {
    const ids = new Set(allSessions.map((s) => s.agentId));
    return Array.from(ids).sort();
  }, [allSessions]);

  const sessions = useMemo(() => {
    let list = allSessions;
    if (filterAgent !== 'all') list = list.filter((s) => s.agentId === filterAgent);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) => s.agentId.includes(q) || s.threadKey.includes(q) || s.sessionKey.includes(q),
      );
    }
    list = [...list];
    if (sortBy === 'recent') list.sort((a, b) => b.lastActivity - a.lastActivity);
    else if (sortBy === 'messages') list.sort((a, b) => b.messageCount - a.messageCount);
    else if (sortBy === 'tokens')
      list.sort((a, b) => b.contextTokensEstimate - a.contextTokensEstimate);
    return list;
  }, [allSessions, filterAgent, search, sortBy]);

  const totalMessages = allSessions.reduce((s, x) => s + x.messageCount, 0);
  const totalTokens = allSessions.reduce((s, x) => s + x.contextTokensEstimate, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{t('sessions.title')}</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {allSessions.length} sessions · {totalMessages} messages · ~
            {totalTokens.toLocaleString()} tokens
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={refetch} disabled={loading}>
          {loading ? <span className="animate-spin inline-block">⟳</span> : t('sessions.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder={t('sessions.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-36 bg-slate-800/60 ring-1 ring-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-indigo-500/60"
        />
        <select
          value={filterAgent}
          onChange={(e) => setFilterAgent(e.target.value)}
          className="bg-slate-800/60 ring-1 ring-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-300 focus:outline-none"
        >
          <option value="all">{t('sessions.allAgents')}</option>
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="bg-slate-800/60 ring-1 ring-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-300 focus:outline-none"
        >
          <option value="recent">{t('sessions.recentFirst')}</option>
          <option value="messages">{t('sessions.mostMessages')}</option>
          <option value="tokens">{t('sessions.mostTokens')}</option>
        </select>
      </div>

      {!loading && sessions.length === 0 && (
        <div className="text-center py-16 text-sm text-slate-500">
          {search || filterAgent !== 'all'
            ? t('sessions.noMatch')
            : t('sessions.noSessions')}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {sessions.map((s) => (
          <SessionRow
            key={s.sessionKey}
            session={s}
            expanded={expandedKey === s.sessionKey}
            onToggle={() => setExpandedKey((k) => (k === s.sessionKey ? null : s.sessionKey))}
            onCleared={() => {
              void refetch();
              setExpandedKey(null);
            }}
          />
        ))}
      </div>
    </div>
  );
}
