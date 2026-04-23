/**
 * Unified config loader for claude-sync.
 *
 * Resolves vault URL, token, and target path from three sources in priority:
 *   1. process.env (CLAUDE_SYNC_VAULT / _TOKEN / _TARGET)
 *   2. ~/.claude-sync/config.json  (central config, recommended for multi-machine use)
 *   3. <project>/.env              (legacy, kept for backwards compatibility)
 *
 * The central config lets a user configure claude-sync once per machine
 * instead of re-editing a project-local .env every time.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const CENTRAL_DIR = join(homedir(), '.claude-sync');
export const CENTRAL_CONFIG_PATH = join(CENTRAL_DIR, 'config.json');

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const out = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readCentralConfig() {
  if (!existsSync(CENTRAL_CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CENTRAL_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse ${CENTRAL_CONFIG_PATH}: ${err.message}`,
    );
  }
}

/**
 * Aggregate config from all sources. Env wins over central, central wins over .env.
 * @param {object} opts
 * @param {string} [opts.envFile]  Path to a project-local .env file.
 * @returns {{vault?: string, token?: string, target?: string, sources: object}}
 */
export function loadConfig({ envFile } = {}) {
  const sources = { env: {}, central: {}, dotenv: {} };

  if (envFile) sources.dotenv = parseEnvFile(envFile);
  sources.central = readCentralConfig();

  sources.env.CLAUDE_SYNC_VAULT = process.env.CLAUDE_SYNC_VAULT;
  sources.env.CLAUDE_SYNC_TOKEN = process.env.CLAUDE_SYNC_TOKEN;
  sources.env.CLAUDE_SYNC_TARGET = process.env.CLAUDE_SYNC_TARGET;

  const pick = (envKey, centralKey) =>
    sources.env[envKey] ||
    sources.central[centralKey] ||
    sources.dotenv[envKey] ||
    undefined;

  return {
    vault: pick('CLAUDE_SYNC_VAULT', 'vault'),
    token: pick('CLAUDE_SYNC_TOKEN', 'token'),
    target: pick('CLAUDE_SYNC_TARGET', 'target'),
    sources,
  };
}

/**
 * Write the central config atomically and lock down permissions (0600).
 */
export function writeCentralConfig({ vault, token, target }) {
  mkdirSync(CENTRAL_DIR, { recursive: true });
  const body = {};
  if (vault) body.vault = vault;
  if (token) body.token = token;
  if (target) body.target = target;

  const tmp = `${CENTRAL_CONFIG_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf-8');
  chmodSync(tmp, 0o600);
  renameSync(tmp, CENTRAL_CONFIG_PATH);
}

async function promptLine(prompt, { defaultValue } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const label = defaultValue ? `${prompt} [${defaultValue}]: ` : `${prompt}: `;
  try {
    const answer = await new Promise(res => rl.question(label, res));
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

/**
 * Interactively fill any missing fields and persist to the central config.
 * Existing fields (from env / central / dotenv) are NOT re-asked.
 *
 * Returns the merged config.
 */
export async function promptForMissingConfig(current) {
  const updates = {};
  const final = { ...current };

  if (!final.vault) {
    console.log('');
    console.log('No vault URL configured yet.');
    console.log('HTTPS form is recommended (e.g. https://github.com/you/my-vault.git).');
    const v = await promptLine('vault URL');
    if (!v) throw new Error('vault URL is required');
    updates.vault = v;
    final.vault = v;
  }

  const isHttps = /^https?:\/\//i.test(final.vault || '');
  if (isHttps && !final.token) {
    console.log('');
    console.log('HTTPS vault URL needs a GitHub token (scope: repo).');
    console.log('Generate one at: https://github.com/settings/tokens/new?scopes=repo&description=claude-sync');
    const t = await promptLine('GitHub token');
    if (!t) throw new Error('token is required for HTTPS vault URLs');
    updates.token = t;
    final.token = t;
  }

  if (!final.target) {
    const defaultTarget = join(homedir(), '.knowledge-vault');
    const t = await promptLine('local vault path', { defaultValue: defaultTarget });
    updates.target = t;
    final.target = t;
  }

  if (Object.keys(updates).length > 0) {
    // Persist only newly-gathered fields merged with whatever was already in central.
    const existing = readCentralConfig();
    writeCentralConfig({ ...existing, ...updates });
    console.log('');
    console.log(`[config] wrote ${CENTRAL_CONFIG_PATH} (mode 600)`);
  }

  return final;
}
