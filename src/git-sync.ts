import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  writeFileSync,
  chmodSync,
  mkdtempSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncStatus } from './types.js';

const exec = promisify(execFile);

const VAULT_PATH = process.env.VAULT_PATH!;
const DEBOUNCE_MS = 30_000;

let syncEnabled = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const syncStatus: SyncStatus = {
  lastSync: null,
  head: null,
  dirty: false,
  syncing: false,
};

// Build the env for `git` child processes once. If CLAUDE_SYNC_TOKEN is set,
// we plant a GIT_ASKPASS script so HTTPS remotes pick up the token without
// it ever being persisted to .git/config. If the token is not set, git falls
// back to whatever the system already has (ssh-agent, credential helpers).
let askpassScript: string | null = null;
let askpassDir: string | null = null;

function buildGitEnv(): NodeJS.ProcessEnv {
  const token = process.env.CLAUDE_SYNC_TOKEN;
  if (!token) return process.env;

  if (!askpassScript) {
    askpassDir = mkdtempSync(join(tmpdir(), 'claude-sync-askpass-'));
    askpassScript = join(askpassDir, 'askpass.sh');
    writeFileSync(askpassScript, '#!/bin/sh\nprintf "%s" "$CLAUDE_SYNC_TOKEN"\n', 'utf-8');
    chmodSync(askpassScript, 0o700);
  }

  return {
    ...process.env,
    GIT_ASKPASS: askpassScript,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function cleanupAskpass(): void {
  if (askpassScript) {
    try { unlinkSync(askpassScript); } catch { /* best-effort */ }
    askpassScript = null;
  }
  if (askpassDir) {
    try { rmdirSync(askpassDir); } catch { /* best-effort */ }
    askpassDir = null;
  }
}

process.on('exit', cleanupAskpass);

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: VAULT_PATH,
    timeout: 30_000,
    env: buildGitEnv(),
  });
  return stdout;
}

async function isGitRepo(): Promise<boolean> {
  try {
    await git('rev-parse', '--git-dir');
    return true;
  } catch {
    return false;
  }
}

export async function startSync(): Promise<void> {
  if (!(await isGitRepo())) {
    process.stderr.write('claude-sync: VAULT_PATH is not a git repository, sync disabled\n');
    return;
  }

  syncEnabled = true;

  // Detect and commit uncommitted changes
  try {
    const status = await git('status', '--porcelain');
    if (status.trim()) {
      process.stderr.write('claude-sync: committing uncommitted changes found on startup\n');
      await git('add', '-A');
      await git('commit', '-m', 'claude-sync: auto-commit uncommitted changes on startup');
    }
  } catch (err) {
    process.stderr.write(`claude-sync: startup commit warning: ${err}\n`);
  }

  // Pull latest
  try {
    await git('pull', '--rebase');
    process.stderr.write('claude-sync: pulled latest changes\n');
  } catch {
    process.stderr.write('claude-sync: pull --rebase failed, trying pull -X theirs\n');
    try { await git('rebase', '--abort'); } catch { /* no rebase in progress */ }
    try {
      await git('pull', '-X', 'theirs');
    } catch (err) {
      process.stderr.write(`claude-sync: pull -X theirs also failed: ${err}\n`);
    }
  }

  // Record current HEAD
  try {
    syncStatus.head = (await git('rev-parse', 'HEAD')).trim();
    syncStatus.lastSync = new Date().toISOString();
  } catch {
    // might be empty repo
  }
}

export function scheduleSync(): void {
  if (!syncEnabled) return;
  syncStatus.dirty = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    doSync().catch(err => {
      process.stderr.write(`claude-sync: sync error: ${err}\n`);
    });
  }, DEBOUNCE_MS);
}

/**
 * Flush pending writes immediately (for graceful shutdown).
 * Cancels debounce timer and runs doSync() synchronously if dirty.
 */
export async function flushSync(): Promise<void> {
  if (!syncEnabled) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (syncStatus.dirty && !syncStatus.syncing) {
    await doSync();
  }
}

async function doSync(): Promise<void> {
  if (syncStatus.syncing) return;
  syncStatus.syncing = true;

  try {
    await git('add', '-A');

    const status = await git('status', '--porcelain');
    if (!status.trim()) {
      syncStatus.dirty = false;
      return;
    }

    const timestamp = new Date().toISOString();
    await git('commit', '-m', `claude-sync: auto-commit ${timestamp}`);

    // Pull with rebase
    try {
      await git('pull', '--rebase');
    } catch {
      process.stderr.write('claude-sync: rebase conflict, resolving with -X theirs\n');
      try { await git('rebase', '--abort'); } catch { /* ignore */ }
      await git('pull', '-X', 'theirs');
    }

    // Push
    try {
      await git('push');
    } catch (err) {
      process.stderr.write(`claude-sync: push failed (will retry next sync): ${err}\n`);
    }

    syncStatus.head = (await git('rev-parse', 'HEAD')).trim();
    syncStatus.lastSync = new Date().toISOString();
    syncStatus.dirty = false;
    process.stderr.write(`claude-sync: synced at ${syncStatus.lastSync}\n`);
  } catch (err) {
    process.stderr.write(`claude-sync: sync failed: ${err}\n`);
  } finally {
    syncStatus.syncing = false;
  }
}

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}
