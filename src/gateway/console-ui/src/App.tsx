import { Suspense, lazy, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { Toast } from './components/Toast.js';
import { LocaleProvider } from './context/i18n.js';
import { WorkflowRunProvider } from './context/workflow-run.js';
import { rpc } from './hooks/useRpc.js';
import { ToastContext, useToastState } from './hooks/useToast.js';
import { SetupWizard } from './tabs/SetupWizard.js';
import type { ChatRecoveryContext, ChatRecoveryMode } from './types.js';

type TabId =
  | 'overview'
  | 'agents'
  | 'chat'
  | 'inbox'
  | 'logs'
  | 'config'
  | 'deliverables'
  | 'scheduler'
  | 'sessions'
  | 'workflow'
  | 'memory'
  | 'federation'
  | 'guide'
  | 'about';

const OverviewTab = lazy(() =>
  import('./tabs/OverviewTab.js').then((m) => ({ default: m.OverviewTab })),
);
const AgentsTab = lazy(() => import('./tabs/AgentsTab.js').then((m) => ({ default: m.AgentsTab })));
const ChatTab = lazy(() => import('./tabs/ChatTab.js').then((m) => ({ default: m.ChatTab })));
const InboxTab = lazy(() => import('./tabs/ChatTab.js').then((m) => ({ default: m.InboxTab })));
const LogsTab = lazy(() => import('./tabs/LogsTab.js').then((m) => ({ default: m.LogsTab })));
const ConfigTab = lazy(() => import('./tabs/ConfigTab.js').then((m) => ({ default: m.ConfigTab })));
const DeliverablesTab = lazy(() =>
  import('./tabs/DeliverablesTab.js').then((m) => ({ default: m.DeliverablesTab })),
);
const SchedulerTab = lazy(() =>
  import('./tabs/SchedulerTab.js').then((m) => ({ default: m.SchedulerTab })),
);
const SessionsTab = lazy(() =>
  import('./tabs/SessionsTab.js').then((m) => ({ default: m.SessionsTab })),
);
const WorkflowTab = lazy(() =>
  import('./tabs/WorkflowTab.js').then((m) => ({ default: m.WorkflowTab })),
);
const MemoryTab = lazy(() => import('./tabs/MemoryTab.js').then((m) => ({ default: m.MemoryTab })));
const FederationTab = lazy(() =>
  import('./tabs/FederationTab.js').then((m) => ({ default: m.FederationTab })),
);
const DocsTab = lazy(() => import('./tabs/DocsTab.js').then((m) => ({ default: m.DocsTab })));
const AboutTab = lazy(() => import('./tabs/AboutTab.js').then((m) => ({ default: m.AboutTab })));

const TAB_MAP: Record<TabId, React.ComponentType> = {
  overview: OverviewTab,
  agents: AgentsTab,
  chat: ChatTab,
  inbox: InboxTab,
  logs: LogsTab,
  config: ConfigTab,
  deliverables: DeliverablesTab,
  scheduler: SchedulerTab,
  sessions: SessionsTab,
  workflow: WorkflowTab,
  memory: MemoryTab,
  federation: FederationTab,
  guide: DocsTab,
  about: AboutTab,
};

function Spinner() {
  return (
    <div className="flex items-center justify-center h-32 gap-2.5">
      <div className="w-4 h-4 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
      <span className="text-sm text-slate-500">Loading…</span>
    </div>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [sessionsAgentFilter, setSessionsAgentFilter] = useState('all');
  const [sessionsErrorCodeFilter, setSessionsErrorCodeFilter] = useState('all');
  const [chatAgentId, setChatAgentId] = useState('');
  const [chatThreadKey, setChatThreadKey] = useState('');
  const [chatRecoveryContext, setChatRecoveryContext] = useState<ChatRecoveryContext | null>(null);
  const toastState = useToastState();
  const ActiveTab = TAB_MAP[activeTab];

  // ── First-run detection ─────────────────────────────────────────────────
  const [setupChecked, setSetupChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    rpc<{ models?: Record<string, { models?: Record<string, unknown> }> }>('config.get')
      .then((cfg) => {
        // Unconfigured if no model groups exist, or none of them contain actual model entries
        const hasModels = Object.values(cfg.models ?? {}).some(
          (g) => Object.keys(g?.models ?? {}).length > 0,
        );
        setNeedsSetup(!hasModels);
      })
      .catch(() => setNeedsSetup(false))
      .finally(() => setSetupChecked(true));
  }, []);

  function handleSetupDone(goToChat?: boolean) {
    setNeedsSetup(false);
    if (goToChat) setActiveTab('chat');
  }

  function handleNavigate(
    tab: string,
    options?: {
      sessionAgentId?: string;
      sessionErrorCode?: string;
      chatAgentId?: string;
      chatThreadKey?: string;
      chatRecoveryErrorCode?: string;
      chatRecoveryMode?: ChatRecoveryMode;
    },
  ): void {
    const nextTab = tab as TabId;
    if (nextTab === 'sessions') {
      setSessionsAgentFilter(options?.sessionAgentId ?? 'all');
      setSessionsErrorCodeFilter(options?.sessionErrorCode ?? 'all');
    }
    if (nextTab === 'chat') {
      setChatAgentId(options?.chatAgentId ?? '');
      setChatThreadKey(options?.chatThreadKey ?? '');
      if (options?.chatAgentId && options?.chatThreadKey && options?.chatRecoveryErrorCode) {
        setChatRecoveryContext({
          eventId: Date.now(),
          agentId: options.chatAgentId,
          threadKey: options.chatThreadKey,
          errorCode: options.chatRecoveryErrorCode,
          mode: options.chatRecoveryMode ?? 'continue',
        });
      } else {
        setChatRecoveryContext(null);
      }
    }
    setActiveTab(nextTab);
  }

  return (
    <LocaleProvider>
      <WorkflowRunProvider>
        <ToastContext.Provider value={toastState}>
        {/* First-run setup wizard — shown full-page when models/agents are not yet configured */}
        {setupChecked && needsSetup ? (
          <SetupWizard onDone={handleSetupDone} />
        ) : (
          <div
            className="flex min-h-screen text-slate-200"
            style={{ backgroundColor: '#07090f', fontFamily: "'Outfit', system-ui, sans-serif" }}
          >
            <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
            <main
              className="flex-1 p-6 overflow-auto"
              style={{
                background:
                  'radial-gradient(ellipse 80% 50% at 20% -10%, rgba(99,102,241,0.06) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(139,92,246,0.04) 0%, transparent 55%)',
              }}
            >
              <Suspense fallback={<Spinner />}>
                {activeTab === 'overview' ? (
                  <OverviewTab onNavigate={handleNavigate} />
                ) : activeTab === 'agents' ? (
                  <AgentsTab onNavigate={handleNavigate} />
                ) : activeTab === 'chat' ? (
                  <ChatTab
                    initialAgentId={chatAgentId}
                    initialThreadKey={chatThreadKey}
                    initialRecoveryContext={chatRecoveryContext}
                    onOpenInbox={() => setActiveTab('inbox')}
                  />
                ) : activeTab === 'inbox' ? (
                  <InboxTab
                    onOpenChat={({ agentId, threadKey }) => {
                      setChatAgentId(agentId ?? '');
                      setChatThreadKey(threadKey ?? '');
                      setChatRecoveryContext(null);
                      setActiveTab('chat');
                    }}
                  />
                ) : activeTab === 'sessions' ? (
                  <SessionsTab
                    initialAgentFilter={sessionsAgentFilter}
                    initialErrorCodeFilter={sessionsErrorCodeFilter}
                    onNavigate={handleNavigate}
                  />
                ) : (
                  <ActiveTab />
                )}
              </Suspense>
            </main>
          </div>
        )}
        <Toast toasts={toastState.toasts} />
      </ToastContext.Provider>
    </WorkflowRunProvider>
    </LocaleProvider>
  );
}
