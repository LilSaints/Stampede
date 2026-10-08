import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, AdmissionError, type Slot } from '../../src/hub/scheduler.js';
const config = { global: 8, perRun: 8, claude: 6, codex: 6, reserve: 1, admissionMaxMs: 100 };
const slots = (count: number, runId: string, comms = true, backend: 'claude' | 'codex' = 'codex'): Slot[] => Array.from({length: count}, (_, i) => ({ id: `${runId}-${backend}-${i}`, name: `${runId}-${i}`, runId, backend, comms }));
test('oversized teams fail before acquiring any permits', () => {
  const scheduler = new Scheduler(config);
  assert.throws(() => scheduler.acquire(slots(6, 'large')), /team does not fit/);
  assert.equal(scheduler.snapshot().held.length, 0);
});
test('non-comms bypass a blocked gang; comms reservations survive idle until release', async () => {
  const scheduler = new Scheduler(config);
  const release = await scheduler.acquire(slots(5, 'first'));
  const waiting = scheduler.acquire(slots(5, 'second'));
  const freeNonComms = await scheduler.acquire(slots(1, 'review', false));
  assert.equal(scheduler.snapshot().held.length, 6);
  assert.equal(scheduler.snapshot().queued.length, 1);
  freeNonComms(); release();
  const freeSecond = await waiting;
  assert.equal(scheduler.snapshot().held.length, 5);
  freeSecond(); freeSecond();
  assert.equal(scheduler.snapshot().held.length, 0);
});
test('gang timeout is bounded and reports idle reservation holders', async () => {
  const scheduler = new Scheduler({ ...config, admissionMaxMs: 25 });
  const free = await scheduler.acquire(slots(5, 'idle'));
  await assert.rejects(scheduler.acquire(slots(5, 'next')), error => error instanceof AdmissionError && error.blockedBy.length === 5);
  assert.equal(scheduler.snapshot().held.length, 5);
  assert.equal(scheduler.snapshot().queued.length, 0);
  free();
});
test('mixed gangs acquire atomically and pause/cancel holds no partial slots', async () => {
  const scheduler = new Scheduler(config);
  scheduler.pause('mixed', true);
  const controller = new AbortController();
  const waiting = scheduler.acquire([...slots(2, 'mixed'), ...slots(2, 'mixed', true, 'claude')], controller.signal);
  assert.equal(scheduler.snapshot().held.length, 0);
  controller.abort();
  await assert.rejects(waiting, /cancelled/);
  assert.equal(scheduler.snapshot().queued.length, 0);
});
test('project caps limit only that run and preserve cross-run throughput', async () => {
  const scheduler = new Scheduler(config);
  scheduler.configureRun('limited', { ...config, global: 2, perRun: 2, codex: 2 });
  assert.throws(() => scheduler.acquire(slots(2, 'limited')), /does not fit/);
  const first = await scheduler.acquire([{ ...slots(1, 'limited', false)[0], id: 'first' }]);
  const second = await scheduler.acquire([{ ...slots(1, 'limited', false)[0], id: 'second' }]);
  const waiting = scheduler.acquire([{ ...slots(1, 'limited', false)[0], id: 'third' }]);
  const other = await scheduler.acquire(slots(1, 'other', false));
  assert.equal(scheduler.snapshot().held.length, 3);
  assert.equal(scheduler.snapshot().queued.length, 1);
  first(); const third = await waiting; second(); third(); other();
});
