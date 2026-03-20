import { useEffect, useRef, useState } from 'react'
import { rpc, useQuery } from '../hooks/useRpc.js'
import { MarkdownView } from '../components/MarkdownView.js'
import { CopyButton } from '../components/CopyButton.js'
import { Button } from '../components/Button.js'
import type { AgentInfo, ChatChunk, AgentListResult, SessionMessagesResult, SessionListResult, SessionMetaInfo } from '../types.js'

interface ToolCall {
  id: string
  name: string
  input: string
}

interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

interface Message {
  role: 'user' | 'assistant' | 'thinking'
  content: string
  streaming?: boolean
  tools?: ToolCall[]
  usage?: TokenUsage
}

// ── Per-agent panel ──────────────────────────────────────────────────────────

interface AgentPanelProps {
  agent: AgentInfo
  isActive: boolean
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function AgentPanel({ agent, isActive }: AgentPanelProps) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [currentThread, setCurrentThread] = useState(`console:${agent.agentId}`)
  const [showSessions, setShowSessions] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Sessions for this agent (for thread selection)
  const { data: sessionsData, refetch: refetchSessions } = useQuery<SessionListResult>(
    () => rpc<SessionListResult>('session.list'),
    [],
  )
  const agentSessions: SessionMetaInfo[] = (sessionsData?.sessions ?? [])
    .filter((s) => s.agentId === agent.agentId)
    .sort((a, b) => b.lastActivity - a.lastActivity)

  // Reload history whenever thread changes
  useEffect(() => {
    const sessionKey = `agent:${agent.agentId}:${currentThread}`
    rpc<SessionMessagesResult>('session.messages', { sessionKey })
      .then((res) => {
        setMessages(
          res.messages.map((m) => ({
            role: m.role,
            content: m.text,
            tools: m.tools?.map((t) => ({ id: '', name: t.name, input: t.input })),
          }))
        )
      })
      .catch(() => setMessages([]))
  }, [currentThread]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadSession = (session: SessionMetaInfo) => {
    setCurrentThread(session.threadKey)
    setShowSessions(false)
  }

  const startNewThread = () => {
    const newThread = `console:${agent.agentId}:${Date.now()}`
    setCurrentThread(newThread)
    setMessages([])
    setShowSessions(false)
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setBusy(true)

    const TOKEN = window.__AF_TOKEN__
    const PORT = window.__AF_PORT__

    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ agentId: agent.agentId, message: text, thread: currentThread }),
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let replyContent = ''
      let thinkingContent = ''
      const pendingTools = new Map<string, ToolCall>()

      setMessages((prev) => [...prev, { role: 'assistant', content: '', streaming: true }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })

        const parts = buf.split('\n')
        buf = parts.pop() ?? ''

        for (const line of parts) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') break
          let chunk: ChatChunk
          try {
            chunk = JSON.parse(payload) as ChatChunk
          } catch {
            continue
          }

          if (chunk.type === 'text_delta') {
            replyContent += chunk.text
            setMessages((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: replyContent, streaming: true }
              }
              return next
            })
          } else if (chunk.type === 'thinking' || chunk.type === 'thinking_delta') {
            thinkingContent += chunk.text
            // Insert or update a thinking bubble right before the streaming assistant bubble
            setMessages((prev) => {
              const next = [...prev]
              const lastIdx = next.length - 1
              const last = next[lastIdx]
              // If last is an empty streaming assistant placeholder, insert thinking before it
              if (last?.role === 'assistant' && last.streaming && !last.content) {
                const thinkIdx = lastIdx - 1
                if (thinkIdx >= 0 && next[thinkIdx]?.role === 'thinking') {
                  next[thinkIdx] = { ...next[thinkIdx]!, content: thinkingContent, streaming: true }
                } else {
                  next.splice(lastIdx, 0, { role: 'thinking', content: thinkingContent, streaming: true })
                }
              } else {
                // Check if second-to-last is thinking
                let thinkIdx = -1
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i]?.role === 'thinking' && next[i]?.streaming) { thinkIdx = i; break }
                }
                if (thinkIdx >= 0) {
                  next[thinkIdx] = { ...next[thinkIdx]!, content: thinkingContent }
                }
              }
              return next
            })
          } else if (chunk.type === 'tool_use_start') {
            pendingTools.set(chunk.id, { id: chunk.id, name: chunk.name, input: '' })
            setMessages((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') {
                const tools = [...(last.tools ?? [])]
                const existingIdx = tools.findIndex((t) => t.id === chunk.id)
                if (existingIdx >= 0) {
                  tools[existingIdx] = { id: chunk.id, name: chunk.name, input: '' }
                } else {
                  tools.push({ id: chunk.id, name: chunk.name, input: '' })
                }
                next[next.length - 1] = { ...last, tools }
              }
              return next
            })
          } else if (chunk.type === 'tool_use_delta') {
            const tool = pendingTools.get(chunk.id)
            if (tool) {
              tool.input += chunk.inputJson
              pendingTools.set(chunk.id, tool)
            }
          } else if (chunk.type === 'done') {
            setMessages((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last?.role === 'assistant') {
                next[next.length - 1] = {
                  ...last,
                  streaming: false,
                  usage: {
                    input: chunk.inputTokens,
                    output: chunk.outputTokens,
                    cacheRead: chunk.cacheReadTokens,
                    cacheWrite: chunk.cacheWriteTokens,
                  },
                }
              }
              // Mark thinking bubble as done
              let thinkIdx = -1
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i]?.role === 'thinking' && next[i]?.streaming) { thinkIdx = i; break }
              }
              if (thinkIdx >= 0) next[thinkIdx] = { ...next[thinkIdx]!, streaming: false }
              return next
            })
          } else if (chunk.type === 'error') {
            throw new Error(chunk.message)
          }
        }
      }

      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { ...last, streaming: false }
        }
        return next
      })
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev]
        if (next[next.length - 1]?.streaming) next.pop()
        return [...next, { role: 'assistant', content: `Error: ${e instanceof Error ? e.message : String(e)}` }]
      })
    } finally {
      setBusy(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  if (!isActive) return null

  return (
    <div className="flex flex-col h-full gap-0">
      {/* Panel header */}
      <div className="flex items-center justify-between pb-3 shrink-0 border-b border-slate-700/50 gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-slate-100">{agent.name ?? agent.agentId}</span>
          <span className="font-mono text-[10px] text-slate-500 truncate max-w-[240px]" title={currentThread}>
            🧵 {currentThread}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="relative">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setShowSessions((v) => !v); void refetchSessions() }}
            >
              🗂 Sessions ({agentSessions.length})
            </Button>
            {showSessions && (
              <div className="absolute right-0 top-full mt-1 w-80 bg-slate-900 ring-1 ring-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-700/60 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">Select Thread</span>
                  <button onClick={() => setShowSessions(false)} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <button
                    onClick={startNewThread}
                    className="w-full px-3 py-2.5 text-left hover:bg-slate-700/50 border-b border-slate-700/40 flex items-center gap-2"
                  >
                    <span className="text-emerald-400 text-xs">＋</span>
                    <span className="text-xs text-slate-300">New Thread</span>
                  </button>
                  {agentSessions.length === 0 && (
                    <p className="text-xs text-slate-500 px-3 py-3">No sessions yet.</p>
                  )}
                  {agentSessions.map((s) => (
                    <button
                      key={s.sessionKey}
                      onClick={() => loadSession(s)}
                      className={`w-full px-3 py-2.5 text-left hover:bg-slate-700/50 flex flex-col gap-0.5 ${
                        s.threadKey === currentThread ? 'bg-indigo-600/20' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-slate-300 truncate">{s.threadKey}</span>
                        {s.threadKey === currentThread && (
                          <span className="text-[10px] text-indigo-400 ml-1 shrink-0">active</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span>{s.messageCount} msgs</span>
                        <span>·</span>
                        <span>{timeAgo(s.lastActivity)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMessages([])
              void rpc('session.clear', { sessionKey: `agent:${agent.agentId}:${currentThread}` })
            }}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0 pt-3">
        {messages.length === 0 && (
          <div className="text-center text-slate-500 text-sm mt-12">
            Start a conversation with <span className="text-slate-300">{agent.name ?? agent.agentId}</span>…
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="pt-3 shrink-0">
        <div className="relative flex items-end gap-2 bg-slate-800/60 ring-1 ring-slate-700/50 rounded-xl p-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={busy}
            className="flex-1 bg-transparent text-slate-200 text-sm placeholder:text-slate-500 resize-none focus:outline-none min-h-10"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void sendMessage()}
            disabled={busy || !input.trim()}
          >
            {busy ? '…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Main ChatTab: left sidebar agent list + right panel ──────────────────────

export function ChatTab() {
  const [activeAgentId, setActiveAgentId] = useState<string>('')

  const { data: agentsResult, refetch } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
    [],
  )
  const agents: AgentInfo[] = Array.isArray(agentsResult?.agents) ? agentsResult.agents : []

  // Auto-select first agent when list first loads
  useEffect(() => {
    if (!activeAgentId && agents.length > 0) {
      setActiveAgentId(agents[0]!.agentId)
    }
  }, [agents, activeAgentId])

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-0">
      {/* Left: agent list sidebar */}
      <div className="w-48 shrink-0 flex flex-col border-r border-slate-700/50 pr-2 mr-3">
        <div className="flex items-center justify-between pb-3 shrink-0">
          <h1 className="text-sm font-semibold text-slate-100">Chat</h1>
          <Button size="sm" variant="ghost" onClick={refetch}>↺</Button>
        </div>
        <div className="flex flex-col gap-1 flex-1 overflow-y-auto">
          {agents.length === 0 && (
            <p className="text-xs text-slate-500 pt-2">No agents running.</p>
          )}
          {agents.map((a) => {
            const active = a.agentId === activeAgentId
            return (
              <button
                key={a.agentId}
                onClick={() => setActiveAgentId(a.agentId)}
                className={`flex flex-col items-start px-2.5 py-2 rounded-lg text-left w-full transition-all duration-100 ${
                  active
                    ? 'bg-indigo-600/30 text-indigo-200 ring-1 ring-indigo-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
                }`}
              >
                <span className="text-xs font-medium truncate w-full">{a.name ?? a.agentId}</span>
                {a.name && <span className="text-[10px] font-mono text-slate-500 truncate w-full">{a.agentId}</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* Right: per-agent chat panels */}
      <div className="flex-1 min-w-0">
        {agents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            No agents available. Start a gateway first.
          </div>
        ) : (
          agents.map((a) => (
            <AgentPanel key={a.agentId} agent={a} isActive={a.agentId === activeAgentId} />
          ))
        )}
      </div>
    </div>
  )
}

function ThinkingBubble({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs bg-slate-800/30 rounded-lg ring-1 ring-slate-700/30 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-slate-500 hover:text-slate-400 transition-colors"
      >
        <span className="text-[10px] leading-none">{open ? '▾' : '▸'}</span>
        <span className="italic">
          {msg.streaming ? (
            <span className="animate-pulse">Thinking…</span>
          ) : (
            `Reasoning (${msg.content.length} chars)`
          )}
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-3 whitespace-pre-wrap font-mono text-slate-500 text-[11px] border-t border-slate-700/30">
          {msg.content}
        </pre>
      )}
    </div>
  )
}

function ToolCallList({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {tools.map((tool) => (
        <div key={tool.id} className="flex items-center gap-2 text-[11px] bg-slate-900/60 ring-1 ring-slate-700/40 rounded-lg px-3 py-1.5">
          <span className="text-amber-400 font-mono font-semibold">{tool.name}</span>
          {tool.input && (
            <span className="text-slate-500 truncate max-w-[260px] font-mono">{tool.input}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function TokenBadge({ usage }: { usage: TokenUsage }) {
  const total = usage.input + usage.output
  const cacheNote = usage.cacheRead ? ` · ${usage.cacheRead.toLocaleString()} cached` : ''
  return (
    <div className="text-[10px] text-slate-600 mt-1 text-right font-mono">
      {usage.input.toLocaleString()}↑ {usage.output.toLocaleString()}↓ · {total.toLocaleString()} tokens{cacheNote}
    </div>
  )
}

function ChatBubble({ msg }: { msg: Message }) {
  if (msg.role === 'thinking') {
    return <ThinkingBubble msg={msg} />
  }

  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-indigo-600/80 text-slate-100 rounded-br-sm'
            : 'bg-slate-800/80 ring-1 ring-slate-700/50 rounded-bl-sm'
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <MarkdownView content={msg.content} />
            {msg.tools && msg.tools.length > 0 && <ToolCallList tools={msg.tools} />}
            {msg.streaming && (
              <span className="text-xs text-slate-500 animate-pulse">typing…</span>
            )}
          </div>
        )}
        {!isUser && !msg.streaming && msg.content && (
          <div className="mt-1.5 flex justify-end">
            <CopyButton text={msg.content} />
          </div>
        )}
        {!isUser && !msg.streaming && msg.usage && <TokenBadge usage={msg.usage} />}
      </div>
    </div>
  )
}
