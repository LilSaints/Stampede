import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const port = parentPort!;
let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc(method: string, params: unknown): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); port.postMessage({ type: 'call', id, method, params }); });
}
port.on('message', message => {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
});
const heartbeat = setInterval(() => port.postMessage({ type: 'heartbeat' }), 100);
heartbeat.unref();
const context = vm.createContext({ __rpc: rpc, __args: workerData.args, __total: workerData.total, __spent: workerData.spentBuffer, URL, structuredClone }, { codeGeneration: { strings: false, wasm: false } });
// Hooks and callbacks live in the VM realm. Only structured data crosses RPC.
const bootstrap = `
const nondeterministic = () => { throw new Error('non-deterministic API unavailable in workflow scripts; pass values via args'); };
const NativeDate = Date;
Date = new Proxy(NativeDate, {
  apply: nondeterministic,
  construct(target, args) { if (!args.length) return nondeterministic(); return Reflect.construct(target, args); },
  get(target, key) { return key === 'now' ? nondeterministic : Reflect.get(target, key); }
});
NativeDate.now = nondeterministic;
Object.defineProperty(NativeDate.prototype, 'constructor', { value: Date });
Math.random = nondeterministic;
const rpc = __rpc;
const args = __args;
const total = __total;
const spentView = new BigInt64Array(__spent);
const budget = Object.freeze({ total, spent: () => Number(Atomics.load(spentView, 0)), remaining: () => total === null ? Infinity : Math.max(0, total - Number(Atomics.load(spentView, 0))) });
delete globalThis.__rpc; delete globalThis.__args; delete globalThis.__total; delete globalThis.__spent;
let currentPhase;
const phase = title => { currentPhase = title; return rpc('phase', { title }); };
const log = message => rpc('log', { message: String(message) });
// A rejected agent() call was refused before launch; the error names the call for the run log.
const agent = (prompt, opts = {}) => rpc('agent', { prompt, opts: { phase: currentPhase, ...opts } }).catch(error => { error.refusedAgent = String(opts?.name ?? opts?.label ?? ''); throw error; });
// The script sees only null, so the reason goes to the run log, which workflow_status shows.
async function nulled(where, error) {
  const message = String(error?.message ?? error).slice(0, 500);
  const call = typeof error?.refusedAgent === 'string' ? 'agent()' + (error.refusedAgent ? ' ' + JSON.stringify(error.refusedAgent.slice(0, 40)) : '') + ' was refused: ' : '';
  if (message !== 'run cancelled') await log(where + ' is null: ' + call + message).catch(() => {});
  return null;
}
async function parallel(thunks) {
  if (!Array.isArray(thunks) || thunks.length > 4096) throw new Error('parallel supports at most 4096 thunks');
  return Promise.all(thunks.map(async (thunk, index) => { try { return await thunk(); } catch (error) { return nulled('parallel() slot ' + index, error); } }));
}
async function pipeline(items, ...stages) {
  if (!Array.isArray(items) || items.length > 4096) throw new Error('pipeline supports at most 4096 items');
  return Promise.all(items.map(async (item, index) => {
    let previous = item;
    for (const [n, stage] of stages.entries()) { try { previous = await stage(previous, item, index); } catch (error) { return nulled('pipeline() item ' + index + ' (stage ' + (n + 1) + ' of ' + stages.length + ' threw)', error); } if (previous === null) return null; }
    return previous;
  }));
}
const workflow = (ref, args) => rpc('workflow', { ref, args });
const send = (to, text) => rpc('send', { to, text });
const board = topic => rpc('board', { topic });
const workspace = name => rpc('workspace', { name: String(name) });
const checkpoint = (name, data = null, opts = {}) => rpc('checkpoint', { name, data, opts });
async function spawnTeam(members, opts = {}) {
  const team = await rpc('spawnTeam', { members, opts: { phase: currentPhase, ...opts } });
  return Object.freeze({ ...team,
    untilQuiet: opts => rpc('team.untilQuiet', { id: team.id, opts }),
    untilDone: (names, opts) => rpc('team.untilDone', { id: team.id, names, opts }),
    send: (to, text) => rpc('team.send', { id: team.id, to, text }),
    results: () => rpc('team.results', { id: team.id }),
    board: topic => rpc('team.board', { id: team.id, topic }),
    messages: () => rpc('team.messages', { id: team.id }),
    stop: () => rpc('team.stop', { id: team.id })
  });
}
`;
try {
  new vm.Script(bootstrap, { filename: 'stampede:runtime' }).runInContext(context);
  const execution = new vm.Script(`(async function __main(){\n${workerData.body}\n})()`, { filename: workerData.filename, lineOffset: -1 }).runInContext(context);
  Promise.resolve(execution).then(value => { port.postMessage({ type: 'result', value }); }, error => { port.postMessage({ type: 'error', error: { message: error.message, stack: error.stack } }); });
} catch (error) { port.postMessage({ type: 'error', error: { message: (error as Error).message, stack: (error as Error).stack } }); }
