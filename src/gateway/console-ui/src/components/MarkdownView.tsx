interface Props {
  content: string;
  className?: string;
}

/** Renders Markdown-like text to safe HTML (subset: bold, italic, code, links, blockquote, ordered/unordered lists). */
export function MarkdownView({ content, className = '' }: Props) {
  const html = toHtml(content);
  return (
    <div
      className={`prose prose-invert prose-sm max-w-none ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineFormat(s: string): string {
  return s
    .replace(
      /`([^`]+)`/g,
      '<code class="bg-slate-700/60 px-1 py-0.5 rounded text-xs font-mono">$1</code>',
    )
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" class="text-indigo-400 underline underline-offset-2">$1</a>',
    );
}

function toHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) {
        out.push(
          `<pre class="bg-slate-900/80 rounded-lg p-3 overflow-x-auto text-xs font-mono"><code>${codeLines.map(escape).join('\n')}</code></pre>`,
        );
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }
    if (!raw.trim()) {
      out.push('<div class="h-2"></div>');
      continue;
    }
    if (raw.startsWith('# ')) {
      out.push(
        `<h1 class="text-xl font-bold text-slate-100 mt-4 mb-2">${inlineFormat(escape(raw.slice(2)))}</h1>`,
      );
    } else if (raw.startsWith('## ')) {
      out.push(
        `<h2 class="text-lg font-semibold text-slate-100 mt-3 mb-1.5">${inlineFormat(escape(raw.slice(3)))}</h2>`,
      );
    } else if (raw.startsWith('### ')) {
      out.push(
        `<h3 class="text-base font-semibold text-slate-200 mt-2 mb-1">${inlineFormat(escape(raw.slice(4)))}</h3>`,
      );
    } else if (raw.startsWith('> ')) {
      out.push(
        `<blockquote class="border-l-2 border-slate-500 pl-3 text-slate-400 italic">${inlineFormat(escape(raw.slice(2)))}</blockquote>`,
      );
    } else if (/^[-*] /.test(raw)) {
      out.push(
        `<li class="ml-4 list-disc text-slate-300">${inlineFormat(escape(raw.slice(2)))}</li>`,
      );
    } else if (/^\d+\. /.test(raw)) {
      out.push(
        `<li class="ml-4 list-decimal text-slate-300">${inlineFormat(escape(raw.replace(/^\d+\. /, '')))}</li>`,
      );
    } else {
      out.push(`<p class="text-slate-300 leading-relaxed">${inlineFormat(escape(raw))}</p>`);
    }
  }
  return out.join('');
}
