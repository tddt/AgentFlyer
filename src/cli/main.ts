#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { startCommand } from './commands/start.js';
import { chatCommand } from './commands/chat.js';
import { configCommand } from './commands/config.js';
import { reloadCommand } from './commands/reload.js';
import { skillsCommand } from './commands/skills.js';
import { memoryCommand } from './commands/memory.js';
import { federationCommand } from './commands/federation.js';
import { webCommand } from './commands/web.js';
import { gatewayCommand, gatewayStop, gatewayStatus } from './commands/gateway.js';
import { agentCommand } from './commands/agent.js';
import { messageCommand } from './commands/message.js';
import { sessionsCommand } from './commands/sessions.js';

const main = defineCommand({
  meta: {
    name: 'agentflyer',
    version: '1.0.0',
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
