import { cn } from '@/lib/utils';
import type { SessionSummary, SessionStatusGroup } from '@/types/api';

const statusConfig: Record<
  SessionStatusGroup,
  { label: string; className: string; pulse?: boolean }
> = {
  'needs-input': {
    label: 'Needs Input',
    className:
      'bg-status-blocked/20 text-status-blocked border-status-blocked/30',
  },
  active: {
    label: 'Running',
    className:
      'bg-status-running/20 text-status-running border-status-running/30',
    pulse: true,
  },
  completed: {
    label: 'Done',
    className: 'bg-muted text-muted-foreground border-border',
  },
};

export function classifySession(
  session: SessionSummary,
  pendingSessionIds: Set<string>,
  busySessionIds?: Set<string>,
): SessionStatusGroup {
  if (pendingSessionIds.has(session.id)) return 'needs-input';
  // A live session is only shown as "Running" when it actually has a turn in
  // flight. When isBusy is false (turn finished or was stopped) the badge
  // reverts to "Done" so the sidebar clears promptly after Stop.
  if (session.mode === 'live') return busySessionIds?.has(session.id) ? 'active' : 'completed';
  if (session.alive) return 'active';
  return 'completed';
}

export function SessionStatusBadge({
  status,
  className,
}: {
  status: SessionStatusGroup;
  className?: string;
}) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        config.className,
        className,
      )}
    >
      {config.pulse && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {config.label}
    </span>
  );
}
