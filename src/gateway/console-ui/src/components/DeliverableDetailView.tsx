import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CellObject as XlsxCellObject } from 'xlsx-js-style';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { CopyButton } from './CopyButton.js';
import { MarkdownView } from './MarkdownView.js';
import { useLocale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type {
  ArtifactRef,
  DeliverablePublicationTarget,
  DeliverableRecord,
  WorkflowRunRecord,
  WorkflowStepResult,
} from '../types.js';

const CONTENT_BASE = window.location.origin;
const CONTENT_TOKEN = encodeURIComponent(window.__AF_TOKEN__);
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
type OfficePreviewKind = 'docx' | 'xlsx' | 'pptx';

const OFFICE_MIME_KINDS: Record<string, OfficePreviewKind> = {
  'application/msword': 'docx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function formatBytes(size?: number): string | null {
  if (!size || size <= 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactPreview(artifact: ArtifactRef): string | null {
  if (!artifact.textContent?.trim()) return null;
  return artifact.textContent;
}

function canFetchTextPreview(artifact: ArtifactRef): boolean {
  if (!artifact.contentItemId || !artifact.mimeType) return false;
  if ((artifact.size ?? 0) > MAX_TEXT_PREVIEW_BYTES) return false;
  if (artifact.mimeType === 'text/html') return false;
  return artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json';
}

function canEmbedBrowserPreview(artifact: ArtifactRef): boolean {
  if (!artifact.contentItemId || !artifact.mimeType) return false;
  return artifact.mimeType === 'text/html' || artifact.mimeType === 'application/pdf';
}

function getOfficeKind(artifact: ArtifactRef): OfficePreviewKind | null {
  if (!artifact.contentItemId || !artifact.mimeType) return null;
  return OFFICE_MIME_KINDS[artifact.mimeType] ?? null;
}

function sourceLabel(
  deliverable: DeliverableRecord,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  if (deliverable.source.kind === 'workflow_run') {
    return t('deliverables.source.workflowLabel', { name: deliverable.source.workflowName });
  }
  if (deliverable.source.kind === 'scheduler_task_run') {
    return t('deliverables.source.schedulerLabel', { name: deliverable.source.taskName });
  }
  return t('deliverables.source.chatLabel', { name: deliverable.source.agentId });
}

function sourceKey(deliverable: DeliverableRecord): string {
  if (deliverable.source.kind === 'workflow_run') {
    return deliverable.source.runId;
  }
  if (deliverable.source.kind === 'scheduler_task_run') {
    return deliverable.source.runKey;
  }
  return `${deliverable.source.agentId}:${deliverable.source.threadKey}`;
}

function statusVariant(status: DeliverableRecord['status']): 'green' | 'red' | 'gray' {
  if (status === 'ready') return 'green';
  if (status === 'error') return 'red';
  return 'gray';
}

function publicationVariant(
  status: DeliverablePublicationTarget['status'],
): 'green' | 'red' | 'gray' | 'blue' {
  if (status === 'sent') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'available') return 'blue';
  return 'gray';
}

function primaryArtifact(deliverable: DeliverableRecord): ArtifactRef | undefined {
  return (
    deliverable.artifacts.find((artifact) => artifact.id === deliverable.primaryArtifactId) ??
    deliverable.artifacts[0]
  );
}

function renderArtifactTextContent(artifact: ArtifactRef, textContent: string): ReactElement {
  if (artifact.format === 'json' || artifact.format === 'csv') {
    return (
      <pre className="max-h-[680px] overflow-auto rounded-2xl bg-slate-950/70 p-5 text-xs leading-6 text-slate-300">
        {textContent}
      </pre>
    );
  }

  if (artifact.format === 'markdown' || artifact.mimeType === 'text/markdown') {
    return (
      <div className="max-h-[680px] overflow-auto rounded-2xl bg-slate-950/70 p-5">
        <MarkdownView content={textContent} />
      </div>
    );
  }

  return (
    <pre className="max-h-[680px] overflow-auto rounded-2xl bg-slate-950/70 p-5 text-xs leading-6 whitespace-pre-wrap break-words text-slate-300">
      {textContent}
    </pre>
  );
}

function artifactUrl(artifact: ArtifactRef | null | undefined): string | null {
  if (!artifact?.contentItemId) return null;
  return `${CONTENT_BASE}/api/content/${encodeURIComponent(artifact.contentItemId)}?token=${CONTENT_TOKEN}`;
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  queueMicrotask(() => document.body.removeChild(a));
}

function downloadArtifact(artifact: ArtifactRef): void {
  const url = artifactUrl(artifact);
  if (url) {
    triggerDownload(url, artifact.name);
    return;
  }
  if (artifact.textContent) {
    const blob = new Blob([artifact.textContent], { type: artifact.mimeType ?? 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);
    triggerDownload(blobUrl, artifact.name);
    queueMicrotask(() => URL.revokeObjectURL(blobUrl));
  }
}

function downloadAllArtifacts(artifacts: ArtifactRef[]): void {
  // stagger by 80ms to avoid browser blocking multiple simultaneous downloads
  artifacts.forEach((artifact, idx) => {
    setTimeout(() => downloadArtifact(artifact), idx * 80);
  });
}

function renderMediaPreview(
  artifact: ArtifactRef,
  t: (key: string, vars?: Record<string, string>) => string,
): ReactElement | null {
  const url = artifactUrl(artifact);
  if (!url || !artifact.mimeType) return null;

  if (artifact.mimeType.startsWith('image/')) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70">
        <img src={url} alt={artifact.name} className="max-h-[720px] w-full object-contain" />
      </div>
    );
  }

  if (artifact.mimeType.startsWith('video/')) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70 p-2">
        <video controls preload="metadata" className="max-h-[720px] w-full rounded-xl" src={url} />
      </div>
    );
  }

  if (artifact.mimeType.startsWith('audio/')) {
    return (
      <div className="rounded-2xl border border-white/8 bg-slate-950/70 p-5">
        <div className="mb-3 text-sm text-slate-300">{t('deliverables.artifact.audioPreview')}</div>
        <audio controls preload="metadata" className="w-full" src={url} />
      </div>
    );
  }

  return null;
}

type XlsxModule = typeof import('xlsx-js-style');
type XlsxSheets = ReturnType<XlsxModule['read']>['Sheets'];

interface XlsxCellStyle {
  font?: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    u?: boolean | string;
    sz?: number;
    name?: string;
    color?: { rgb?: string; indexed?: number };
  };
  fill?: {
    patternType?: string;
    fgColor?: { rgb?: string; indexed?: number };
  };
  alignment?: {
    horizontal?: string;
    vertical?: string;
    wrapText?: boolean;
  };
}

function colorToHex(c: { rgb?: string; indexed?: number } | undefined): string | null {
  if (!c || c.indexed === 64) return null; // 64 = 'no color' slot in xlsx spec
  if (!c.rgb || c.rgb.length < 6) return null;
  if (c.rgb.length === 8 && c.rgb.slice(0, 2).toLowerCase() === '00') return null; // fully transparent
  return `#${c.rgb.length === 8 ? c.rgb.slice(2) : c.rgb}`;
}

type FormulaVal = number | string | boolean | null;

// Minimal recursive-descent formula evaluator.
// Supports arithmetic, comparisons, string literals, cell references,
// and common functions: IF, SUM, ROUND, INT, ABS, MAX, MIN, AND, OR, NOT,
// IFERROR, CONCAT/CONCATENATE, LEN, TRIM, UPPER, LOWER, LEFT.
function evalXlsxFormula(
  formula: string,
  getCellVal: (addr: string) => FormulaVal,
): FormulaVal {
  const src = formula.trim();
  let pos = 0;

  function skipWs(): void {
    while (pos < src.length && src[pos] === ' ') pos++;
  }

  function parseExpr(): FormulaVal {
    return parseConcat();
  }

  function parseConcat(): FormulaVal {
    let left = parseCompare();
    while (true) {
      skipWs();
      if (src[pos] !== '&') break;
      pos++;
      const right = parseCompare();
      left = String(left ?? '') + String(right ?? '');
    }
    return left;
  }

  function parseCompare(): FormulaVal {
    const left = parseAddSub();
    skipWs();
    const two = src.slice(pos, pos + 2);
    if (two === '>=' || two === '<=' || two === '<>') {
      pos += 2;
      const right = parseAddSub();
      if (two === '>=') return Number(left) >= Number(right);
      if (two === '<=') return Number(left) <= Number(right);
      return left !== right;
    }
    const one = src[pos];
    if (one === '>') { pos++; const r = parseAddSub(); return Number(left) > Number(r); }
    if (one === '<') { pos++; const r = parseAddSub(); return Number(left) < Number(r); }
    if (one === '=') { pos++; const r = parseAddSub(); return left == r; }
    return left;
  }

  function parseAddSub(): FormulaVal {
    let result = parseMulDiv();
    while (true) {
      skipWs();
      const op = src[pos];
      if (op !== '+' && op !== '-') break;
      pos++;
      const right = parseMulDiv();
      result = op === '+' ? Number(result) + Number(right) : Number(result) - Number(right);
    }
    return result;
  }

  function parseMulDiv(): FormulaVal {
    let result = parseUnary();
    while (true) {
      skipWs();
      const op = src[pos];
      if (op !== '*' && op !== '/') break;
      pos++;
      const right = parseUnary();
      if (op === '/') {
        const r = Number(right);
        result = r === 0 ? null : Number(result) / r;
      } else {
        result = Number(result) * Number(right);
      }
    }
    return result;
  }

  function parseUnary(): FormulaVal {
    skipWs();
    if (src[pos] === '-') { pos++; return -Number(parseAtom()); }
    if (src[pos] === '+') { pos++; return Number(parseAtom()); }
    return parseAtom();
  }

  function parseAtom(): FormulaVal {
    skipWs();
    // Parenthesised expression
    if (src[pos] === '(') {
      pos++;
      const v = parseExpr();
      skipWs();
      if (src[pos] === ')') pos++;
      return v;
    }
    // String literal
    if (src[pos] === '"') {
      pos++;
      let s = '';
      while (pos < src.length) {
        if (src[pos] === '"') {
          pos++;
          if (src[pos] === '"') { s += '"'; pos++; } // escaped quote
          else break;
        } else {
          s += src[pos++];
        }
      }
      return s;
    }
    // Number literal
    if (/[0-9]/.test(src[pos] ?? '')) {
      let n = '';
      while (pos < src.length && /[0-9.]/.test(src[pos])) n += src[pos++];
      if (src[pos] === 'E' || src[pos] === 'e') {
        n += src[pos++];
        if (src[pos] === '+' || src[pos] === '-') n += src[pos++];
        while (/[0-9]/.test(src[pos] ?? '')) n += src[pos++];
      }
      return parseFloat(n);
    }
    // Identifier: cell reference, function call, or keyword
    if (/[A-Za-z_]/.test(src[pos] ?? '')) {
      const start = pos;
      while (pos < src.length && /[A-Za-z_]/.test(src[pos])) pos++;
      const lettersEnd = pos;
      while (pos < src.length && /[0-9]/.test(src[pos])) pos++;
      const token = src.slice(start, pos);
      skipWs();
      // Cell reference: letters followed by digits, no opening paren
      if (src[pos] !== '(' && /^[A-Z]+[0-9]+$/i.test(token)) {
        // Handle range reference (e.g. A1:B10) — skip past the end-cell; ranges are not evaluatable here
        if (src[pos] === ':') {
          pos++; // skip ':'
          while (pos < src.length && /[A-Za-z]/.test(src[pos])) pos++; // skip end col letters
          while (pos < src.length && /[0-9]/.test(src[pos])) pos++; // skip end row digits
          return null;
        }
        return getCellVal(token.toUpperCase());
      }
      // Function call
      if (src[pos] === '(') {
        pos++;
        const args: FormulaVal[] = [];
        while (pos < src.length) {
          skipWs();
          if (src[pos] === ')') { pos++; break; }
          const prevPos = pos;
          args.push(parseExpr());
          skipWs();
          if (src[pos] === ',') { pos++; continue; }
          // Safety: if parseExpr made no progress and we're not at ')' or ',',
          // advance one char to prevent an infinite loop on unexpected chars (e.g. ':')
          if (pos === prevPos) pos++;
        }
        const fname = token.toUpperCase();
        if (fname === 'IF') return args[0] ? (args[1] ?? null) : (args[2] ?? null);
        if (fname === 'SUM') return args.reduce<number>((a, v) => a + Number(v), 0);
        if (fname === 'ROUND') {
          const digits = Number(args[1] ?? 0);
          return Math.round(Number(args[0]) * 10 ** digits) / 10 ** digits;
        }
        if (fname === 'INT') return Math.floor(Number(args[0]));
        if (fname === 'ABS') return Math.abs(Number(args[0]));
        if (fname === 'MAX') return Math.max(...args.map(Number));
        if (fname === 'MIN') return Math.min(...args.map(Number));
        if (fname === 'AND') return args.every(Boolean);
        if (fname === 'OR') return args.some(Boolean);
        if (fname === 'NOT') return !args[0];
        if (fname === 'IFERROR') return args[0] !== null ? args[0] : (args[1] ?? null);
        if (fname === 'CONCATENATE' || fname === 'CONCAT') return args.map(v => String(v ?? '')).join('');
        if (fname === 'LEN') return String(args[0] ?? '').length;
        if (fname === 'TRIM') return String(args[0] ?? '').trim();
        if (fname === 'UPPER') return String(args[0] ?? '').toUpperCase();
        if (fname === 'LOWER') return String(args[0] ?? '').toLowerCase();
        if (fname === 'LEFT') return String(args[0] ?? '').slice(0, Number(args[1] ?? 1));
        if (fname === 'RIGHT') return String(args[0] ?? '').slice(-Number(args[1] ?? 1));
        if (fname === 'MID') return String(args[0] ?? '').slice(Number(args[1] ?? 1) - 1, Number(args[1] ?? 1) - 1 + Number(args[2] ?? 1));
        if (fname === 'TEXT') return String(args[0] ?? '');
        if (fname === 'VALUE') return Number(args[0]);
        if (fname === 'SQRT') return Math.sqrt(Number(args[0]));
        if (fname === 'POWER') return Math.pow(Number(args[0]), Number(args[1]));
        if (fname === 'MOD') return Number(args[0]) % Number(args[1]);
        if (fname === 'COUNTA') return args.filter(v => v !== null && v !== '').length;
        if (fname === 'COUNT') return args.filter(v => typeof v === 'number').length;
        if (fname === 'AVERAGE') {
          const nums = args.filter(v => typeof v === 'number') as number[];
          return nums.length ? nums.reduce((a, v) => a + v, 0) / nums.length : null;
        }
        // Unknown function — return null rather than crash
        return null;
      }
      // Reset to just letters if digits were consumed but it's not a cell ref or function
      pos = lettersEnd;
      const kw = token.slice(0, lettersEnd - start).toUpperCase();
      if (kw === 'TRUE') return true;
      if (kw === 'FALSE') return false;
      return null;
    }
    // Unrecognized character — advance to prevent infinite loops in outer loops
    pos++;
    return null;
  }

  try {
    return parseExpr();
  } catch {
    return null;
  }
}

function renderXlsxSheet(XLSX: XlsxModule, sheet: XlsxSheets[string]): string {
  if (!sheet['!ref']) {
    return '<html><body style="padding:16px;color:#888;font-family:sans-serif">Empty sheet</body></html>';
  }

  const range = XLSX.utils.decode_range(sheet['!ref']!);
  const merges =
    (sheet['!merges'] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>) ?? [];
  const colInfos =
    (sheet['!cols'] as Array<{ wch?: number; width?: number; wpx?: number }> | undefined) ?? [];
  const rowInfos =
    (sheet['!rows'] as Array<{ hpt?: number; hpx?: number } | undefined> | undefined) ?? [];

  // Pre-compute formula cells (t='z' = uncalculated stub; file stores v=0 as default cached value)
  // We do a multi-pass evaluation so formulas that reference other formula cells resolve correctly.
  const formulaComputed = new Map<string, FormulaVal>();
  const getCellVal = (addr: string): FormulaVal => {
    const computed = formulaComputed.get(addr);
    if (computed !== undefined) return computed;
    const c = sheet[addr] as XlsxCellObject | undefined;
    if (!c) return null;
    // Prefer Excel's pre-formatted string for non-formula cells
    if (typeof c.w === 'string' && c.w !== '') {
      const n = Number(c.w.replace(/,/g, ''));
      return isNaN(n) ? c.w : n;
    }
    if (typeof c.v === 'number') return c.v;
    if (typeof c.v === 'string') return c.v;
    if (typeof c.v === 'boolean') return c.v;
    return null;
  };
  // Collect all formula cells in range order
  const allFormulaCells: string[] = [];
  {
    const r = XLSX.utils.decode_range(sheet['!ref']!);
    for (let R = r.s.r; R <= r.e.r; R++) {
      for (let C = r.s.c; C <= r.e.c; C++) {
        const a = XLSX.utils.encode_cell({ r: R, c: C });
        const ce = sheet[a] as XlsxCellObject | undefined;
        if (ce?.f) allFormulaCells.push(a);
      }
    }
  }
  // Three passes handle chains of dependent formulas
  for (let pass = 0; pass < 3; pass++) {
    for (const addr of allFormulaCells) {
      const ce = sheet[addr] as XlsxCellObject;
      if (!ce.f) continue;
      const result = evalXlsxFormula(ce.f, getCellVal);
      if (result !== null) formulaComputed.set(addr, result);
    }
  }

  // Build merge map: top-left cell → span; covered cells in skipSet
  const skipSet = new Set<string>();
  const spanMap = new Map<string, { cs: number; rs: number }>();
  for (const m of merges) {
    const topLeft = XLSX.utils.encode_cell(m.s);
    spanMap.set(topLeft, { cs: m.e.c - m.s.c + 1, rs: m.e.r - m.s.r + 1 });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) skipSet.add(XLSX.utils.encode_cell({ r, c }));
      }
    }
  }

  const parts: string[] = [
    '<html><head><meta charset="utf-8"><style>',
    'body{margin:0;padding:8px;font-family:Calibri,Arial,sans-serif;font-size:11pt;background:#fff}',
    'table{border-collapse:collapse;width:100%}',
    'td{border:1px solid #d0d7de;padding:2px 6px;overflow:hidden;white-space:nowrap;vertical-align:bottom}',
    '</style></head><body><table>',
  ];

  for (let C = range.s.c; C <= range.e.c; C++) {
    const ci = colInfos[C];
    const w = ci?.wpx
      ? `${ci.wpx}px`
      : ci?.width
        ? `${Math.round(ci.width * 7)}px`
        : ci?.wch
          ? `${Math.round(ci.wch * 8)}px`
          : '80px';
    parts.push(`<col style="width:${w}">`);
  }

  const H_ALIGN: Record<string, string> = {
    center: 'center',
    right: 'right',
    left: 'left',
    justify: 'justify',
    distributed: 'justify',
  };
  const V_ALIGN: Record<string, string> = {
    center: 'middle',
    top: 'top',
    bottom: 'bottom',
    distributed: 'middle',
    justify: 'middle',
  };

  for (let R = range.s.r; R <= range.e.r; R++) {
    const ri = rowInfos[R];
    const rh = ri?.hpx
      ? ` style="height:${ri.hpx}px"`
      : ri?.hpt
        ? ` style="height:${ri.hpt}pt"`
        : '';
    parts.push(`<tr${rh}>`);

    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (skipSet.has(addr)) continue;

      const cell = sheet[addr] as XlsxCellObject | undefined;
      const s = (cell?.s as XlsxCellStyle | undefined) ?? {};
      const span = spanMap.get(addr);
      const attrs: string[] = [];
      if (span && span.cs > 1) attrs.push(`colspan="${span.cs}"`);
      if (span && span.rs > 1) attrs.push(`rowspan="${span.rs}"`);

      const css: string[] = [];

      // Background fill
      if (s.fill?.patternType !== 'none') {
        const bg = colorToHex(s.fill?.fgColor);
        if (bg) css.push(`background-color:${bg}`);
      }

      // Font
      const f = s.font;
      if (f) {
        const fc = colorToHex(f.color);
        if (fc) css.push(`color:${fc}`);
        if (f.bold) css.push('font-weight:bold');
        if (f.italic) css.push('font-style:italic');
        if (f.sz) css.push(`font-size:${f.sz}pt`);
        if (f.name) css.push(`font-family:"${f.name}",sans-serif`);
        const decors: string[] = [];
        if (f.u) decors.push('underline');
        if (f.strike) decors.push('line-through');
        if (decors.length) css.push(`text-decoration:${decors.join(' ')}`);
      }

      // Alignment
      const ha = s.alignment?.horizontal;
      const va = s.alignment?.vertical;
      if (ha) css.push(`text-align:${H_ALIGN[ha] ?? 'left'}`);
      if (va) css.push(`vertical-align:${V_ALIGN[va] ?? 'bottom'}`);
      if (s.alignment?.wrapText) css.push('white-space:pre-wrap');

      const styleAttr = css.length ? ` style="${css.join(';')}"` : '';
      // Use cell.w (Excel's pre-formatted display string) as the authoritative source.
      // An empty cell.w means Excel itself displays nothing — respect that and do NOT
      // fall back to cell.v, which would turn hidden-zero cells into "0".
      // Only fall back when cell.w is absent (undefined) entirely.
      let value = '';
      if (cell) {
        // For formula cells (t='z'), use our client-side evaluated result first
        const computed = formulaComputed.get(addr);
        if (computed !== undefined && computed !== null) {
          if (typeof computed === 'number') {
            // Trim trailing zeros but keep up to 4 decimal places
            value = Number.isInteger(computed) ? String(computed) : parseFloat(computed.toFixed(4)).toString();
          } else {
            value = String(computed);
          }
        } else if (typeof cell.w === 'string') {
          // cell.w defined (even ''); trust Excel's own formatted display
          value = cell.w;
        } else if (cell.t === 'b') {
          value = cell.v ? 'TRUE' : 'FALSE';
        } else if (cell.t === 'e') {
          value = '#ERROR';
        } else if (cell.v !== undefined && cell.v !== null) {
          value = String(cell.v);
        }
      }
      const safe = value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      parts.push(`<td${attrs.length ? ` ${attrs.join(' ')}` : ''}${styleAttr}>${safe}</td>`);
    }

    parts.push('</tr>');
  }

  parts.push('</table></body></html>');
  return parts.join('');
}

function OfficePreviewContent({
  artifact,
  url,
  kind,
  t,
}: {
  artifact: ArtifactRef;
  url: string;
  kind: OfficePreviewKind;
  t: (key: string, vars?: Record<string, string>) => string;
}): ReactElement {
  const docContainerRef = useRef<HTMLDivElement>(null);
  const xlsxModuleRef = useRef<XlsxModule | null>(null);
  const xlsxSheetsRef = useRef<XlsxSheets | null>(null);
  const sheetHtmlsRef = useRef<Map<string, string>>(new Map());
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [activeHtml, setActiveHtml] = useState<string | null>(null);

  useEffect(() => {
    setStatus('loading');
    sheetHtmlsRef.current.clear();
    xlsxModuleRef.current = null;
    xlsxSheetsRef.current = null;
    setSheetNames([]);
    setActiveSheet('');
    setActiveHtml(null);

    if (kind === 'pptx') {
      setStatus('done');
      return;
    }

    const controller = new AbortController();

    void (async (): Promise<void> => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (controller.signal.aborted) return;

        if (kind === 'docx') {
          const { renderAsync } = await import('docx-preview');
          if (controller.signal.aborted || !docContainerRef.current) return;
          await renderAsync(buffer, docContainerRef.current, undefined, {
            className: 'docx-preview-body',
            ignoreWidth: true,
            ignoreHeight: true,
          });
        } else if (kind === 'xlsx') {
          const XLSX = await import('xlsx-js-style');
          if (controller.signal.aborted) return;
          const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellStyles: true });
          if (controller.signal.aborted) return;

          const names = wb.SheetNames;
          if (names.length === 0) throw new Error('Empty workbook');

          xlsxModuleRef.current = XLSX;
          xlsxSheetsRef.current = wb.Sheets;

          const firstName = names[0];
          const firstHtml = renderXlsxSheet(XLSX, wb.Sheets[firstName]);
          sheetHtmlsRef.current.set(firstName, firstHtml);

          if (!controller.signal.aborted) {
            setSheetNames(names);
            setActiveSheet(firstName);
            setActiveHtml(firstHtml);
          }
        }

        if (!controller.signal.aborted) setStatus('done');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [artifact.contentItemId, url, kind]);

  const handleSheetSwitch = useCallback(
    (name: string): void => {
      if (!xlsxModuleRef.current || !xlsxSheetsRef.current) return;
      setActiveSheet(name);
      const cached = sheetHtmlsRef.current.get(name);
      if (cached !== undefined) {
        setActiveHtml(cached);
        return;
      }
      const html = renderXlsxSheet(xlsxModuleRef.current, xlsxSheetsRef.current[name]);
      sheetHtmlsRef.current.set(name, html);
      setActiveHtml(html);
    },
    [],
  );

  if (kind === 'pptx') {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/8 bg-slate-950/70 p-8 text-sm text-slate-400">
        <svg
          className="h-12 w-12 text-slate-600"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <div className="text-center">
          <div className="mb-1 font-medium text-slate-300">
            {t('deliverables.artifact.pptxNoPreview')}
          </div>
          <div>{t('deliverables.artifact.pptxDownloadHint')}</div>
        </div>
      </div>
    );
  }

  const label =
    kind === 'docx'
      ? t('deliverables.artifact.docxPreview')
      : t('deliverables.artifact.xlsxPreview');

  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/8 px-4 py-2">
        <span className="text-xs text-slate-400">{label}</span>
        {sheetNames.length > 1 &&
          sheetNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => handleSheetSwitch(name)}
              className={`rounded px-2 py-0.5 text-xs transition-colors ${
                name === activeSheet
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {name}
            </button>
          ))}
      </div>

      {status === 'loading' && (
        <div className="p-5 text-sm text-slate-500">
          {t('deliverables.artifact.officePreviewLoading')}
        </div>
      )}

      {status === 'error' && (
        <div className="p-5 text-sm text-amber-300">
          {t('deliverables.artifact.officePreviewFailed')}
        </div>
      )}

      {kind === 'docx' && (
        <div
          ref={docContainerRef}
          className="max-h-[720px] overflow-auto bg-white p-4"
          style={{ display: status === 'done' ? 'block' : 'none' }}
        />
      )}

      {kind === 'xlsx' && activeHtml !== null && (
        <iframe
          srcDoc={activeHtml}
          sandbox=""
          title={artifact.name}
          className="h-[720px] w-full bg-white"
        />
      )}
    </div>
  );
}

function ArtifactPreviewContent({
  artifact,
  t,
}: {
  artifact: ArtifactRef;
  t: (key: string, vars?: Record<string, string>) => string;
}): ReactElement | null {
  const url = artifactUrl(artifact);
  const [textContent, setTextContent] = useState<string | null>(artifact.textContent ?? null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setTextContent(artifact.textContent ?? null);
    setLoadFailed(false);
    if (artifact.textContent || !url || !canFetchTextPreview(artifact)) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const body = new TextDecoder('utf-8').decode(buffer);
        if (!controller.signal.aborted) {
          setTextContent(body);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [artifact.contentItemId, artifact.id, artifact.mimeType, artifact.size, artifact.textContent, url]);

  const mediaPreview = renderMediaPreview(artifact, t);
  if (mediaPreview) {
    return mediaPreview;
  }

  if (textContent?.trim()) {
    return renderArtifactTextContent(artifact, textContent);
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
        {t('deliverables.artifact.loadingPreview')}
      </div>
    );
  }

  const officeKind = getOfficeKind(artifact);
  if (url && officeKind) {
    return <OfficePreviewContent artifact={artifact} url={url} kind={officeKind} t={t} />;
  }

  if (url && canEmbedBrowserPreview(artifact)) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70">
        <div className="border-b border-white/8 px-4 py-2 text-xs text-slate-400">
          {t('deliverables.artifact.browserPreview')}
        </div>
        <iframe
          title={artifact.name}
          src={url}
          sandbox={artifact.mimeType === 'text/html' ? '' : undefined}
          className="h-[720px] w-full bg-white"
        />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="rounded-2xl border border-dashed border-amber-400/20 bg-amber-500/8 p-5 text-sm text-amber-100">
        {t('deliverables.artifact.previewFailed')}
      </div>
    );
  }

  return null;
}

export function DeliverableDetailView({
  deliverable,
  loading = false,
  onPublished,
  onOpenFiles,
}: {
  deliverable: DeliverableRecord | null;
  loading?: boolean;
  onPublished?: () => void;
  onOpenFiles?: (artifact?: ArtifactRef) => void;
}) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [batchPublishing, setBatchPublishing] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [publicationOverrides, setPublicationOverrides] = useState<
    Record<string, Partial<DeliverablePublicationTarget>>
  >({});
  // B4: inline title/summary editing
  const [editingField, setEditingField] = useState<'title' | 'summary' | null>(null);
  const [localTitle, setLocalTitle] = useState<string | null>(null);
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  // B3: file attach
  const [showAttach, setShowAttach] = useState(false);
  const [attachPath, setAttachPath] = useState('');
  const [attaching, setAttaching] = useState(false);
  // B5: execution trace
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceRun, setTraceRun] = useState<WorkflowRunRecord | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ArtifactRef | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [categoryTarget, setCategoryTarget] = useState<ArtifactRef | null>(null);
  const [categoryValue, setCategoryValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ArtifactRef | null>(null);
  const [artifactActionBusy, setArtifactActionBusy] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const summaryInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPublicationOverrides({});
    setPublishingId(null);
    setSelectedArtifactId(null);
    setEditingField(null);
    setLocalTitle(null);
    setLocalSummary(null);
    setShowAttach(false);
    setAttachPath('');
    setTraceOpen(false);
    setTraceRun(null);
    setRenameTarget(null);
    setRenameValue('');
    setCategoryTarget(null);
    setCategoryValue('');
    setDeleteTarget(null);
    setArtifactActionBusy(false);
  }, [deliverable?.id]);

  if (loading) {
    return (
      <div className="rounded-[28px] border border-white/10 bg-slate-950/70 p-8 text-sm text-slate-400">
        {t('deliverables.loading')}
      </div>
    );
  }

  if (!deliverable) {
    return (
      <div className="rounded-[28px] border border-dashed border-white/10 bg-slate-950/40 p-8 text-sm text-slate-500">
        {t('deliverables.detail.none')}
      </div>
    );
  }

  const artifacts = deliverable.artifacts;
  const activeArtifact =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? primaryArtifact(deliverable);
  const preview = activeArtifact ? artifactPreview(activeArtifact) : null;
  const publications = (deliverable.publications ?? []).map((publication) => ({
    ...publication,
    ...(publicationOverrides[publication.id] ?? {}),
  }));
  const artifactCategories = Array.from(
    new Set(
      artifacts
        .map((artifact) => artifact.category?.trim())
        .filter((category): category is string => Boolean(category)),
    ),
  ).sort();

  const moveArtifactSelection = (nextIndex: number): void => {
    const artifact = artifacts[nextIndex];
    if (!artifact) return;
    setSelectedArtifactId(artifact.id);
    queueMicrotask(() => {
      const element = document.getElementById(`deliverable-artifact-${artifact.id}`);
      element?.focus();
    });
  };

  const handleArtifactKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveArtifactSelection(Math.min(index + 1, artifacts.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveArtifactSelection(Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      moveArtifactSelection(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      moveArtifactSelection(artifacts.length - 1);
    }
  };

  const publishToTarget = async (publication: DeliverablePublicationTarget): Promise<void> => {
    setPublishingId(publication.id);
    try {
      await rpc('deliverable.publish', {
        deliverableId: deliverable.id,
        publicationId: publication.id,
      });
      setPublicationOverrides((current) => ({
        ...current,
        [publication.id]: {
          status: 'sent',
          lastAttemptAt: Date.now(),
        },
      }));
      toast(t('deliverables.publish.success'), 'success');
      onPublished?.();
    } catch (error) {
      setPublicationOverrides((current) => ({
        ...current,
        [publication.id]: {
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          lastAttemptAt: Date.now(),
        },
      }));
      toast(error instanceof Error ? error.message : t('deliverables.publish.failed'), 'error');
    } finally {
      setPublishingId(null);
    }
  };

  const batchPublishAll = async (): Promise<void> => {
    setBatchPublishing(true);
    try {
      const result = await rpc<{ total: number; results: Array<{ ok: boolean }> }>(
        'deliverable.batchPublish',
        { deliverableId: deliverable.id },
      );
      const successCount = result.results.filter((r) => r.ok).length;
      toast(t('deliverables.publish.batchDone', { count: String(successCount) }), 'success');
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.publish.failed'), 'error');
    } finally {
      setBatchPublishing(false);
    }
  };

  const saveField = async (field: 'title' | 'summary', value: string): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (field === 'title') setLocalTitle(trimmed);
    else setLocalSummary(trimmed);
    try {
      await rpc('deliverable.update', { deliverableId: deliverable.id, [field]: trimmed });
      toast(t('deliverables.update.success'), 'success');
      onPublished?.();
    } catch {
      toast(t('deliverables.update.failed'), 'error');
      if (field === 'title') setLocalTitle(null);
      else setLocalSummary(null);
    }
    setEditingField(null);
  };

  const attachFile = async (): Promise<void> => {
    if (!attachPath.trim()) return;
    setAttaching(true);
    try {
      await rpc('deliverable.attachArtifact', {
        deliverableId: deliverable.id,
        filePath: attachPath.trim(),
      });
      toast(t('deliverables.attach.success'), 'success');
      setAttachPath('');
      setShowAttach(false);
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.attach.failed'), 'error');
    } finally {
      setAttaching(false);
    }
  };

  const loadTrace = async (): Promise<void> => {
    if (deliverable.source.kind !== 'workflow_run') return;
    setTraceLoading(true);
    try {
      const result = await rpc<WorkflowRunRecord | null>('workflow.runStatus', {
        runId: deliverable.source.runId,
      });
      setTraceRun(result);
    } catch {
      // silently ignore
    } finally {
      setTraceLoading(false);
    }
  };

  const saveArtifactRename = async (): Promise<void> => {
    if (!renameTarget) return;
    const nextName = renameValue.trim();
    if (!nextName) return;
    setArtifactActionBusy(true);
    try {
      await rpc('artifact.rename', {
        deliverableId: deliverable.id,
        artifactId: renameTarget.id,
        name: nextName,
      });
      toast(t('files.artifact.rename'), 'success');
      setRenameTarget(null);
      setRenameValue('');
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.update.failed'), 'error');
    } finally {
      setArtifactActionBusy(false);
    }
  };

  const saveArtifactCategory = async (): Promise<void> => {
    if (!categoryTarget) return;
    setArtifactActionBusy(true);
    try {
      await rpc('artifact.setCategory', {
        deliverableId: deliverable.id,
        artifactId: categoryTarget.id,
        category: categoryValue.trim() || null,
      });
      toast(
        categoryValue.trim() ? t('files.category.set') : t('files.category.clear'),
        'success',
      );
      setCategoryTarget(null);
      setCategoryValue('');
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.update.failed'), 'error');
    } finally {
      setArtifactActionBusy(false);
    }
  };

  const removeArtifact = async (): Promise<void> => {
    if (!deleteTarget) return;
    setArtifactActionBusy(true);
    try {
      await rpc('artifact.delete', {
        deliverableId: deliverable.id,
        artifactId: deleteTarget.id,
      });
      if (selectedArtifactId === deleteTarget.id) {
        setSelectedArtifactId(null);
      }
      toast(t('files.artifact.delete'), 'success');
      setDeleteTarget(null);
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.update.failed'), 'error');
    } finally {
      setArtifactActionBusy(false);
    }
  };

  return (
    <div className="rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(34,197,94,0.14),transparent_22%),radial-gradient(circle_at_top_left,rgba(59,130,246,0.18),transparent_32%),rgba(2,6,23,0.88)] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.45)] backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/8 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(deliverable.status)}>{deliverable.status}</Badge>
            <Badge
              variant={
                deliverable.source.kind === 'workflow_run'
                  ? 'blue'
                  : deliverable.source.kind === 'scheduler_task_run'
                    ? 'purple'
                    : 'green'
              }
            >
              {sourceLabel(deliverable, t)}
            </Badge>
            <Badge variant="gray">{artifacts.length}</Badge>
          </div>
          <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-50">
            {editingField === 'title' ? (
              <input
                ref={titleInputRef}
                autoFocus
                defaultValue={localTitle ?? deliverable.title}
                className="w-full rounded-lg bg-slate-800/80 px-3 py-1.5 text-xl font-semibold text-slate-50 ring-1 ring-cyan-400/50 outline-none"
                onBlur={(e) => void saveField('title', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingField(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span
                title={t('deliverables.detail.editHint')}
                className="cursor-text hover:opacity-80"
                onDoubleClick={() => setEditingField('title')}
              >
                {localTitle ?? deliverable.title}
              </span>
            )}
          </h3>
          <p className="mt-1 max-w-3xl line-clamp-2 text-sm leading-6 text-slate-300">
            {editingField === 'summary' ? (
              <textarea
                ref={summaryInputRef}
                autoFocus
                rows={2}
                defaultValue={localSummary ?? deliverable.summary}
                className="w-full rounded-lg bg-slate-800/80 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-cyan-400/50 outline-none resize-none"
                onBlur={(e) => void saveField('summary', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingField(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span
                title={t('deliverables.detail.editHint')}
                className="cursor-text hover:opacity-80"
                onDoubleClick={() => setEditingField('summary')}
              >
                {(localSummary ?? deliverable.summary) || deliverable.previewText || t('deliverables.artifact.noPreview')}
              </span>
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.createdAt')}</span>
              {new Date(deliverable.createdAt).toLocaleString()}
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.updatedAt')}</span>
              {new Date(deliverable.updatedAt).toLocaleString()}
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.artifactCount')}</span>
              {deliverable.artifacts.length}
            </div>
            <div className="max-w-full rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.sourceKey')}</span>
              <span className="break-all">{sourceKey(deliverable)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onOpenFiles && (
            <Button variant="ghost" size="sm" onClick={() => onOpenFiles()}>
              {t('nav.files')}
            </Button>
          )}
          <CopyButton text={deliverable.previewText || deliverable.summary || deliverable.title} />
        </div>
      </div>

      <div className="mt-4 grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="xl:sticky xl:top-6 xl:self-start">
          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                {t('deliverables.detail.artifacts')}
              </div>
              <div className="flex items-center gap-2">
                {artifacts.length > 1 && (
                  <button
                    type="button"
                    className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] text-cyan-200 hover:bg-cyan-500/18"
                    onClick={() => downloadAllArtifacts(artifacts)}
                    title={t('deliverables.artifact.downloadAll')}
                  >
                    ↓ {t('deliverables.artifact.downloadAll')}
                  </button>
                )}
                <Badge variant="gray">{artifacts.length}</Badge>
              </div>
            </div>
            <div className="mb-3 rounded-xl border border-cyan-400/10 bg-cyan-500/[0.06] px-3 py-2 text-[11px] leading-5 text-cyan-100/80">
              {t('deliverables.artifact.keyboardHint')}
            </div>
            <div className="flex max-h-[760px] flex-col gap-2 overflow-auto pr-1">
              {artifacts.map((artifact, index) => {
                const active = artifact.id === activeArtifact?.id;
                const sizeLabel = formatBytes(artifact.size);
                return (
                  <button
                    id={`deliverable-artifact-${artifact.id}`}
                    key={artifact.id}
                    type="button"
                    onClick={() => setSelectedArtifactId(artifact.id)}
                    onKeyDown={(event) => handleArtifactKeyDown(event, index)}
                    className={`relative rounded-2xl border px-4 py-3 pl-5 text-left transition-all ${
                      active
                        ? 'border-cyan-300/45 bg-cyan-500/12 ring-1 ring-cyan-300/30 shadow-[0_18px_36px_rgba(6,182,212,0.12)]'
                        : 'border-white/8 bg-slate-950/55 hover:border-white/15 hover:bg-white/[0.03] focus:border-cyan-300/35'
                    }`}
                    aria-pressed={active}
                  >
                    <span
                      className={`absolute inset-y-3 left-2 w-1 rounded-full ${
                        active ? 'bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.85)]' : 'bg-white/8'
                      }`}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-sm font-medium text-slate-100">{artifact.name}</div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <div className="rounded-full border border-white/8 bg-slate-900/80 px-2 py-0.5 text-[10px] text-slate-400">
                          {index + 1}/{artifacts.length}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        className="rounded-full border border-slate-600/40 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700/70"
                        onClick={(e) => { e.stopPropagation(); downloadArtifact(artifact); }}
                        title={t('deliverables.artifact.download')}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-slate-600/40 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700/70"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameTarget(artifact);
                          setRenameValue(artifact.name);
                        }}
                        title={t('files.artifact.rename')}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-slate-600/40 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700/70"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCategoryTarget(artifact);
                          setCategoryValue(artifact.category ?? '');
                        }}
                        title={t('files.category.set')}
                      >
                        📁
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-rose-400/30 bg-rose-500/12 px-2 py-0.5 text-[10px] text-rose-200 hover:bg-rose-500/22"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(artifact);
                        }}
                        title={t('files.artifact.delete')}
                      >
                        🗑
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant={artifact.role === 'primary' ? 'blue' : 'purple'}>
                        {artifact.role}
                      </Badge>
                      <Badge variant="gray">{artifact.format}</Badge>
                      {sizeLabel && <Badge variant="gray">{sizeLabel}</Badge>}
                      {artifact.category && <Badge variant="blue">{artifact.category}</Badge>}
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">
                      {artifact.mimeType ?? artifact.filePath ?? ''}
                    </div>
                  </button>
                );
              })}
            </div>
            {/* B3: Attach file */}
            {!showAttach ? (
              <button
                type="button"
                className="mt-3 w-full rounded-xl border border-dashed border-slate-600/50 py-2 text-[11px] text-slate-500 hover:border-cyan-400/30 hover:text-cyan-300"
                onClick={() => setShowAttach(true)}
              >
                {t('deliverables.attach.action')}
              </button>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                <input
                  autoFocus
                  className="w-full rounded-lg bg-slate-800/70 px-3 py-2 text-xs text-slate-200 ring-1 ring-slate-600/60 outline-none focus:ring-cyan-400/40"
                  placeholder={t('deliverables.attach.placeholder')}
                  value={attachPath}
                  onChange={(e) => setAttachPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void attachFile();
                    if (e.key === 'Escape') { setShowAttach(false); setAttachPath(''); }
                  }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={attaching || !attachPath.trim()}
                    className="flex-1 rounded-lg bg-cyan-600/30 py-1.5 text-xs text-cyan-100 hover:bg-cyan-600/45 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void attachFile()}
                  >
                    {attaching ? '…' : t('deliverables.attach.confirm')}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-600/40 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                    onClick={() => { setShowAttach(false); setAttachPath(''); }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {activeArtifact && (
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-slate-500">
                      <span>{t('deliverables.detail.primary')}</span>
                      <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-400">
                        {artifacts.findIndex((artifact) => artifact.id === activeArtifact.id) + 1}/{artifacts.length}
                      </span>
                    </div>
                    <div className="mt-2 truncate text-lg font-semibold text-slate-50">
                      {activeArtifact.name}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant={activeArtifact.role === 'primary' ? 'blue' : 'purple'}>
                        {activeArtifact.role}
                      </Badge>
                      <Badge variant="gray">{activeArtifact.format}</Badge>
                      {activeArtifact.mimeType && <Badge variant="gray">{activeArtifact.mimeType}</Badge>}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {onOpenFiles && activeArtifact && (
                  <Button variant="ghost" size="sm" onClick={() => onOpenFiles(activeArtifact)}>
                    {t('nav.files')}
                  </Button>
                )}
                {preview && <CopyButton text={preview} />}
              </div>
            </div>
            {activeArtifact ? (
              <ArtifactPreviewContent key={activeArtifact.id} artifact={activeArtifact} t={t} />
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
                {t('deliverables.artifact.noPreview')}
              </div>
            )}
            {activeArtifact?.filePath && (
              <div className="mt-4 rounded-xl bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  {t('deliverables.artifact.filePath')}
                </div>
                <div className="mt-1 break-all">{activeArtifact.filePath}</div>
              </div>
            )}
            {artifactUrl(activeArtifact) && (
              <div className="mt-4 flex justify-end">
                <a
                  href={artifactUrl(activeArtifact) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/15"
                >
                  {t('deliverables.artifact.openRaw')}
                </a>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {t('deliverables.detail.source')}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {deliverable.source.kind === 'workflow_run' ? (
                <>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.workflowId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.workflowId}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.runId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.runId}</div>
                  </div>
                </>
              ) : deliverable.source.kind === 'scheduler_task_run' ? (
                <>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.taskId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.taskId}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.runKey')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.runKey}</div>
                  </div>
                  {deliverable.source.workflowId && (
                    <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        {t('deliverables.detail.workflowId')}
                      </div>
                      <div className="mt-1 break-all">{deliverable.source.workflowId}</div>
                    </div>
                  )}
                  {deliverable.source.agentId && (
                    <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        {t('deliverables.detail.agentId')}
                      </div>
                      <div className="mt-1 break-all">{deliverable.source.agentId}</div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.agentId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.agentId}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.threadKey')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.threadKey}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.channelId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.channelId}</div>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                {t('deliverables.detail.distribution')}
              </div>
              <div className="flex items-center gap-2">
                {publications.some((p) => p.status === 'available' || p.status === 'planned') && (
                  <button
                    type="button"
                    disabled={batchPublishing}
                    className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] text-cyan-200 hover:bg-cyan-500/18 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void batchPublishAll()}
                  >
                    {batchPublishing ? t('deliverables.publish.batchSending') : t('deliverables.publish.publishAll')}
                  </button>
                )}
                <Badge variant="gray">{publications.length}</Badge>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {publications.map((publication) => (
                <div
                  key={publication.id}
                  className="rounded-2xl border border-white/8 bg-slate-950/60 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={publicationVariant(publication.status)}>
                      {t(`deliverables.publication.status.${publication.status}`)}
                    </Badge>
                    <Badge variant={publication.mode === 'artifact' ? 'green' : 'blue'}>
                      {t(`deliverables.publication.mode.${publication.mode}`)}
                    </Badge>
                    <Badge variant="gray">{t(`deliverables.publication.kind.${publication.kind}`)}</Badge>
                    {publication.lastAttemptAt && publication.status === 'sent' && (
                      <span className="text-[10px] text-slate-500">
                        {new Date(publication.lastAttemptAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-sm font-medium text-slate-100">{publication.label}</div>
                  {publication.detail && (
                    <div className="mt-2 text-xs leading-5 text-slate-400">{publication.detail}</div>
                  )}
                  <div className="mt-3 text-[11px] text-slate-500">
                    {t('deliverables.publication.targetId')}: {publication.targetId}
                  </div>
                  {publication.threadKey && (
                    <div className="mt-1 text-[11px] text-slate-500">threadKey: {publication.threadKey}</div>
                  )}
                  {publication.agentId && (
                    <div className="mt-1 text-[11px] text-slate-500">agentId: {publication.agentId}</div>
                  )}
                  {(publication.status === 'available' || publication.status === 'planned' || publication.status === 'failed') && (
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={publishingId === publication.id}
                        onClick={() => void publishToTarget(publication)}
                      >
                        {publishingId === publication.id
                          ? t('deliverables.publish.sending')
                          : publication.status === 'failed'
                            ? t('deliverables.publish.retry')
                            : t('deliverables.publish.action')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {publications.length === 0 && (
                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
                  {t('deliverables.detail.noDistribution')}
                </div>
              )}
            </div>
          </section>

          {/* B5: Workflow execution trace panel */}
          {deliverable.source.kind === 'workflow_run' && (
            <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <button
                type="button"
                className="flex w-full items-center justify-between text-[11px] uppercase tracking-[0.22em] text-slate-500 hover:text-slate-300"
                onClick={() => {
                  const next = !traceOpen;
                  setTraceOpen(next);
                  if (next && !traceRun && !traceLoading) void loadTrace();
                }}
              >
                <span>{t('deliverables.trace.title')}</span>
                <span className="text-slate-600">{traceOpen ? '▲' : '▼'}</span>
              </button>
              {traceOpen && (
                <div className="mt-3">
                  {traceLoading && (
                    <div className="text-xs text-slate-500">{t('deliverables.trace.loading')}</div>
                  )}
                  {!traceLoading && traceRun && traceRun.stepResults.length === 0 && (
                    <div className="text-xs text-slate-500">{t('deliverables.trace.empty')}</div>
                  )}
                  {!traceLoading && traceRun && traceRun.stepResults.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {traceRun.stepResults.map((result: WorkflowStepResult, idx: number) => {
                        const duration =
                          result.startedAt && result.finishedAt
                            ? `${((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s`
                            : null;
                        const hasError = !!result.error;
                        const isDone = !!result.finishedAt && !hasError;
                        return (
                          <button
                            key={result.stepId}
                            type="button"
                            className={`rounded-xl border p-3 text-left transition-all ${
                              artifacts.some((a) => a.stepId === result.stepId)
                                ? 'border-cyan-400/25 bg-cyan-500/8 hover:bg-cyan-500/14'
                                : 'border-white/8 bg-slate-950/50 hover:border-white/15'
                            }`}
                            onClick={() => {
                              const artifact = artifacts.find((a) => a.stepId === result.stepId);
                              if (artifact) setSelectedArtifactId(artifact.id);
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium text-slate-200">
                                {idx + 1}. {result.stepId}
                              </span>
                              <div className="flex items-center gap-2">
                                {duration && (
                                  <span className="text-[10px] text-slate-500">
                                    {t('deliverables.trace.duration')}: {duration}
                                  </span>
                                )}
                                <Badge variant={hasError ? 'red' : isDone ? 'green' : 'gray'}>
                                  {hasError
                                    ? t('deliverables.trace.step.error')
                                    : isDone
                                      ? t('deliverables.trace.step.done')
                                      : t('deliverables.trace.step.running')}
                                </Badge>
                              </div>
                            </div>
                            {(result.error ?? result.output) && (
                              <div className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-slate-400">
                                {result.error ?? result.output}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!traceLoading && !traceRun && (
                    <div className="text-xs text-slate-500">{t('deliverables.trace.empty')}</div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {renameTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65"
          onClick={() => {
            if (!artifactActionBusy) {
              setRenameTarget(null);
              setRenameValue('');
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/95 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-100">{t('files.artifact.renameTitle')}</div>
            <div className="mt-1 text-xs text-slate-400">{renameTarget.name}</div>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveArtifactRename();
                if (e.key === 'Escape' && !artifactActionBusy) {
                  setRenameTarget(null);
                  setRenameValue('');
                }
              }}
              placeholder={t('files.artifact.namePlaceholder')}
              className="mt-3 w-full rounded-lg border border-slate-600/50 bg-slate-800/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/45"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={artifactActionBusy}
                onClick={() => {
                  setRenameTarget(null);
                  setRenameValue('');
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={artifactActionBusy || !renameValue.trim()}
                onClick={() => void saveArtifactRename()}
              >
                {t('files.category.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {categoryTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65"
          onClick={() => {
            if (!artifactActionBusy) {
              setCategoryTarget(null);
              setCategoryValue('');
            }
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/95 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-100">{t('files.category.set')}</div>
            <div className="mt-1 text-xs text-slate-400">{categoryTarget.name}</div>
            {artifactCategories.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {artifactCategories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className="rounded-md border border-slate-500/40 bg-slate-800/70 px-2 py-0.5 text-[11px] text-slate-300 hover:border-cyan-400/40 hover:text-cyan-200"
                    onClick={() => setCategoryValue(category)}
                  >
                    {category}
                  </button>
                ))}
              </div>
            )}
            <input
              autoFocus
              value={categoryValue}
              onChange={(e) => setCategoryValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveArtifactCategory();
                if (e.key === 'Escape' && !artifactActionBusy) {
                  setCategoryTarget(null);
                  setCategoryValue('');
                }
              }}
              placeholder={t('files.category.placeholder')}
              className="mt-3 w-full rounded-lg border border-slate-600/50 bg-slate-800/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/45"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={artifactActionBusy}
                onClick={() => {
                  setCategoryTarget(null);
                  setCategoryValue('');
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={artifactActionBusy}
                onClick={() => void saveArtifactCategory()}
              >
                {t('files.category.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65"
          onClick={() => {
            if (!artifactActionBusy) setDeleteTarget(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-rose-400/20 bg-slate-900/95 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-rose-200">{t('files.artifact.delete')}</div>
            <div className="mt-2 text-xs text-slate-400">{t('files.artifact.deleteConfirm')}</div>
            <div className="mt-2 truncate text-xs text-slate-200">{deleteTarget.name}</div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={artifactActionBusy}
                onClick={() => setDeleteTarget(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={artifactActionBusy}
                onClick={() => void removeArtifact()}
              >
                {t('files.artifact.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
