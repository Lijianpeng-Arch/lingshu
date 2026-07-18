# 灵枢 — 项目记忆索引

> 轻量索引。**详细权威状态在 [`docs/project-state.md`](docs/project-state.md)**,先读那个。
> 最后更新: 2026-07-18(融合焕新:合体为一个 v0.2)

---

## 必读文件

- **权威状态**: [`docs/project-state.md`](docs/project-state.md)（能力清单 + 架构 + 测试基线 + v0.2 拓展路线,唯一真相源）
- **项目级长期记忆**: `~/.claude/projects/d--lingshu/memory/MEMORY.md`

## 启动 / 测试 / GitHub

- 启动、测试命令、基线数字 → 见 `docs/project-state.md`(唯一真相源,禁在此复制数字以免漂移)
- GitHub push 免认证已配好(token 存 gh keyring + manager fallback),**不要再问 push 流程**。远端: https://github.com/Lijianpeng-Arch/lingshu

## 设计基调

- 主色 `#2563eb` 蓝 · 暗背景 `#0e0e10` · 单色调 · 无 Tailwind(纯 CSS Modules)· 不用 emoji 当 UI 元素

## 最近大改动

- **2026-07-18 融合焕新** — 合体为一个 v0.2:聊天通道统一 `/chat/stream`、删 deprecated `/api/chat`、`routes/mvp/`→`routes/`、删 29 个过期 V2/V6 文档、README/project-state 重写。详见 `docs/project-state.md` 焕新变动。
