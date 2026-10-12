import path from 'node:path';
import { readJournal } from './store.js';
import { git, type Workspace } from './workspaces.js';
import type { BoardEntry, Message } from './bus.js';
export interface TeamRecord { teamKey: string; occ: number; runId: string; status: string; members: { name: string; status: string; result: unknown; markedDone: boolean; effects: Workspace; cacheable: boolean; externalTools?: string[] }[]; boardEntries: BoardEntry[]; messages: Message[] }
export interface CallRecord { key: string; occ: number; agentId: string; status: string; result: unknown; cacheable: boolean; tainted: boolean; effects: Workspace; inputs: unknown; shared?: { reads: string[]; writes: string[] }; externalTools?: string[] }
export class RunCache {
  private occurrences = new Map<string, number>();
  private records = new Map<string, CallRecord>();
  private teams = new Map<string, TeamRecord>();
  readonly verificationFailures: string[] = [];
  readonly notCacheable: { label: string; reason: string }[] = [];
  readonly cachedExternalTools: { label: string; tools: string[] }[] = [];
  /** Agents the resumed run finished that start again, and why. */
  readonly misses: { label: string; reason: string }[] = [];
  async load(runDirectory: string) {
    for (const record of await readJournal<CallRecord>(path.join(runDirectory, 'journal.jsonl'))) if (record.key) this.records.set(`${record.key}:${record.occ}`, record);
    for (const record of await readJournal<TeamRecord>(path.join(runDirectory, 'teams.jsonl'))) if (record.teamKey) this.teams.set(`${record.teamKey}:${record.occ}`, record);
  }
  next(key: string) { const n = this.occurrences.get(key) ?? 0; this.occurrences.set(key, n + 1); return n; }
  async lookup(key: string, occ: number) {
    const record = this.records.get(`${key}:${occ}`);
    if (!record || record.status !== 'done' || !record.cacheable || record.tainted) return undefined;
    return await this.verify(record.effects) ? record : undefined;
  }
  /** Why a lookup of a call whose key is unchanged found nothing to replay. */
  missReason(key: string, occ: number) {
    const record = this.records.get(`${key}:${occ}`);
    return !record ? 'its result was not recorded there' : record.status !== 'done' ? `it ended ${record.status} there` : record.tainted ? 'messages or shared tools fed into it there, so its result rests on more than its call' : !record.cacheable ? 'it was not cacheable there' : 'its branch is no longer at the commit it finished at';
  }
  async lookupTeam(key: string, occ: number) {
    const record = this.teams.get(`${key}:${occ}`);
    if (!record || record.status !== 'complete' || record.members.some(m => !m.cacheable || m.status !== 'done')) return undefined;
    for (const member of record.members) if (!await this.verify(member.effects)) return undefined;
    return record;
  }
  private async verify(effects: Workspace) {
    if (effects.kind === 'worktree' && effects.kept) {
      try { if (await git(effects.repo!, ['rev-parse', effects.branch!]) !== effects.commit) throw new Error('branch changed'); }
      catch { this.verificationFailures.push(`${effects.branch}: branch no longer at cached commit`); return false; }
    }
    return true;
  }
}
