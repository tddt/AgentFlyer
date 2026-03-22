/**
 * Copy Vite-built console-ui dist into the TypeScript output directory
 * so the installed binary can find the files at dist/gateway/console-ui/dist/
 */
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const src = join(root, 'src/gateway/console-ui/dist');
const dest = join(root, 'dist/gateway/console-ui/dist');

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[copy-console] Copied console-ui dist → dist/gateway/console-ui/dist');
