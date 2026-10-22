import { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, ArrowDown } from 'lucide-react';
import { Sidebar } from './components/sidebar';
import type { NavItem } from './components/sidebar';
import { CommandPalette } from './components/command-palette';
import { KeyboardShortcuts } from './components/keyboard-shortcuts';
import { SessionMeter } from './components/session-meter';
import { MemoryView } from './components/memory-view';
import { SchedulesView } from './components/schedules-view';
import { BgJobsView } from './components/bg-jobs-view';
import { HandoffsView } from './components/handoffs-view';
import { SettingsView } from './components/settings-view';
import { Composer } from './components/composer';
import { ApprovalCards } from './components/approval-cards';
import { MobileSidebar, HamburgerButton } from './components/mobile-sidebar';
import { ToastProvider, useToast } from './components/toast';
import { useSessions } from './hooks/use-sessions';
import { usePendingApprovals } from './hooks/use-pending-approvals';
import { useTranscript } from './hooks/use-transcript';
import { useScrollPin } from './hooks/use-scroll-pin';
import { useQueue } from './hooks/use-queue';
import { useCommandOutputs } from './hooks/use-command-outputs';
import { SessionContent } from './components/session-content';
import { apiFetch } from './lib/api';

export function App() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}

function Dashboard() {
  const { sessions, loading } = useSessions();
  const { approvals, pendingSessionIds } = usePendingApprovals();
  const { toast } = useToast();

  const [activeNav, setActiveNav] = useState<NavItem>('sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const { items, totals, status, turnActive, liveTurns } = useTranscript(selectedSessionId);
  const { containerRef, scrollToBottom, isPinned, showScrollButton } = useScrollPin();

  // Per-session client-local command output items (not persisted; see use-command-outputs).
  const { itemsFor: cmdItemsFor, addItem: addCmdItem } = useCommandOutputs();
  const cmdItems = cmdItemsFor(selectedSessionId);

  // Auto-scroll when new transcript items arrive and user is pinned to the bottom.
  useEffect(() => {
    if (isPinned) scrollToBottom();
  }, [items.length, cmdItems.length, isPinned, scrollToBottom]);

  const handleNavigate = (nav: string) => {
    setActiveNav(nav as NavItem);
    setMobileSidebarOpen(false);
  };

  const handleSelectSession = (id: string) => {
    setSelectedSessionId(id);
    setMobileSidebarOpen(false);
  };

  const isBusy = turnActive;
  const [selectedModel, setSelectedModel] = useState('sonnet');

  const handleNewSession = useCallback(async () => {
    try {
      const result = await apiFetch<{ session: { id: string } }>('/api/sessions', { method: 'POST', body: JSON.stringify({ model: selectedModel }) });
      setSelectedSessionId(result.session.id);
    } catch {
      // best-effort
    }
  }, [selectedModel]);

  // Abort controller ref: abort in-flight POSTs when the session changes.
  const abortRef = useRef<AbortController | null>(null);

  const submitPrompt = useCallback(async (text: string) => {
    if (!selectedSessionId) throw new Error('no session');
    const controller = new AbortController();
    abortRef.current = controller;
    await apiFetch(`/api/sessions/${selectedSessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  }, [selectedSessionId]);

  const queue = useQueue({
    submit: submitPrompt,
    isLive: selectedSession?.mode === 'live',
  });

  // Track the previous liveTurns value to detect new turn completions.
  const prevTurnsRef = useRef(0);

  // Clear the queue, abort in-flight POST, and clear command outputs when session changes.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    queue.clear();
    prevTurnsRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queue identity stable; selectedSessionId is the real dep
  }, [selectedSessionId]);

  // Flush the queue when a live turn completes.
  useEffect(() => {
    if (liveTurns > prevTurnsRef.current) {
      void queue.flush();
    }
    prevTurnsRef.current = liveTurns;
  }, [liveTurns, queue.flush]);

  const sidebarContent = (
    <Sidebar
      sessions={sessions}
      pendingSessionIds={pendingSessionIds}
      selectedSessionId={selectedSessionId}
      onSelectSession={handleSelectSession}
      activeNav={activeNav}
      onNavChange={handleNavigate}
      collapsed={sidebarCollapsed}
      onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
    />
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <CommandPalette onNavigate={handleNavigate} />
      <KeyboardShortcuts onNavigate={handleNavigate} />

      {/* Desktop sidebar */}
      <div className="hidden md:block">{sidebarContent}</div>

      {/* Mobile sidebar */}
      <MobileSidebar
        open={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
      >
        {sidebarContent}
      </MobileSidebar>

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <div className="flex items-center gap-3">
            <HamburgerButton
              className="md:hidden"
              onClick={() => setMobileSidebarOpen(true)}
            />
            <h1 className="text-sm font-medium text-muted-foreground">
              {activeNav === 'sessions' && 'Sessions'}
              {activeNav === 'memory' && 'Memory'}
              {activeNav === 'schedules' && 'Schedules'}
              {activeNav === 'jobs' && 'Background Jobs'}
              {activeNav === 'handoffs' && 'Pending Handoffs'}
              {activeNav === 'settings' && 'Settings'}
            </h1>
            {activeNav === 'sessions' && selectedSession && (
              <StreamStatusDot status={status} />
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeNav === 'sessions' && (
              <button
                onClick={() => void handleNewSession()}
                title="New Session"
                className="flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
            {activeNav === 'sessions' && selectedSession && (
              <SessionMeter totals={totals} />
            )}
            <kbd className="hidden rounded border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
              ⌘K
            </kbd>
          </div>
        </header>

        {/* Content area */}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {showScrollButton && activeNav === 'sessions' && (
            <button
              onClick={scrollToBottom}
              className="animate-fade-in fixed bottom-24 left-1/2 z-20 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg hover:bg-brand/90 transition-colors"
            >
              <ArrowDown className="size-3" />
              New messages
            </button>
          )}
          <div ref={containerRef} className="relative flex flex-1 flex-col overflow-y-auto">
            <div className="flex-1">
              {activeNav === 'sessions' && (
                <SessionContent
                  loading={loading}
                  sessions={sessions}
                  selectedSession={selectedSession}
                  items={items}
                  cmdItems={cmdItems}
                  totals={totals}
                  status={status}
                  turnActive={turnActive}
                />
              )}
              {activeNav === 'memory' && <MemoryView />}
              {activeNav === 'schedules' && <SchedulesView />}
              {activeNav === 'jobs' && <BgJobsView />}
              {activeNav === 'handoffs' && <HandoffsView />}
              {activeNav === 'settings' && <SettingsView />}
            </div>

            {/* Composer + approvals (sessions view only, live sessions) */}
            {activeNav === 'sessions' && selectedSession && selectedSession.mode === 'live' && (
              <div className="shrink-0">
                {approvals.length > 0 && (
                  <ApprovalCards approvals={approvals} />
                )}
                <Composer
                  sessionId={selectedSession.id}
                  sessionMode={selectedSession.mode}
                  isBusy={isBusy}
                  queue={queue}
                  onModelSelect={setSelectedModel}
                  currentModel={selectedModel}
                  onCommandOutput={(input, response) =>
                    addCmdItem(selectedSession.id, input, response, items.length)}
                  onToast={(msg) => toast(msg, 'info')}
                />
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------


function StreamStatusDot({ status }: { status: string }) {
  if (status === 'open') {
    return <span className="size-2 rounded-full bg-status-running" title="Live" />;
  }
  if (status === 'connecting' || status === 'reconnecting') {
    return <span className="size-2 animate-pulse rounded-full bg-status-blocked" title={status} />;
  }
  if (status === 'ended') {
    return <span className="size-2 rounded-full bg-muted-foreground" title="Session ended" />;
  }
  return null;
}
