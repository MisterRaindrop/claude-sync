#!/usr/bin/env node
/**
 * Create symlinks from ~/.claude/ to the private vault, based on mapping.json.
 *
 * mapping.json shape:
 * {
 *   "projects": {
 *     "<project-name>": ["/abs/path/1", "/abs/path/2"],
 *     "_global": ["/Users/alice"]
 *   }
 * }
 *
 * Symlink layout:
 *   ~/.claude/projects/{encoded-path}/memory/   → <vault>/memory/{project}/
 *   ~/.claude/projects/{encoded-path}/CLAUDE.md → <vault>/config/projects/{project}/CLAUDE.md
 *   ~/.claude/CLAUDE.md                         → <vault>/config/CLAUDE.md
 *
 * Existing non-symlink targets are backed up to <target>.bak.<timestamp>.
 *
 * Usage: node scripts/create-symlinks.js <vault-path>
 */

import { readFile, mkdir, symlink, lstat, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

function encodePath(p) {
  // Claude Code's project path encoding: replace / with -
  // e.g. /Volumes/foo/bar → -Volumes-foo-bar
  return p.replace(/\//g, '-');
}

async function ensureParent(target) {
  await mkdir(dirname(target), { recursive: true });
}

async function backupIfExists(target) {
  // Use lstat first to detect dangling symlinks (existsSync returns false for those)
  let st;
  try {
    st = await lstat(target);
  } catch {
    return false; // nothing at this path
  }
  if (st.isSymbolicLink()) {
    // Existing symlink (possibly dangling) — remove it
    await unlink(target);
    return false;
  }
  // Real file/dir — back up
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${target}.bak.${stamp}`;
  await rename(target, bak);
  console.log(`  [backup] ${target} → ${bak}`);
  return true;
}

async function linkOne(target, source, label) {
  await ensureParent(target);
  await backupIfExists(target);
  try {
    await symlink(source, target);
    console.log(`  [link] ${label}: ${target} → ${source}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`  [skip] ${label}: source does not exist: ${source}`);
    } else {
      throw err;
    }
  }
}

async function main() {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    console.error('usage: create-symlinks.js <vault-path>');
    process.exit(1);
  }

  const absVault = resolve(vaultPath);
  const mappingFile = join(absVault, 'mapping.json');
  if (!existsSync(mappingFile)) {
    console.error(`error: mapping.json not found at ${mappingFile}`);
    console.error('hint: run generate-mapping.js first');
    process.exit(1);
  }

  const mapping = JSON.parse(await readFile(mappingFile, 'utf-8'));
  const projects = mapping.projects || {};
  const claudeDir = join(homedir(), '.claude');

  // Global CLAUDE.md
  const globalClaudeMd = join(claudeDir, 'CLAUDE.md');
  const globalSource = join(absVault, 'config', 'CLAUDE.md');
  if (existsSync(globalSource)) {
    await linkOne(globalClaudeMd, globalSource, 'global CLAUDE.md');
  }

  // Per-project
  for (const [projectName, paths] of Object.entries(projects)) {
    if (projectName === '_global') continue; // handled above implicitly
    for (const absPath of paths) {
      const encoded = encodePath(absPath);
      const projectDir = join(claudeDir, 'projects', encoded);

      // Memory: link the directory
      const memoryTarget = join(projectDir, 'memory');
      const memorySource = join(absVault, 'memory', projectName);
      await linkOne(memoryTarget, memorySource, `${projectName} memory`);

      // Project CLAUDE.md
      const projClaudeMdTarget = join(projectDir, 'CLAUDE.md');
      const projClaudeMdSource = join(absVault, 'config', 'projects', projectName, 'CLAUDE.md');
      if (existsSync(projClaudeMdSource)) {
        await linkOne(projClaudeMdTarget, projClaudeMdSource, `${projectName} CLAUDE.md`);
      }
    }
  }

  console.log('[ok] symlinks created');
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
