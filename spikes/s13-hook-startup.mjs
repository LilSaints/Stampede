import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] ?? `spikes/artifacts/s13-${Date.now()}`);
await mkdir(directory, { recursive: true });
const times = [];
for (let i = 0; i < 30; i++) {
  const start = performance.now();
  const child = spawn(process.execPath, [path.resolve('dist/hook.js'), 'post-tool-use', '--backend', 'claude'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STAMPEDE_AGENT_TOKEN: '', STAMPEDE_HUB_URL: '' } });
  child.stdin.end('{}');
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const result = { samples: 30, medianMs: times[14], p95Ms: times[28], maxMs: times[29], passed: times[28] <= 150, scope: 'Dedicated bundled hook startup, empty inbox environment; excludes hub round trip.' };
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result) + '\n');
