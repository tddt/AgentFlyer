# AgentFlyer — 开发规则（AGENTS.md）

> 所有参与 AgentFlyer 开发的 AI / 人类工程师必须遵守本文档。

---

## 一、项目简介

AgentFlyer 是一个**去中心化、跨平台、多主机联邦**的 AI Agent 框架。
目标：比 OpenClaw 更轻量、更快、更省 Token、支持多主机协作。

- 设计文档：`docs/01-05`（阅读后再编码）
- 代码根目录：`src/`
- 测试根目录：`tests/`
- 运行时数据：`~/.agentflyer/`

---

## 二、运行时 & 包管理

- **主运行时**：Bun ≥ 1.2（`bun run src/cli/main.ts`）
- **Node 兼容**：Node.js ≥ 22（`node --import tsx src/cli/main.ts`）
- **包管理器**：pnpm（保持 `pnpm-lock.yaml` 同步）
- **语言**：TypeScript 5.x strict + ESM（`.ts` 文件直接运行，import 带 `.js` 扩展）
- **模块格式**：ESM only，`type: "module"` in package.json

---

## 三、目录与模块层次

依赖方向：**下层不得依赖上层**

```
core/           ← 无内部依赖
skills/         ← 只依赖 core/
memory/         ← 只依赖 core/
agent/          ← 依赖 core/, skills/, memory/
mesh/           ← 依赖 agent/ 接口, core/
federation/     ← 依赖 mesh/, memory/, core/
channels/       ← 依赖 core/, agent/ 接口
gateway/        ← 顶层，依赖所有
scheduler/      ← 依赖 core/, agent/ 接口
cli/            ← 通过 RPC 调用 gateway 或直接创建 Gateway 实例
```

**违反依赖方向的 PR 一律拒绝。**

---

## 四、代码规范

### 4.1 TypeScript
- strict 模式，禁止 `any`，禁止 `@ts-nocheck`
- 所有函数必须有明确的返回类型（除显然的 arrow fn）
- 用 `import type { X }` 做纯类型导入
- 相对路径导入必须带 `.js` 扩展（e.g. `import { x } from './types.js'`）
- 禁止 `require()`（ESM only）

### 4.2 命名
- 文件名：`kebab-case.ts`
- 类：`PascalCase`
- 函数/变量：`camelCase`
- 常量（全局不变值）：`SCREAMING_SNAKE_CASE`
- 类型/接口：`PascalCase`
- Branded type：`type Foo = string & { readonly _brand: 'Foo' }`

### 4.3 文件大小
- 单文件 ≤ 500 LOC（超出时拆分，提取 helpers）
- 禁止"V2"副本，直接重构原文件

### 4.4 注释
- 只为非显然逻辑添加注释
- 禁止空 JSDoc / 无意义注释
- 关键权衡决策用 `// RATIONALE:` 注释说明

---

## 五、Bun / Node 兼容

所有 Bun 专用 API 调用必须写在 `src/core/runtime-compat.ts` 的 shim 后面：

| Bun API | Node.js 替代 |
|---------|-------------|
| `Bun.serve()` | `node:http` / fastify（见 gateway/server.ts）|
| `Bun.sqlite` | `better-sqlite3` |
| `Bun.file()` | `node:fs/promises` |
| `Bun.CryptoHasher` | `node:crypto` createHash |

---

## 六、安全规则

- **bash 工具**：默认需要用户审批；配置了例外列表的命令才自动执行
- **文件系统访问**：只限 workspace 目录内（经 `path.resolve()` 校验）
- **API Key**：只存 `~/.agentflyer/credentials/*.enc`（AES-256-GCM 加密），禁止明文落盘
- **Gateway 认证**：所有 RPC 接口强制 Bearer token
- **CORS**：只允许 localhost / 受控白名单
- **联邦通信**：所有消息签名（Ed25519）+ 可选加密（AES-GCM）
- 禁止在代码、注释、测试中硬编码真实 API Key / 密码 / 手机号

---

## 七、测试规范

- 框架：Vitest + V8 coverage
- 覆盖率目标：lines/branches/functions/statements ≥ 70%
- 测试文件：与源文件同目录（`foo.ts` → `foo.test.ts`）或 `tests/unit/`
- E2E 测试：`tests/e2e/`
- 集成测试：`tests/integration/`
- Mock LLM：用 `msw@2`，不调真实 API（CI 中）
- 不允许修改 `node_modules`

---

## 八、开发命令

```bash
# 安装依赖
pnpm install

# 开发运行（Bun）
pnpm dev start          # 启动 gateway
pnpm dev chat           # CLI 对话

# 类型检查
pnpm typecheck

# 代码质量
pnpm check             # lint + format 检查
pnpm check:fix         # 自动修复

# 测试
pnpm test              # 全量测试
pnpm test:coverage     # 覆盖率报告
pnpm test:watch        # 监视模式

# 构建（输出 dist/）
pnpm build
```

---

## 九、提交规范

- Conventional Commits 格式：`type(scope): message`
- type：`feat` / `fix` / `refactor` / `test` / `docs` / `chore`
- scope：模块名，如 `core` / `agent/runner` / `gateway` / `cli`
- 提交前必须通过：`pnpm typecheck && pnpm check && pnpm test`

---

## 十、Phase 开发状态

| Phase | 模块 | 状态 |
|-------|------|------|
| 0 | 项目骨架 | ✅ 完成 |
| 1 | `core/` | 🚧 进行中 |
| 2 | `skills/` | 🚧 进行中 |
| 3 | `memory/` | 🚧 进行中 |
| 4 | `agent/` | 🚧 进行中 |
| 5 | `mesh/` | 🚧 进行中 |
| 6 | `channels/` | 🚧 进行中 |
| 7 | `gateway/` | 🚧 进行中 |
| 8 | `scheduler/` | 🚧 进行中 |
| 9 | `cli/` | 🚧 进行中 |
| F | `federation/` | 📋 接口预留，Phase 2 实现 |

---

*更新：2026-03-15*
