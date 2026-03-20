/**
 * System prompt layer definitions.
 *
 * Layers are stacked in order (0 = bottom / always present):
 *   Layer 0 — Identity & Constraints  (static, never trimmed)
 *   Layer 1 — Workspace context       (AGENTS.md / SOUL.md — semi-static)
 *   Layer 2 — Skills directory        (dynamic, condensed on overflow)
 *   Layer 3 — Memory context          (retrieved, trimmed on overflow)
 *   Layer 4 — Task / session context  (per-turn, injected by caller)
 */

export type PromptLayerId = 0 | 1 | 2 | 3 | 4;

export interface PromptLayer {
  id: PromptLayerId;
  name: string;
  /** Content; may be empty string if layer is inactive. */
  content: string;
  /** Estimated tokens (set after building). */
  estimatedTokens: number;
  /** Can we trim this layer if context is too full? */
  trimable: boolean;
}

/** Layer 0: Core identity — injected first, never removed. */
export function layer0Identity(
  agentName: string,
  agentId: string,
  meshRole?: string,
  /** Inline persona content from config (`buildPersonaContent`). */
  personaContent?: string,
): PromptLayer {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const shell = platform === 'win32' ? 'cmd.exe / PowerShell' : 'bash';
  const openBrowserCmd =
    platform === 'win32'
      ? 'start "" "<url>"'
      : platform === 'darwin'
        ? 'open "<url>"'
        : 'xdg-open "<url>"';

  const meshLines: string[] =
    meshRole === 'coordinator'
      ? [
          '',
          '## Multi-agent mesh (you are the coordinator)',
          '- You can delegate tasks to other agents on the local mesh.',
          '- Use `mesh_list` to discover available agents (returns their id, display name, and role).',
          '- Use `mesh_send` to delegate a task: provide `agent_id` (exact id from mesh_list) and `message`.',
          '- Use `mesh_spawn` + `mesh_status` for fire-and-forget async delegation.',
          '- IMPORTANT: When the user explicitly asks another agent (by name or id) to do something,',
          '  you MUST delegate via mesh_send — do NOT do the work yourself.',
          '- Map natural-language names to agent ids via mesh_list before calling mesh_send.',
          '',
          '## Scheduler (recurring tasks)',
          '- Use `task_schedule` to assign a recurring task to any agent.',
          '  Required: agent_id, message (task prompt), name; plus either `cron` or `interval_minutes`.',
          '  Optional: `report_to` — agent id to receive results after each run.',
          '- Use `task_list` to see all scheduled tasks and when they last/next ran.',
          '- Use `task_cancel` to stop a recurring task by its task ID.',
          '- For "every hour" use interval_minutes=60 or cron="0 * * * *".',
        ]
      : meshRole
        ? [
            '',
            `## Multi-agent mesh (your role: ${meshRole})`,
            '- You receive delegated tasks from coordinator agents. Execute them faithfully and concisely.',
            '- Return only the requested output — no meta-commentary about the delegation.',
            '- Use `mesh_list` to discover other available agents (returns id, name, and role).',
            '- Use `mesh_send` to escalate a task you cannot complete, report results proactively,',
            '  or hand off a subtask to another specialist agent. Provide `agent_id` and `message`.',
          ]
        : [];

  return {
    id: 0,
    name: 'identity',
    content: [
      `You are ${agentName} (id: ${agentId}), a capable AI agent powered by AgentFlyer.`,
      ...(personaContent ? ['', personaContent] : []),
      '',
      '## Runtime environment',
      `- Running LOCALLY on the user\'s desktop machine (OS: ${platform}, shell: ${shell}).`,
      '- You have direct access to the local file system and can run GUI applications.',
      `- To open a URL in the default browser use the bash tool with: ${openBrowserCmd}`,
      `- To open Chrome specifically on Windows: start chrome "<url>"`,
      '- Internet-connected; you can open web pages, but cannot fetch their content directly.',
      '',
      '## Core principles',
      '- Be concise, accurate and helpful.',
      '- Use tools when they serve the task; explain what you are doing.',
      '- Never fabricate file contents or command outputs.',
      '- Never perform destructive operations without user confirmation.',
      '- If uncertain, ask; do not guess on behalf of the user.',
      ...meshLines,
    ].join('\n'),
    estimatedTokens: 0,
    trimable: false,
  };
}

/** Layer 1: Workspace doc (AGENTS.md / SOUL.md). */
export function layer1Workspace(content: string): PromptLayer {
  return {
    id: 1,
    name: 'workspace',
    content,
    estimatedTokens: 0,
    // RATIONALE: trimable=true so the builder can drop the workspace doc
    // AFTER skills (Layer 2) when the context window is tight.
    // Layer 0 (identity) always stays; trimming order is highest id first:
    // Layer 4 -> 3 -> 2 -> 1. Skills survive as long as workspace survives.
    trimable: true,
  };
}

/** Layer 2: Skills directory snippet. */
export function layer2Skills(skillsText: string): PromptLayer {
  const content = skillsText
    ? [
        '## Available Skills',
        '',
        skillsText,
        '',
        '> **How to use a skill:**',
        '> 1. Call `skill_list` to confirm the skill ID.',
        '> 2. Call `skill_read` with the skill ID to get the full step-by-step instructions.',
        '> 3. Follow the instructions in the SKILL.md — they tell you exactly what commands/scripts to run.',
        '> Do NOT search the file system for skills; use `skill_list` and `skill_read` instead.',
      ].join('\n')
    : '';
  return {
    id: 2,
    name: 'skills',
    content,
    estimatedTokens: 0,
    trimable: true,
  };
}

/** Layer 3: Retrieved memory context. */
export function layer3Memory(memoryText: string): PromptLayer {
  return {
    id: 3,
    name: 'memory',
    content: memoryText ? `## Relevant Memory\n\n${memoryText}` : '',
    estimatedTokens: 0,
    trimable: true,
  };
}

/** Layer 4: Per-session task context injected by the caller. */
export function layer4Task(taskContext: string): PromptLayer {
  return {
    id: 4,
    name: 'task',
    content: taskContext,
    estimatedTokens: 0,
    trimable: true,
  };
}
