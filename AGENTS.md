# AGENTS.md

灵枢 — 本地桌面 AI 助手（monorepo: electron 桌面 + Fastify 后端 + Python sidecar + shared-types）。

## Setup commands

- Install deps: `npm install`（workspaces 自动装所有子包）
- Start dev: 双击 `start.bat`（一键启 backend + Electron；Windows）
- Run backend only: `npm --workspace backend run dev`
- Run electron only: `npm --workspace electron run dev`
- Run soul (optional Python sidecar): `cd soul && .venv/Scripts/python.exe -m soul.api`
- Build Electron: `npm --workspace electron run package:win`

## Test & quality

- Test backend: `npm --workspace backend test` （Vitest；基线数字见 docs/project-state.md）
- Test electron: `npm --workspace electron test` （Vitest + jsdom，main + renderer）
- Test soul: `cd soul && .venv/Scripts/python.exe -m pytest`（pytest，45 测试基线）
- Typecheck backend: `npm --workspace backend exec tsc --noEmit`
- Typecheck electron: `npm --workspace electron exec tsc --noEmit`
- Lint Python: `cd soul && .venv/Scripts/python.exe -m ruff check .`
- Full verify: `npm run verify`（typecheck + lint + test）

## Project layout

- `packages/shared-types/` — 跨包共享 TypeScript 类型（`@lingshu/shared-types`，含 SSE 契约）
- `backend/` — Fastify 后端（Node + TS），HTTP 路由在 `backend/src/routes/`
- `electron/` — Electron 桌面（main + preload + renderer/mvp React 组件树）
- `soul/` — Python sidecar（pytest，可选）
- `docs/` — 文档（`project-state.md` 是唯一权威状态）
- `scripts/` — 工具脚本
- `start.bat` — Windows 一键启动脚本（backend + electron dev）

## Code style

- TypeScript strict mode（各包 `tsconfig.json`）
- 后端 ESM + `.js` 后缀 import；前端 Vite + 不带 `.js` 后缀
- CSS Modules（`*.module.css`），不用 Tailwind，不用 emoji 当 UI 元素
- 单一强调色（`#2563eb` 蓝），暗色背景（`#0e0e10`）
- 中文优先 UI 文字，英文代码注释

## Testing instructions

- 每个 Task 必须有 Vitest 测试，**先写失败测试再写实现**（TDD）
- 跑测试必须在改完代码后立刻跑 — 不许"先 commit 等 CI"
- 跑 `npm run verify` 在 commit 前
- 端到端验证用 Playwright（已配 `mcp__plugin_playwright_playwright`），不靠"我觉得应该可以"

## PR & commit conventions

- 主分支: `main`
- 永远不直接 push main（用 feature branch）
- Commit message: conventional commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`）
- 允许 squash merge 简化历史
- Push token 已存 gh keyring + manager fallback（CLAUDE.md 安全规则），不要问 push 流程

## Security

- 永远不 commit secrets — `.env` 在 `.gitignore`
- GitHub PAT 等长寿命 token 走 OS 加密 store（gh keyring），不入 git / 不入 dotenv / 不入对话
- 删除 / 强制推送 / 切主分支仍需用户确认
- `git push` 已配免认证（CLAUDE.md 规则）
- 可以装软件/插件/MCP，但需用户确认
- 危险命令（`rm -rf` / `format` / `diskpart` 等）需用户确认

## Project-specific rules

- **共享类型**：跨进程/跨包类型走 `@lingshu/shared-types`（含 SSE 契约 `chat-stream.ts`），加聊天事件只改这一处
- **产品定位**：一个完整的本地 AI 助手 v0.2（聊天 + 文件/命令/记忆工具 + 智能体底座），不做主动/多 agent/插件市场
- **第一原则**（用户原话）：最快速度开发不要怕消耗，保证产品质量
- **端到端验证必做**：测完代码 + 测完测试后，必须用 Playwright 或 curl 真实跑一遍,**不许说"应该可以"**
