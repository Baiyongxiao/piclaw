# piclaw

**piclaw** 是 [pi](https://github.com/Baiyongxiao/pi)（编码智能体 CLI）和 [pi-web](https://github.com/Baiyongxiao/pi-web)（Web 界面）的融合项目。

## 项目来源

本项目由两个上游仓库合并而成：

| 上游项目 | 原始仓库 | 说明 |
|---------|---------|------|
| **pi** | [earendil-works/pi](https://github.com/earendil-works/pi) | 编码智能体核心，包含 CLI、AI 多提供商 API、Agent 运行时、TUI 组件、Orchestrator 守护进程 |
| **pi-web** | [agegr/pi-web](https://github.com/agegr/pi-web) | pi 的 Web 界面，基于 Next.js，支持会话浏览、对话、分支管理 |

包名已从 `@earendil-works/pi-*` 统一重命名为 `@piclaw/*`。

## 包结构

| 包 | 路径 | 说明 |
|----|------|------|
| **@piclaw/coding-agent** | `packages/coding-agent` | 交互式编码智能体 CLI（入口：`pi`） |
| **@piclaw/agent-core** | `packages/agent` | Agent 运行时，工具调用和状态管理 |
| **@piclaw/ai** | `packages/ai` | 统一多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| **@piclaw/orchestrator** | `packages/orchestrator` | 后台守护进程，管理多个 pi 实例（实验性） |
| **@piclaw/tui** | `packages/tui` | 终端 UI 组件库 |
| **web** | `web` | Next.js Web 界面 |

## 快速开始

### 安装依赖

```bash
npm install
```

### 启动 Web 开发服务器

```bash
npm run dev
```

### 构建所有包

```bash
npm run build
```

### 生产启动

```bash
# 构建 Web 生产版本
npm run build:web

# 启动生产服务器（默认端口 30142）
npm run start
```
