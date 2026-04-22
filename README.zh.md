# claude-sync

[English](README.md) · **简体中文**

一个 MCP 服务器，为 Claude Code 提供 **Git 同步的知识库**与**跨机器记忆**。
你的笔记、项目 `CLAUDE.md`、以及 Claude 自动写入的记忆会在笔记本、服务器、
虚拟机之间自动跟随你。

- **Git 后端**：知识、记忆、配置全部放在你私有的 GitHub 仓库里。任何写入
  都会有 30 秒防抖，之后自动推送；启动时自动拉取最新。
- **跨机器记忆**：`~/.claude/projects/*/memory/` 会被符号链接到
  `vault/memory/{project}/`，让 `MEMORY.md` 和项目 `CLAUDE.md` 到处同步。
- **九个工具**：读、列出、搜索、创建、追加、局部修改、删除 vault 里的
  markdown 文件，外加一个服务器状态探针。
- **纯文件系统**：不需要外部编辑器或 sidecar 进程。服务器直接读写磁盘文件。

## 架构

```
claude-sync（本仓库，开源）                my-vault（你的私有 GitHub 仓库）
├── src/server.ts                        ├── knowledge/   ← markdown 知识文件
├── src/git-sync.ts                      ├── memory/      ← Claude 记忆
├── src/tools.ts                         ├── config/      ← CLAUDE.md
└── scripts/init.js                      └── mapping.example.json
         │                                        │
         └──── claude-sync-init --vault ──────────┘
                       ↓
         ~/.knowledge-vault/  （私有 vault 的本地克隆 + .claude-sync/ 运行时）
         ├── knowledge/       ← MCP 服务器从这里读
         ├── memory/          ← 符号链接到 ~/.claude/projects/*/memory/
         ├── config/          ← 符号链接到 ~/.claude/CLAUDE.md
         ├── mapping.json     ← 本机特定的路径映射（gitignored）
         └── .claude-sync/    ← 指向已安装 claude-sync 的符号链接
```

## 工具

九个工具：

| 工具 | 作用 |
|------|------|
| `get_vault_file` | 读取一个文件（可选以 JSON 形式返回并解析 frontmatter） |
| `list_vault_files` | 递归列出 vault 或某子目录下的所有文件 |
| `search_vault_smart` | 基于 flexsearch 的全文搜索，支持目录过滤 |
| `search_vault_simple` | 字面字符串匹配，带上下文 |
| `create_vault_file` | 创建或覆盖一个文件 |
| `append_to_vault_file` | 向文件末尾追加内容 |
| `patch_vault_file` | 在标题、block 引用或 frontmatter 字段处局部修改内容 |
| `delete_vault_file` | 删除文件 |
| `get_server_info` | 返回版本和同步状态（lastSync、HEAD、dirty 标志） |

### `patch_vault_file` 的定位方式

| `targetType` | `target` | 用途 |
|--------------|----------|------|
| `frontmatter` | 字段名（如 `status`） | 修改 YAML frontmatter 字段。`append`/`prepend` 对数组字段有效。`contentType: application/json` 会把内容当 JSON 解析后再赋值。 |
| `heading` | 标题路径（如 `"Section::Subsection"`） | 定位到 Markdown 的某个章节，用 `::` 分隔。`append`/`prepend` 在章节内部追加；`replace` 替换整个章节（含子章节）。 |
| `block` | Block 引用 ID（如 `^abc` 或 `abc`） | 定位到包含 `^id` 的段落。 |

## 安装与配置

**前置依赖**：`git`、`node` ≥ 18，以及[`gh`](https://cli.github.com) 并且已
登录 GitHub（`init.js` 在 vault 仓库不存在时需要用它自动创建）。如果你想
自己手动建私有仓库，可以跳过这步。

### 1. 安装 claude-sync

```bash
git clone https://github.com/MisterRaindrop/claude_sync.git
cd claude_sync
npm install
npm run build
```

### 2. 配置 vault URL

三选一：

**a) `.env` 文件（跨 shell 持久）：**

```bash
cp .env.example .env
# 然后编辑 .env，把 CLAUDE_SYNC_VAULT 设成 git@github.com:你/my-vault.git
```

**b) 环境变量：**

```bash
export CLAUDE_SYNC_VAULT=git@github.com:你/my-vault.git
```

**c) 命令行参数**：直接给 `init.js` 传 `--vault <url>`（见下）。

优先级：CLI flag > 导出的环境变量 > `.env` 文件。

### 3. 跑 init（一条命令）

```bash
node scripts/init.js
```

脚本是幂等的——重跑不会出问题。

它做了什么：

1. 如果 GitHub 上没有这个仓库，用 `gh repo create --private` 建一个
2. 克隆到 `~/.knowledge-vault/`
3. 如果克隆下来是空的，初始化目录骨架（`knowledge/`、`memory/`、
   `config/projects/`、`.gitignore`、`mapping.example.json`），**并把你现有
   的 `~/.claude/projects/*/memory/` 内容迁移进 `memory/<project>/`**，
   然后 commit + push
4. 如果 `dist/` 不存在，先构建 claude-sync，然后把它符号链接到
   `~/.knowledge-vault/.claude-sync/`
5. 扫描 `~/.claude/projects/` 生成 `mapping.json`，并建立从 `~/.claude/`
   到 vault 的符号链接
6. 在 `~/.claude.json` 的 `mcpServers["claude-sync"]` 下注册 MCP 服务器
   （`mcpServers` 里其他条目不动）

需要的话编辑 `~/.knowledge-vault/mapping.json` 增减或改名项目映射，然后重启
Claude Code。

验证：

```bash
claude mcp list
# claude-sync 应该显示 Connected
```

### 用命令行参数替代

```bash
node scripts/init.js --vault git@github.com:你/my-vault.git
node scripts/init.js --env-file /path/to/custom.env
```

### 从旧版本升级

如果你之前把 claude-sync 注册在旧名字 `obsidian` 下，`~/.claude.json` 里还
有一条指向 `dist/server.js` 的 `obsidian` 条目。不需要的话自己手动删掉
即可——新脚本只写 `mcpServers["claude-sync"]`，不会去动其他 key。

## 手动运行（不用 init）

```bash
VAULT_PATH=/path/to/vault/knowledge node dist/server.js
```

`VAULT_PATH` 必须指向 vault 下的 `knowledge/` 子目录（markdown 文件所在
地）。Git 操作在它的父目录（vault 仓根）执行，所以 `memory/` 和 `config/`
也会一起同步。

## 同步行为

- **写入**：文件发生变更 → `dirty=true`，重置 30 秒防抖计时器。
- **空闲 30 秒**：`git add -A && git commit && git pull --rebase && git push`。
- **Rebase 冲突**：`git rebase --abort && git pull -X theirs && git push`
  （后写胜出，简单可预期）。
- **启动时**：自动 commit 任何未提交的改动，然后 `git pull --rebase`。
- **关闭时**（SIGTERM/SIGINT）：在退出前 flush 尚未同步的改动。

## 开发

```bash
npm install
npm run build          # 编译 TypeScript → dist/
npm test               # 跑单元测试（patch.ts：15 条）
npm run dev            # 用 tsx 跑 server（需设置 VAULT_PATH）
```

用 MCP inspector 调试：

```bash
VAULT_PATH=/tmp/test-vault/knowledge \
  npx @modelcontextprotocol/inspector node dist/server.js
```

## 许可

MIT
