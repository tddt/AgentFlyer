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

const SPLASH_HTML = `<div id="af-splash" aria-hidden="true">
<style>
#af-splash{position:fixed;inset:0;z-index:9999;background:#07090f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;transition:opacity .5s ease,visibility .5s ease}
#af-splash.af-out{opacity:0;visibility:hidden;pointer-events:none}
.af-orbit{position:relative;width:80px;height:80px}
.af-ring{position:absolute;inset:0;border-radius:50%;border:2px solid transparent}
.af-ring-1{border-top-color:#6366f1;border-right-color:rgba(99,102,241,.25);animation:af-spin 1.1s linear infinite}
.af-ring-2{inset:10px;border-bottom-color:#a78bfa;border-left-color:rgba(167,139,250,.2);animation:af-spin .75s linear infinite reverse}
.af-ring-3{inset:20px;border-top-color:rgba(99,102,241,.5);animation:af-spin 1.6s linear infinite}
.af-af{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 16px/1 system-ui,sans-serif;background:linear-gradient(135deg,#6366f1,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.af-name{font:500 14px/1 system-ui,sans-serif;color:#475569;letter-spacing:.12em;text-transform:uppercase}
.af-dots{display:flex;gap:7px;align-items:center}
.af-dot{width:6px;height:6px;border-radius:50%;background:#6366f1;animation:af-bounce 1.4s ease-in-out infinite}
.af-dot:nth-child(2){animation-delay:.18s;background:#818cf8}
.af-dot:nth-child(3){animation-delay:.36s;background:#a78bfa}
.af-sub{font:400 11px/1 system-ui,sans-serif;color:#334155;letter-spacing:.04em}
@keyframes af-spin{to{transform:rotate(360deg)}}
@keyframes af-bounce{0%,60%,100%{transform:translateY(0);opacity:.35}30%{transform:translateY(-9px);opacity:1}}
</style>
<div class="af-orbit">
  <div class="af-ring af-ring-1"></div>
  <div class="af-ring af-ring-2"></div>
  <div class="af-ring af-ring-3"></div>
  <div class="af-af">AF</div>
</div>
<div class="af-name">AgentFlyer</div>
<div class="af-dots"><div class="af-dot"></div><div class="af-dot"></div><div class="af-dot"></div></div>
<div class="af-sub">Loading console…</div>
</div>`;

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
  ${SPLASH_HTML}
  <div id="root"></div>
  <script>${_js}</script>
</body>
</html>`;
}
