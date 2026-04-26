/**
 * Soul file utilities.
 *
 * A "soul" consists of:
 *   - SOUL.md in the agent workspace — identity, personality, description (user-editable)
 *   - Inline persona config (agentflyer.json) — machine-read fields only: language, outputDir
 *
 * Layer mapping:
 *   Layer 0 — language instruction injected here (from persona.language)
 *   Layer 1 — SOUL.md loaded here via workspace.ts (semi-static, 30 s cache)
 */

import type { AgentConfig } from '../../core/config/schema.js';

// ── Section parser (for preserving user-edited SOUL.md content) ──────────────

/**
 * Extract the body of a Markdown section between `## Header` and the next `##`.
 * Returns null when the section is not found in the document.
 */
function extractSection(md: string, header: string): string | null {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // RATIONALE: Do NOT use the 'm' flag — with 'm', '$' matches end-of-line
  // (before every '\n'), causing the lazy capture to stop at the first blank
  // line. Without 'm', '$' only matches end-of-string, so the capture runs
  // until the next '## ' header or the actual end of the document.
  const pattern = new RegExp(`(?:^|\\n)## ${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = md.match(pattern);
  // match[1] is the capture group; present whenever match is non-null
  return match ? (match[1] ?? '').trimEnd() : null;
}

// ── Inline persona → Layer 0 content ─────────────────────────────────────────

/**
 * Build the Layer 0 persona fragment.
 * Injects the language instruction AND a runtime-authoritative tool access
 * section that merges the configured allowlist with skill system tools.
 *
 * RATIONALE: SOUL.md (Layer 1) is user-editable and static — its Tool Access
 * section reflects the first-launch snapshot. The runtime section here in
 * Layer 0 is always accurate and takes precedence, so the LLM never
 * self-restricts based on a stale SOUL.md when skills have been added.
 */
export function buildPersonaContent(cfg: AgentConfig): string {
  const lang = cfg.persona.language;
  const langLine = lang.startsWith('zh')
    ? '默认使用中文（简体）回复。除非用户使用其他语言提问，否则不要切换语言。'
    : `Default response language: ${lang}. Mirror the user's language when they write in a different one.`;

  const hasSkills = Array.isArray(cfg.skills) && cfg.skills.length > 0;
  const userAllow = cfg.tools.allow && cfg.tools.allow.length > 0 ? cfg.tools.allow : null;

  // Build the effective allowlist: user-configured tools + skill system tools (when skills are assigned)
  let toolAccessLine: string;
  if (userAllow) {
    const effective = hasSkills
      ? [...new Set([...userAllow, 'skill_list', 'skill_read'])]
      : userAllow;
    toolAccessLine = `允许工具: ${effective.join(', ')}`;
  } else {
    toolAccessLine = '(全部工具可用，受 deny 列表约束)';
  }

  const skillNote = hasSkills
    ? '\n> `skill_list` 和 `skill_read` 已作为系统工具自动授权，不受 allow 列表约束。'
    : '';

  const denyLine = cfg.tools.deny.length > 0 ? `\nDeny list: ${cfg.tools.deny.join(', ')}` : '';

  // RATIONALE: Inject the config-assigned skills list so the LLM always knows
  // which skills are available, even before reading Layer 2 (skill directory).
  // This is authoritative — independent of what the possibly-stale SOUL.md says.
  const assignedSkillsSection = hasSkills
    ? [
        '',
        '## Assigned Skills (runtime — authoritative)',
        cfg.skills.map((s) => `- ${s}`).join('\n'),
        '> 调用 `skill_read` 传入上方 skill id 可获取完整操作说明。',
      ].join('\n')
    : '';

  return [
    '## Language',
    langLine,
    '',
    '## Tool Access (runtime — authoritative, overrides SOUL.md)',
    toolAccessLine + skillNote + denyLine,
    assignedSkillsSection,
  ].join('\n');
}

// ── SOUL.md template generator ────────────────────────────────────────────────

/** User-editable SOUL.md sections to carry over when re-syncing the file. */
interface SoulMdPreserved {
  description?: string | null;
  personality?: string | null;
  triggers?: string | null;
}

/**
 * Generate a SOUL.md string from an agent's config.
 * Written to {workspace}/SOUL.md on startup; re-synced on every restart so
 * machine-managed sections (Capabilities, Mesh, Tool Access, footer) always
 * reflect the current config.
 *
 * Pass `preserved` to carry over the user-edited sections (Description,
 * Personality & Style, Heartbeat Triggers) from an existing file.
 */
export function generateSoulMd(cfg: AgentConfig, preserved: SoulMdPreserved = {}): string {
  const name = cfg.name ?? cfg.id;

  const triggersSection =
    cfg.mesh.triggers.length > 0
      ? cfg.mesh.triggers.map((t) => `- ${t}`).join('\n')
      : '<!-- 在此添加触发词让路由更精准，例如: - 搜索\n- 查资料 -->';

  const capabilitiesSection =
    cfg.mesh.capabilities.length > 0
      ? cfg.mesh.capabilities.map((c) => `- ${c}`).join('\n')
      : '<!-- 填写此 agent 擅长的能力标签，例如: - web_search\n- code -->';

  const hasSkillsInCfg = Array.isArray(cfg.skills) && cfg.skills.length > 0;
  const userAllow = cfg.tools.allow && cfg.tools.allow.length > 0 ? cfg.tools.allow : null;
  const toolsAllowNote = userAllow
    ? `允许工具: ${(hasSkillsInCfg ? [...new Set([...userAllow, 'skill_list', 'skill_read'])] : userAllow).join(', ')}`
    : '(全部工具可用，受 deny 列表约束)';

  // Skills section: list configured skills so the agent knows what's available
  const assignedSkillsSection = hasSkillsInCfg
    ? `\n## Assigned Skills\n\n${cfg.skills.map((s) => `- ${s}`).join('\n')}\n`
    : '';

  const description =
    preserved.description ?? `${name} 负责处理用户或协调者智能体委派的任务，准确、高效地完成目标。`;

  const personality = preserved.personality ?? '- helpful\n- accurate\n- concise';

  return `# ${name} — Soul File

<!-- 此文件由 AgentFlyer 在首次启动时自动生成。可以自由编辑，修改后 30 秒内生效。 -->
<!-- Auto-generated by AgentFlyer on first launch. Edit freely — changes apply within 30 s. -->
<!-- 机器管理段落（Capabilities / Mesh / Tool Access / 页脚）每次 gateway 启动自动同步。 -->

## Identity

你是 ${name}，一个由 AgentFlyer 驱动的专业 AI 智能体。

## Description

${description}

## Personality & Style

${personality}

## Language

首选语言: ${cfg.persona.language}
规则: 默认使用上述语言回复；若用户以其他语言提问，跟随用户语言。

## Capabilities

${capabilitiesSection}
${assignedSkillsSection}
## Mesh Configuration

- Role: ${cfg.mesh.role}
- Visibility: ${cfg.mesh.visibility}
- Accepts: ${cfg.mesh.accepts.join(', ')}

## Heartbeat Triggers

${preserved.triggers ?? triggersSection}

## Tool Access

${toolsAllowNote}
Deny list: ${cfg.tools.deny.length > 0 ? cfg.tools.deny.join(', ') : '(none)'}
Requires approval: ${cfg.tools.approval.length > 0 ? cfg.tools.approval.join(', ') : '(none)'}

## Output Directory

${cfg.persona.outputDir} (relative to workspace, or absolute path)

---
*Agent ID: ${cfg.id} | Model: ${cfg.model ?? '(default)'}*
`;
}

// ── SOUL.md sync (preserves user edits, refreshes machine-managed sections) ──

/**
 * Re-sync a SOUL.md on gateway startup.
 *
 * Machine-managed sections (Capabilities, Assigned Skills, Mesh Configuration,
 * Tool Access, Output Directory, footer) are always regenerated from the current
 * config. The three user-editable sections (Description, Personality & Style,
 * Heartbeat Triggers) are preserved from `existingContent` when present.
 */
export function syncSoulMd(cfg: AgentConfig, existingContent: string | null): string {
  if (!existingContent) return generateSoulMd(cfg);
  return generateSoulMd(cfg, {
    description: extractSection(existingContent, 'Description'),
    personality: extractSection(existingContent, 'Personality & Style'),
    triggers: extractSection(existingContent, 'Heartbeat Triggers'),
  });
}
