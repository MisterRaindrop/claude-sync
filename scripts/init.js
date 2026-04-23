#!/usr/bin/env node
/**
 * One-shot setup for claude-sync.
 *
 * Clones a private vault repo (creating it on GitHub first if it does not
 * exist), seeds the initial folder structure and migrates any existing
 * per-project memory content into it, installs claude-sync inside the vault,
 * generates mapping.json, creates symlinks, and registers the MCP server.
 *
 * Configuration (in priority order):
 *   1. env vars: CLAUDE_SYNC_VAULT / CLAUDE_SYNC_TOKEN / CLAUDE_SYNC_TARGET
 *   2. ~/.claude-sync/config.json   (recommended, works across projects)
 *   3. <this repo>/.env              (legacy, kept for backwards compat)
 *
 * For HTTPS vault URLs we use a GitHub personal access token (no ssh key, no
 * gh CLI). For SSH URLs (git@github.com:...) we fall back to the legacy path
 * that relies on ssh + gh.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import {
  loadConfig,
  promptForMissingConfig,
  CENTRAL_CONFIG_PATH,
} from './config.js';
import { runGit } from './git-auth.js';
import { repoExists, createRepo } from './github-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_SYNC_ROOT = resolve(__dirname, '..');

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

async function ensureRepoExists(vaultUrl, token) {
  const parsed = parseGitUrl(vaultUrl);
  if (!parsed) {
    console.log('  [warn] could not parse repo URL; skipping GitHub existence check');
    return;
  }

  if (parsed.protocol === 'https') {
    if (!token) {
      throw new Error(
        'HTTPS vault URL requires CLAUDE_SYNC_TOKEN (or `token` in ~/.claude-sync/config.json).\n' +
        'Generate one at: https://github.com/settings/tokens/new?scopes=repo',
      );
    }
    const exists = await repoExists(parsed.owner, parsed.name, token);
    if (exists) {
      console.log(`  [ok] repo ${parsed.full} exists on GitHub`);
      return;
    }
    console.log(`  [info] repo ${parsed.full} not found, creating as private...`);
    await createRepo(parsed.owner, parsed.name, token);
    console.log(`  [ok] created ${parsed.full}`);
    return;
  }

  // SSH path: legacy gh CLI flow.
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

    let st;
    try { st = lstatSync(memDir); } catch { continue; }
    if (st.isSymbolicLink()) continue;

    const files = readdirSync(memDir);
    if (files.length === 0) continue;

    const projectName = inferProjectName(decoded);
    const target = join(vaultDir, 'memory', projectName);
    mkdirSync(target, { recursive: true });

    run('cp', ['-R', `${memDir}/.`, target]);
    console.log(`  [migrate] ${projectName}: ${files.length} entries from ${memDir}`);
    migrated++;
  }
  return migrated;
}

function seedVaultIfEmpty(vaultDir, token) {
  if (!isVaultEmpty(vaultDir)) {
    console.log('  [skip] vault is not empty; skipping seed');
    return false;
  }

  console.log('  [info] vault is empty, seeding initial structure...');
  mkdirSync(join(vaultDir, 'knowledge'), { recursive: true });
  mkdirSync(join(vaultDir, 'memory'), { recursive: true });
  mkdirSync(join(vaultDir, 'config', 'projects'), { recursive: true });

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

  runGit(['add', '-A'], { cwd: vaultDir });
  runGit(['commit', '-m', 'seed: initial vault structure'], { cwd: vaultDir });
  try {
    runGit(['branch', '-M', 'main'], { cwd: vaultDir });
  } catch {
    // branch may already be named main
  }
  runGit(['push', '-u', 'origin', 'main'], { cwd: vaultDir, token });
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve config: env > ~/.claude-sync/config.json > project .env.
  const envFile = args['env-file']
    ? resolve(args['env-file'])
    : join(CLAUDE_SYNC_ROOT, '.env');
  let cfg = loadConfig({ envFile });

  // --vault flag still wins over everything.
  if (args.vault) cfg.vault = args.vault;
  if (args.target) cfg.target = args.target;

  // If vault/target/token are missing, prompt the user and persist to central
  // config so the next machine (or rerun) is painless.
  cfg = await promptForMissingConfig(cfg);

  const vaultUrl = cfg.vault;
  const token = cfg.token;
  const target = resolve(cfg.target || join(homedir(), '.knowledge-vault'));

  console.log('');
  console.log(`claude-sync init`);
  console.log(`  vault url: ${vaultUrl}`);
  console.log(`  target:    ${target}`);
  console.log(`  auth:      ${token ? 'token (HTTPS)' : 'ssh/system credential'}`);
  console.log(`  config:    ${CENTRAL_CONFIG_PATH}`);
  console.log('');

  console.log('[1/6] ensuring repo exists on GitHub...');
  await ensureRepoExists(vaultUrl, token);

  console.log('\n[2/6] cloning vault...');
  if (existsSync(target)) {
    console.log(`  [skip] ${target} already exists`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    runGit(['clone', vaultUrl, target], { token });
  }

  console.log('\n[3/6] seeding vault (if empty)...');
  seedVaultIfEmpty(target, token);

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
