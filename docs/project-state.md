# 灵枢 — 项目当前状态

> 本文件是灵枢的**唯一权威状态**。新会话第一件事读这个。
> 最后更新: 2026-07-18(融合焕新:合体为一个 v0.2,清过期文档 + 统一叙述)

---

## 灵枢是什么

一个跑在本地的桌面 AI 助手(Electron + React 前端 / Fastify 后端 / 可选 Python 侧车)。
一个完整的 v0.2,不再有"MVP vs V6 两套"的历史包袱——就是一个灵枢。

**核心能力**:
- **聊天**:统一通道 `POST /chat/stream`,4 provider(DeepSeek/OpenAI/Anthropic/Ollama)+ SSE 流式 + 真 LLM。底层 `models/registry.streamChat()`,已内建工具调用转发 / 用量记账 / 中断 / 心跳。
- **文件工具**:`/api/files/{list,read,write,search}` + 沙箱守卫 + 写权限确认(后端就绪)。
- **命令工具**:`/api/commands/run` + 危险命令黑名单 + 权限确认 + 超时(后端就绪)。
- **长期记忆**:`/api/memory/{recall,store}` + SQLite(后端就绪)。
- **设置**:`/api/settings` CRUD + 前端 SettingsModal + ⚙ 按钮,改 key/模型/目录/权限不碰 .env。
- **智能体底座**:`agent/main-loop`(自主循环)、`tools/`、`mcp/`、`skills/`、`reflect/`、`plan/` 等模块随后端启动并 wire,是拓展能力的地基(工具尚未在聊天流触发,见下方拓展路线)。

**没配 API key 时**:诚实提示去设置填 key,不假装回复(SSE `error` 事件)。

---

## 架构(前后端一条链)

```
前端 useChat ──► POST /chat/stream ──► createChatStreamRoute ──► streamChat() ──► 4 provider
  (electron       (统一聊天通道)         (routes/chat-stream.ts)   (models/registry)
   renderer/mvp)                          │
   解析 SSE 契约 ◄──────────────────────── 写 message_start/text_delta/
   (ChatStreamEvent)                        usage/tool_call/message_finish/error
```

- **SSE 契约唯一真相源**:`packages/shared-types/src/chat-stream.ts`(`ChatStreamEvent`)。前端解析、后端写出都按它。加新事件只改这一处。
- **ws `/ws` 通道**:供 agent 主循环(main-loop)广播用,与聊天通道并存。

## 关键架构决定

1. **一条聊天通道** — 前端只走 `/chat/stream`,旧 `/api/chat` 已删。
2. **CSS Modules,不用 Tailwind** — 历史教训:tailwind 编译失败导致整批 UI 废弃。
3. **智能体能力是 v0.2 主体** — main-loop/tools/mcp/skills 不是死代码,是拓展地基。
4. **provider 命名统一 `'anthropic'`** — 不用 `'claude'`。
5. **soul Python 侧车** — 记忆/灵魂扩展点,可选,聊天主线不依赖。

---

## 测试基线(实测 2026-07-18 融合焕新后)

| 项 | 命令 | 状态 |
|---|---|---|
| Backend vitest | `cd backend && npx vitest run` | **94 文件 / 877 测试 全绿** ✅ |
| Electron vitest | `cd electron && npx vitest run` | **8 文件 / 30 测试 全绿** ✅ |
| Root vitest (workspace) | `cd lingshu && npx vitest run` | **102 文件 / 907 测试 全绿** ✅ |
| Soul pytest | `cd soul && .venv/Scripts/python.exe -m pytest` | **45/45 全绿** ✅ |
| Backend `tsc --noEmit` | `npx tsc --noEmit -p backend/tsconfig.json` | **0 错** ✅ |
| Electron `tsc --noEmit` | `cd electron && npx tsc --noEmit -p tsconfig.json` | **0 错** ✅ |
| 端到端 | start.bat → 5173 聊天面板 → 真 LLM 流式回复 | ✅ |

> 焕新变动(2026-07-18):删 deprecated `/api/chat`(-8 测试,885→877 是预期正确下降);`routes/mvp/` 改名 `routes/`;删 29 个过期 V2/V6 文档;README/project-state 重写为"一个 v0.2"。

---

## v0.2 拓展路线(点亮智能体能力)

聊天通道已统一,新能力都往 `/chat/stream` 加。每项"要接哪根线":

| 能力 | 后端现状 | 接线点 |
|---|---|---|
| **AI 会用工具** | `tools/` + `mcp/` 就绪;`/chat/stream` 已转发 `tool_call` 事件;`llm/chat-handler.ts` 有带工具的 LLM 循环 | ① `chat-stream.ts` 的 `streamChat()` 调用带上 `tools/builtin`;② 前端 `useChat` switch 加 `case 'tool_call'`;③ 建 `CommandPermissionDialog` |
| **AI 有记忆** | `routes/memory.ts`(SQLite) + `reflect/`(反思提取)就绪 | ① 聊天后提取写 SQLite;② 聊天前 recall 注入 systemPrompt;③ 建 `MemoryPanel` |
| **用量/费用显示** | `/chat/stream` 已发 `usage` 事件 + `session/registry.ts` 记账 | ① 前端 `useChat` switch 加 `case 'usage'`;② `ChatPanel` 显示费用条(providers.ts 有 `inputPricePer1k`) |
| **文件工具 UI** | `routes/files.ts` 4 端点 + 沙箱就绪 | 建 `FileToolPanel` 调 `/api/files/*` |
| **打包** | electron-builder.yml 太薄 | 配好出 Windows .exe installer |

**关键**:`ChatStreamEvent` 已预留 `tool_call`/`usage`/`awareness` variant,前端 switch 已有 `default` 忽略分支。点亮只需**加 case,不改结构**。

---

## 文件结构

```
D:/lingshu/lingshu/
├── packages/shared-types/       # 跨包共享类型 (@lingshu/shared-types, 含 chat-stream SSE 契约)
├── backend/src/
│   ├── routes/                  # chat-stream / files / commands / memory / settings / providers
│   ├── models/registry.ts       # 多模型统一抽象 (streamChat)
│   ├── providers/               # deepseek + errors + types
│   ├── db/ util/ permission/     # SQLite / id / 设置持久化
│   ├── agent/ tools/ mcp/ skills/ reflect/ plan/ uacs/ proactive/ ...  # 智能体能力模块
│   ├── llm/chat-handler.ts       # 带工具的 LLM 循环
│   └── server.ts                 # Fastify 启动
├── electron/src/
│   ├── main/                     # main.ts + preload + window-pool + ipc-router + skill handlers
│   └── renderer/mvp/             # ChatPanel/InputBar/MessageList/ModelSelector/SessionList/
│                                 #   SettingsModal/WelcomeBanner/useChat
├── soul/                         # Python 侧车 (可选)
├── docs/project-state.md        # ← 本文件, 唯一权威文档
├── AGENTS.md · README.md · project_memory.md
└── start.bat
```

---

## 启动命令(Windows)

```cmd
start.bat        # 一键启动 (backend + electron dev)

# 分开跑
npm --workspace backend run dev      # 后端 :3000
electron .                            # Electron 桌面

# soul 侧车 (可选)
cd soul && .venv/Scripts/python.exe -m soul.api
```

---

## 下一步(新会话第一件事)

1. 读本文件
2. 读 `~/.claude/projects/d--lingshu/memory/MEMORY.md`(项目级 memory 索引)
3. 跑全套测试确认基线(数字见上表)——**与上表不一致就自己实测自己改,禁靠记忆改数字**
4. 看用户要点亮哪个能力(工具/记忆/用量/文件 UI/打包),按"v0.2 拓展路线"接线
