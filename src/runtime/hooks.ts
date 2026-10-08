import { Worker } from 'node:worker_threads';
import { parseWorkflow } from './parse.js';

export interface RuntimeOptions {
  source: string; filename?: string; args?: unknown; budgetTokens?: number | null;
  cpuBlockMs?: number; signal?: AbortSignal;
  call(method: string, params: any): Promise<unknown>;
}
export function executeWorkflow(options: RuntimeOptions) {
  const parsed = parseWorkflow(options.source);
  const spentBuffer = new SharedArrayBuffer(8);
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { body: parsed.body, filename: options.filename ?? 'workflow.js', args: options.args, total: options.budgetTokens ?? null, spentBuffer } });
  let heartbeat = Date.now();
  let settled = false;
  const result = new Promise<unknown>((resolve, reject) => {
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      options.signal?.removeEventListener('abort', abort);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error('run cancelled'));
    const watchdog = setInterval(() => { if (Date.now() - heartbeat > (options.cpuBlockMs ?? 10000)) finish(new Error('script blocked the event loop')); }, Math.min(250, options.cpuBlockMs ?? 10000));
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { if (!settled) finish(new Error(`script worker exited (${code})`)); });
    worker.on('message', message => {
      if (message.type === 'heartbeat') heartbeat = Date.now();
      else if (message.type === 'result') finish(undefined, message.value);
      else if (message.type === 'error') finish(Object.assign(new Error(message.error.message), { stack: message.error.stack }));
      else if (message.type === 'call') {
        Promise.resolve().then(() => options.call(message.method, message.params)).then(
          value => { if (!settled) worker.postMessage({ id: message.id, value }); },
          error => { if (!settled) worker.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
        ).catch(error => finish(error));
      }
    });
    if (options.signal?.aborted) abort();
  });
  return { meta: parsed.meta, result, setSpent(tokens: number) { Atomics.store(new BigInt64Array(spentBuffer), 0, BigInt(Math.floor(tokens))); } };
}
