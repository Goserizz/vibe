import type { Monitor } from './protocol.js';

/** Sidebar-only aggregate; never contains probe commands, credentials or runbooks. */
export interface SessionMonitorSummary {
  total: number;
  enabled: number;
  attention: number;
}

type MonitorState = Pick<Monitor, 'sessionId' | 'enabled' | 'status' | 'consecutiveFailures'>;

/** Rebuild from the account-scoped snapshot so deletion/rebinding clears old badges. */
export function summarizeSessionMonitors(monitors: readonly MonitorState[]): Record<string, SessionMonitorSummary> {
  const summaries = new Map<string, SessionMonitorSummary>();
  for (const monitor of monitors) {
    if (!monitor.sessionId) continue;
    const summary = summaries.get(monitor.sessionId) ?? { total: 0, enabled: 0, attention: 0 };
    summary.total++;
    if (monitor.enabled) {
      summary.enabled++;
      // A recheck must not clear an alert before a healthy result arrives.
      if (monitor.status === 'firing' || monitor.status === 'error' || monitor.consecutiveFailures > 0) summary.attention++;
    }
    summaries.set(monitor.sessionId, summary);
  }
  return Object.fromEntries(summaries);
}

export function monitorBadgeInfo(summary?: SessionMonitorSummary): {
  tone: 'enabled' | 'attention' | 'paused';
  label: string;
} | null {
  if (!summary?.total) return null;
  const { total, enabled, attention } = summary;
  const tone = attention ? 'attention' : enabled ? 'enabled' : 'paused';
  const label = `Monitors: ${enabled}/${total} enabled`
    + (attention ? `; ${attention} need attention` : '')
    + (!enabled ? '; all paused or draft' : enabled < total ? `; ${total - enabled} paused or draft` : '');
  return { tone, label };
}
