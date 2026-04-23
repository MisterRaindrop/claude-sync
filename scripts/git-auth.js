/**
 * Inject a GitHub token into git commands without writing it to disk-at-rest.
 *
 * Strategy: generate a short-lived askpass script that prints the token from
 * an environment variable. Git reads the token via GIT_ASKPASS only for the
 * duration of this process's git calls, so the token never ends up in
 * .git/config or in a credential store.
 *
 * Setting GIT_TERMINAL_PROMPT=0 guarantees git won't silently fall back to
 * an interactive tty prompt (which would deadlock when run under init.js or
 * inside the MCP server).
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, chmodSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Build an env block suitable for a git child process when a token is present.
 * When token is falsy, returns process.env unchanged (no injection).
 *
 * Caller is responsible for calling cleanup() after the git command finishes.
 *
 * @returns {{env: NodeJS.ProcessEnv, cleanup: () => void}}
 */
export function buildGitAuthEnv(token) {
  if (!token) return { env: process.env, cleanup: () => {} };

  const dir = mkdtempSync(join(tmpdir(), 'claude-sync-askpass-'));
  const script = join(dir, 'askpass.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "%s" "$CLAUDE_SYNC_TOKEN"\n', 'utf-8');
  chmodSync(script, 0o700);

  const env = {
    ...process.env,
    CLAUDE_SYNC_TOKEN: token,
    GIT_ASKPASS: script,
    GIT_TERMINAL_PROMPT: '0',
  };

  const cleanup = () => {
    try { unlinkSync(script); } catch { /* best-effort */ }
    try { rmdirSync(dir); } catch { /* best-effort */ }
  };

  return { env, cleanup };
}

/**
 * Run a git command with optional token injection. Token may be undefined,
 * in which case git runs with whatever credentials the environment already
 * has (ssh-agent, system credential helper, etc.).
 *
 * Uses spawnSync + stdio: 'inherit' so users see git's output as init.js runs.
 */
export function runGit(args, { cwd, token } = {}) {
  const { env, cleanup } = buildGitAuthEnv(token);
  try {
    console.log(`$ git ${args.join(' ')}`);
    const r = spawnSync('git', args, { cwd, stdio: 'inherit', env });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (exit ${r.status})`);
    }
  } finally {
    cleanup();
  }
}
