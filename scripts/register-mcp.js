#!/usr/bin/env node
/**
 * Register claude-sync as an MCP server named "obsidian" in ~/.claude.json.
 *
 * Writes (or updates) top-level mcpServers.obsidian so existing skills that
 * call mcp__obsidian__* tools work unchanged.
 *
 * Usage:
 *   node scripts/register-mcp.js <vault-path>
 *
 * <vault-path> is the root of the cloned private vault repo (e.g. ~/.knowledge-vault).
 * The MCP server binary is expected at <vault-path>/.claude-sync/dist/server.js.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

async function main() {
  const vaultPath = process.argv[2];
  if (!vaultPath) {
    console.error('usage: register-mcp.js <vault-path>');
    process.exit(1);
  }

  const absVault = resolve(vaultPath);
  const serverEntry = join(absVault, '.claude-sync', 'dist', 'server.js');

  if (!existsSync(serverEntry)) {
    console.error(`error: server entry not found at ${serverEntry}`);
    console.error('hint: run `cd <vault>/.claude-sync && npm install && npm run build` first');
    process.exit(1);
  }

  const configPath = join(homedir(), '.claude.json');
  let config = {};
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, 'utf-8');
      config = JSON.parse(raw);
    } catch (err) {
      console.error(`error: failed to parse ${configPath}: ${err.message}`);
      process.exit(1);
    }
  }

  config.mcpServers = config.mcpServers || {};

  if (config.mcpServers.obsidian) {
    console.error('note: mcpServers.obsidian already exists, overwriting');
  }

  config.mcpServers.obsidian = {
    type: 'stdio',
    command: 'node',
    args: [serverEntry],
    env: {
      VAULT_PATH: join(absVault, 'knowledge'),
    },
  };

  // Atomic write: tempfile + rename
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  await rename(tmpPath, configPath);

  console.log(`[ok] registered mcpServers.obsidian in ${configPath}`);
  console.log(`     command: node ${serverEntry}`);
  console.log(`     env.VAULT_PATH: ${join(absVault, 'knowledge')}`);
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
