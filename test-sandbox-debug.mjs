import { createHostSandboxRuntime } from './dist/sandbox/runtime.js';
import { mkdtempSync } from 'fs';
import { join } from 'path';

const dataDir = mkdtempSync(join(process.cwd(), '.tmp-debug-'));
const runtime = createHostSandboxRuntime({ dataDir });

const nodeCommand = [
  "$ErrorActionPreference = 'Stop'",
  `& ${JSON.stringify(process.execPath)} -e "console.log('sandbox-stdout'); console.error('sandbox-stderr')"`,
].join('\n');

console.log('Running command:', nodeCommand);
const result = await runtime.execute({
  command: nodeCommand,
  cwd: process.cwd(),
  timeoutMs: 10_000,
});

console.log('Result:', JSON.stringify(result, null, 2));
