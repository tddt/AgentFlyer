import { defineCommand } from 'citty';
import { note, outro } from '@clack/prompts';
import chalk from 'chalk';
import JSON5 from 'json5';
import { readFileSync, accessSync, constants } from 'node:fs';
import { createConnection } from 'node:net';
import { loadConfig, saveConfig, getDefaultConfigPath } from '../../core/config/loader.js';
import { ConfigSchema } from '../../core/config/schema.js';

export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description: 'View or edit AgentFlyer configuration',
  },
  subCommands: {
    show: defineCommand({
      meta: { name: 'show', description: 'Print current config' },
      args: {
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      run({ args }) {
        const cfg = loadConfig(args.config as string | undefined);
        process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
      },
    }),

    path: defineCommand({
      meta: { name: 'path', description: 'Print path to the config file' },
      run() {
        process.stdout.write(getDefaultConfigPath() + '\n');
      },
    }),

    set: defineCommand({
      meta: { name: 'set', description: 'Set a top-level config key (JSON value)' },
      args: {
        key: { type: 'positional', description: 'Dot-separated config key' },
        value: { type: 'positional', description: 'JSON value' },
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      async run({ args }) {
        const configPath = args.config as string | undefined;
        const cfg = loadConfig(configPath) as Record<string, unknown>;
        const keys = (args.key as string).split('.');
        let obj = cfg;
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i]!;
          if (obj[k] === undefined || typeof obj[k] !== 'object') obj[k] = {};
          obj = obj[k] as Record<string, unknown>;
        }
        const lastKey = keys[keys.length - 1]!;
        try {
          obj[lastKey] = JSON5.parse(args.value as string);
        } catch {
          obj[lastKey] = args.value;
        }

        const parsed = ConfigSchema.safeParse(cfg);
        if (!parsed.success) {
          note(parsed.error.message, 'Validation error');
          process.exit(1);
        }
        await saveConfig(parsed.data, configPath);
        note(`Set ${args.key} = ${args.value}`, 'Config updated');
      },
    }),

    validate: defineCommand({
      meta: { name: 'validate', description: 'Validate the config file' },
      args: {
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      run({ args }) {
        try {
          loadConfig(args.config as string | undefined);
          outro(chalk.green('Config is valid'));
        } catch (err) {
          note(String(err), 'Validation failed');
          process.exit(1);
        }
      },
    }),

    doctor: defineCommand({
      meta: { name: 'doctor', description: 'Diagnose configuration and environment issues' },
      args: {
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      async run({ args }) {
        const configPath = (args.config as string | undefined) ?? getDefaultConfigPath();
        const lines: string[] = [];
        let errors = 0;
        let warnings = 0;

        const ok = (msg: string): void => { lines.push(chalk.green('  ✔  ') + msg); };
        const fail = (msg: string): void => { errors++; lines.push(chalk.red('  ✘  ') + msg); };
        const warn = (msg: string): void => { warnings++; lines.push(chalk.yellow('  ⚠  ') + msg); };

        // ── 1. File exists and is readable ────────────────────────────────
        let rawText = '';
        try {
          rawText = readFileSync(configPath, 'utf8');
          ok(`Config file found: ${configPath}`);
        } catch {
          fail(`Config file not found or unreadable: ${configPath}`);
          printSummary(lines, errors, warnings);
          process.exit(1);
        }

        // ── 2. Parses as valid JSON5 ───────────────────────────────────────
        let rawObj: unknown;
        try {
          rawObj = JSON5.parse(rawText);
          ok('Config file is valid JSON5');
        } catch (e) {
          fail(`JSON5 parse error: ${String(e)}`);
          printSummary(lines, errors, warnings);
          process.exit(1);
        }

        // ── 3. Schema validation ──────────────────────────────────────────
        const parsed = ConfigSchema.safeParse(rawObj);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            fail(`Schema: ${issue.path.join('.')} — ${issue.message}`);
          }
        } else {
          ok('Config passes schema validation');
          const cfg = parsed.data;

          // ── 4. Models: API keys ─────────────────────────────────────────
          for (const [key, model] of Object.entries(cfg.models)) {
            const apiKey =
              (model as { apiKey?: string }).apiKey ??
              process.env[`AGENTFLYER_${key.toUpperCase()}_API_KEY`] ??
              process.env['AGENTFLYER_API_KEY'];
            if (apiKey) {
              ok(`Model "${key}": API key present`);
            } else {
              warn(`Model "${key}": no API key (set models.${key}.apiKey or AGENTFLYER_${key.toUpperCase()}_API_KEY)`);
            }
          }

          // ── 5. Agents: model reference and workspace ─────────────────────
          for (const agent of cfg.agents) {
            const modelRef = agent.model ?? cfg.defaults.model;
            if (!(modelRef in cfg.models)) {
              fail(`Agent "${agent.id}": model "${modelRef}" not found in models`);
            } else {
              ok(`Agent "${agent.id}": model reference "${modelRef}" valid`);
            }

            const wsDir = agent.workspace;
            if (wsDir) {
              try {
                accessSync(wsDir, constants.W_OK);
                ok(`Agent "${agent.id}": workspace writable (${wsDir})`);
              } catch {
                warn(`Agent "${agent.id}": workspace not writable (${wsDir}) — will be created on start`);
              }
            }
          }

          // ── 6. Gateway port available ─────────────────────────────────
          const port = cfg.gateway.port;
          const portFree = await new Promise<boolean>((resolve) => {
            const socket = createConnection(port, '127.0.0.1');
            socket.on('connect', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => { resolve(true); });
          });
          if (portFree) {
            ok(`Gateway port ${port} is available`);
          } else {
            warn(`Gateway port ${port} is already in use (gateway may already be running)`);
          }
        }

        printSummary(lines, errors, warnings);
        if (errors > 0) process.exit(1);

        function printSummary(msgs: string[], errs: number, warns: number): void {
          process.stdout.write('\n' + chalk.bold('AgentFlyer Config Doctor\n') + '\n');
          for (const l of msgs) process.stdout.write(l + '\n');
          process.stdout.write('\n');
          if (errs === 0 && warns === 0) {
            process.stdout.write(chalk.green.bold('Everything looks good!\n'));
          } else {
            if (errs > 0) process.stdout.write(chalk.red.bold(`${errs} error(s)  `) );
            if (warns > 0) process.stdout.write(chalk.yellow.bold(`${warns} warning(s)`));
            process.stdout.write('\n');
          }
        }
      },
    }),

    migrate: defineCommand({
      meta: { name: 'migrate', description: 'Migrate config from OpenClaw or legacy AgentFlyer v1 format' },
      args: {
        from: {
          type: 'string',
          description: 'Source config file path (default: ~/.openclaw/openclaw.json)',
        },
        output: {
          type: 'string',
          alias: 'o',
          description: 'Destination config file path (default: system default)',
        },
        dry: {
          type: 'boolean',
          description: 'Print migrated config but do not save',
          default: false,
        },
      },
      async run({ args }) {
        const { homedir } = await import('node:os');
        const { existsSync } = await import('node:fs');
        const { readFile, writeFile } = await import('node:fs/promises');

        const srcPath = (args.from as string | undefined) ??
          [homedir(), '.openclaw', 'openclaw.json'].join('/');

        if (!existsSync(srcPath)) {
          note(`Source config not found: ${srcPath}`, 'Error');
          process.exit(1);
        }

        let raw: unknown;
        try {
          raw = JSON5.parse(await readFile(srcPath, 'utf-8'));
        } catch (e) {
          note(`Cannot parse source config: ${String(e)}`, 'Error');
          process.exit(1);
        }

        // Basic migration mapping — copies top-level known fields
        const src = raw as Record<string, unknown>;
        const migrated: Record<string, unknown> = {
          agents: (src['agents'] as unknown[]) ?? [],
          models: (src['models'] as Record<string, unknown>) ?? {},
          gateway: (src['gateway'] as Record<string, unknown>) ?? {},
          defaults: (src['defaults'] as Record<string, unknown>) ?? {},
          federation: (src['federation'] as Record<string, unknown>) ?? { enabled: false, peers: [] },
          log: (src['log'] as Record<string, unknown>) ?? {},
          scheduler: (src['scheduler'] as Record<string, unknown>) ?? {},
        };

        const parsed = ConfigSchema.safeParse(migrated);
        if (parsed.success) {
          if (args.dry) {
            process.stdout.write(JSON.stringify(parsed.data, null, 2) + '\n');
            note('Dry run complete — no file written.', 'Migrate');
            return;
          }
          const dest = (args.output as string | undefined) ?? getDefaultConfigPath();
          if (typeof writeFile === 'function') {
            await saveConfig(parsed.data, dest);
          }
          note(`Migrated config written to ${dest}`, 'Migrate complete');
        } else {
          note(
            'Migration produced an invalid config:\n' + parsed.error.message,
            'Validation error',
          );
          process.stdout.write(JSON.stringify(migrated, null, 2) + '\n');
          process.exit(1);
        }
      },
    }),
  },
});
