import test from 'node:test';
import assert from 'node:assert/strict';
import { Locks } from '../../src/hub/locks.js';

test('a lock goes to waiters in the order they asked, and a wait that runs out or is aborted leaves the queue', async () => {
  const locks = new Locks(), a = { id: 'a', label: 'a' }, b = { id: 'b', label: 'b' }, c = { id: 'c', label: 'c' };
  assert.equal(await locks.acquire('ui', a, 0), true);
  assert.equal(await locks.acquire('ui', a, 0), true, 'its holder takes it again at once');
  assert.equal(await locks.acquire('ui', b, 0), false, 'no wait, no lock');
  const second = locks.acquire('ui', b, 5000), third = locks.acquire('ui', c, 5000);
  const abort = new AbortController(), gone = locks.acquire('ui', { id: 'd', label: 'd' }, 5000, abort.signal); abort.abort();
  assert.equal(await gone, false);
  assert.equal(await locks.acquire('ui', { id: 'e', label: 'e' }, 10), false, 'a wait runs out');
  assert.equal(locks.release('ui', 'b'), false, 'only its holder gives it back');
  assert.equal(locks.release('ui', 'a'), true);
  assert.equal(await second, true); assert.equal(locks.holder('ui')?.id, 'b');
  assert.deepEqual(locks.snapshot().map(s => [s.name, s.holder, s.waiting]), [['ui', 'b', 1]]);
  assert.deepEqual(locks.releaseAll('b'), ['ui']);
  assert.equal(await third, true); assert.equal(locks.holder('ui')?.id, 'c');
});
