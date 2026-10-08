import { request } from 'node:http';
function call(url: string, token: string, route: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(url + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, timeout: 1500 }, response => {
      let text = ''; response.on('data', data => { text += data; }); response.on('end', () => { try { if (response.statusCode !== 200) throw new Error('hub rejected hook'); resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    });
    req.once('error', reject); req.once('timeout', () => req.destroy(new Error('hook timeout'))); req.end(JSON.stringify(body));
  });
}
export async function hook(event: string, backend: string) {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) return; }
    JSON.parse(input || '{}');
    const url = process.env.STAMPEDE_HUB_URL, token = process.env.STAMPEDE_AGENT_TOKEN;
    if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || backend !== 'claude') return;
    const result = await call(url, token, '/v1/agent/claim', { event });
    if (!result.claimId) return;
    const output = event === 'stop' ? { decision: 'block', reason: `${result.context}\nYou have new messages. Handle them, then finish with your final answer.` } : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.context } };
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(output) + '\n', error => error ? reject(error) : resolve()));
    await call(url, token, '/v1/agent/claim-ack', { claimId: result.claimId });
  } catch { /* fail open; unacknowledged claims expire and are redelivered */ }
}
