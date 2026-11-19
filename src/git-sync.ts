import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
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
// Commits left unpushed (a push that failed, or a process that was killed while pulling/pushing on shutdown) are
// pushed by the next sync, by the next server start, and by this periodic check in long-running sessions.
const PENDING_PUSH_MS = Number(process.env.CLAUDE_SYNC_PENDING_PUSH_MS) || 5 * 60_000;

let syncEnabled = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTimer: ReturnType<typeof setInterval> | null = null;

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

  // A process killed in the middle of `pull --rebase` leaves the rebase half done; nothing can commit until it is gone.
  await abortStuckRebase();

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
      await git('pull', '--no-rebase', '-X', 'theirs');
    } catch (err) {
      process.stderr.write(`claude-sync: pull -X theirs also failed: ${err}\n`);
    }
  }

  // Push what an earlier process committed but could not push (just pulled above)
  await pushPending(false);

  pendingTimer = setInterval(() => {
    if (syncStatus.syncing || debounceTimer) return;
    pushPending().catch(err => process.stderr.write(`claude-sync: pending push error: ${err}\n`));
  }, PENDING_PUSH_MS);
  pendingTimer.unref();

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

async function abortStuckRebase(): Promise<void> {
  try {
    const gitDir = (await git('rev-parse', '--absolute-git-dir')).trim();
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
      process.stderr.write('claude-sync: aborting a rebase left half done by an interrupted sync\n');
      await git('rebase', '--abort');
    }
  } catch (err) {
    process.stderr.write(`claude-sync: rebase check warning: ${err}\n`);
  }
}

async function aheadOfUpstream(): Promise<number> {
  try {
    return parseInt((await git('rev-list', '--count', '@{u}..HEAD')).trim(), 10) || 0;
  } catch {
    return 0;          // no upstream configured
  }
}

async function pullRebase(): Promise<void> {
  try {
    await git('pull', '--rebase');
  } catch {
    process.stderr.write('claude-sync: rebase conflict, resolving with -X theirs\n');
    try { await git('rebase', '--abort'); } catch { /* ignore */ }
    await git('pull', '--no-rebase', '-X', 'theirs');
  }
}

/**
 * Push local commits that are not on the upstream yet. doSync() returns early when the work tree is clean, so
 * without this a commit whose push failed (or was cut off by shutdown) would stay local until the next write.
 */
export async function pushPending(pull = true): Promise<void> {
  if (!syncEnabled || syncStatus.syncing) return;
  syncStatus.syncing = true;
  try {
    const n = await aheadOfUpstream();
    if (!n) return;
    process.stderr.write(`claude-sync: pushing ${n} pending commit(s)\n`);
    if (pull) await pullRebase();
    await git('push');
    syncStatus.head = (await git('rev-parse', 'HEAD')).trim();
    syncStatus.lastSync = new Date().toISOString();
  } catch (err) {
    process.stderr.write(`claude-sync: pending push failed (will retry): ${err}\n`);
  } finally {
    syncStatus.syncing = false;
  }
}

/**
 * Graceful shutdown: commit pending writes, but do not pull or push. The client stops waiting for an MCP server
 * a few seconds after asking it to exit (`claude -p` ends right after its last tool call), and a network pull/push
 * cut off half way lost the push or left a rebase half done. The next server start or the periodic check pushes it.
 */
export async function flushSync(): Promise<void> {
  if (!syncEnabled) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingTimer) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
  if (syncStatus.syncing) return;
  try {
    await git('add', '-A');
    if ((await git('status', '--porcelain')).trim()) {
      await git('commit', '-m', `claude-sync: auto-commit ${new Date().toISOString()}`);
      process.stderr.write('claude-sync: committed on shutdown; the next start pushes it\n');
    }
    syncStatus.dirty = false;
  } catch (err) {
    process.stderr.write(`claude-sync: shutdown commit failed: ${err}\n`);
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
      syncStatus.syncing = false;
      await pushPending();          // nothing new, but an earlier push may have failed
      return;
    }

    const timestamp = new Date().toISOString();
    await git('commit', '-m', `claude-sync: auto-commit ${timestamp}`);

    await pullRebase();

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
