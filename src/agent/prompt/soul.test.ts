import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../core/config/schema.js';
import { buildPersonaContent, generateSoulMd, syncSoulMd } from './soul.js';

function baseCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'test-agent',
    name: 'TestAgent',
    skills: [],
    mesh: {
      role: 'worker',
      capabilities: [],
      accepts: ['task'],
      visibility: 'public',
      triggers: [],
    },
    owners: [],
    tools: { deny: [], approval: [] },
    persona: { language: 'zh-CN', outputDir: 'output' },
    ...overrides,
  };
}

describe('buildPersonaContent', () => {
  it('includes language instruction for zh-CN', () => {
    const content = buildPersonaContent(baseCfg());
    expect(content).toContain('默认使用中文');
    expect(content).toContain('## Language');
  });

  it('includes English instruction for en locale', () => {
    const content = buildPersonaContent(baseCfg({ persona: { language: 'en', outputDir: 'out' } }));
    expect(content).toContain('Default response language: en');
  });

  it('shows all-tools-allowed when no allow list', () => {
    const content = buildPersonaContent(baseCfg());
    expect(content).toContain('全部工具可用');
  });

  it('lists allowed tools when an allow list is provided', () => {
    const cfg = baseCfg({ tools: { allow: ['bash', 'fs_read'], deny: [], approval: [] } });
    const content = buildPersonaContent(cfg);
    expect(content).toContain('bash');
    expect(content).toContain('fs_read');
  });

  it('appends skill tools to allow list when skills are present', () => {
    const cfg = baseCfg({
      skills: ['summarise'],
      tools: { allow: ['bash'], deny: [], approval: [] },
    });
    const content = buildPersonaContent(cfg);
    expect(content).toContain('skill_list');
    expect(content).toContain('skill_read');
  });

  it('includes assigned skills section when skills configured', () => {
    const cfg = baseCfg({ skills: ['my-skill'] });
    const content = buildPersonaContent(cfg);
    expect(content).toContain('my-skill');
    expect(content).toContain('Assigned Skills');
  });
});

describe('generateSoulMd', () => {
  it('generates a markdown document with agent identity', () => {
    const md = generateSoulMd(baseCfg());
    expect(md).toContain('# TestAgent');
    expect(md).toContain('test-agent');
    expect(md).toContain('## Identity');
    expect(md).toContain('## Language');
  });

  it('includes mesh configuration', () => {
    const cfg = baseCfg({
      mesh: {
        role: 'orchestrator',
        capabilities: ['planning'],
        accepts: ['query'],
        visibility: 'private',
        triggers: ['分析', '规划'],
      },
    });
    const md = generateSoulMd(cfg);
    expect(md).toContain('orchestrator');
    expect(md).toContain('planning');
    expect(md).toContain('分析');
  });

  it('preserves user-provided description in preserved param', () => {
    const md = generateSoulMd(baseCfg(), { description: 'Custom description text' });
    expect(md).toContain('Custom description text');
  });

  it('includes deny list when configured', () => {
    const cfg = baseCfg({ tools: { deny: ['dangerous_tool'], approval: [] } });
    const md = generateSoulMd(cfg);
    expect(md).toContain('dangerous_tool');
  });

  it('includes assigned skills section when skills are set', () => {
    const cfg = baseCfg({ skills: ['summarise', 'translate'] });
    const md = generateSoulMd(cfg);
    expect(md).toContain('summarise');
    expect(md).toContain('translate');
    expect(md).toContain('## Assigned Skills');
  });
});

describe('syncSoulMd', () => {
  it('generates a fresh soul when existingContent is null', () => {
    const md = syncSoulMd(baseCfg(), null);
    expect(md).toContain('# TestAgent');
  });

  it('preserves user-edited Description section from existing content', () => {
    const existing = `# TestAgent — Soul File

## Description

My custom description that should survive sync.

## Personality & Style

- focused

## Heartbeat Triggers

- daily report

## Other Section

ignored
`;
    const md = syncSoulMd(baseCfg(), existing);
    expect(md).toContain('My custom description that should survive sync.');
    expect(md).toContain('- focused');
    expect(md).toContain('- daily report');
  });

  it('regenerates machine-managed sections from new config', () => {
    const existing = `# OldName — Soul File\n## Description\nOld desc\n`;
    const cfg = baseCfg({ name: 'NewName', mesh: { role: 'orchestrator', capabilities: [], accepts: [], visibility: 'public', triggers: [] } });
    const md = syncSoulMd(cfg, existing);
    expect(md).toContain('NewName');
    expect(md).toContain('orchestrator');
  });
});
