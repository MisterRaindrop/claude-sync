#!/usr/bin/env node
/**
 * Register claude-sync as an MCP server named "claude-sync" in ~/.claude.json.
 *
 * Writes (or updates) top-level mcpServers["claude-sync"]. Other entries in
 * mcpServers are left untouched.
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
import { loadConfig } from './config.js';

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

  if (config.mcpServers['claude-sync']) {
    console.error('note: mcpServers["claude-sync"] already exists, overwriting');
  }

  // Pull the token from the central config (or env var) so the MCP server
  // can authenticate git push/pull without touching the user's ssh setup.
  const cfg = loadConfig();
  const env = {
    VAULT_PATH: join(absVault, 'knowledge'),
  };
  if (cfg.token) env.CLAUDE_SYNC_TOKEN = cfg.token;

  config.mcpServers['claude-sync'] = {
    type: 'stdio',
    command: 'node',
    args: [serverEntry],
    env,
  };

  // Atomic write: tempfile + rename
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
  await rename(tmpPath, configPath);

  console.log(`[ok] registered mcpServers["claude-sync"] in ${configPath}`);
  console.log(`     command: node ${serverEntry}`);
  console.log(`     env.VAULT_PATH: ${join(absVault, 'knowledge')}`);
  if (cfg.token) {
    console.log(`     env.CLAUDE_SYNC_TOKEN: (redacted, ${cfg.token.length} chars)`);
  }
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
