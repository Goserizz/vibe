import type { Monitor } from '../../../shared/protocol.js';
import { summarizeSessionMonitors, type SessionMonitorSummary } from '../../../shared/monitorSummary.js';
import { createMonitorRequestLoader, type MonitorRequestStatus } from './monitorRequests.js';

/** Coalesce WS bursts, re-fetch changes arriving during a request, and discard
 * replies from an old login. No per-session polling or eager agent startup. */
export function createMonitorSummaryLoader(
  fetchMonitors: (signal: AbortSignal) => Promise<Monitor[]>,
  commit: (summaries: Record<string, SessionMonitorSummary>, monitors: Monitor[]) => void,
  report?: (status: MonitorRequestStatus) => void,
): { refresh: () => Promise<void>; reset: () => void } {
  return createMonitorRequestLoader(
    fetchMonitors,
    (monitors) => commit(summarizeSessionMonitors(monitors), monitors),
    report,
  );
}
