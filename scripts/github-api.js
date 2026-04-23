/**
 * Thin wrapper over GitHub REST API, used in place of `gh` CLI when a PAT is
 * available. Keeps init.js free of gh CLI dependency on machines where the
 * user only has a token.
 */

const API_BASE = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'claude-sync',
  };
}

function explainStatus(status, body) {
  if (status === 401) {
    return '401 Unauthorized — check that CLAUDE_SYNC_TOKEN is valid and not expired.';
  }
  if (status === 403) {
    return '403 Forbidden — token likely missing the `repo` scope. Regenerate at https://github.com/settings/tokens/new?scopes=repo';
  }
  if (status === 422) {
    return `422 Unprocessable — ${body?.message || 'repo may already exist under a different owner'}`;
  }
  return `${status} ${body?.message || ''}`.trim();
}

/**
 * @returns {Promise<boolean>} true if the repo exists and token has access.
 */
export async function repoExists(owner, repo, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, {
    headers: headers(token),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  const body = await res.json().catch(() => ({}));
  throw new Error(`github: repoExists failed: ${explainStatus(res.status, body)}`);
}

/**
 * Create a private repo. If `owner` equals the authenticated user (common
 * case), uses POST /user/repos; otherwise uses POST /orgs/{owner}/repos.
 *
 * The caller usually doesn't know whether `owner` is a user or org, so we
 * optimistically try /user/repos first (the common case for personal vaults).
 * If GitHub says the name conflicts with an org-owned context, we fall back.
 */
export async function createRepo(owner, repo, token, { privateRepo = true } = {}) {
  // Determine if owner is the authenticated user.
  const meRes = await fetch(`${API_BASE}/user`, { headers: headers(token) });
  const me = await meRes.json().catch(() => ({}));
  if (!meRes.ok) {
    throw new Error(`github: /user failed: ${explainStatus(meRes.status, me)}`);
  }

  const body = { name: repo, private: privateRepo, auto_init: false };
  const url =
    me.login && me.login.toLowerCase() === owner.toLowerCase()
      ? `${API_BASE}/user/repos`
      : `${API_BASE}/orgs/${owner}/repos`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`github: createRepo failed: ${explainStatus(res.status, json)}`);
  }
  return json;
}
