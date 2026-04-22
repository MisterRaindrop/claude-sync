# claude-sync

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

Prerequisites: `git`, `node` ≥ 18, and [`gh`](https://cli.github.com) logged
in to GitHub (needed so `init.js` can auto-create the vault repo if it does
not exist yet). If you prefer, create the private repo yourself and skip the
auto-create step.

### 1. Install claude-sync

```bash
git clone https://github.com/MisterRaindrop/claude_sync.git
cd claude_sync
npm install
npm run build
```

### 2. Configure the vault URL

Pick one of:

**a) `.env` file (persists across shells):**

```bash
cp .env.example .env
# then edit .env and set CLAUDE_SYNC_VAULT=git@github.com:you/my-vault.git
```

**b) Environment variable:**

```bash
export CLAUDE_SYNC_VAULT=git@github.com:you/my-vault.git
```

**c) CLI flag:** pass `--vault <url>` directly to `init.js` (see below).

Precedence: CLI flag > exported env var > `.env` file.

### 3. Run init (one command)

```bash
node scripts/init.js
```

The script is idempotent — rerunning it is safe.

What happens:

1. Create the GitHub repo if it does not exist (`gh repo create --private`)
2. Clone it into `~/.knowledge-vault/`
3. If the clone is empty, seed the folder structure
   (`knowledge/`, `memory/`, `config/projects/`, `.gitignore`,
   `mapping.example.json`) and **migrate any existing
   `~/.claude/projects/*/memory/` content** into `memory/<project>/`
   before committing and pushing
4. Build claude-sync (if `dist/` is missing) and symlink it into
   `~/.knowledge-vault/.claude-sync/`
5. Generate `mapping.json` from `~/.claude/projects/` and create symlinks
   from `~/.claude/` into the vault
6. Register the MCP server as `claude-sync` in `~/.claude.json`
   (other `mcpServers` entries are left untouched)

Edit `~/.knowledge-vault/mapping.json` if you want to prune or rename project
mappings, then restart Claude Code.

Verify:

```bash
claude mcp list
# claude-sync should show: Connected
```

### CLI flag alternatives

```bash
node scripts/init.js --vault git@github.com:you/my-vault.git
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
