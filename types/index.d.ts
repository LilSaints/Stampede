export interface StampedeUiState {
  stampedeHome?: string;
  hub: { url: string | null; ok: boolean; lastError?: string; versionMismatch?: boolean };
  hubSeq: number;
  runs: Record<string, any>;
  ownedRunIds: string[];
  /** Expanded run cards, newest opened first; null until one is chosen, which opens the newest run. */
  openRuns: string[] | null;
  paneOpen: boolean;
  busy: boolean;
  pendingWake: { runId: string; hubSeq: number; kind: string; text: string }[];
  wakeTimes: number[];
  wakeInFlight?: boolean;
  wakeSeen?: Record<string, number>;
  wakeEnabled: boolean;
  compactBand?: boolean;
  dismissedAlertSeq?: number;
  toastPending?: { runId: string; hubSeq: number; text: string }[];
  wakeLimitNotified?: boolean;
  wakeLimitToastPending?: boolean;
  pendingSince: number;
  lastTrigger: number;
  lastToast: number;
  /** The run whose Stop is asking to confirm. */
  cancelConfirm: string | false;
  expandedPhases?: Record<string, boolean>;
  /** Agents' transcripts open in panes of their own, by pane id, as the hub last gave them; `open` names the folds expanded (`g<entry>` a tool group, `p<entry>` a long prompt). */
  transcripts?: Record<string, { runId: string; agent: string; title: string; backend: string; model: string | null; status: string; entries: { kind: 'prompt' | 'text' | 'tool' | 'error' | 'turn'; text: string; tool?: string }[]; omitted: number; fetched: boolean; open?: string[] }>;
  dismissedRuns?: string[];
  finishedCollapsed?: boolean;
  actionPending: boolean;
  uiConfig: { pollMs: number; idlePollMs: number; wakeDebounceMs: number; maxWakesPerHour: number };
}
declare module 'claude-code' {
  interface PluginState { stampede: { ui: StampedeUiState } }
}
