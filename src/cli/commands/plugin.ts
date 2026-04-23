/**
 * Plugin marketplace commands
 *
 *   agentflyer plugin search <keyword>
 *   agentflyer plugin install <name>[@version]
 *   agentflyer plugin list
 *   agentflyer plugin remove <name>
 *
 * Plugins are npm packages that expose an `agentflyer.plugin` field in their
 * package.json pointing to the plugin entry point.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';

const DEFAULT_DATA_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.agentflyer');

interface PluginRecord {
  name: string;
  version: string;
  entryPoint: string;
  installedAt: number;
}

interface PluginsManifest {
  plugins: PluginRecord[];
}

async function readManifest(dataDir: string): Promise<PluginsManifest> {
  const p = join(dataDir, 'plugins.json');
  if (!existsSync(p)) return { plugins: [] };
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as PluginsManifest;
  } catch {
    return { plugins: [] };
  }
}

async function writeManifest(dataDir: string, manifest: PluginsManifest): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'plugins.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

export const pluginCommand = defineCommand({
  meta: {
    name: 'plugin',
    description: 'Manage AgentFlyer plugins from the marketplace',
  },
  subCommands: {
    search: defineCommand({
      meta: { name: 'search', description: 'Search the plugin registry' },
      args: {
        keyword: { type: 'positional', description: 'Search keyword', required: true },
      },
      async run({ args }) {
        const keyword = String(args.keyword ?? '');
        process.stdout.write(chalk.bold(`\nSearching npm for agentflyer plugins matching "${keyword}"…\n\n`));

        // Query npm registry — filter by `agentflyer` keyword
        const registryUrl = `https://registry.npmjs.org/-/v1/search?text=agentflyer-plugin+${encodeURIComponent(keyword)}&size=10`;
        try {
          const res = await fetch(registryUrl);
          if (!res.ok) throw new Error(`Registry returned ${res.status}`);
          const body = (await res.json()) as {
            objects: Array<{ package: { name: string; version: string; description: string } }>;
          };
          if (body.objects.length === 0) {
            note('No plugins found. Try a different keyword.', 'Search');
          } else {
            for (const { package: pkg } of body.objects) {
              process.stdout.write(
                `  ${chalk.cyan(pkg.name)}@${chalk.gray(pkg.version)}  ${pkg.description ?? ''}\n`,
              );
            }
            process.stdout.write(
              `\nInstall with: ${chalk.cyan('agentflyer plugin install <name>')}\n\n`,
            );
          }
        } catch (err) {
          process.stderr.write(chalk.red(`Error: ${String(err)}\n`));
          process.exit(1);
        }
      },
    }),

    install: defineCommand({
      meta: { name: 'install', description: 'Install a plugin from npm' },
      args: {
        name: { type: 'positional', description: 'Package name (optionally @version)', required: true },
        dataDir: { type: 'string', alias: 'd', description: 'AgentFlyer data directory' },
      },
      async run({ args }) {
        const nameArg = String(args.name ?? '');
        const dataDir = String(args.dataDir ?? DEFAULT_DATA_DIR);
        const pkgDir = join(dataDir, 'plugins', nameArg.replace(/[@/]/g, '_'));

        process.stdout.write(chalk.bold(`\nInstalling ${chalk.cyan(nameArg)}…\n`));

        // Use npm/pnpm to install into a dedicated dir
        const { spawnSync } = await import('node:child_process');
        await mkdir(pkgDir, { recursive: true });

        const result = spawnSync('npm', ['install', '--prefix', pkgDir, nameArg], {
          stdio: 'inherit',
          shell: true,
        });
        if (result.status !== 0) {
          process.stderr.write(chalk.red('\nInstall failed.\n'));
          process.exit(1);
        }

        // Read installed package.json to find the plugin entry point
        const [pkgName] = nameArg.split('@');
        const installedPkgJson = join(pkgDir, 'node_modules', pkgName ?? nameArg, 'package.json');
        let entryPoint = '';
        let installedVersion = 'unknown';
        try {
          const pkgMeta = JSON.parse(await readFile(installedPkgJson, 'utf-8')) as {
            version?: string;
            agentflyer?: { plugin?: string };
            main?: string;
          };
          installedVersion = pkgMeta.version ?? 'unknown';
          entryPoint = pkgMeta.agentflyer?.plugin
            ? join(pkgDir, 'node_modules', pkgName ?? nameArg, pkgMeta.agentflyer.plugin)
            : join(pkgDir, 'node_modules', pkgName ?? nameArg, pkgMeta.main ?? 'index.js');
        } catch {
          process.stderr.write(chalk.yellow('Warning: could not read plugin package.json.\n'));
        }

        const manifest = await readManifest(dataDir);
        const existing = manifest.plugins.findIndex((p) => p.name === (pkgName ?? nameArg));
        const record: PluginRecord = {
          name: pkgName ?? nameArg,
          version: installedVersion,
          entryPoint,
          installedAt: Date.now(),
        };
        if (existing >= 0) {
          manifest.plugins[existing] = record;
        } else {
          manifest.plugins.push(record);
        }
        await writeManifest(dataDir, manifest);

        outro(chalk.green(`✓ Plugin "${pkgName ?? nameArg}" v${installedVersion} installed.`));
        process.stdout.write(
          `\nAdd ${chalk.cyan(`"${entryPoint}"`)} to ${chalk.cyan('plugins')} array in agentflyer.json to enable it.\n\n`,
        );
      },
    }),

    list: defineCommand({
      meta: { name: 'list', description: 'List installed plugins' },
      args: {
        dataDir: { type: 'string', alias: 'd', description: 'AgentFlyer data directory' },
      },
      async run({ args }) {
        const dataDir = String(args.dataDir ?? DEFAULT_DATA_DIR);
        const manifest = await readManifest(dataDir);
        if (manifest.plugins.length === 0) {
          note('No plugins installed.', 'Plugins');
          process.exit(0);
        }
        process.stdout.write(chalk.bold(`\n${manifest.plugins.length} plugin(s) installed:\n\n`));
        for (const p of manifest.plugins) {
          process.stdout.write(
            `  ${chalk.cyan(p.name)}@${chalk.gray(p.version)}  ${chalk.dim(p.entryPoint)}\n`,
          );
        }
        process.stdout.write('\n');
      },
    }),

    remove: defineCommand({
      meta: { name: 'remove', description: 'Uninstall a plugin' },
      args: {
        name: { type: 'positional', description: 'Plugin name to remove', required: true },
        dataDir: { type: 'string', alias: 'd', description: 'AgentFlyer data directory' },
      },
      async run({ args }) {
        const name = String(args.name ?? '');
        const dataDir = String(args.dataDir ?? DEFAULT_DATA_DIR);
        const manifest = await readManifest(dataDir);
        const before = manifest.plugins.length;
        manifest.plugins = manifest.plugins.filter((p) => p.name !== name);
        if (manifest.plugins.length === before) {
          note(`Plugin "${name}" is not installed.`, 'Remove');
          process.exit(1);
        }
        await writeManifest(dataDir, manifest);

        // Remove plugin directory
        const pkgDir = join(dataDir, 'plugins', name.replace(/[@/]/g, '_'));
        const { rm } = await import('node:fs/promises');
        await rm(pkgDir, { recursive: true, force: true });

        outro(chalk.green(`✓ Plugin "${name}" removed.`));
      },
    }),
  },
});
