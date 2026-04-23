import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';
import { createSkillTools } from '../../../src/skills/skill-tools.js';
import { asSkillId } from '../../../src/core/types.js';
import type { SkillMeta } from '../../../src/skills/registry.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-skilltools-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SKILL_MD = `---
id: demo-skill
name: Demo Skill
description: A demonstration skill for unit testing
tags: [demo, test]
---

## Instructions

Call this skill to run the demo.
`;

async function makeSkillFile(baseDir: string, skillId: string): Promise<string> {
  const skillDir = join(baseDir, skillId);
  await mkdir(skillDir, { recursive: true });
  const filePath = join(skillDir, 'SKILL.md');
  await writeFile(filePath, SKILL_MD, 'utf-8');
  return filePath;
}

function makeRegistry(metas: SkillMeta[] = []): SkillRegistry {
  const reg = new SkillRegistry();
  for (const m of metas) reg.register(m);
  return reg;
}

function makeSkillMeta(id: string, filePath: string): SkillMeta {
  return {
    id: asSkillId(id),
    name: `${id} Name`,
    description: `Description of ${id}`,
    shortDesc: `Short desc of ${id}`,
    tags: ['test'],
    apiKeyRequired: false,
    filePath,
    cachedAt: Date.now(),
    contentHash: 'abc',
  };
}

async function callHandler(tool: ReturnType<typeof createSkillTools>[number], input: unknown) {
  return tool.handler(input);
}

describe('createSkillTools', () => {
  it('returns two tools: skill_list and skill_read', () => {
    const tools = createSkillTools(makeRegistry());
    const names = tools.map((t) => t.definition.name);
    expect(names).toContain('skill_list');
    expect(names).toContain('skill_read');
  });

  describe('skill_list tool', () => {
    it('returns "No skills available." when registry is empty', async () => {
      const tools = createSkillTools(makeRegistry());
      const listTool = tools.find((t) => t.definition.name === 'skill_list')!;
      const result = await callHandler(listTool, {});
      expect(result.isError).toBe(false);
      expect(result.content).toContain('No skills available');
    });

    it('lists all registered skills with id and description', async () => {
      const baseDir = await createTempDir();
      const filePath = await makeSkillFile(baseDir, 'demo-skill');
      const reg = makeRegistry([makeSkillMeta('demo-skill', filePath)]);
      const tools = createSkillTools(reg);
      const listTool = tools.find((t) => t.definition.name === 'skill_list')!;
      const result = await callHandler(listTool, {});
      expect(result.isError).toBe(false);
      expect(result.content).toContain('demo-skill');
      expect(result.content).toContain('Available skills (1)');
    });

    it('shows count for multiple skills', async () => {
      const baseDir = await createTempDir();
      const f1 = await makeSkillFile(baseDir, 'skill-a');
      const f2 = await makeSkillFile(baseDir, 'skill-b');
      const reg = makeRegistry([makeSkillMeta('skill-a', f1), makeSkillMeta('skill-b', f2)]);
      const tools = createSkillTools(reg);
      const listTool = tools.find((t) => t.definition.name === 'skill_list')!;
      const result = await callHandler(listTool, {});
      expect(result.content).toContain('Available skills (2)');
    });
  });

  describe('skill_read tool', () => {
    it('returns error when skill id is not found', async () => {
      const tools = createSkillTools(makeRegistry());
      const readTool = tools.find((t) => t.definition.name === 'skill_read')!;
      const result = await callHandler(readTool, { skill_id: 'unknown-skill' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('returns skill content with directory prepended', async () => {
      const baseDir = await createTempDir();
      const filePath = await makeSkillFile(baseDir, 'demo-skill');
      const reg = makeRegistry([makeSkillMeta('demo-skill', filePath)]);
      const tools = createSkillTools(reg);
      const readTool = tools.find((t) => t.definition.name === 'skill_read')!;
      const result = await callHandler(readTool, { skill_id: 'demo-skill' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('IMPORTANT — Skill directory');
      expect(result.content).toContain('Demo Skill');
    });

    it('includes the raw SKILL.md content in the output', async () => {
      const baseDir = await createTempDir();
      const filePath = await makeSkillFile(baseDir, 'demo-skill');
      const reg = makeRegistry([makeSkillMeta('demo-skill', filePath)]);
      const tools = createSkillTools(reg);
      const readTool = tools.find((t) => t.definition.name === 'skill_read')!;
      const result = await callHandler(readTool, { skill_id: 'demo-skill' });
      expect(result.content).toContain('## Instructions');
    });

    it('returns error when the skill file cannot be read', async () => {
      // Register a skill with a non-existent file path
      const reg = makeRegistry([makeSkillMeta('broken-skill', '/nonexistent/path/SKILL.md')]);
      const tools = createSkillTools(reg);
      const readTool = tools.find((t) => t.definition.name === 'skill_read')!;
      const result = await callHandler(readTool, { skill_id: 'broken-skill' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Failed to read skill file');
    });

    it('lists available skills when requested skill is not found', async () => {
      const baseDir = await createTempDir();
      const filePath = await makeSkillFile(baseDir, 'known-skill');
      const reg = makeRegistry([makeSkillMeta('known-skill', filePath)]);
      const tools = createSkillTools(reg);
      const readTool = tools.find((t) => t.definition.name === 'skill_read')!;
      const result = await callHandler(readTool, { skill_id: 'ghost-skill' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('known-skill');
    });
  });
});
