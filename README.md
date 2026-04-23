# claude-sync

**English** · [简体中文](README.zh.md)

An MCP server that gives Claude Code a **Git-synced knowledge vault** and
**cross-machine memory**, so your notes, project `CLAUDE.md` files, and
Claude's auto-written memories follow you across laptop, server, and VM.

- **Git-backed vault**: your knowledge, memory, and config live in a private
  GitHub repo. Writes are debounced 30s and pushed automatically; startup
  pulls the latest.
- **Cross-machine memory**: `~/.claude/projects/*/memory/` is symlinked into
  `vault/memory/{project}/`, so `MEMORY.md` and project CLAUDE.md files sync
  everywhere.
- **Nine tools**: read, list, search, create, append, patch, and delete
  markdown files in the vault; plus a server-info probe.
- **Plain filesystem**: no external editor or sidecar required. The server
  talks directly to files on disk.

## Architecture

```
claude-sync (this repo, open source)     my-vault (private GitHub repo)
├── src/server.ts                        ├── knowledge/   ← markdown knowledge files
├── src/git-sync.ts                      ├── memory/      ← Claude memory
├── src/tools.ts                         ├── config/      ← CLAUDE.md
└── scripts/init.js                      └── mapping.example.json
         │                                        │
         └──── claude-sync-init --vault ──────────┘
                       ↓
         ~/.knowledge-vault/  (private vault clone + .claude-sync/ runtime)
         ├── knowledge/       ← MCP server reads from here
         ├── memory/          ← symlinked to ~/.claude/projects/*/memory/
         ├── config/          ← symlinked to ~/.claude/CLAUDE.md
         ├── mapping.json     ← machine-specific path mapping (gitignored)
         └── .claude-sync/    ← symlink to installed claude-sync
```

## Tools

All nine tools:

| Tool | Purpose |
|------|---------|
| `get_vault_file` | Read a file (optionally as JSON with parsed frontmatter) |
| `list_vault_files` | Recursively list files in the vault or a subdirectory |
| `search_vault_smart` | Full-text search backed by flexsearch, with folder filters |
| `search_vault_simple` | Literal string match with surrounding context |
| `create_vault_file` | Create or overwrite a file |
| `append_to_vault_file` | Append content to a file |
| `patch_vault_file` | Modify content at a heading, block ref, or frontmatter field |
| `delete_vault_file` | Remove a file |
| `get_server_info` | Return version and sync status (lastSync, HEAD, dirty flag) |

### `patch_vault_file` targeting

| `targetType` | `target` | Use case |
|--------------|----------|----------|
| `frontmatter` | Field name (e.g. `status`) | Modify YAML frontmatter fields. `append`/`prepend` work on array fields. `contentType: application/json` parses the content as JSON before assignment. |
| `heading` | Heading path (e.g. `"Section::Subsection"`) | Target a Markdown section delimited by `::`. `append`/`prepend` add content inside the section; `replace` replaces the entire body (including sub-sections). |
| `block` | Block reference ID (e.g. `^abc` or `abc`) | Target the paragraph containing `^id`. |

## Setup

Prerequisites: `git` and `node` ≥ 18. A [GitHub Personal Access
Token](https://github.com/settings/tokens/new?scopes=repo&description=claude-sync)
with `repo` scope is recommended — with it, `init.js` can create the private
vault repo and push over HTTPS without any ssh-key or `gh` CLI setup. (If you
already have ssh + `gh` configured, that path still works — see
[Using an existing ssh + gh setup](#using-an-existing-ssh--gh-setup) below.)

### 1. Install claude-sync

```bash
git clone https://github.com/MisterRaindrop/claude-sync.git
cd claude-sync
npm install
npm run build
```

### 2. Run init

```bash
node scripts/init.js
```

On the first run, `init.js` will prompt for:

- your vault URL (HTTPS form, e.g. `https://github.com/you/my-vault.git`)
- your GitHub token
- the local vault path (default `~/.knowledge-vault`)

These are saved to `~/.claude-sync/config.json` (mode `600`). On subsequent
runs — and on any other machine where you copy or re-create that file —
the prompts are skipped.

The script is idempotent; rerunning it is safe.

What happens:

1. Verify the repo exists (or create it as private via the GitHub API)
2. Clone into the local target
3. If the clone is empty, seed the folder structure
   (`knowledge/`, `memory/`, `config/projects/`, `.gitignore`,
   `mapping.example.json`) and **migrate any existing
   `~/.claude/projects/*/memory/` content** into `memory/<project>/`
   before committing and pushing
4. Build claude-sync (if `dist/` is missing) and symlink it into
   `<vault>/.claude-sync/`
5. Generate `mapping.json` and create symlinks from `~/.claude/` into the vault
6. Register the MCP server as `claude-sync` in `~/.claude.json`
   (other `mcpServers` entries are left untouched)

Verify:

```bash
claude mcp list
# claude-sync should show: Connected
```

### Using on multiple machines

Put the same `~/.claude-sync/config.json` on each machine (or re-answer the
prompt once per machine) — no ssh key management or `gh auth login` needed.
Token lives in `~/.claude-sync/config.json` with mode `600`; it is injected
into git via `GIT_ASKPASS` at runtime and is **never written to `.git/config`**.

```json
{
  "vault": "https://github.com/you/my-vault.git",
  "token": "ghp_xxxxxxxxxxxxxxxxxxxxxxxx",
  "target": "/home/you/.knowledge-vault"
}
```

```bash
chmod 600 ~/.claude-sync/config.json
```

Env vars (`CLAUDE_SYNC_VAULT`, `CLAUDE_SYNC_TOKEN`, `CLAUDE_SYNC_TARGET`) and
a project-local `.env` still work as overrides. Resolution order: env >
central config > `.env`.

### Using an existing ssh + gh setup

If your vault URL is `git@github.com:...`, `init.js` skips the token flow
entirely and falls back to ssh + `gh` (same behavior as earlier builds). No
changes needed for existing users.

### CLI flag alternatives

```bash
node scripts/init.js --vault https://github.com/you/my-vault.git
node scripts/init.js --env-file /path/to/custom.env
```

### Upgrading from an earlier build

If you previously registered claude-sync under the old name `obsidian`, your
`~/.claude.json` still has that entry pointing at `dist/server.js`. Remove it
manually if you no longer want it — the new script writes to
`mcpServers["claude-sync"]` and never touches other keys.

## Running manually (without init)

```bash
VAULT_PATH=/path/to/vault/knowledge node dist/server.js
```

`VAULT_PATH` must point at the `knowledge/` subdirectory of the vault
(where the Markdown files live). Git operations run in the parent directory
(the vault repo root), so `memory/` and `config/` are synced too.

## Sync behavior

- **Write**: file changed → `dirty=true`, reset 30s debounce timer.
- **30s of idle**: `git add -A && git commit && git pull --rebase && git push`.
- **Rebase conflict**: `git rebase --abort && git pull -X theirs && git push`
  (last-write-wins; simple and predictable).
- **Startup**: auto-commit any uncommitted changes, then `git pull --rebase`.
- **Shutdown** (SIGTERM/SIGINT): flush pending sync before exit.

## Development

```bash
npm install
npm run build          # compile TypeScript → dist/
npm test               # run unit tests (patch.ts: 15 tests)
npm run dev            # run server with tsx (set VAULT_PATH)
```

Inspect with the MCP inspector:

```bash
VAULT_PATH=/tmp/test-vault/knowledge \
  npx @modelcontextprotocol/inspector node dist/server.js
```

## License

MIT
