#!/usr/bin/env node
/**
 * Generate mapping.json from mapping.example.json in the vault, plus hints
 * from scanning ~/.claude/projects/ for existing project directories.
 *
 * Default behavior: non-interactive. Copies mapping.example.json to mapping.json
 * if it exists; otherwise writes a skeleton with discovered projects.
 *
 * The user is expected to edit mapping.json manually afterwards to add
 * machine-specific paths.
 *
 * Usage: node scripts/generate-mapping.js <vault-path>
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

function decodeProjectPath(encoded) {
  // Claude Code encodes project paths by replacing /, ., and potentially
  // other chars with -. This is lossy — we can't reliably reverse it.
  // Strategy: naively decode, then verify the path exists on disk.
  if (!encoded.startsWith('-')) return null;
  const naive = encoded.replace(/-/g, '/');
  if (existsSync(naive)) return naive;
  // Path doesn't exist — the encoding was ambiguous (e.g. cloudberry-pxf
  // decoded as cloudberry/pxf). Skip this entry.
  return null;
}

async function scanExistingProjects() {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];
  const entries = await readdir(projectsDir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const decoded = decodeProjectPath(entry.name);
    if (decoded) paths.push(decoded);
  }
  return paths;
}

function inferProjectName(absPath) {
  const segments = absPath.split('/').filter(Boolean);
  // Known subdirs that should fall through to parent
  const subdirNames = new Set(['fdw', 'src', 'build', 'dist', 'lib']);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!subdirNames.has(segments[i])) return segments[i];
  }
  return segments[segments.length - 1] ?? 'unknown';
}

async function main() {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    console.error('usage: generate-mapping.js <vault-path>');
    process.exit(1);
  }

  const absVault = resolve(vaultPath);
  const exampleFile = join(absVault, 'mapping.example.json');
  const outputFile = join(absVault, 'mapping.json');

  if (existsSync(outputFile)) {
    console.log(`[skip] mapping.json already exists at ${outputFile}`);
    console.log('       delete it if you want to regenerate');
    return;
  }

  let template = { projects: {} };
  if (existsSync(exampleFile)) {
    template = JSON.parse(await readFile(exampleFile, 'utf-8'));
    console.log(`[info] using template from ${exampleFile}`);
  }

  // Discover projects from ~/.claude/projects/
  const discovered = await scanExistingProjects();
  if (discovered.length) {
    console.log(`[info] discovered ${discovered.length} project paths in ~/.claude/projects/`);
    for (const p of discovered) {
      const name = inferProjectName(p);
      if (!template.projects[name]) {
        template.projects[name] = [];
      }
      if (!template.projects[name].includes(p)) {
        template.projects[name].push(p);
      }
    }
  }

  await writeFile(outputFile, JSON.stringify(template, null, 2), 'utf-8');
  console.log(`[ok] wrote ${outputFile}`);
  console.log('     review and edit it to add/remove paths, then run create-symlinks.js');
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
