#!/usr/bin/env node
/**
 * One-shot setup for claude-sync.
 *
 * Clones a private vault repo (creating it on GitHub first if it does not
 * exist), seeds the initial folder structure and migrates any existing
 * per-project memory content into it, installs claude-sync inside the vault,
 * generates mapping.json, creates symlinks, and registers the MCP server.
 *
 * Usage:
 *   CLAUDE_SYNC_VAULT=git@github.com:you/my-vault.git node scripts/init.js
 *   # or
 *   node scripts/init.js --vault git@github.com:you/my-vault.git [--target <path>]
 *
 * Defaults:
 *   --target: ~/.knowledge-vault
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeProjectPath,
  inferProjectName,
  parseGitUrl,
} from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_SYNC_ROOT = resolve(__dirname, '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf-8');
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding matching quotes, if any
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`command failed: ${cmd} ${cmdArgs.join(' ')} (exit ${r.status})`);
  }
}

function trySpawn(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { stdio: 'ignore', ...opts });
}

function ensureRepoExists(vaultUrl) {
  const parsed = parseGitUrl(vaultUrl);
  if (!parsed) {
    console.log('  [warn] could not parse repo URL; skipping GitHub existence check');
    return;
  }

  // Probe the repo via gh api. If gh isn't installed, we can still try to
  // clone below — a helpful error will surface there.
  const ghAvailable = trySpawn('gh', ['--version']).status === 0;
  if (!ghAvailable) {
    console.log('  [info] gh CLI not found; assuming repo already exists');
    return;
  }

  const probe = trySpawn('gh', ['api', `repos/${parsed.full}`]);
  if (probe.status === 0) {
    console.log(`  [ok] repo ${parsed.full} exists on GitHub`);
    return;
  }

  console.log(`  [info] repo ${parsed.full} not found, creating as private...`);
  run('gh', ['repo', 'create', parsed.full, '--private']);
}

function isVaultEmpty(vaultDir) {
  if (!existsSync(vaultDir)) return true;
  const entries = readdirSync(vaultDir).filter(e => e !== '.git');
  return entries.length === 0;
}

function migrateExistingMemory(vaultDir) {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return 0;

  let migrated = 0;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const decoded = decodeProjectPath(entry.name);
    if (!decoded) continue;

    const memDir = join(projectsDir, entry.name, 'memory');
    if (!existsSync(memDir)) continue;

    // Skip if already a symlink (already pointing into some vault)
    let st;
    try { st = lstatSync(memDir); } catch { continue; }
    if (st.isSymbolicLink()) continue;

    const files = readdirSync(memDir);
    if (files.length === 0) continue;

    const projectName = inferProjectName(decoded);
    const target = join(vaultDir, 'memory', projectName);
    mkdirSync(target, { recursive: true });

    // Recursive copy via cp -R; trailing /. copies contents, not the folder itself
    run('cp', ['-R', `${memDir}/.`, target]);
    console.log(`  [migrate] ${projectName}: ${files.length} entries from ${memDir}`);
    migrated++;
  }
  return migrated;
}

function seedVaultIfEmpty(vaultDir) {
  if (!isVaultEmpty(vaultDir)) {
    console.log('  [skip] vault is not empty; skipping seed');
    return false;
  }

  console.log('  [info] vault is empty, seeding initial structure...');
  mkdirSync(join(vaultDir, 'knowledge'), { recursive: true });
  mkdirSync(join(vaultDir, 'memory'), { recursive: true });
  mkdirSync(join(vaultDir, 'config', 'projects'), { recursive: true });

  // placeholders so empty dirs survive git
  writeFileSync(join(vaultDir, 'knowledge', '.gitkeep'), '');
  writeFileSync(join(vaultDir, 'config', 'projects', '.gitkeep'), '');

  writeFileSync(
    join(vaultDir, '.gitignore'),
    ['node_modules/', '.claude-sync/', 'mapping.json', ''].join('\n'),
  );
  writeFileSync(
    join(vaultDir, 'mapping.example.json'),
    JSON.stringify({ projects: {} }, null, 2) + '\n',
  );

  const migrated = migrateExistingMemory(vaultDir);
  if (migrated === 0) {
    console.log('  [info] no existing memory to migrate');
  }

  // Commit + push the seed. Force branch main in case the empty repo is
  // on a different default.
  run('git', ['add', '-A'], { cwd: vaultDir });
  run('git', ['commit', '-m', 'seed: initial vault structure'], { cwd: vaultDir });
  try {
    run('git', ['branch', '-M', 'main'], { cwd: vaultDir });
  } catch {
    // branch may already be named main
  }
  run('git', ['push', '-u', 'origin', 'main'], { cwd: vaultDir });
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Load .env (repo root by default; --env-file overrides). Does not
  // overwrite already-exported env vars.
  const envPath = args['env-file']
    ? resolve(args['env-file'])
    : join(CLAUDE_SYNC_ROOT, '.env');
  if (loadEnvFile(envPath)) {
    console.log(`[env] loaded ${envPath}`);
  }

  const vaultUrl = args.vault || process.env.CLAUDE_SYNC_VAULT;
  const target = resolve(
    args.target || process.env.CLAUDE_SYNC_TARGET || join(homedir(), '.knowledge-vault'),
  );

  if (!vaultUrl) {
    console.error('usage: node scripts/init.js --vault <git-url> [--target <path>]');
    console.error('   or: CLAUDE_SYNC_VAULT=<git-url> node scripts/init.js');
    console.error('   or: echo "CLAUDE_SYNC_VAULT=<git-url>" > .env && node scripts/init.js');
    console.error('example: CLAUDE_SYNC_VAULT=git@github.com:you/my-vault.git node scripts/init.js');
    process.exit(1);
  }

  console.log(`claude-sync init`);
  console.log(`  vault url: ${vaultUrl}`);
  console.log(`  target:    ${target}`);
  console.log('');

  console.log('[1/6] ensuring repo exists on GitHub...');
  ensureRepoExists(vaultUrl);

  console.log('\n[2/6] cloning vault...');
  if (existsSync(target)) {
    console.log(`  [skip] ${target} already exists`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    run('git', ['clone', vaultUrl, target]);
  }

  console.log('\n[3/6] seeding vault (if empty)...');
  seedVaultIfEmpty(target);

  console.log('\n[4/6] preparing claude-sync runtime...');
  const distDir = join(CLAUDE_SYNC_ROOT, 'dist');
  if (!existsSync(distDir)) {
    console.log('  dist/ not found, running npm install + build');
    run('npm', ['install'], { cwd: CLAUDE_SYNC_ROOT });
    run('npm', ['run', 'build'], { cwd: CLAUDE_SYNC_ROOT });
  }
  const runtimeDir = join(target, '.claude-sync');
  if (!existsSync(runtimeDir)) {
    run('ln', ['-s', CLAUDE_SYNC_ROOT, runtimeDir]);
    console.log(`  symlinked ${runtimeDir} → ${CLAUDE_SYNC_ROOT}`);
  } else {
    console.log(`  [skip] ${runtimeDir} already exists`);
  }

  console.log('\n[5/6] generating mapping.json + creating symlinks...');
  run('node', [join(CLAUDE_SYNC_ROOT, 'scripts', 'generate-mapping.js'), target]);
  run('node', [join(CLAUDE_SYNC_ROOT, 'scripts', 'create-symlinks.js'), target]);

  console.log('\n[6/6] registering MCP server...');
  run('node', [join(CLAUDE_SYNC_ROOT, 'scripts', 'register-mcp.js'), target]);

  console.log('\n[done] claude-sync installed.');
  console.log(`  vault:   ${target}`);
  console.log(`  runtime: ${runtimeDir}`);
  console.log('\nnext steps:');
  console.log(`  1. review ${join(target, 'mapping.json')} — add/remove paths as needed`);
  console.log('  2. restart Claude Code so the new MCP server is picked up');
  console.log('  3. run `claude mcp list` — "claude-sync" should show Connected');
}

main().catch(err => {
  console.error(`\nfatal: ${err.message}`);
  process.exit(1);
});
