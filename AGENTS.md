# Piclaw 项目指南

## 项目概览

**piclaw** 是 [pi](https://github.com/Baiyongxiao/pi)（编码智能体 CLI）和 **pi-web**（Web 界面）的融合项目。核心产品 `pi` 是一个终端交互式 AI 编码助手，具备读写文件、执行命令、会话管理等能力。

## 包结构

| 包 | 路径 | 类型 | 说明 |
|----|------|------|------|
| `@piclaw/coding-agent` | `packages/coding-agent` | CLI | 主入口 `pi`，TUI 交互模式、会话管理 |
| `@piclaw/agent-core` | `packages/agent` | 库 | Agent 运行时，工具调用和状态管理 |
| `@piclaw/ai` | `packages/ai` | 库 | 统一多提供商 LLM API（OpenAI、Anthropic、Google 等） |
| `@piclaw/orchestrator` | `packages/orchestrator` | 守护进程 | 后台管理多个 pi 实例（实验性） |
| `@piclaw/tui` | `packages/tui` | 库 | 终端 UI 组件库（Editor、Markdown 渲染等） |
| `web` | `web` | Next.js | Web 界面 |

## 开发命令

```bash
npm install                    # 安装依赖（workspace 模式）
npm run build                  # 构建所有包
npm run dev                    # 启动 Web 开发服务器（端口 3030）
```

每个包有独立的构建/测试命令，在对应 `packages/*/` 目录下运行。

## 技术栈

- **运行时**: Node.js >= 22.19.0, Bun（用于编译二进制）
- **语言**: TypeScript（严格模式）
- **构建**: `tsgo`（内部构建工具），tsc 类型检查
- **格式化和 Lint**: Biome（tab 缩进 3 空格，行宽 120）
- **数据库**: better-sqlite3（WAL 模式）
- **测试**: Vitest
- **发布**: npm workspaces，包名 `@piclaw/*`

## 编码约定

### TypeScript

- 使用 ES 模块（`type: "module"`，`.ts` 扩展名）
- 所有导入使用完整 `.ts` 扩展名：`import { x } from "./foo.ts"`
- `noNonNullAssertion` 关闭，允许 `!` 断言
- `noExplicitAny` 关闭，允许 `any` 类型
- 优先使用 `const` 而非 `let`
- 优先使用 `interface` 而非 `type`（对象类型）
- 异步函数使用 `async/await`，避免裸 `.then()`

### 错误处理

- 业务异常使用自定义 Error 子类（如 `MissingSessionCwdError`）
- 资源加载失败不应崩溃，应收集 diagnostics 返回给调用层
- 外部输入验证不通过应抛出明确错误信息

### 状态管理

- Agent 状态通过 `AgentSession` 统一管理
- Session 持久化通过 `SqliteStore` 接口抽象
- 扩展系统通过事件总线（`EventBus`）+ Runner 模式驱动
- 跨连接共享使用单例（如 `SqliteStore.getDefault()`）


## 架构原则

1. **分层清晰**：CLI -> AgentRuntime -> AgentSession -> Services（SettingsManager、ResourceLoader 等）
2. **扩展优先**：功能优先通过扩展机制实现，而非直接修改核心
3. **诊断收集**：非致命错误通过 `Diagnostic[]` 返回，不直接 `console.error`
4. **Session 即树**：每次对话是一棵树，`/fork` 创建分支，`/tree` 导航分支
5. **多 Provider**：LLM 提供商通过 `@piclaw/ai` 统一抽象，可热插拔
