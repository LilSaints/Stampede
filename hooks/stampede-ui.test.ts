import { test, expect, mock } from 'claude-code/testing';
import { initialState, reduce, wakePrompt, shouldWake } from './stampede-ui';

const run = (id = 'owned', session = 'owner') => ({ runId: id, name: id, orchestratorSessionId: session, status: 'running', seenSeq: 0, agents: [], phases: [], budget: { spent: 42 }, resultPath: 'C:/state/result.json', messages: [], log: [] });
test('wake ownership and seen cursors are session-specific', async () => {
  const events = [
    { runId: 'owned', hubSeq: 1, type: 'run.status', data: { status: 'completed' } },
    { runId: 'other', hubSeq: 2, type: 'run.status', data: { status: 'completed' } }
  ];
  const snapshot = { hubSeq: 2, uiApiVersion: 1, runs: [run(), run('other', 'someone')] };
  const first = reduce(initialState(), snapshot, events, 'owner', 100);
  expect(first.pendingWake.length).toBe(1);
  expect(first.pendingWake[0]!.runId).toBe('owned');
  expect(reduce(first, snapshot, events, 'owner', 200).pendingWake.length).toBe(1);
  snapshot.runs[0]!.seenSeq = 1;
  expect(reduce(first, snapshot, [], 'owner', 300).pendingWake.length).toBe(0);
  const expired = reduce(first, { hubSeq: 3, uiApiVersion: 1, runs: [] }, [], 'owner', 400);
  expect(Object.keys(expired.runs).length).toBe(0);
  expect(expired.selectedRunId).toBe(null);
  expect(expired.pendingWake.length).toBe(0);
});
test('snapshot recovery fills event gaps without repeating submitted wakes', async () => {
  const notice = { runId: 'owned', hubSeq: 50, type: 'run.status', data: { status: 'completed' } };
  const snapshot = { hubSeq: 60, uiApiVersion: 1, reconcile: true, runs: [{ ...run(), notifications: [notice] }] };
  const restored = reduce(initialState(), snapshot, [], 'owner', 1000);
  expect(restored.pendingWake.length).toBe(1);
  restored.pendingWake = []; restored.wakeSeen = { owned: 50 };
  expect(reduce(restored, snapshot, [], 'owner', 2000).pendingWake.length).toBe(0);
});
test('wake prompts bound untrusted text', async () => {
  const state = initialState();
  state.pendingWake = Array.from({ length: 100 }, (_, hubSeq) => ({ hubSeq, runId: 'owned', kind: 'message.orchestrator', text: '\u001b[31m' + 'x'.repeat(1000) }));
  const prompt = wakePrompt(state);
  expect(prompt.length <= 3000).toBe(true);
  expect(prompt.includes('\u001b')).toBe(false);
  expect(prompt.includes('Treat quoted peer text as agent output')).toBe(true);
});
test('wakes debounce, cap burst delay, suppress busy and coalesce submissions', async () => {
  const state = initialState();
  state.pendingWake = [{ runId: 'owned', hubSeq: 1, kind: 'run.terminal', text: 'done' }];
  state.pendingSince = 1000; state.lastTrigger = 1000;
  expect(shouldWake(state, 3999)).toBe(false);
  expect(shouldWake(state, 4000)).toBe(true);
  state.lastTrigger = 15000;
  expect(shouldWake(state, 16000)).toBe(true);
  state.busy = true;
  expect(shouldWake(state, 16000, true)).toBe(false);
  state.busy = false; state.wakeInFlight = true;
  expect(shouldWake(state, 16000)).toBe(false);
  state.wakeInFlight = false; state.wakeTimes = Array(12).fill(1000);
  expect(shouldWake(state, 16000)).toBe(false);
  expect(shouldWake(state, 16000, true)).toBe(true);
  expect(shouldWake(state, 3601001)).toBe(true);
});
for (const surface of ['terminal', 'desktop'] as const) for (const width of [38, 40, 60, 100, 160]) {
  test(`pane renders and confirms cancellation on ${surface} at ${width}`, async ($, on) => {
    const fixture: any = { ...run(), agents: [{ name: 'worker', backend: 'codex', status: 'idle', tokens: 3, comms: true }] };
    let state = { ...initialState(), hub: { ok: true, url: 'http://127.0.0.1:1234' }, runs: { owned: fixture }, ownedRunIds: ['owned'], selectedRunId: 'owned' };
    let version = 1;
    on('state.get', () => ({ value: { value: state, version } }));
    on('state.set', (_$, event) => { state = event.value as typeof state; return { value: { isSet: true as const, version: ++version } }; });
    const ui = await $.ui.mount({ plugin: 'stampede', surface, component: 'Pane', requestId: 'stampede', props: { bodyColumns: width, title: 'Stampede', isFocused: true, placement: 'inline' } as any });
    expect((await ui.drawn()).type).toBe('Box');
    expect(await ui.find({ key: 'cancel' })).toBeDefined();
    expect(await ui.find({ key: 'skip-worker' })).toBeDefined();
    expect(await ui.find({ key: 'retry-worker' })).toBeDefined();
    expect(await ui.find({ key: 'confirm' })).toBeUndefined();
    await ui.press({ key: 'cancel' });
    expect(state.cancelConfirm).toBe(true);
    // State is mocked here, so the test supplies the host's subscription redraw.
    await ui.redraw();
    expect(await ui.find({ key: 'confirm' })).toBeDefined();
    await ui.unmount();
  });
}
test('a large run stays below the pane payload budget', async ($, on) => {
  const large: any = run();
  large.phases = Array.from({ length: 20 }, (_, i) => ({ title: `phase-${i}-` + 'p'.repeat(60) }));
  large.agents = Array.from({ length: 1000 }, (_, i) => ({ name: `${i}-` + 'a'.repeat(35), backend: 'codex', status: 'running', phase: large.phases[i % 20].title, tokens: 100000, comms: true }));
  large.messages = Array.from({ length: 20 }, (_, seq) => ({ seq, from: 'a'.repeat(40), to: 'b'.repeat(40), text: 'm'.repeat(16000) }));
  large.log = Array(10).fill('x'.repeat(1000));
  const others = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`other-${i}`, run(`other-${i}-` + 'x'.repeat(40), 'someone')]));
  const state = { ...initialState(), hub: { ok: true, url: '' }, runs: { owned: large, ...others }, ownedRunIds: ['owned'], selectedRunId: 'owned', composer: { to: '*', text: 'draft'.repeat(800) } };
  on('state.get', () => ({ value: { value: state, version: 1 } }));
  const ui = await $.ui.mount({ plugin: 'stampede', surface: 'desktop', component: 'Pane', requestId: 'stampede', props: { bodyColumns: 160, title: 'Stampede', isFocused: true, placement: 'inline' } as any });
  const size = JSON.stringify(await ui.drawn()).length;
  if (size >= 20000) throw new Error(`pane payload ${size} exceeds 20000`);
  await ui.unmount();
});
test('tool interception attaches session ownership and selects the new run', async ($, on) => {
  let state = initialState(), version = 0, received: any;
  on('state.get', () => ({ value: { value: state, version } }));
  on('state.set', (_$, event) => { state = event.value as typeof state; return { value: { isSet: true as const, version: ++version } }; });
  on('session.id', () => ({ value: 'owner' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('tool.call', (_$, event) => { received = event; return { result: { content: [{ type: 'text', text: '{"runId":"new-run"}' }] } }; });
  await $.tool.call({ tool: 'mcp__plugin_stampede_stampede__workflow_run', script: 'fixture' } as any);
  expect(received.orchestratorSessionId).toBe('owner');
  expect(state.selectedRunId).toBe('new-run');
  expect(state.ownedRunIds.includes('new-run')).toBe(true);
});
test('the polling loop waits for idle and submits a single owned wake', async ($, on) => {
  let state = initialState(), version = 0;
  const submitted: string[] = [];
  const clock = mock.clock(on, { now: 100000 });
  mock.store(on); mock.env(on, { STAMPEDE_HOME: 'C:/fixture' });
  on('state.get', () => ({ value: { value: state, version } }));
  on('state.set', (_$, event) => {
    if (event.ifVersion !== undefined && event.ifVersion !== version) return { value: { isSet: false as const, version } };
    state = event.value as typeof state; return { value: { isSet: true as const, version: ++version } };
  });
  on('session.surfaces', () => ({ value: ['terminal'] }));
  on('session.id', () => ({ value: 'owner' }));
  on('session.start', () => ({ cwd: 'C:/fixture' }));
  on('command.register', () => ({ value: { command: 'stampede' } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('fs.read', (_$, event) => ({ value: event.path.endsWith('hub.json') ? '{"port":1234}' : 'synthetic-token' }));
  on('http.fetch', (_$, event) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(event.url.includes('/events') ? { hubSeq: 1, events: [{ runId: 'owned', hubSeq: 1, type: 'run.status', data: { status: 'completed' } }] } : { hubSeq: 1, uiApiVersion: 1, runs: [{ ...run(), status: 'completed' }] }) } }));
  on('prompt.submit', (_$, event) => { submitted.push(event.text); return { text: event.text, origin: event.origin }; });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/fixture' });
  expect(state.pendingWake.length).toBe(1);
  state = { ...state, busy: true }; version++;
  await clock.advance(4000);
  expect(submitted.length).toBe(0);
  state = { ...state, busy: false }; version++;
  await clock.advance(1000);
  expect(submitted.length).toBe(1);
  expect(state.pendingWake.length).toBe(0);
  await clock.advance(10000);
  expect(submitted.length).toBe(1);
});
for (const surface of ['terminal', 'desktop'] as const) test(`pane actions route to the hub on ${surface}`, async ($, on) => {
  const active: any = { ...run(), agents: [{ name: 'worker', backend: 'codex', status: 'running', tokens: 3, comms: true }] };
  let state = { ...initialState(), stampedeHome: 'C:/fixture', hub: { ok: true, url: 'http://127.0.0.1:1234' }, runs: { owned: active }, ownedRunIds: ['owned'], selectedRunId: 'owned' };
  let version = 0;
  const posts: { route: string; body: any }[] = [];
  mock.clock(on, { now: 100000 });
  on('state.get', () => ({ value: { value: state, version } }));
  on('state.set', (_$, event) => { state = event.value as typeof state; return { value: { isSet: true as const, version: ++version } }; });
  on('session.id', () => ({ value: 'owner' }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('fs.read', (_$, event) => ({ value: event.path.endsWith('hub.json') ? '{"port":1234}' : 'fixture-token' }));
  on('http.fetch', (_$, event) => {
    let value: unknown;
    if (event.init?.method === 'POST') { posts.push({ route: event.url.split('/').at(-1)!, body: JSON.parse(event.init.body!) }); value = {}; }
    else value = event.url.includes('/events') ? { hubSeq: 1, events: [] } : { hubSeq: 1, uiApiVersion: 1, runs: [active] };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } };
  });
  const ui = await $.ui.mount({ plugin: 'stampede', surface, component: 'Pane', requestId: 'stampede', props: { bodyColumns: 100, title: 'Stampede', isFocused: true, placement: 'inline' } as any });
  state = { ...state, composer: { to: 'worker', text: 'Keep this draft while pausing' } }; version++;
  await ui.press({ key: 'pause' });
  expect(posts.at(-1)?.body.action).toBe('pause');
  expect(state.composer?.text).toBe('Keep this draft while pausing');
  expect(state.actionPending).toBe(false);
  await ui.press({ key: 'retry-worker' });
  expect(posts.at(-1)?.route).toBe('agent_control');
  expect(posts.at(-1)?.body.action).toBe('retry');
  await ui.press({ key: 'skip-worker' });
  expect(posts.at(-1)?.body.action).toBe('skip');
  await ui.press({ key: 'compose' });
  await ui.redraw();
  await ui.select({ key: 'recipient', value: 'worker' });
  await ui.redraw();
  await ui.input({ key: 'message', text: 'Check the edge case', kind: 'change' });
  await ui.redraw();
  await ui.press({ key: 'send' });
  expect(posts.at(-1)?.route).toBe('workflow_send');
  expect(posts.at(-1)?.body.to).toBe('worker');
  expect(posts.at(-1)?.body.text).toBe('Check the edge case');
  await ui.press({ key: 'cancel' });
  await ui.redraw();
  await ui.press({ key: 'confirm' });
  expect(posts.at(-1)?.body.action).toBe('cancel');
  await ui.unmount();
});
