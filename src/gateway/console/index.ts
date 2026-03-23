import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dir, '../console-ui/dist');

let _js = '';
let _css = '';

function loadDist(): void {
  if (_js) return;
  try {
    _js = readFileSync(join(distDir, 'index.js'), 'utf-8');
    _css = readFileSync(join(distDir, 'index.css'), 'utf-8');
  } catch {
    _js = 'console.error("[AgentFlyer] Console UI not built — run: pnpm console:build")';
    _css = '';
  }
}

export function buildConsoleHtml(token: string, port: number): string {
  loadDist();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>AgentFlyer Console</title>
  <script>window.__AF_TOKEN__=${JSON.stringify(token)};window.__AF_PORT__=${port};</script>
  <style>${_css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${_js}</script>
</body>
</html>`;
}
