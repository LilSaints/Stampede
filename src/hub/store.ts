import { mkdir, open, readFile, rename, rm, readdir, truncate, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) { if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error; await delay(10 * 2 ** attempt); }
    }
  } finally { await rm(temporary, { force: true }); }
}
export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function readJournal<T>(file: string, repair = false): Promise<T[]> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  // An incomplete final write is recoverable. Corruption in a complete record is not.
  const end = text.lastIndexOf('\n') + 1;
  const lines = text.slice(0, end).split('\n'); lines.pop();
  const records = lines.filter(Boolean).map((line, i) => { try { return JSON.parse(line); } catch { throw new Error(`corrupt journal ${file}:${i + 1}`); } });
  // Repair only during exclusive startup recovery, never during a live read.
  if (repair && end < text.length) await truncate(file, Buffer.byteLength(text.slice(0, end), 'utf8'));
  return records;
}

export class Store {
  private queues = new Map<string, Promise<unknown>>();
  private failure?: Error;
  constructor(readonly home: string) {}
  runDir(id: string) { if (!/^run_[0-9A-Z]{26}$/.test(id)) throw new Error('invalid run id'); return path.join(this.home, 'runs', id); }
  async initialize() { await mkdir(path.join(this.home, 'runs'), { recursive: true, mode: 0o700 }); }
  private serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve();
    const next = previous.then(() => { if (this.failure) throw this.failure; return operation(); }).catch(error => { this.failure = error; throw error; });
    this.queues.set(file, next.catch(() => {}));
    return next;
  }
  write(file: string, value: unknown) { const snapshot = structuredClone(value); return this.serialize(file, () => atomicJson(file, snapshot)); }
  append(file: string, value: unknown) {
    // Each acknowledged append is fsync'd. This is stronger than batch-50ms;
    // batching can replace it without changing the durability contract.
    const line = JSON.stringify(value) + '\n';
    return this.serialize(file, async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const handle = await open(file, 'a', 0o600);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    });
  }
  appendLog(file: string, value: unknown, maxBytes = 10 * 1024 * 1024, copies = 5) {
    const line = JSON.stringify(value) + '\n';
    return this.serialize(file, async () => {
      const size = await stat(file).then(info => info.size).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size + Buffer.byteLength(line) > maxBytes) {
        await rm(`${file}.${copies}`, { force: true });
        for (let i = copies - 1; i >= 0; i--) {
          try { await rename(i ? `${file}.${i}` : file, `${file}.${i + 1}`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      const handle = await open(file, 'a', 0o600);
      try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    });
  }
  async flush() { await Promise.all(this.queues.values()); if (this.failure) throw this.failure; }
  async runs() { try { return (await readdir(path.join(this.home, 'runs'))).filter(n => /^run_[0-9A-Z]{26}$/.test(n)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
}
