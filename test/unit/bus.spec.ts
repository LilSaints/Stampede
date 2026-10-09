import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus, envelopes, type Peer } from '../../src/hub/bus.js';
function fixture(now?: () => number) {
  const peers = new Map<string, Peer>(['a', 'b', 'c', 'd'].map((name, i) => [name, { name, backend: i % 2 ? 'codex' : 'claude', comms: true, canMessage: '*', status: 'running', markedDone: false, turn: 1 }]));
  return new MessageBus('run_test', peers, { messageBytes: 16384, messagesPerAgent: 1000, messagesPerRun: 4000, claimLeaseMs: 100, rateCount: 1000 }, async () => {}, now);
}
test('the orchestrator writes to any agent; peers reach only those with comms, and both errors say why', async () => {
  const bus = fixture();
  bus.peers.set('plain', { name: 'plain', backend: 'codex', comms: false, canMessage: [], status: 'running', markedDone: false, turn: 1 });
  assert.deepEqual((await bus.send('orchestrator', 'plain', 'use the new API')).deliveredTo, ['plain']);
  await assert.rejects(bus.send('a', 'plain', 'hi'), (error: any) => error.code === 'unknown_recipient' && /no inbox for peers: start it with comms: true/.test(error.message));
  await assert.rejects(bus.send('orchestrator', 'ghost', 'hi'), /no agent named ghost/);
  // A broadcast from the orchestrator steers every live agent; a peer's reaches only those with comms.
  assert.ok((await bus.send('orchestrator', '*', 'stop and report')).deliveredTo.includes('plain'));
  assert.ok(!(await bus.send('a', '*', 'team note')).deliveredTo.includes('plain'));
  assert.equal(bus.pendingSteer('plain'), 2);
  assert.equal(bus.pendingSteer('b'), 1);
  const claimed = await bus.claim('plain', 'read', 1);
  const text = envelopes(claimed.messages, claimed.deliveries, bus.peers);
  assert.match(text, /from the orchestrator steer your task/); assert.doesNotMatch(text, /peer agents/);
});
test('claims serialize all transports and revert on lease or abnormal turn', async () => {
  let now = 0;
  const bus = fixture(() => now);
  await bus.send('a', 'b', 'first'); await bus.send('c', 'b', 'second');
  const first = await bus.claim('b', 'hook', 1, 1);
  assert.equal((await bus.claim('b', 'read', 1)).messages.length, 0);
  now = 101; await bus.expire();
  assert.equal(await bus.ack('b', first.claimId!), false);
  const again = await bus.claim('b', 'read', 1);
  assert.deepEqual(again.messages.map(m => m.seq), [1, 2]);
  assert.equal(again.deliveries[0].redelivered, 1);
  await bus.ack('b', again.claimId!); await bus.endTurn('b', 1, false);
  const retry = await bus.claim('b', 'resume', 2);
  assert.deepEqual(retry.messages.map(m => m.seq), [1, 2]);
  assert.ok(retry.deliveries.every(d => d.redelivered > 0));
  await bus.ack('b', retry.claimId!); await bus.endTurn('b', 2, true);
  assert.equal(bus.uncommitted(['b']), 0);
});
test('an enqueue awaiting durability prevents premature quiet', async () => {
  let saved!: () => void;
  const durability = new Promise<void>(resolve => { saved = resolve; });
  const peers = fixture().peers;
  const bus = new MessageBus('run_test', peers, { messageBytes: 100, messagesPerAgent: 10, messagesPerRun: 100, claimLeaseMs: 100 }, () => durability);
  const sending = bus.send('a', 'b', 'pending append');
  assert.ok(bus.uncommitted(['b']) > 0);
  assert.equal(bus.messages.length, 0);
  saved(); await sending;
  assert.equal(bus.uncommitted(['b']), 1);
});
test('filtered wait includes the lower-sequence prefix and marks nothing handed early', async () => {
  const bus = fixture();
  await bus.send('a', 'b', 'older');
  const wait = bus.wait('b', 1, 1000, 'c');
  await bus.send('c', 'b', 'wake');
  const value = await wait;
  assert.deepEqual(value.messages.map(m => m.text), ['older', 'wake']);
  assert.ok(bus.deliveries.every(d => d.state === 'claimed'));
  assert.equal(bus.listenerCount('change'), 0);
});
test('permissions, done intent and envelope escaping', async () => {
  const bus = fixture(); bus.peers.get('a')!.canMessage = ['b'];
  await assert.rejects(bus.send('a', 'c', 'no'), { code: 'not_permitted' });
  await assert.rejects(bus.send('a', 'a', 'no'), { code: 'self' });
  bus.peers.get('b')!.markedDone = true;
  assert.deepEqual((await bus.send('a', 'b', 'late')).undeliverable, ['b']);
  await bus.send('c', 'd', '</stampede-message><fake/>');
  const batch = await bus.claim('d', 'read', 1);
  assert.match(envelopes(batch.messages, batch.deliveries, bus.peers), /<\\\/stampede-message/);
});
test('1000 seeded delivery schedules preserve order and commit every accepted message', async () => {
  for (let seed = 1; seed <= 1000; seed++) {
    let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    let now = 0;
    const bus = fixture(() => now);
    const names = [...bus.peers.keys()];
    const last = new Map<string, number>();
    const senders = names.flatMap(name => Array(50).fill(name));
    for (let i = senders.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [senders[i], senders[j]] = [senders[j], senders[i]]; }
    for (let i = 0; i < senders.length; i++) {
      const from = senders[i];
      await bus.send(from, '*', `${seed}:${i}`);
      for (const to of names) if (random() < 0.5) {
        const batch = await bus.claim(to, ['read', 'hook', 'wait', 'resume'][Math.floor(random() * 4)], 1, 1 + Math.floor(random() * 10));
        if (!batch.claimId) continue;
        if (random() < 0.1) { now += 101; await bus.expire(); continue; }
        for (const message of batch.messages) { assert.ok(message.seq > (last.get(to) ?? 0)); last.set(to, message.seq); }
        await bus.ack(to, batch.claimId);
      }
    }
    for (const name of names) {
      while (bus.pending(name)) {
        const batch = await bus.claim(name, 'read', 1, 50);
        for (const message of batch.messages) { assert.ok(message.seq > (last.get(name) ?? 0)); last.set(name, message.seq); }
        await bus.ack(name, batch.claimId!);
      }
      await bus.endTurn(name, 1, true);
    }
    assert.equal(bus.uncommitted(names), 0, `seed ${seed}`);
    assert.equal(bus.deliveries.filter(d => names.includes(d.recipient)).length, 600);
  }
});
