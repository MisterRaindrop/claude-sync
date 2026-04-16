#!/usr/bin/env node
/**
 * One-shot setup for claude-sync.
 *
 * Clones a private vault repo, installs claude-sync inside it, compiles,
 * generates mapping.json, creates symlinks, and registers the MCP server.
 *
 * Usage:
 *   claude-sync-init --vault <git-url> [--target <path>]
 *
 * Defaults:
 *   --target: ~/.knowledge-vault
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultUrl = args.vault;
  const target = resolve(args.target || join(homedir(), '.knowledge-vault'));

  if (!vaultUrl) {
    console.error('usage: claude-sync-init --vault <git-url> [--target <path>]');
    console.error('example: claude-sync-init --vault git@github.com:you/my-vault.git');
    process.exit(1);
  }

  console.log(`claude-sync init`);
  console.log(`  vault url: ${vaultUrl}`);
  console.log(`  target:    ${target}`);
  console.log('');

  // Step 1: clone (or skip if already exists)
  if (existsSync(target)) {
    console.log(`[skip] ${target} already exists; assuming clone done`);
  } else {
    console.log('[1/5] cloning vault...');
    mkdirSync(dirname(target), { recursive: true });
    run('git', ['clone', vaultUrl, target]);
  }

  // Step 2: ensure claude-sync is built, then symlink into .claude-sync/
  console.log('\n[2/5] preparing claude-sync runtime...');
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

  // Step 3: generate mapping.json
  console.log('\n[3/5] generating mapping.json...');
  run('node', [join(CLAUDE_SYNC_ROOT, 'scripts', 'generate-mapping.js'), target]);

  // Step 4: create symlinks
  console.log('\n[4/5] creating symlinks...');
  run('node', [join(CLAUDE_SYNC_ROOT, 'scripts', 'create-symlinks.js'), target]);

  // Step 5: register MCP server
  console.log('\n[5/5] registering MCP server...');
  run('node', [join(CLAUDE_SYNC_ROOT, 'scripts', 'register-mcp.js'), target]);

  console.log('\n[done] claude-sync installed.');
  console.log(`  vault:   ${target}`);
  console.log(`  runtime: ${runtimeDir}`);
  console.log('\nnext steps:');
  console.log(`  1. review ${join(target, 'mapping.json')} — add/remove paths as needed`);
  console.log('  2. restart Claude Code so the new MCP server is picked up');
  console.log('  3. run `claude mcp list` — "obsidian" should show Connected');
}

main().catch(err => {
  console.error(`\nfatal: ${err.message}`);
  process.exit(1);
});
