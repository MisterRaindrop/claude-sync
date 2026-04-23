/**
 * Shared helpers for scripts/*.
 */

import { existsSync } from 'node:fs';

/**
 * Decode a Claude Code project directory name back to an absolute path.
 * Claude encodes by replacing / with -, so this is lossy. Returns null if
 * the decoded path does not exist on disk.
 */
export function decodeProjectPath(encoded) {
  if (!encoded.startsWith('-')) return null;
  const naive = encoded.replace(/-/g, '/');
  if (existsSync(naive)) return naive;
  return null;
}

/**
 * Infer a short project name from an absolute path. Walks the path from the
 * tail and skips known-uninformative subdirectory names like `src`/`dist`.
 */
export function inferProjectName(absPath) {
  const segments = absPath.split('/').filter(Boolean);
  const subdirNames = new Set(['fdw', 'src', 'build', 'dist', 'lib']);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!subdirNames.has(segments[i])) return segments[i];
  }
  return segments[segments.length - 1] ?? 'unknown';
}

/**
 * Parse a git remote URL (ssh or https) into { owner, name, full, protocol }.
 * Returns null if the URL is not a recognized GitHub-style form.
 */
export function parseGitUrl(url) {
  const ssh = url.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) {
    return { owner: ssh[1], name: ssh[2], full: `${ssh[1]}/${ssh[2]}`, protocol: 'ssh' };
  }
  const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) {
    return { owner: https[1], name: https[2], full: `${https[1]}/${https[2]}`, protocol: 'https' };
  }
  return null;
}
