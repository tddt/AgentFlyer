#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand, runMain } from 'citty';

const _pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
) as { version: string };
import { agentCommand } from './commands/agent.js';
import { chatCommand } from './commands/chat.js';
import { configCommand } from './commands/config.js';
import { federationCommand } from './commands/federation.js';
import { gatewayCommand, gatewayStatus, gatewayStop } from './commands/gateway.js';
import { memoryCommand } from './commands/memory.js';
import { messageCommand } from './commands/message.js';
import { reloadCommand } from './commands/reload.js';
import { sessionsCommand } from './commands/sessions.js';
import { skillsCommand } from './commands/skills.js';
import { startCommand } from './commands/start.js';
import { statsCommand } from './commands/stats.js';
import { webCommand } from './commands/web.js';

const main = defineCommand({
  meta: {
    name: 'agentflyer',
    version: _pkg.version,
    description: 'Decentralized, cross-platform, multi-host federated AI Agent framework',
  },
  subCommands: {
    // Top-level shortcuts
    start: startCommand,
    stop: gatewayStop,
    status: gatewayStatus,
    chat: chatCommand,
    reload: reloadCommand,
    web: webCommand,
    // Grouped commands
    gateway: gatewayCommand,
    agent: agentCommand,
    message: messageCommand,
    sessions: sessionsCommand,
    config: configCommand,
    skills: skillsCommand,
    memory: memoryCommand,
    federation: federationCommand,
    stats: statsCommand,
  },
  run() {
    process.stdout.write(
      [
        '',
        '  agentflyer start               — Start the gateway',
        '  agentflyer stop                — Stop the gateway',
        '  agentflyer status              — Show gateway & agent status',
        '  agentflyer agent list          — List running agents',
        '  agentflyer agent reload        — Reload agent config',
        '  agentflyer message send        — Send a message to an agent',
        '  agentflyer sessions list       — List sessions',
        '  agentflyer sessions show       — Show session history',
        '  agentflyer sessions clear      — Delete a session',
        '  agentflyer chat                — Interactive chat with an agent',
        '  agentflyer config              — View/edit configuration',
        '  agentflyer skills              — List skills',
        '  agentflyer memory              — Manage agent memory',
        '  agentflyer federation          — Federation status',
        '  agentflyer stats               — Token usage statistics',
        '',
        '  Shortcuts: agentflyer start | stop | status | reload | web | chat',
        '',
        'Run agentflyer <command> --help for details.',
        '',
      ].join('\n'),
    );
  },
});

runMain(main);
