import { hook } from './hook.js';
await hook(process.argv[2], process.argv[4] ?? 'claude');
