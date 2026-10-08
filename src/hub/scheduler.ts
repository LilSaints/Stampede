export type Backend = 'claude' | 'codex';
export interface Slot { id: string; name: string; runId: string; backend: Backend; comms: boolean }
export interface SchedulerConfig { global: number; perRun: number; claude: number; codex: number; reserve: number; admissionMaxMs: number }
interface Entry { slots: Slot[]; resolve: (release: (id?: string) => void) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; cleanup: () => void }
export class AdmissionError extends Error {
  readonly kind = 'admission_timeout';
  constructor(readonly waitedMs: number, readonly blockedBy: string[]) { super(`admission_timeout after ${waitedMs}ms; reservations held by ${blockedBy.join(', ')}`); }
}

/** Reservations count against all three caps until explicitly released. */
export class Scheduler {
  private held = new Map<string, Slot>();
  private queue: Entry[] = [];
  private paused = new Set<string>();
  private lastRun: Partial<Record<Backend, string>> = {};
  private cooldown = new Map<Backend, { cap: number; next: number }>();
  private runLimits = new Map<string, SchedulerConfig>();
  readonly config: SchedulerConfig;
  constructor(config: SchedulerConfig) {
    this.config = { ...config, perRun: Math.min(config.perRun, config.global), claude: Math.min(config.claude, config.global), codex: Math.min(config.codex, config.global) };
    for (const key of ['global', 'perRun', 'claude', 'codex', 'reserve'] as const) if (!Number.isInteger(this.config[key]) || this.config[key] < (key === 'reserve' ? 0 : 1)) throw new Error(`invalid scheduler ${key}`);
    if (config.reserve < 1 || config.reserve > Math.min(this.config.global, this.config.perRun, this.config.claude, this.config.codex)) throw new Error('nonCommsReserve must be at least 1 and fit every cap');
    if (!Number.isFinite(config.admissionMaxMs) || config.admissionMaxMs <= 0) throw new Error('invalid admissionMaxMs');
  }
  validate(slots: Slot[]) {
    if (!slots.length || new Set(slots.map(s => s.id)).size !== slots.length) throw new Error('invalid scheduler entry');
    if (slots.some(s => s.runId !== slots[0].runId || s.comms !== slots[0].comms)) throw new Error('gang members must belong to one run and pool');
    if (!slots[0].comms && slots.length !== 1) throw new Error('non-comms entries must be individual turns');
    const limit = this.runLimits.get(slots[0].runId) ?? this.config;
    const reserve = slots[0].comms ? this.config.reserve : 0;
    for (const backend of ['claude', 'codex'] as const) if (slots.filter(s => s.backend === backend).length > Math.min(this.config[backend], limit[backend]) - reserve) throw new Error(`team does not fit: ${backend} comms pool`);
    if (slots.length > Math.min(this.config.global, this.config.perRun, limit.global, limit.perRun) - reserve) throw new Error('team does not fit: global/per-run comms pool');
  }
  configureRun(runId: string, limits: SchedulerConfig) { this.runLimits.set(runId, limits); }
  forgetRun(runId: string) { this.runLimits.delete(runId); this.paused.delete(runId); }
  rejectBackend(runId: string, backend: Backend, error: Error) {
    const rejected = this.queue.filter(e => e.slots.some(s => s.runId === runId && s.backend === backend));
    this.queue = this.queue.filter(e => !rejected.includes(e));
    for (const entry of rejected) { entry.cleanup(); entry.reject(error); }
    this.drain();
  }
  acquire(slots: Slot[], signal?: AbortSignal): Promise<(id?: string) => void> {
    this.validate(slots);
    if (slots.some(s => this.held.has(s.id) || this.queue.some(e => e.slots.some(t => t.id === s.id)))) throw new Error('duplicate scheduler slot');
    if (signal?.aborted) return Promise.reject(new Error('run cancelled'));
    return new Promise((resolve, reject) => {
      const entry: Entry = { slots, resolve, reject, cleanup: () => { clearTimeout(entry.timer); signal?.removeEventListener('abort', abort); } };
      const remove = (error: Error) => { const index = this.queue.indexOf(entry); if (index < 0) return; this.queue.splice(index, 1); entry.cleanup(); reject(error); this.drain(); };
      const abort = () => remove(new Error('run cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      const maxMs = Math.min(this.config.admissionMaxMs, this.runLimits.get(slots[0].runId)?.admissionMaxMs ?? Infinity);
      if (slots[0].comms) entry.timer = setTimeout(() => remove(new AdmissionError(maxMs, this.blockers(slots))), maxMs);
      this.queue.push(entry);
      this.drain();
    });
  }
  pause(runId: string, paused: boolean) { paused ? this.paused.add(runId) : this.paused.delete(runId); this.drain(); }
  blockingSlots(slots: Slot[]) { return [...this.held.values()].filter(s => s.comms && (s.runId === slots[0].runId || slots.some(t => t.backend === s.backend) || this.held.size >= this.config.global - this.config.reserve)); }
  blockers(slots: Slot[]) { return this.blockingSlots(slots).map(s => s.name); }
  snapshot() { return { held: [...this.held.values()], queued: this.queue.map(e => e.slots), paused: [...this.paused] }; }
  rateLimited(backend: Backend, now = Date.now()) {
    const current = this.capacity(backend, now);
    this.cooldown.set(backend, { cap: Math.max(1, Math.floor(current / 2)), next: now + 60000 });
  }
  tick(now = Date.now()) { for (const backend of ['claude', 'codex'] as const) this.capacity(backend, now); this.drain(); }
  private capacity(backend: Backend, now = Date.now()) {
    const state = this.cooldown.get(backend);
    if (!state) return this.config[backend];
    if (now >= state.next) { const steps = 1 + Math.floor((now - state.next) / 30000); state.cap = Math.min(this.config[backend], state.cap + steps); state.next += steps * 30000; }
    if (state.cap === this.config[backend]) this.cooldown.delete(backend);
    return state.cap;
  }
  private fits(slots: Slot[]): boolean {
    const held = [...this.held.values()];
    const comms = slots[0].comms;
    const run = slots[0].runId, limit = this.runLimits.get(run) ?? this.config;
    const limits: [Slot[], Slot[], number][] = [
      [held, slots, this.config.global],
      [held.filter(s => s.runId === run), slots, Math.min(this.config.perRun, limit.global, limit.perRun)],
      ...(['claude', 'codex'] as const).map(backend => [held.filter(s => s.runId === run && s.backend === backend), slots.filter(s => s.backend === backend), limit[backend]] as [Slot[], Slot[], number]),
      ...(['claude', 'codex'] as const).map(backend => [held.filter(s => s.backend === backend), slots.filter(s => s.backend === backend), this.capacity(backend)] as [Slot[], Slot[], number])
    ];
    return limits.every(([existing, requested, cap]) => !requested.length || (existing.length + requested.length <= cap && (!comms || existing.filter(s => s.comms).length + requested.length <= cap - this.config.reserve)));
  }
  private drain() {
    // A blocked gang fences later comms entries on each involved backend.
    // Non-comms always bypass this fence and can consume their reserve.
    for (;;) {
      const blocked = new Set<Backend>();
      const eligible: Entry[] = [];
      for (const entry of this.queue) {
        if (this.paused.has(entry.slots[0].runId)) continue;
        const backends = new Set(entry.slots.map(s => s.backend));
        if (entry.slots[0].comms && [...backends].some(b => blocked.has(b))) continue;
        if (this.fits(entry.slots)) eligible.push(entry);
        else if (entry.slots[0].comms) backends.forEach(b => blocked.add(b));
      }
      if (!eligible.length) return;
      // Prefer a competing run, while preserving queue order within a run.
      const entry = eligible.find(e => e.slots.every(s => this.lastRun[s.backend] !== s.runId)) ?? eligible[0];
      this.queue.splice(this.queue.indexOf(entry), 1);
      entry.cleanup();
      for (const slot of entry.slots) { this.held.set(slot.id, slot); this.lastRun[slot.backend] = slot.runId; }
      const remaining = new Set(entry.slots.map(s => s.id));
      entry.resolve(id => { for (const key of [...remaining]) if (!id || key === id) { this.held.delete(key); remaining.delete(key); } this.drain(); });
    }
  }
}
