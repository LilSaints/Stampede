export interface StampedeUiState {
  stampedeHome?: string;
  hub: { url: string | null; ok: boolean; lastError?: string; versionMismatch?: boolean };
  hubSeq: number;
  runs: Record<string, any>;
  ownedRunIds: string[];
  selectedRunId: string | null;
  paneOpen: boolean;
  busy: boolean;
  pendingWake: { runId: string; hubSeq: number; kind: string; text: string }[];
  wakeTimes: number[];
  composer: { to: string; text: string } | null;
  inFlight: boolean;
  wakeInFlight?: boolean;
  wakeSeen?: Record<string, number>;
  lastPoll: number;
  wakeEnabled: boolean;
  pendingSince: number;
  lastTrigger: number;
  lastToast: number;
  cancelConfirm: boolean;
  actionPending: boolean;
  uiConfig: { pollMs: number; idlePollMs: number; wakeDebounceMs: number; maxWakesPerHour: number };
}
declare module 'claude-code' {
  interface PluginState { stampede: { ui: StampedeUiState } }
}
