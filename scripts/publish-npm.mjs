#!/usr/bin/env node
/**
 * publish-npm.mjs
 * Usage: pnpm publish:npm <version>
 *   version: e.g. 1.0.1 | 1.1.0-beta.1
 *
 * Steps:
 *   1. Validate semver version
 *   2. Bump version in package.json
 *   3. pnpm build + pnpm check + pnpm test
 *   4. npm publish to https://registry.npmjs.org --access public
 *   5. Git tag + push
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PKG_PATH = resolve(ROOT, 'package.json');

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const NPM_REGISTRY = 'https://registry.npmjs.org';

function run(cmd, opts = {}) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// ── 1. Parse & validate version ──────────────────────────────────────────────
const version = process.argv[2];
if (!version) {
  fail('Usage: pnpm publish:npm <version>\n  Example: pnpm publish:npm 1.0.1');
}
if (!SEMVER_RE.test(version)) {
  fail(`Invalid version: "${version}". Expected semver like 1.0.1 or 1.0.1-beta.1`);
}

// ── 2. Bump version in package.json ──────────────────────────────────────────
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const prevVersion = pkg.version;
if (prevVersion === version) {
  fail(`package.json already at version ${version}. Nothing to publish.`);
}
pkg.version = version;
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n✔ Version bumped: ${prevVersion} → ${version}`);

// ── 3. Build + Lint + Test ────────────────────────────────────────────────────
try {
  run('pnpm build');
  run('pnpm check');
  run('pnpm test');
} catch {
  // Restore version on pre-publish failure
  pkg.version = prevVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  fail('Pre-publish checks failed. package.json version restored.');
}

// ── 4. Publish to npmjs.org ───────────────────────────────────────────────────
const isPrerelease = version.includes('-');
const tag = isPrerelease ? 'beta' : 'latest';

// Allow passing token via NPM_TOKEN env var; fall back to ~/.npmrc authToken
const tokenEnv = process.env.NPM_TOKEN
  ? `npm config set //registry.npmjs.org/:_authToken ${process.env.NPM_TOKEN} &&`
  : '';

try {
  run(
    `${tokenEnv} npm publish --registry ${NPM_REGISTRY} --access public --tag ${tag} --ignore-scripts`,
    { shell: true }
  );
} catch {
  // Restore version on publish failure
  pkg.version = prevVersion;
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  fail('npm publish failed. package.json version restored.');
}

// ── 5. Git commit + tag + push ───────────────────────────────────────────────
const tag_name = `v${version}`;
try {
  run(`git add package.json`);
  run(`git commit -m "chore: release ${tag_name}"`);
  run(`git tag ${tag_name}`);
  run(`git push && git push origin ${tag_name}`);
} catch {
  console.warn('\n⚠ Publish succeeded but git tag/push failed. Please run manually:');
  console.warn(`  git add package.json && git commit -m "chore: release ${tag_name}"`);
  console.warn(`  git tag ${tag_name} && git push && git push origin ${tag_name}`);
}

console.log(`\n✅ agentflyer@${version} published to npm (tag: ${tag})`);
console.log(`   https://www.npmjs.com/package/agentflyer`);
