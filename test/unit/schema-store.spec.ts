import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { codexSchema, jsonAnswer, validateSchema } from '../../src/backends/codexSchema.js';
import { Store, atomicJson, readJson, readJournal } from '../../src/hub/store.js';

test('Codex encoding is lossless for optional properties, arrays and local refs', () => {
  const source = { type: 'object', properties: { label: { type: 'string', minLength: 2 }, nested: { $ref: '#/$defs/item' }, values: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['label'], additionalProperties: false, $defs: { item: { type: 'object', properties: { number: { type: 'integer' } }, additionalProperties: false } } };
  const converted = codexSchema(source);
  const validate = validateSchema(source);
  for (let i = 0; i < 200; i++) {
    const value = { label: `item-${i}`, ...(i % 2 ? { nested: {} } : {}), ...(i % 3 ? { values: [{ number: i }, {}] } : {}) };
    assert.ok(validate(value));
    assert.deepEqual(converted.decode(converted.encode(value)), value);
  }
  assert.equal(converted.schema.properties.label.minLength, undefined);
  assert.equal(validate({ label: 'x' }), false);
});
test('unsupported schemas fail before launch', () => {
  for (const child of [{ type: ['string', 'null'] }, { type: 'object', additionalProperties: true }, { oneOf: [{ type: 'string' }] }, { $ref: 'https://example.com/schema.json' }]) assert.throws(() => codexSchema({ type: 'object', properties: { x: child } }));
  assert.throws(() => validateSchema({ type: 'object', properties: {}, required: ['missing'] }), /subset/);
  assert.throws(() => codexSchema({ type: 'object', properties: { value: { anyOf: [
    { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false },
    { type: 'object', properties: { n: { type: 'null' } }, required: ['n'], additionalProperties: false }
  ] } }, required: ['value'] }), /discriminator/);
});
test('durable store serializes concurrent appends, atomically replaces snapshots and recovers a torn final record', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede-store-'));
  try {
    const store = new Store(dir); await store.initialize();
    const journal = path.join(dir, 'journal.jsonl');
    await Promise.all(Array.from({ length: 50 }, (_, seq) => store.append(journal, { seq })));
    assert.deepEqual((await readJournal<{ seq: number }>(journal)).map(e => e.seq), Array.from({ length: 50 }, (_, i) => i));
    await store.write(path.join(dir, 'run.json'), { status: 'running' });
    await store.write(path.join(dir, 'run.json'), { status: 'done' });
    assert.deepEqual(await readJson(path.join(dir, 'run.json')), { status: 'done' });
    await appendFile(journal, '{"torn":');
    assert.equal((await readJournal(journal)).length, 50);
    await readJournal(journal, true);
    await store.append(journal, { seq: 50, text: '日本語' });
    assert.equal((await readJournal(journal)).length, 51);
    await store.flush();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('atomic snapshots retry antivirus-style rename contention without losing the prior snapshot', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stampede rename '));
  const target = path.join(dir, 'snapshot.json'), rename = fs.rename;
  try {
    await atomicJson(target, { version: 1 });
    let failures = 3, attempts = 0;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
      attempts++;
      if (failures-- > 0) throw Object.assign(new Error('synthetic scanner lock'), { code: 'EBUSY' });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await atomicJson(target, { version: 2 });
    assert.equal(attempts, 4); assert.deepEqual(await readJson(target), { version: 2 });
    failures = 10; attempts = 0;
    await assert.rejects(atomicJson(target, { version: 3 }), { code: 'EBUSY' });
    assert.equal(attempts, 6); assert.deepEqual(await readJson(target), { version: 2 });
    assert.deepEqual(await fs.readdir(dir), ['snapshot.json']);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});
test('an answer\'s JSON is the whole text, else its last fenced block, else its outermost braces', () => {
  assert.deepEqual(jsonAnswer(' {"verdict":"ship"} '), { verdict: 'ship' });
  assert.deepEqual(jsonAnswer('Review done.\n```json\n{"verdict":"draft"}\n```\nThen:\n```json\n{"verdict":"fix"}\n```\nThanks.'), { verdict: 'fix' });
  assert.deepEqual(jsonAnswer('The answer is {"verdict":"fix","notes":["a {b}"]} as asked.'), { verdict: 'fix', notes: ['a {b}'] });
  assert.equal(jsonAnswer('The verdict is fix.'), undefined);
  assert.equal(jsonAnswer(undefined), undefined);
});
