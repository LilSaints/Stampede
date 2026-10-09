/**
 * Named locks held by workers across every run of the hub, for a resource
 * only one may use at a time (a real desktop window, a device). A worker takes
 * one with the `lock` tool and gives it back with `unlock`; the hub also takes
 * it back when the worker's turn ends or the agent does, so a worker that dies
 * never leaves it held. Waiters are served in the order they asked.
 */
export interface LockHolder { id: string; label: string }
interface Held extends LockHolder { since: string }
interface Waiter { holder: LockHolder; grant: () => void }

export class Locks {
  private held = new Map<string, Held>();
  private waiters = new Map<string, Waiter[]>();

  /** Takes `name` for `holder`, waiting up to `waitMs` behind earlier askers; false when the wait ran out or was aborted. */
  async acquire(name: string, holder: LockHolder, waitMs: number, signal?: AbortSignal): Promise<boolean> {
    const current = this.held.get(name);
    if (!current) { this.held.set(name, { ...holder, since: new Date().toISOString() }); return true; }
    if (current.id === holder.id) return true;
    if (signal?.aborted || waitMs <= 0) return false;
    return new Promise(resolve => {
      const queue = this.waiters.get(name) ?? [];
      let timer: NodeJS.Timeout | undefined;
      const leave = () => { clearTimeout(timer); signal?.removeEventListener('abort', give); const rest = (this.waiters.get(name) ?? []).filter(w => w !== waiter); if (rest.length) this.waiters.set(name, rest); else this.waiters.delete(name); };
      const give = () => { leave(); resolve(false); };
      const waiter: Waiter = { holder, grant: () => { leave(); this.held.set(name, { ...holder, since: new Date().toISOString() }); resolve(true); } };
      queue.push(waiter); this.waiters.set(name, queue);
      timer = setTimeout(give, waitMs);
      signal?.addEventListener('abort', give, { once: true });
    });
  }
  /** Gives `name` back if `holderId` holds it, to the next waiter; whether it was held. */
  release(name: string, holderId: string) {
    if (this.held.get(name)?.id !== holderId) return false;
    this.held.delete(name);
    this.waiters.get(name)?.[0]?.grant();
    return true;
  }
  /** Gives back every lock `holderId` holds: its turn or the agent ended. */
  releaseAll(holderId: string) {
    const names = [...this.held].filter(([, held]) => held.id === holderId).map(([name]) => name);
    for (const name of names) this.release(name, holderId);
    return names;
  }
  holder(name: string): Held | undefined { return this.held.get(name); }
  /** Each held lock: its holder, since when, and how many wait for it. */
  snapshot() { return [...this.held].map(([name, held]) => ({ name, holder: held.label, since: held.since, waiting: this.waiters.get(name)?.length ?? 0 })); }
}
