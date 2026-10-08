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
  dismissedRuns?: string[];
  finishedCollapsed?: boolean;
  actionPending: boolean;
  uiConfig: { pollMs: number; idlePollMs: number; wakeDebounceMs: number; maxWakesPerHour: number };
}
declare module 'claude-code' {
  interface PluginState { stampede: { ui: StampedeUiState } }
}
