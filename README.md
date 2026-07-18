# 灵枢 (Lingshu)

> 本地桌面 AI 助手 —— 能聊天、能读写文件、能跑命令、有长期记忆,数据全在你自己电脑上。

灵枢是一个跑在你自己电脑上的 AI 助手:跟 4 个大模型(DeepSeek / OpenAI / Anthropic / Ollama 本地)聊天,
让 AI 帮你读写本地文件(沙箱守卫 + 写操作要你确认),帮你跑命令(危险命令黑名单 + 执行要你确认),
并记住你聊过的内容(长期记忆)。中文优先,小白可用,Windows 双击即启动。

**没配 API key 时**:灵枢会诚实提示你去设置里填 key,不会假装回复。

---

## 能力现状

| 能力 | 情况 |
|---|---|
| 一键启动 | 双击 `start.bat` |
| 聊天 | 统一通道 `/chat/stream`,4 provider 切换 + SSE 流式回复,接真 LLM ✅ |
| 文件工具 | list/read/write/search + 沙箱守卫 + 写权限确认(后端就绪,前端 UI 待建) |
| 命令工具 | run command + 危险命令黑名单 + 权限确认 + 超时(后端就绪,前端 UI 待建) |
| 长期记忆 | SQLite 检索(后端就绪,提取+前端待建) |
| 设置页 | 改 API key / 模型 / 工作目录 / 权限,不用碰 .env ✅ |

## 快速开始

**系统要求**:Windows 10/11 · Node.js 18+ ·（可选）Python 3.12+（仅跑 soul 侧车时需要）

```cmd
# 1. 装依赖
npm install

# 2. 配 API key —— 打开应用后点右上角 ⚙ 设置填,或改项目根 .env:
#    LINGSHU_DEEPSEEK_API_KEY=你的key

# 3. 启动
start.bat
```

启动后:后端 `http://127.0.0.1:3000`,Electron 窗口自动弹出聊天界面,首次启动自动建 `~/.lingshu/` 目录。

## 跑测试

```cmd
npm --workspace backend test      # 后端
npm --workspace electron test     # Electron (main + renderer)
npm test                          # 一键全部 (root workspace)

# TypeScript 检查
npm --workspace backend exec tsc --noEmit
npm --workspace electron exec tsc --noEmit
```

## 已实现 API（后端,前缀 `/`）

| 端点 | 用途 |
|---|---|
| `POST /chat/stream` | 统一聊天通道,SSE 流式(内建工具转发/用量/中断) |
| `GET /chat/stream/providers` | 可用 provider + 默认 |
| `GET /api/providers` | provider + 模型详细列表(前端选择器用) |
| `POST /api/files/{list,read,write,search}` | 文件工具(write 要 `confirmToken:"approved"`) |
| `GET /api/files/sandbox` | 沙箱根目录 |
| `POST /api/commands/run` | 跑命令(黑名单 + confirmToken) |
| `POST /api/memory/{recall,store}` | 记忆检索 / 写入 |
| `GET/PATCH /api/settings` + `POST /api/settings/test-key` | 设置 CRUD + 测 key |
| `GET /api/health` | 健康检查 |

## 项目结构

```
lingshu/
├── packages/shared-types/   # 跨包共享类型 (@lingshu/shared-types, 含 SSE 契约)
├── backend/                 # Fastify 后端
│   └── src/
│       ├── routes/          # HTTP 路由: chat-stream/files/commands/memory/settings/providers
│       ├── models/          # 多模型统一抽象 (streamChat)
│       ├── agent/ tools/ mcp/ skills/ reflect/ plan/ ...  # 智能体能力模块
│       └── server.ts        # Fastify 启动
├── electron/                # Electron 桌面
│   └── src/renderer/mvp/    # 聊天界面组件 (ChatPanel/useChat/...)
├── soul/                    # Python 侧车 (记忆/灵魂扩展,可选)
├── docs/project-state.md    # ← 项目权威状态,先读这个
└── start.bat                 # 启动脚本
```

## 文档

- [项目权威状态 docs/project-state.md](docs/project-state.md) —— 完整能力清单 + 拓展路线,**新会话先读这个**
