<!--
这份报告是 Open Whale 开发期间的内部调研产物，原样发布以便读者复核结论。
为保护隐私，文中本机绝对路径与本地账户名已替换为占位符（<local-path> / <user> / %DSH_INSTALL%）；
除此之外内容未做修改，包括「已验证 / 推断 / 未找到」的标注。

原始文件名：DSH-CORE-API.md
-->
# DeepSeek Harness (DSH) 内部插件 API 调研报告

- 目标版本：DSH **44.0.0**（`%DSH_INSTALL%`）
- 核心包位置：`%DSH_INSTALL%\resources\app.asar`，内部路径形如 `/dsh/node_modules/@deepseek-ai/<pkg>/...`
- 调研方式：**只读**。所有结论尽量给出「文件路径 + 关键代码行原文」。
- 标记约定：
  - **【已验证】** = 我在源码 / 官方 README / 运行时 Inspector 中直接读到该结论。
  - **【推断】** = 由已验证事实推导，未直接读到对应声明。
  - **【未找到】** = 没有找到，不臆造。

## 0. 本次调研最重要的方法论发现（影响所有结论的可信度）

DSH asar 内**没有 `.d.ts`**（`list "\.d\.ts$"` → 0 命中），`lib/types/*.js` 是**类型被剥除后的空模块**，例如：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.js
/**
 * Public agent types and live-runtime events. ...
 * @module @deepseek-ai/dsh-agent
 */
export {};
```

因此有三条互补的权威来源，本报告交叉使用：

| 来源 | 位置 | 性质 |
|---|---|---|
| **Typert 生成的 API 目录** | `/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`（8188 行） | 含精确 TS 声明字符串 |
| **各包的 typert schema 包** | `/dsh/node_modules/@deepseek-ai/<pkg>/lib/typert.host.js` | 同上，按包切分，**比 api-catalog 更全** |
| **运行时 Inspector** | `cordis_inspect_query`（platform=host, provider=Service/Event/Config） | 实时投影，最快的确认手段 |

> ⚠️ **关键告警（已验证）**：这些投影是**有体积预算的、会静默丢字段**的。
> 证据 1：`api-catalog.js` 中 `SessionEventMap` 与 `SessionHeader` 声明里被硬编码插入 `/* …truncated — full shape in source */`（全文出现 3 次）。
> 证据 2：`api-catalog.js:4512` 声明 `AssembleContext { scope?; signal? }`，但源码证明实际含 `agent`：
> ```
> 证据: /dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:291
> function assembleContextFor(agent, signal) {
> 	return {
> 		agent,
> 		scope: agent,
> 		...signal === void 0 ? {} : { signal }
> 	};
> }
> ```
> **结论：任何单次 Inspector / catalog 读取都必须用源码交叉验证，尤其是字段是否齐全。** 本报告凡涉及"字段是否齐全"的地方都以源码为准。

另一条主证据线：**包 README 极其详尽且权威**（`/<pkg>/README.md`），例如 `dsh-agent/README.md` 直接给出了 `followup/steer/inject/cancel/whenIdle` 的语义与作用域规则。

---

## 1. 创建并驱动一个 DSH agent

### 1.1 `ctx.agents.create()` 与 `CreateAgentOptions` 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js（声明 CreateAgentOptions）
证据: cordis_inspect_query(platform=host, provider=Service, service="agents")
export interface CreateAgentOptions {
    readonly sessionId: SessionId;
    readonly parentAgent?: Agent;
    readonly meta?: {
        readonly cwd?: string;
        readonly parentSession?: SessionId;
        readonly isSeeded?: boolean;
        readonly origin?: 'subagent';
        readonly delegationDepth?: number;
        readonly agentPreset?: string;
    };
    readonly inheritedEventCount?: SessionLogOffset;
    readonly seed?: readonly SessionEvent[];
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
}
```

服务方法签名：

```
证据: cordis_inspect_query(service="agents")
async create(options: CreateAgentOptions): Promise<AgentHandle>
async resume(options: ResumeAgentOptions): Promise<AgentHandle>
```

**逐字段说明（全部已验证）**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `sessionId` | ✅ | **没有默认值，必须由调用方提供** |
| `parentAgent` | ❌ | 给了就是运行时子 agent；不给就是运行时根（top-level root）。与持久化的 `parentSession` 血缘无关 |
| `meta.cwd` | ❌ | 新会话的工作目录。**注意：`cwd` 在 `meta` 里，不在顶层** |
| `meta.parentSession` / `isSeeded` / `origin` / `delegationDepth` / `agentPreset` | ❌ | 写进 `SessionHeader`（持久化血缘/委派元数据） |
| `inheritedEventCount` / `seed` | ❌ | 会话日志种子 |
| `agentOptions` | ❌ | provider/model/reasoningEffort/maxTokens |
| `signal` | ❌ | 取消创建 |
| `setup` | ❌ | 发布前组合该 agent 的 scope（见 1.4） |

> **`CreateAgentOptions` 里没有 `name` 字段。** 没有找到任何 agent「名字」入参。

### 1.2 sessionId 怎么给？能否自己生成？——**可以自己生成** 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-session/lib/types/types.js:1-9
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand';
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string with the session-id brand.
 */
export function SessionId(id) {
    return brandString(id);
}
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-brand/lib/index.js
/**
 * Apply a compile-time string brand without changing the value.
 */
function brandString(value) {
	return value;
}
```

即 **brand 是纯编译期的，运行时就是原字符串**（`brandString(v) === v`），所以任意字符串都能当 SessionId。

真实调用方的做法（**这正是你要的最小范式**）：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js:313
const sessionId = brandString(config.sessionId ?? `session-${randomUUID()}`);
```

**【推断】** sessionId 的字符集/长度没有校验（没找到校验代码）；但建议只用一个 `[A-Za-z0-9._-]` 前缀 + UUID，避免下游当文件名/路由参数时出问题。

### 1.3 `AgentHandle` 上到底有什么？——**注意：只有两个成员** 【已验证】

```
证据: cordis_inspect_query(service="agents") → referencedTypes.AgentHandle
export interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
}
```

> ❗ **重要纠正**：`followup` / `steer` / `inject` / `cancel` / `whenIdle` **不在 `AgentHandle` 上**，而在 `handle.agent` 上。
> `AgentHandle` 是「唯一能拆掉这个 agent 的能力凭证」。
> 证据: `/dsh/node_modules/@deepseek-ai/dsh-agent/README.md`
> > "Both delegate to the registered factory and return an `AgentHandle` — **the only object that can tear that agent down**."
> > `await handle.dispose()   // stops the loop, unregisters, removes the session, unwinds the scope`

### 1.4 `AgentOptions` / `AgentSetup` 【已验证】

```
证据: cordis_inspect_query(service="agents")
export interface AgentOptions {
    provider?: string;
    model?: string;
    reasoningEffort?: ReasoningEffortId;
    maxTokens?: number;
}

export type AgentSetup = (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void;

export interface AgentSetupCommit {
    commit(): void;
}
```

> 注意：`AgentOptions` **没有 `temperature`**。`temperature` 只存在于 `LlmCallConfig`（在 `agent/request` waterfall 里改）。
> `reasoningEffort` 是 branded string，**具体合法值未找到**（见第 9 节）。

`setup` 语义（README 原文，已验证）：

> "An optional `setup(agentCtx, agent)` callback composes the agent's scoped world before it is published: **`agentCtx` owns registrations, while the explicit unpublished Agent provides its Session; the Context has no reverse Agent property.** Scoped tools, prompt sections, and listeners exist before any creation announcement. **Setup is composition-only: drive the agent only after creation resolves.**"

### 1.5 `Agent` 的完整表面（从具体实现类枚举）【已验证 + 部分推断】

`Agent` 接口的**完整声明拿不到**（类型被剥除），但可以从具体类 `ReactLoopAgent`（即 factory 产物）读出实例成员：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:747-789
var ReactLoopAgent = class {
	loopCtx;
	id;
	options;
	session;
	inbox;
	phase;
	activityDone = Promise.resolve();
	/** The agent-scoped registration boundary; ... */
	scope;
	ctx;
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:790, 806-821, 870
	get status() { return this.phase.kind === "idle" || this.phase.kind === "maintenance" ? "idle" : "running"; }
	followup(input) { this.send(input, "next-turn", true); }
	steer(input)    { this.send(input, "next-step", true); }
	inject(input)   { this.send(input, "next-step", false); }
	cancel(cause, options = {}) {
		if (!options.keepInbox) { this.inbox.clear(); ... }
		if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
	}
	async whenIdle() { ... }
```

| 成员 | 契约 | 状态 |
|---|---|---|
| `id: SessionId` | 与 SessionId 同一个值 | 【已验证】 |
| `session` | Session 对象，`session.header`、`session.seq` 可用 | 【已验证】`dsh-headless:322-324` |
| `ctx: Context` | **agent 级 scoped context**（注册只影响本 agent，dispose 时回卷） | 【已验证】README + `index.js:757,779` |
| `inbox` | 结构化 `Inbox`：`nextTurn`/`nextStep`/`hasPending`/`append`/`prepend`/`replace`/`remove`/`clear`/`splice` | 【已验证】README + `index.js:70-208` |
| `status` | `'idle' \| 'running'` | 【已验证】`index.js:790` |
| `followup(input)` → `void` | 排入 **next-turn** 并唤醒 driver | 【已验证】 |
| `steer(input)` → `void` | 排入 **next-step** 并唤醒 driver | 【已验证】 |
| `inject(input)` → `void` | 排入 next-step，**不唤醒** | 【已验证】 |
| `cancel(cause, {keepInbox?})` | 中止当前活动；默认清空 inbox | 【已验证】 |
| `whenIdle(): Promise<void>` | 等到整个 agent 静默 | 【已验证】 |
| `runMaintenance(job)` | 内部：空闲时串行维护任务 | 【推断】非公开 |

`AgentCancelCause`：

```
证据: cordis_inspect_query(service="agents")
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' };
```

### 1.6 前置条件与生命周期陷阱 【已验证】

1. **必须先有 factory**：`ctx.agents.create()` 委托给注册的 AgentFactory；没有就 reject。
   ```
   证据: /dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:307
   const NO_FACTORY_MESSAGE = "no agent factory registered (load an agent-loop plugin)";
   ```
   即组成里必须同时挂 `@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-agent-loop`。
2. **创建期间不能 `whenIdle`**（README "Known Limitations"）：
   > "An `agent/created` listener **must not await `agent.whenIdle()`** or its own owner's disposal: those operations wait for creation to finish."
3. **`cancel()` 默认清空 inbox**；只中止当前 turn 用 `cancel(cause, { keepInbox: true })`。**没有「只中止一步但保留 turn」的 API。**
4. `ctx.agents.get(id)` 返回**裸 Agent**（不是 handle）；handle 只给创建者。

### 1.7 更低层的等价 API

```
证据: cordis_inspect_query(service="agentLoop")
async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent>
async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
```

`ctx.agentLoop.create(...)` 直接返回 `Agent`（无 handle）；一般场景用 `ctx.agents.create()`。

---

## 2. 发送用户消息

### 2.1 `Agent.followup(input)` 的入参形状 【已验证】

`input` 是一个 **`UserMessage`**（不是 `{content, source}` 以外的东西；`role` 由构造函数补）：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:800-808
	send(message, target, wakeup) {
		const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
		const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
		this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
		if (wakeup) this.wakeDriver(wakingAfterAbort);
	}
	followup(input) { this.send(input, "next-turn", true); }
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js
export interface MessageBase {
    readonly id: MessageId;
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
export interface UserMessage extends MessageBase {
    readonly role: 'user';
}
```

### 2.2 ❗`input` 必须带 `id`（**这是最容易踩的坑**）【已验证】

inbox 的重复检测按 `message.id` 做 key：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:189-194
		const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted);
		const ids = /* @__PURE__ */ new Set();
		for (const message of target === "next-turn" ? [...candidate, ...state["next-step"]] : [...candidate, ...state["next-turn"]]) {
			if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
			ids.add(message.id);
		}
```

之后 `this.session.append("agent/inbox/spliced", splice)` 会把消息写进**持久化日志**（会走 schema 校验）。
**所以不要手搓 `{content, source}`，一定用 `createUserMessage()` 生成带 `id` 的冻结消息。**

> ⚠️ `dsh-agent/README.md` 里的示例 `handle.agent.followup({ content: [...], source: {...} })` 是**省略了 `id` 的示意写法**；真实代码（`dsh-headless`、`dsh-acp`、`dsh-command-goal`、`dsh-goal-round-driver` 等 7+ 处）**全部用 `createUserMessage(...)`**。

### 2.3 `createUserMessage()` 精确签名与返回类型 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js
/**
 * Create one identified user-role message and freeze it before publication.
 * @param input - complete content and source for a new user message.
 * @returns an immutable user message with a fresh stable identity.
 */
export function createUserMessage(input) {
    return createMessage({
        ...input,
        role: 'user',
    });
}

/**
 * Create one identified message and freeze it before publication.
 * @param input - complete role, content, and source for a new message.
 * @returns an immutable message with a fresh stable identity.
 */
export function createMessage(input) {
    return deepFreeze(structuredClone({
        ...input,
        id: brandString(randomUUID()),
    }));
}
```

- 签名（**推断出的 TS 形式**，由实现 + `MessageBase` + `MessageSourceMap['user']` 合成）：
  ```ts
  function createUserMessage(input: {
    content: readonly ContentBlock[]
    source: { kind: 'user' }
  }): UserMessage
  ```
- **返回类型**：`UserMessage`（`role: 'user'`，带 `id: MessageId`，`deepFreeze` 冻结）。
- **副作用**：`id` 由 `randomUUID()` 生成；对象被 `structuredClone` + `deepFreeze` → **不可变，不能复用同一个实例喂两次**（第二次会因为重复 id 抛 `message "..." is already pending`）。
- `createUserMessage` 已确认是 `@deepseek-ai/dsh-llm` 的公开导出：
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js:2390 （export { ... createUserMessage, expandAssistantStream, AssistantStreamAccumulator, ... }）
  ```

### 2.4 `ContentBlock` 联合类型 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js
export type ContentBlock = ContentBlockMap[ContentBlockType];
export interface ContentBlockMap {
    text: TextBlock;
    reasoning: ReasoningBlock;
    image: ImageBlock;
    file: FileBlock;
    'tool-call': ToolCallBlock;
    'tool-addition': ToolAdditionBlock;
    'tool-removal': ToolRemovalBlock;
}
export interface TextBlock { type: 'text'; text: string; }
```

### 2.5 `MessageSourceMap`（**很大，且 README 里有个不存在的 kind**）

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js
export interface MessageSourceMap {
    user: { kind: 'user'; };
    model: ModelMessageSource;
    tool: ToolMessageSource;
    'system-prompt': SystemPromptMessageSource;
    'model-selection': { kind: 'model-selection'; } & ContextFormed;
    'user-approval': { kind: 'user-approval'; } & ContextFormed;
    'ptc-mode': { kind: 'ptc-mode'; };
    'tool-registry': { kind: 'tool-registry'; };
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; };
    'agent-message': AgentMessageSource;
    'subagent-settled': SubagentSettledMessageSource;
    'skill-invocation': SkillInvocationSource;
    'cordis-host-runner': { kind: 'cordis-host-runner'; };
    goal: GoalMessageSource;
    schedule: { kind: 'schedule'; } & ContextFormed;
    'compact-checkpoint': CompactionCheckpointSource;
    'session-reference': SessionReferenceSource;
    'user-question-reply': { kind: 'user-question-reply'; callId: ToolCallId; outcome: 'answered'; };
}
```

> ⚠️ **README 示例不准确**：`dsh-agent/README.md` 的 steer 示例用了 `source: { kind: 'plugin', plugin: 'my-plugin' }`，但 `MessageSourceMap` 中**没有 `'plugin'` 这个 kind**。
> **写代码请只用上表中真实存在的 kind**（自己发消息用 `{ kind: 'user' }`；如果想标识来源，`@deepseek-ai/dsh-agent/README.md` 明确警告 "Each additional `UserMessage` carries exactly one `MessageSource`"）。
> 状态：**已发现矛盾，标记为「文档存疑」**。我没能穷尽验证所有包的 source 扩展，见第 9 节。

### 2.6 可直接复制的最小调用示例 【已验证】

来源与逐行对应：`/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js:313-340`（这是仓库自己的一站式 runner，最干净）。

```js
// 来源: /dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js:313-340
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'          // 或 import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

// 1) 自己生成 sessionId（brand 是纯编译期的，运行时就是字符串）
const sessionId = brandString(`session-${randomUUID()}`)

// 2) 创建 agent —— 注意 cwd 在 meta 里
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: /* 绝对路径，例如 await ctx.fs.processPath(await ctx.fs.resolve('.')) */ },
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})

// 3) 新 agent 初始是 idle，先等静默
await handle.agent.whenIdle()

// 4) 发一条普通用户消息（会自动开一个 turn 并唤醒 driver）
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: '总结一下这个工作区。' }],
  source: { kind: 'user' },
}))

// 5) 等到这一轮跑完
await handle.agent.whenIdle()

// 6) 用完必须 dispose，否则 agent 常驻、session 不释放
await handle.dispose()
```

三个变体：

```js
// 下一步插入（唤醒）：跨 turn 语义等同 followup 的“下一步”版本
handle.agent.steer(createUserMessage({ content: [{ type: 'text', text: '重点看测试。' }], source: { kind: 'user' } }))

// 只注入上下文，不唤醒 —— 会落在下一次被准入的 step 上
handle.agent.inject(createUserMessage({ content: [{ type: 'text', text: '（背景）CI 用的是 pnpm。' }], source: { kind: 'user' } }))

// 中止当前活动但保留排队消息
handle.agent.cancel({ kind: 'hook', reason: '用户按了停止' }, { keepInbox: true })
```

---

## 3. 观察输出

### 3.1 持久化事件：`session/event` 【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Event, event="session/event")
mode: "emit"
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

真实监听写法：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:1464
const disposeEvent = this.ctx.on("session/event", (session, event) => {
```

事件信封：

```
证据: cordis_inspect_query(service="agents") → referencedTypes.SessionEvent
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    [K in SessionEventType]: {
        type: K;
        seq: SessionSeq;
        time: number;
        data: SessionEventMap[K];
        ignorable?: true;
    } & (K extends SurfaceEventType ? SurfaceIntent<K> : {
        surfaceOp?: never;
        sourceEventSeqs?: never;
    });
}[T];
```

- `SurfaceEventType = 'system/message' | 'developer/message' | 'user/message' | 'assistant/message' | 'tool/result'`
- `SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }`
- `ignorable?: true` 是外部插件事件的**兼容标记**（见 3.4）。

### 3.2 `SessionEventMap` —— 你需要的每种 kind 的精确字段 【已验证】

权威完整版来自体积预算更宽裕的 per-package typert 包（api-catalog 里的版本被截断了）：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js （声明 SessionEventMap）
export interface SessionEventMap {
    'turn/start': { turn: number; };
    'turn/end': { turn: number; reason: TurnEndReason; };
    'step/start': { turn: number; step: number; };
    'step/end': { turn: number; step: number; };
    'user/message': UserMessage;
    'developer/message': { turn: number; step: number; message: DeveloperMessage; headerSeq?: SessionSeq; };
    'system/message': { turn: number; step: number; message: SystemMessage; };
    'assistant/message': { turn: number; step: number; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true; };
    'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[]; };
    'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string; };
    'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string; reason?: string; }; meta?: JsonValue; };
    'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true; };
    'request/context': RequestContext;
    'session/end-seed': { inherited?: true; };
    'agent/inbox/spliced': { target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: 'canceled'; };
    'sandbox/mode': { mode: SandboxMode; source?: 'delegation'; };
    'approval/asked': { id: ApprovalRequestId; toolName: string; callId?: ToolCallId; reason?: string; };
    'approval/decided': { id: ApprovalRequestId; outcome: ApprovalOutcome; };
    'approval/policy': { policy: ApprovalPolicy; source?: 'delegation'; };
    'tool/ptc-dispatch-start': PtcDispatchStartEventData;
    'tool/ptc-dispatch': PtcDispatchEventData;
    'agent-preset/selected': { agentPreset: string; };
    'command/run': { commandId: CommandId; name: string; args?: string; source: CommandSource; };
    'command/done': { commandId: CommandId; kind: 'success' | 'error'; text?: string; sourceEventSeq?: SessionSeq; };
    'image/offload': { targets: ImageOffloadTarget[]; };
    'session/title': SessionTitleEventData;
    'todo/write': { todos: TodoItem[]; };
    'model/selection': ModelSelection;
    'subagent/descriptor': SubagentDescriptorData;
    'permission/preset': { preset: string; };
    'subagent/catalog': SubagentCatalogEvent;
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; };
    'compaction/summary': { ... };
    'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string; };
    'compaction/prune': { ... };
    'feedback/record': FeedbackRecord;
    'goal/change': GoalChangeMeta;
    'feedback/message-put': MessageFeedbackPut;
    /* 该投影在此结束；下节的 KNOWN_SESSION_EVENT_TYPES 是事件名的完整清单 */
}
```

> 该投影本身也可能被截断（结尾停在 `feedback/message-put`）。**但第 3.4 节的类型名清单是完整的**，用它可以知道自己漏了什么。

#### 你要的具体字段名速查表

| 你想拿什么 | 从哪里拿 |
|---|---|
| **用户消息文本** | `event.type === 'user/message'` → `event.data.content[]`（`TextBlock.text`） |
| **assistant 文本** | `event.type === 'assistant/message'` → `event.data.message.content[]`，找 `block.type === 'text'` → `block.text` |
| **assistant 推理** | 同上，`block.type === 'reasoning'` → `block.text`（`ReasoningBlock`） |
| **assistant 工具调用块** | 同上，`block.type === 'tool-call'` → `{ id: ToolCallId, name: string, arguments: string }` |
| **token 用量** | `event.data.usage` → `TokenUsage { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }` |
| **工具调用开始 + 参数** | `event.type === 'tool/call'` → `event.data.{ callId, name, arguments }`（`arguments` 是**JSON 字符串**，不是对象！） |
| **工具结果** | `event.type === 'tool/result'` → `event.data.message`（`ToolResultMessage`） |
| **工具结果内容** | `event.data.message.content` → **`readonly ContentBlock[]`（content blocks，不是 string）** |
| **工具是否失败** | `event.data.message.isError`（`boolean?`）+ `event.data.error?: { name, code, reason? }` |
| **工具结果属于哪个调用** | `event.data.message.toolCallId: ToolCallId`（= 上面的 `callId`） |
| **工具附加元数据** | `event.data.meta?: JsonValue` |
| **turn 结束 / 原因** | `event.type === 'turn/end'` → `event.data.{ turn, reason }`，`reason.kind` ∈ `completed \| aborted \| blocked \| error \| max-tokens \| interrupted \| forked` |
| **turn 级错误详情** | `reason.kind === 'error'` → `reason.error: LlmFailure { message, code, status?, providerRetryAfterMs?, requestId?, offloadImages? }` |
| **消息被中断** | `event.data.interrupted === true`（在 `assistant/message` 上） |
| **实际生效的 provider/model** | `event.type === 'request/header'` → `event.data.header.config: LlmCallConfig`；或 `request/context` → `{ provider, model, contextWindow?, systemPromptUpdate? }` |

`ToolResultMessage` / `AssistantMessage` 的封装关系：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js
export interface ToolResultMessage extends MessageBase {
    readonly role: 'tool';
    readonly source: ToolMessageSource;
    readonly toolCallId: ToolCallId;
    readonly isError?: boolean;
}
export interface AssistantMessage extends MessageBase {
    readonly role: 'assistant';
    readonly source: ModelMessageSource;
}
export interface ToolMessageSource { kind: 'tool'; callId: ToolCallId; }
export interface ModelMessageSource extends AssistantProviderMetadata { kind: 'model'; }
export interface AssistantProviderMetadata { provider: string; model: string; replayState?: unknown; }
```

### 3.3 流式输出：`agent/assistant-stream` 【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Event, event="agent/assistant-stream")
mode: "emit"
'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4531
export type AssistantStreamFrame = {
    readonly type: 'start';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly turn: number;
    readonly step: number;
} | {
    readonly type: 'chunk';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;
    readonly time: number;
    readonly chunk: StreamChunk;
} | {
    readonly type: 'end';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    readonly index: number;
    readonly outcome: {
        readonly kind: 'committed';
        readonly eventType: 'assistant/message' | 'assistant/attempt';
        readonly seq: SessionSeq;
    } | {
        readonly kind: 'abandoned';
    };
};
```

`StreamChunk`（帧里真正承载增量文本的东西）：

```
证据: cordis_inspect_query(service="agents") → referencedTypes.StreamChunk
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```

真实消费写法（`ctx.on` 解构 payload；`this` 是 `Scoped<Agent>`）：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:1388
ctx.on("agent/assistant-stream", ({ agent, frame }) => {
```
```
证据: /dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:1481
const disposeAssistantStream = request.assistantStream !== true ? void 0 : this.ctx.on("agent/assistant-stream", ({ agent, frame }) => {
```

语义（`dsh-agent/README.md` 原文，已验证）：
> "`agent/assistant-stream` carries one process-local Assistant attempt's ordered start, transient chunk, and end frames. **Start names the attempt's turn and step, chunk indexes are dense from zero, and `end.index` is the next chunk position.** The loop commits the complete compact stream as one `assistant/message` or `assistant/attempt` **before** a committed end frame, so **the live event remains presentation data rather than the replay source**."

> ❗ **重要**：`agent/assistant-stream` 是**进程内、非持久化**的展示数据。要**可靠/可重放**地拿输出，必须听 `session/event` 的 `assistant/message`。live stream 只适合做 UI 打字机效果。

### 3.4 完整事件类型清单【已验证，完整】

这是本 build 认识的**全部** `SessionEventMap` 成员（生成产物，用于持久化读取的 fail-closed 校验）：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js
export const KNOWN_SESSION_EVENT_TYPES = new Set([
    'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
    'approval/policy', 'assistant/attempt', 'assistant/message', 'command/done', 'command/run',
    'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
    'deliverables/presented', 'developer/message', 'feedback/message-delete',
    'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
    'image/offload', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset',
    'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
    'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
    'session/title-llm-request', 'step/end', 'step/start', 'subagent/catalog',
    'subagent/descriptor', 'subagent/model-selection-policy', 'system/message',
    'team/member', 'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
    'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
    'tool-workflow/run-start', 'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
    'tool/result', 'turn/end', 'turn/start', 'user/message',
    'web/deepseek-search-llm-request', 'workspace/changes',
]);
```

同一文件的重要注释（**外部插件加事件必须带 `ignorable`**）：
> "The persistence read path refuses to interpret a log containing a type outside this set **unless the event carries the envelope's `ignorable` marker** ... **Downstream (out-of-repo) plugin events are outside this list by construction.**"

### 3.5 进程内 agent 级事件（不走 session log）【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Event)
'agent/error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; error: unknown }): void   // emit
'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void                       // emit
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }) // serial
'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void                                          // emit
'agent/inbox/inserted' / 'agent/inbox/claimed' / 'agent/inbox/discarded'                                        // emit
```

- **错误有两处**：`agent/error`（进程内、非持久）与 `session/event` 的 `turn/end` + `reason.kind === 'error'`（持久、带 `LlmFailure`）。**要拿错误文本必须监听后者**，因为 `agent/error` 的 `error` 是 `unknown`。
- `AgentStatus` 的值由实现确认为 `'idle' | 'running'`。
- **`ctx.on` 的作用域即过滤**：在全局 ctx 上监听会收到**所有** agent 的事件；在 `agent.ctx` 上监听只收该 agent 的。

---

## 4. 让某个 agent 会话按「个人助理口语化语气」回复

### 4.1 `PromptSection` 精确契约 —— **字段名是 `text`，不是 `content`** 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:6011
export interface PromptSection {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
    readonly interpolate?: boolean;
    readonly complete?: boolean;
}
```

| 字段 | 必填 | 语义（**全部已验证**） |
|---|---|---|
| `name` | ✅ | 唯一名。**同名会 shadow**（见 4.5）。 |
| `order` | ✅ | 数字，升序拼接。**非有限数会抛** `TypeError`。 |
| `text` | ✅ | 字符串或 `(AssembleContext) => string`（每次 assembly 求值）。 |
| `interpolate` | ❌ | 默认 `true` → 文本里的 `{{var}}` 会被插值。设 `false` 则保留字面量（含 `{{…}}`）。 |
| `complete` | ❌ | `true` → 该 section 成为**完整的 system prompt**（其余 section 被丢弃）。**同时存在 >1 个生效的 complete section 会让 assembly 失败。** |

```
证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:240-243
	section(section) {
		if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
		return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
	}
```

### 4.2 `PromptContext`（`context()`）与 `PromptSection` 的区别 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:5999
export interface PromptContext {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
}
```

关键区别（README 原文 + 源码）：
> "Sections and dynamic contexts are separate inputs: **sections become prompt text, while contexts become sourced user-role snapshots in model history under the loop.**"
> "`includeRuntimeContext: false` or a scoped suppressor removes them all."

即：
- `section()` → 进 **system prompt**。
- `context()` → 变成**带 source 的 user-role 快照**进 model history（是"运行时事实"通道：沙箱策略、审批策略、子 agent 委派信息）。
- **想让 agent 用口语化语气 → 用 `section()`，不是 `context()`。**

### 4.3 `variable()` 精确契约 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:289-300
	* @param name - the `[a-z][a-z0-9_]*` reference name.
	variable(name, provider) {
		if (!VARIABLE_NAME.test(name)) throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`);
		return this.layers.effect(this.ctx, (layer) => layer.variables.insert(name, provider), { label: "systemPrompt.variable()" });
	}
```

- 名字必须匹配 `[a-z][a-z0-9_]*`（大写/数字开头/连字符都会被拒）。
- 在 section 文本里用 `{{name}}` 引用。
- **loop 已经提供 `model` 和 `cwd`**（README 原文）。
- README 的真实示例（注意它解构了 `agent`）：
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/README.md
  ctx.systemPrompt.variable('cwd', ({ agent }) => agent?.session.header.cwd)
  ```
- ⚠️ **风险**：provider 返回 `undefined` 是允许的，但**渲染时任何引用它且取不到值的 section 会让 assembly 抛错**（"an unknown reference, a registered-but-valueless reference ... throws"）。所以给可能为空的变量别写进 section 文本。

### 4.4 `AssembleContext` —— **Inspector 的声明不完整** 【已验证】

Inspector 只给了两个字段：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4512
export interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal; }
```

但源码证明**还有 `agent`**，而且 `agent` 与 `scope` 被一起设置：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:284-297
/**
 * Build the prompt assembly context with agent and scope set together, so
 * agent-scoped prompt and tool contributions cannot be silently omitted.
 * @param agent - the agent the assembly is for.
 * @param signal - the current turn's explicit control signal, when assembly belongs to a turn.
 * @returns the context to pass to `assemble()`.
 */
function assembleContextFor(agent, signal) {
	return {
		agent,
		scope: agent,
		...signal === void 0 ? {} : { signal }
	};
}
```

**实际形状（推荐按此写代码）：**
```ts
interface AssembleContext {
  agent?: Agent        // 【已验证，源码】catalog 里缺失
  scope?: ScopeKey
  signal?: AbortSignal
}
```

`PromptAssembly`：

```
证据: api-catalog.js:5995
export interface PromptAssembly {
    sections: AssembledSection[];
    contexts: AssembledContext[];
    tools: ToolSchema[];
    variables: Record<string, string | undefined>;
}
```

> 注：`assemble()` 返回的 section 文本是**已解析但未插值**的；插值发生在 `renderPrompt()`。这是 README 明确说明的两段式。

### 4.5 能否限定在单个 agent 的 scope？——**能，而且是官方指定做法** 【已验证】

三条独立证据：

**(a) 源码里的报错文案直接指路：**
```
证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:190-192
this.sections  = new NamedEntries((name) => new Error(scope === void 0
  ? `prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)` : `prompt section "${name}" is already registered in this scope`));
this.contexts  = ... `prompt context "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)` ...
this.variables = ... `prompt variable "${name}" is already registered (for a per-agent value, register through that agent's \`agent.ctx\` instead)` ...
```

**(b) `dsh-system-prompt/README.md` 原文：**
> "Contributions are scoped — **registering through `agent.ctx` affects that agent alone and shadows a same-named global.**"
> "Scoped sections, variables, and tool providers **shadow globals** for one agent, and the assembly waterfall dispatches scope-filtered."

**(c) 仓库里真实的 per-agent 注册（规范范式）：**
```
证据: /dsh/node_modules/@deepseek-ai/dsh-file-reference-local/lib/index.js:339-351
		const installPrompt = (agent) => {
			const existing = this.promptFibers.get(agent);
			if (existing !== void 0) return existing;
			const fiber = agent.ctx.inject(["systemPrompt", "tools"], (scope) => {
				scope.systemPrompt.section({
					name: "context:file-reference",
					order: scope.systemPrompt.getSectionOrder("FILE_REFERENCE"),
					text: () => agent.ctx.tools.get("read", agent) === void 0 ? "" : FILE_REFERENCE_PROMPT$1
				});
			});
			this.promptFibers.set(agent, fiber);
			return fiber;
		};
```

`dsh-agent/README.md` 对 `Agent.ctx` 的定义（已验证）：
> "**`Agent.ctx` is the agent's scoped context: registrations made through it (tools, prompt sections, variables, event listeners, restrictions) apply to that agent alone and unwind on disposal.** The same mechanism is what agent presets use to give one session a different capability set without affecting its neighbors."

**所以对「某个 agent 用个人助理口语化语气」，正确做法有两条，都成立：**

1. **创建时用 `setup(agentCtx, agent)`** —— 官方推荐，scope 在 agent 发布前就位：
   ```js
   const handle = await ctx.agents.create({
     sessionId,
     setup: (agentCtx, agent) => {
       agentCtx.systemPrompt.section({
         name: 'persona:casual-assistant',   // 用独立名字，避免和全局撞名
         order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1, // 紧跟在全局 persona 之后
         text: '你是一个口语化的个人助理：用轻松、简短、直白的中文回答；先给结论，少用列表和术语；不确定就直说。',
       })
     },
   })
   ```
2. **运行时用 `agent.ctx.inject(['systemPrompt'], scope => {...})`** —— 对**已存在**的 agent（例如 GUI 里当前会话）挂载/替换语气。参考上面 `dsh-file-reference-local` 的写法：用 `inject` 拿到 `scope`，在回调里 `scope.systemPrompt.section(...)`；`inject` 返回的 fiber 就是 disposer（dispose 即回卷）。

> ⚠️ **同名 shadow 的实际含义**：如果你想**替换**全局语气模板，就复用 `'deployment:persona-prefix'` 这个 section 名（源码常量 `PERSONA_PREFIX_SECTION`，order 0）：
> ```
> 证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:49-57
> /**
> * The deployment persona prefix's section name. Exported because a
> * composition can replace this slot — an agent preset shadows the
> * deployment's persona with its own — and both sides naming the same section
> * is what makes the replacement work rather than duplicate.
> */
> const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
> ```
> 但注意：**同一个 scope layer 内重名会抛错**（见 4.5(a) 的 `is already registered in this scope`）。所以「在同一个 agent.ctx 里注册两次同一个 persona」不行；跨层（global vs scoped）才能 shadow。

### 4.6 `order` 的官方分配表（写代码时请直接抄这些数字）【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:10-48
const SECTION_ORDERS = {
	HARNESS_IDENTITY: -1e3,
	DEPLOYMENT_PERSONA_PREFIX: 0,
	PLAN_POLICY: 500,
	TEAM_POLICY: 600,
	PTC_ONLY: 800,
	FILE_REFERENCE: 900,
	TOOL_BASH: 1e3,
	TOOL_PWSH: 1010,
	TOOL_READ: 1100,
	TOOL_WRITE: 1200,
	TOOL_EDIT: 1300,
	TOOL_GLOB: 1400,
	TOOL_GREP: 1500,
	TOOL_JOBS: 1600,
	TOOL_PTY: 1700,
	TOOL_WEB_SEARCH: 2e3,
	TOOL_WEB_FETCH: 2100,
	TOOL_LSP: 2200,
	TOOL_SESSION_QUERY: 2300,
	TOOL_GOAL: 2400,
	TOOL_WORKFLOW: 2600,
	TOOL_RALPH: 2700,
	TOOL_SUBAGENT: 2800,
	TOOL_REPORT: 2900,
	TOOL_COMPUTER_USE: 3e3,
	MCP_SERVERS: 3100,
	TOOLS_SDK: 5e3,
	DELIVERABLE_FILE_REFERENCES: 9e3,
	STRUCTURED_OUTPUT: 9900,
	HARNESS_SOURCE: 1e4,
	WEB_SURFACE: 10100,
	DEPLOYMENT_PERSONA_SUFFIX: 10200
};
const CONTEXT_ORDERS = {
	SANDBOX_POLICY: 110,
	APPROVAL_POLICY: 115,
	SUBAGENT_DELEGATION: 120
};
```

- 第一个 section 是 `harness:identity`，文本固定为 `"You are an AI agent powered by DeepSeek Harness."`，order `-1000`，可用 config `includeHarnessIdentity: false` 关掉。
- **外部贡献可以用任意有限数字**（README: "External contributions may use any finite order"）。给口语化 persona 建议用 **order 1**（紧跟 `DEPLOYMENT_PERSONA_PREFIX`=0 之后），或直接复用 order 0 的 section 名做覆盖。

### 4.7 其余 `systemPrompt` 方法 【已验证】

| 签名 | 契约 |
|---|---|
| `getSectionOrder(name: PromptSectionOrderName): number` | 查上表；名字不存在返回 `undefined`（**不是抛错**） |
| `getContextOrder(name: PromptContextOrderName): number` | 查 CONTEXT_ORDERS，同上 |
| `context(context: PromptContext): () => void` | 注册运行时上下文；非有限 order 抛 `TypeError` |
| `suppressRuntimeContext(): () => void` | 移除本 scope 全部动态 runtime context；多个 suppressor 可叠加，全部释放后恢复 |
| `tools(provider: (context: AssembleContext) => ToolProviderResult): () => void` | 全局与匹配的 scoped provider **都会生效**（不是 shadow） |
| `assemble(context: AssembleContext = {}): Promise<PromptAssembly>` | 合并 global+scoped、排序、跑 `system-prompt/assemble` waterfall、强制 complete section |
| 全部注册方法 | **返回 Cordis effect disposer**（幂等、随 owner fiber 回卷） |

### 4.8 全局语气（不属于某一个 agent）的配置法 【已验证】

`@deepseek-ai/dsh-system-prompt` 自己的 Config 就是「部署级 persona」：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:201-207
	static Config = z.object({
		includeHarnessIdentity: z.boolean().default(true),
		includeRuntimeContext: z.boolean().default(true),
		personaPrefix: z.string().default(""),
		personaSuffix: z.string().default(""),
		toolOrder: z.array(z.string()).default(void 0)
	});
```

```yaml
# 放到 profile 的 cordis.patch.yml 里（见第 7 节）
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: '你是一个口语化的个人助理，用轻松简短的中文回答。'
```

> **注意**：README 说 "there is no end-user prompt-editing API"；部署级语气靠 config，per-agent 语气靠 scoped section。

---

## 5. 文件回传：把 agent 产出/引用的文件拿给宿主

### 5.1 `ctx.attachments` 精确签名 【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Service, service="attachments")
abstract readonly imageLimits: ImageAttachmentLimits
abstract validateImage(input: SaveImageAttachment): Promise<void>
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
async admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>
admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef>
isAttachmentError(error: unknown): error is AttachmentError
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
imageHostPath(ref: ImageAttachmentRef): string | undefined
saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>
saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>
async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
fileHostPath(ref: FileAttachmentRef): string | undefined
readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment>
```

参数 / 返回类型：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:6223-6231 / 5111
export interface SaveFileAttachment { data: Uint8Array; name?: string; }
export interface SaveFileStreamAttachment { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string; }
export interface FileAttachmentRef { attachmentId: AttachmentId; name: string; bytes: number; }
export type AttachmentId = Branded<'AttachmentId'>;
```

**落盘位置与 host path（关键）** 【已验证】：

```
证据: /dsh/node_modules/@deepseek-ai/dsh-attachment-local/README.md
Attached images are kept below `<DSH_HOME>/attachments/v1` on this machine.
Stored images are never deleted automatically, identical images are stored only once, ...
```
```
证据: /dsh/node_modules/@deepseek-ai/dsh-attachment/README.md
"generic files ... **the exact bytes are saved read-only under the harness home**"
"`fileHostPath` locates the stored object for read-on-demand projection"
"`imageHostPath` exposes an implementation-owned host location **only to trusted same-process consumers**"
```

- `fileHostPath(ref)` 返回本机绝对路径；**当当前 fs 后端无法映射该 host 对象时返回 `undefined`**（README: "When the current execution filesystem maps the stored host object"）。
- **`saveFile` / `saveFileStream` 不做类型白名单、不做大小限制**（README: "There is no file-type whitelist and no size limit"，"neither file write path applies admission limits"）。限制只作用在**图片**通道。
- 只读：存进去的对象是 immutable，且**永不自动删除**。

### 5.2 `ctx.fs` 精确签名 + 类型 【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Service, service="fs")
watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract processPath(target: FsTarget): string
processPathFromHostPath(hostPath: string): string | undefined
abstract fileUrl(target: FsTarget): string
abstract contains(parent: FsTarget, child: FsTarget): boolean
abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
abstract lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
abstract readText(target: FsTarget, signal?: AbortSignal): Promise<string>
abstract streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
abstract readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
abstract readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
abstract listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
abstract editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
```

```
证据: api-catalog.js:5175 / 5163
export interface FsTarget { targetKey: FsTargetKey; displayPath: string; }
export interface FsInfo { version: FsVersion; type: 'file' | 'directory' | 'other'; size?: number; }
```

### 5.3 ❗「把 workspace 内任意路径以**字节流**方式读出」的最小路径 【已验证 + 一处推断】

**已验证的事实：**

1. **`ctx.fs` 没有真正的「字节流」读取原语。**
   - `streamText()` 返回 `AsyncIterable<string>` —— **只用于文本**（会解码 / 会拒绝二进制）。
   - `readBytes(target, signal, maxBytes)` —— **必须显式给上限**，超限直接失败而不是截断。
   - `readByteRange(target, {offset, length})` —— 有界窗口读。
2. **`ctx.fs` 没有 `streamBytes`**（方法清单如上，无此成员）。
3. 官方对这条设计的说明：
   ```
   证据: /dsh/node_modules/@deepseek-ai/dsh-fs/README.md
   "**Bounds live at this seam.** `readBytes` requires `maxBytes` and **fails with `FS_TOO_LARGE` rather than truncating**, so no backend ever buffers an unbounded file."
   "Read, listing, and mutation failures are typed `FsError`s with stable codes such as **`FS_NOT_FOUND`, `FS_STALE_VERSION`, or `FS_AMBIGUOUS_EDIT`**"
   ```
4. `ctx.fs` 契约（README）："`targetKey` and `version` **are branded opaque ids: consumers must not parse or interpret them**; only `displayPath` is for model/UI output."；"Every ordinary operation starts with `resolve(path, { cwd })`"。

**所以「任意路径 → 字节流」的两种正确写法：**

**方案 A（推荐，真正流式、无上限）：`readByteRange` 分块循环** —— **【推断】**（由方法语义组合，未找到仓库内现成的封装示例）
```js
/**
 * 把 workspace 内任意路径以 AsyncIterable<Uint8Array> 形式读出。
 * 来源依据: ctx.fs.readByteRange 签名（cordis_inspect_query service="fs"）
 *          + dsh-fs/README.md 的 "readByteRange is bounded by its window instead"
 */
async function* streamWorkspaceBytes(ctx, absPath, { chunk = 1 << 20, signal } = {}) {
  const target = await ctx.fs.resolve(absPath, { cwd: undefined, signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') throw new Error(`not a regular file: ${absPath}`)
  let offset = 0
  const total = info.size ?? 0
  while (offset < total) {
    const bytes = await ctx.fs.readByteRange(target, { offset, length: Math.min(chunk, total - offset) }, signal)
    if (bytes.byteLength === 0) break
    offset += bytes.byteLength
    yield bytes
  }
}
```

**方案 B（有界、最简单）：`readBytes` 一次读完，自己给上限**
```js
// 依据: ctx.fs.readBytes(target, signal, maxBytes)
const target = await ctx.fs.resolve('/abs/path/in/workspace')
const bytes = await ctx.fs.readBytes(target, undefined, 64 * 1024 * 1024) // 超限抛 FS_TOO_LARGE
```

**如果目标是「回传给宿主/用户」→ 走 attachments（这才是设计意图）：**
```js
// 依据: ctx.attachments.saveFileStream(SaveFileStreamAttachment): Promise<FileAttachmentRef>
//       ctx.attachments.fileHostPath(FileAttachmentRef): string | undefined
const ref = await ctx.attachments.saveFileStream({
  data: streamWorkspaceBytes(ctx, '/abs/path/report.xlsx'),   // AsyncIterable<Uint8Array>
  name: 'report.xlsx',
})
const hostPath = ctx.attachments.fileHostPath(ref)   // 本机绝对路径；不支持映射时为 undefined
// 想读回来：
// for await (const chunk of ctx.attachments.readFileStream(ref)) { ... }  // 会校验长度与摘要
```

### 5.4 「agent 引用的文件」从哪来 【已验证 + 部分推断】

- **agent 产出的文件**：文件本身**不在** session event 里 → 监听 `session/event` 拿到 `tool/call`（`name === 'write'/'edit'`）→ 取 `arguments` JSON 里的路径 → 再走上面的 `ctx.fs` / `ctx.attachments`。**【推断】**（我未找到仓库里现成的、专门从 tool/call 反解文件路径的封装）。
- **有专门的持久化事件**：`deliverables/presented` 存在于 `KNOWN_SESSION_EVENT_TYPES` 中（【已验证】它存在），但我**没有读它的 payload 形状**（见第 9 节）。这是「声明产出物」最该用的通道。
- **工作区根目录**：
  ```js
  const fs = ctx.get('fs')
  const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
  ```
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js:314-315
  	const fs = ctx.get("fs");
  	const cwd = fs === void 0 ? process.cwd() : fs.processPath(await fs.resolve("."));
  ```
- **会话级 cwd**：`agent.session.header.cwd`（`SessionHeader.cwd?: string`，【已验证】）。prompt 变量里可直接用：`ctx.systemPrompt.variable('cwd', ({ agent }) => agent?.session.header.cwd)`。

### 5.5 写文件的沙箱策略 【已验证】

- `writeText` / `editText` 的**第 5 个参数**是 `sandboxPolicy?: SandboxExecutionPolicy`（【已验证】签名）。
- 有 `fs/write-intent` 与 `fs/edit-intent` waterfall 事件让策略插件否决/注入版本前置条件；`fs/observed` 记录观察结果（【已验证】Event catalog）。
- 具体该传什么 `SandboxExecutionPolicy` 值、以及 `dsh-fs-observation-policy` 如何消费它，**我没有读到**（见第 9 节）。

---

## 6. Web 服务器

### 6.1 `ctx.webServer.register(route)` / `registerUpgrade(route)` 精确契约 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:7847 / 7887 / 7851
export interface WebRoute {
    kind: WebRouteKind;
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
export interface WebUpgradeRoute {
    path: string;
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
export type WebRouteKind = 'exact' | 'prefix';
```

```
证据: cordis_inspect_query(platform=host, provider=Service, service="webServer")
register(route: WebRoute): () => void
registerUpgrade(route: WebUpgradeRoute): () => void
registerFallback(handler: WebRoute['handler']): () => void
tapIndex(transform: (html: string) => string): () => void
applyIndexTaps(html: string): string
collectIndexInjections(): IndexInjection[]
renderIndex(html: string): string
```

- `IncomingMessage` / `ServerResponse` 是 **Node 原生 `node:http` 类型**（源码 `import { createServer } from "node:http"`）。
- 返回的 `() => void` 是**幂等 disposer**，删除该路由。

### 6.2 路径匹配语义（读实现，不是猜）【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:177-197
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => { table.delete(route.path); };
	}
	registerUpgrade(route) {
		if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
		this.upgrades.set(route.path, route);
		return () => { this.upgrades.delete(route.path); };
	}
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:322-332
	/** Longest-prefix-wins over the prefix table after an exact-table miss. */
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
```

**结论（全部已验证）：**

| 项 | 语义 |
|---|---|
| 匹配输入 | `new URL(req.url ?? "/", "http://x").pathname` → **只匹配 pathname，query string 不参与匹配**（handler 里自己解 `req.url`） |
| `kind: 'exact'` | Map 精确查表，**只匹配完全相等的 pathname** |
| `kind: 'prefix'` | 先查 exact 表；未命中后在 prefix 表里**最长前缀优先**；命中条件 `pathname === prefix \|\| pathname.startsWith(prefix + '/')`（**不会匹配 `/sidebar/apiX`**） |
| 重复 `(kind, path)` | **抛错** `webserver: duplicate ${kind} route "${path}"` |
| upgrade 路由 | **只有精确 pathname 匹配**（`this.upgrades.get(pathname)`），不支持前缀 |
| 重复 upgrade path | 抛错 `duplicate upgrade route` |
| handler 里能否抛 | 能。HTTP：捕获 → `ctx.logger.warn` → 若未发头则 `res.writeHead(400); res.end()`，已发头则 `res.destroy()` |
| handler 返回 Promise | **会被 await**（`await route.handler(req, res)`；upgrade 侧 `Promise.resolve(route.handler(...)).catch(...)`） |
| 响应所有权 | **handler 完全拥有响应**（"Route handlers retain direct response ownership"）。不写响应就挂住 |
| 无路由命中 | 若有 fallback → 交给它；否则 **404** |
| `path` 是否要带前导 `/` | 源码用 `new URL(...).pathname`，**始终以 `/` 开头**，所以 `path` 必须写成 `'/foo'` |

### 6.3 是否支持 WebSocket upgrade？——**支持，而且是官方范式** 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:261-294
		this.server.on("upgrade", (req, socket, head) => {
			const onError = (error) => { this.ctx.logger.warn(error); socket.destroy(); };
			socket.on("error", onError);
			socket.once("close", () => { socket.off("error", onError); this.upgradedSockets.delete(socket); });
			let route;
			try {
				route = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);
			} catch (error) { ... socket.destroy(); return; }
			if (route === undefined) { socket.destroy(); return; }
			this.upgradedSockets.add(socket);
			try {
				Promise.resolve(route.handler(req, socket, head)).catch((error) => { this.ctx.logger.warn(...); socket.destroy(); });
			} catch (error) { ... socket.destroy(); }
		});
```

要点：
- 就是原生 `node:http` 的 `'upgrade'` 事件 → 可以按标准做法交给 `ws` 的 `WebSocketServer({ noServer: true })` + `handleUpgrade(req, socket, head, cb)`。
- **未匹配到 upgrade 路由的 socket 会被直接 `destroy()`**（没有任何握手，客户端会看到连接被关）。
- 服务在 dispose 时会 `socket.destroy()` 所有通过 upgrade 建立的 socket（`upgradedSockets` 集合，源码 313-319）。
- **`ws` 不是 DSH 的依赖，需要你自己的插件声明**。证据：`dsh-better-sidebar/package.json` 把 `"ws": "^8.18.0"` 放在自己的 `dependencies` 里。

### 6.4 已监听端口 / 基础 URL 怎么读？——**有公开 getter** 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:163-170
	/** The listening port (the OS-assigned value when config.port is 0). */
	get port() {
		return this.listenedPort;
	}
	/** The configured bind host (the loopback or all-interfaces literal). */
	get host() {
		return this.config.host;
	}
```

- `ctx.webServer.port: number` —— 实际监听的端口（`config.port === 0` 时是 OS 分配的）。
- `ctx.webServer.host: '127.0.0.1' | '0.0.0.0'` —— 配置的绑定 host。
- **没有 `baseUrl` getter**（【已验证】——Service 投影的方法/属性里没有）。
- 真实消费（**宿主就是这么拼 URL 的**）：
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:337
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`);
  ```
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-host-directory-picker-auto/lib/index.js:119
  bindHost: ctx.webServer.host,
  ```

> 所以：**`http://127.0.0.1:${ctx.webServer.port}`** 就是基础 URL 的拼法（需要鉴权时再套 `ctx.connection.authenticatedUrl(...)`）。

### 6.5 `registerFallback` / index 注入 【已验证】

- `registerFallback(handler)`：**只能被一个 owner 占用**，第二次注册抛 `webserver: fallback already registered`。承接所有未命中请求（shipped Web 组合里是 SPA dist 服务器）。
- `tapIndex(transform)`：raw HTML→HTML 变换，在 `renderIndex` 里于结构化 row **之后**按注册顺序应用。
- `collectIndexInjections()`：`ctx.emit('webserver/index-inject', table)`，订阅者 push 自己的 `IndexInjection[]`。
- `renderIndex(html)` = `applyIndexTaps(renderIndexInjections(html, collectIndexInjections()))`。
- 真实 fallback 用法：
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js:85-87
  return ctx.webServer.renderIndex(await readFile(distIndex, "utf8")).replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="./">`);
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
  ```

### 6.6 最小「HTTP + WebSocket 升级」示例（真实代码，非虚构）

**这个例子几乎逐行来自已安装的 `dsh-better-sidebar`（生产插件），可信度最高。**

```js
// 来源: <local-path> 7065-7077
//       （path/handler 结构、WebSocketServer noServer 模式、disposer 经 ctx.effect 挂载）
import { WebSocketServer } from 'ws'

function apply(ctx, config) {
  // ---- 1) HTTP 前缀路由 ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',                       // 'exact' | 'prefix'
    path: '/myplugin/api',                // 必须带前导 '/'
    handler: async (req, res) => {
      // handler 完全拥有响应；必须自己 end()
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'method-error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  }), 'myplugin: /myplugin/api route')

  // ---- 2) WebSocket 升级路由（精确路径） ----
  const wss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/myplugin/ws',                 // 只做精确匹配，不支持前缀
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => ws.send(`echo: ${data}`))
      })
    },
  }), 'myplugin: websocket')

  // ---- 3) 读出监听端口（给自己人拼 URL） ----
  ctx.logger?.info?.(`myplugin listening on http://127.0.0.1:${ctx.webServer.port}`)

  ctx.effect(() => () => { wss.close() }, 'myplugin: close wss')
}
```

`noServer` + `handleUpgrade` 的**原始真实代码**：

```
证据: <local-path>
	const agentOpenWss = new WebSocketServer({ noServer: true });
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: "/sidebar/ws/agent-opens",
		handler: (req, socket, head) => {
			if (!fence(req)) {
				socket.destroy();
				return;
			}
			agentOpenWss.handleUpgrade(req, socket, head, (ws) => {
				attachAgentOpen(agentOpenRegistry, ws, req);
			});
		}
	}), "dsh-better-sidebar: agent-opens push WebSocket");
```

### 6.7 `ctx.webServer` 还是自建 `node:http`？——**优先 `ctx.webServer`**

**理由（全部有证据）：**

1. **GUI 就跑在这个服务器上**。当前会话的 GUI 在 `http://127.0.0.1:19387`，由宿主 `ctx.webServer` 提供（`dsh-host-frontend-static` 用 `registerFallback` 渲染 `index.html`）。用 `register` 你的路由与 GUI **同源同端口** —— 浏览器不会遇到 CORS/混合内容/跨端口问题。
2. **端口是 0 时由 OS 分配**，只有 `ctx.webServer.port` 能告诉你实际端口；自建服务器你得自己管端口冲突和告知用户。
3. **生命周期自动接进 Cordis**：`ctx.webServer.register()` 返回 disposer，配 `ctx.effect(...)` 后插件卸载即路由下线；且服务 dispose 时会 `closeAllConnections()` + 销毁所有 upgrade socket（源码 306-320）。
4. **有内置鉴权地板可复用**：宿主侧有 `ctx.connection.authenticatedUrl(base)`；`dsh-better-sidebar` 自己做了 `isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)` 的 fence（`lib/index.js:6797`）。自建服务器这些都得自己写。
5. **可以注入 GUI 的 index.html**（`tapIndex` / `registerIndexInjections`），自建服务器做不到。

**自建 `node:http` 什么时候合理（【推断】）：** 需要独立于 GUI 生命周期长期存活、或需要绑到别的网卡/端口给外部设备访问（例如「展示绑定二维码」让手机扫码连接）时。此时：
- 必须用 `ctx.effect(() => { server.listen(0, '0.0.0.0'); return () => server.close() })` 把生命周期挂到 Cordis；
- 用 `server.address().port` 拿实际端口；
- 需要自己做鉴权，别裸监听 `0.0.0.0`。

> **对本项目（`/openwhale` 展示绑定二维码）的建议**：如果是**本机浏览器**扫码/打开 → 用 `ctx.webServer.register({ kind: 'prefix', path: '/openwhale', ... })`，二维码内容用 `http://127.0.0.1:${ctx.webServer.port}/openwhale`。如果是**手机等外部设备**要连 → 需要 `webServer.host` 为 `0.0.0.0`（配置项），或自建服务器，并自行加鉴权。**【推断】**

---

## 7. 插件包结构

### 7.1 入口导出：`export { name, inject, apply, Config }` 【已验证】

真实插件的导出语句：

```
证据: <local-path>
export { Config, FS_TREES_MAX_PATHS, apply, archiveNameOf, collectZipEntries, contentDispositionOf, disambiguateArchiveNames, inject, mediaTypeForPath, name };
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-command-goal/lib/index.js:187
export { apply, inject, name };
```

```
证据: <local-path> 6041, 6795
const name = "dsh-better-sidebar";
const inject = [ ... ];
function apply(ctx, config) { ... }
```

**契约总结（【已验证】）：**

| 导出 | 必需 | 说明 |
|---|---|---|
| `name` | 推荐 | 插件名，约定 = npm 包名（`"dsh-better-sidebar"`）。Loader 用它做 entry 标识/去重 |
| `inject` | 可选 | 依赖的 **Service key 数组**（不是包名！例如 `['webServer','sessions','settings']`）。也可为 object/null |
| `apply(ctx, config)` | ✅ | 插件主体。**普通函数**（不是 class、不是 default export）。`config` 已经过 `Config` 校验并填好默认值 |
| `Config` | 可选 | schemastery schema，导出后 Loader 用它校验 `config` |
| `default` | ❌ | 上述插件**都没有 default export** |

> ⚠️ 我没有找到「`name` 是否强制」的规范文本。从两个真实插件看是导出的（【已验证】）。【推断】`name` 应与 package.json 的 `name` 一致，否则 `dsh-plugin-manager` 的 bundle 对账会出问题。

### 7.2 `package.json` 的 `dsh` 字段——完整真实示例 【已验证】

`dsh-better-sidebar` 的完整 `dsh` 段：

```
证据: <local-path>
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-modules"
      ],
      "platform": "web"
    },
    "manifestVersion": 1
  },
```

`dsh-image-gen` 的 `dsh` 段（第二个实例，同样是 `bundle.patch` + `client`）：

```
证据: <local-path>
"dsh": {
  "bundle":  { "patch": "./cordis.patch.yml" },
  "client":  {
    "inject": [ "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-remotes"... ],
    "platform": "web"
  }
}
```
（原文完整列表：`@deepseek-ai/dsh-client-connection`, `@deepseek-ai/dsh-api-remotes`, `@deepseek-ai/dsh-client-ui-conversation`, `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-ui-settings-plugins`, `@deepseek-ai/dsh-client-ui-sidebar-right`, `@deepseek-ai/dsh-client-ui-tool`, `@deepseek-ai/dsh-client-locale`）

其他相关字段（同一 package.json）：
```
"type": "module",
"main": "lib/index.js",
"types": "lib/types/index.d.ts",
"exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }, ... },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.4",
  "@deepseek-ai/dsh-agent": "^0.2.0-rc.2",
  "@deepseek-ai/dsh-host-webserver": "^0.2.0-rc.2",
  "@deepseek-ai/dsh-llm": "^0.2.0-rc.2",
  "@deepseek-ai/dsh-session": "^0.2.0-rc.2",
  "@deepseek-ai/dsh-settings": "^0.2.0-rc.2",
  ...
  "react": "^18.2.0", "react-dom": "^18.2.0"
},
"dependencies": { ..., "@deepseek-ai/schemastery": "^3.18.4", "ws": "^8.18.0", ... }
```

> 注意：`@deepseek-ai/cordis` 和所有 `dsh-*` 都是 **peerDependencies**（由宿主提供，插件不重复安装）；`@deepseek-ai/schemastery` 和 `ws` 是**插件自己的 dependencies**。

### 7.3 `dsh.bundle.patch` 的精确契约 【已验证】

```
证据: /dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:488-509
/**
 * The patch files a bundle declares, as written: one file for a string
 * `patch`, the listed files in order for an array.
 * @param bundle - the bundle's `dsh.bundle` declaration, as read from package.json.
 * @returns the package-relative patch file paths in application order.
 * @throws {Error} when `patch` is neither a string nor a list of strings.
 */
function bundlePatchFiles(bundle) {
	const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
	if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
	return declared;
}
function bundlePatchPaths(packageDir, bundle) {
	return bundlePatchFiles(bundle).map((file) => join(packageDir, file));
}
```

- `dsh.bundle.patch` = **字符串**（单文件）**或字符串数组**（多文件，按序应用）。
- 路径**相对于包目录**（`join(packageDir, file)`）。
- 声明了 `dsh.bundle` 的包才能作为 **profile bundle** 被 `dsh plugin add` 安装；没声明的只会是普通 dependency：
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:251
  options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, "stderr");
  ```
- 应用顺序（【已验证】注释）："Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the whole config."

### 7.4 `cordis.patch.yml` 的精确格式 + `insert` 行结构 【已验证】

**格式**：顶层是**一个 YAML 数组**，每个元素是一个「loader patch entry」。

```
证据: <local-path>
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
    performanceUsage: detailed
```

**真实的 `insert` 行（来自已安装插件的 bundle patch）：**

```
证据: <local-path>
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      disabled: !!js "[...ctx.loader.entries()].some((e) => e.options.name === 'dsh-better-sidebar' && e.options.id !== 'better-sidebar' && !e.disabled)"
```

**单条 patch entry 允许的字段（Loader 的 JSON Schema，权威）：**

```
证据: /dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2721-2753（entryMetadata）
function metadata() {
	return {
		id: { type: "string", description: "Entry id. Loader generates an id when an entry omits it; patches use the configured id." },
		name: { type: "string", description: "Plugin module specifier. Inserted relative plugin paths are anchored beside their patch file." },
		config: {},
		group: { type: ["boolean", "null"], description: "Allows patch indexing and insertion into an entry-list config; does not select the plugin implementation." },
		disabled: { anyOf: [{ type: ["boolean", "null"] }, ref("loaderExpression")], description: "Boolean or !!js expression. The Loader coerces other truthy values as disabled; this schema rejects them." },
		inject: { anyOf: [ { type: "array", items: { type: "string" } }, { type: "object" }, { type: "null" } ] },
		intercept: { type: ["object", "null"] },
		isolate: { type: "object", additionalProperties: { anyOf: [{ const: true }, { type: "string" }] } }
	};
}
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2755-2761
function patchStructure() {
	return {
		type: "object",
		allOf: [ref("entryMetadata")],
		properties: { insert: ref("entryList") },
		description: "An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; **config is replaced wholesale, not deep-merged**. A **truthy name asserts the existing plugin name** rather than renaming it. **Unknown targets and non-insert patches without a nonempty id are warned and skipped.**"
	};
}
```

**`insert` 的执行语义（源码）：**

```
证据: /dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:72-94
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) { warn("patch insert: entry %C not found", id); continue; }
				if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) { warn("patch: id is required for non-insert patches"); continue; }
```

**所以 `insert` 行结构（可直接抄）：**

```yaml
# 顶层无 id 的 insert = 追加到根 entry 列表
- insert:
    - id: my-plugin            # 可选，但强烈建议给（便于后续按 id 覆写）
      name: 'my-plugin'        # 模块说明符；相对路径以 patch 文件所在目录为锚点
      config:                  # 可选，会被 Config schema 校验
        foo: bar
      disabled: false          # 可选：boolean 或 !!js 表达式
      inject: ['webServer']    # 可选，覆盖/补充依赖
# 带 id 的 insert = 插入到某个 group 条目的 config 数组里（目标必须是 group: true）
- id: some-group
  insert:
    - id: my-plugin
      name: 'my-plugin'
```

> ⚠️ **`config` 是整体替换，不做深合并**（原文 "config is replaced wholesale, not deep-merged"）。覆写全局配置时要写全量字段。
> ⚠️ **`insert` 没有 `before` / `after` 字段**（【已验证】schema 里没有）。顺序 = 数组顺序；对 group 插入 = push 到末尾。
> ⚠️ `!!js` 表达式是允许的（custom YAML tag），求值上下文有 `ctx`（见上面 `disabled` 的例子）。
> **未找到**：`insert` 行之上的 `id` 为必填的规范文本（只找到 "optional" 的实现行为）。

### 7.5 `Config` schema（`@deepseek-ai/schemastery`） 【已验证】

❗ **最重要的坑：必须 import `@deepseek-ai/schemastery`，不能用公共的 `schemastery` 包。**

```
证据: <local-path>
 * Schemastery comes from DSH, not from the public `schemastery` package, and
 * that is load-bearing rather than stylistic: only DSH's build WRAPS a
 * `meta.volatile` field in a cosmokit `Volatile` reference when it parses the
 * config. The Loader's volatile-commit path walks those references
 * (`volatileEntries` / `updateVolatile`), so a schema built with the public
 * package produces plain values, leaves the loader nothing to commit, and
 * **silently drops every live preference write** — the write reports success
 * and the effective value never changes.
 * @module dsh-better-sidebar/config
 */
import z from '@deepseek-ai/schemastery';
```

**真实 Config（从最简单的到完整的）：**

```js
// 来源: /dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:201-207
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  includeHarnessIdentity: z.boolean().default(true),
  includeRuntimeContext:  z.boolean().default(true),
  personaPrefix:          z.string().default(''),
  personaSuffix:          z.string().default(''),
  toolOrder:              z.array(z.string()).default(void 0),
})
```

```js
// 来源: /dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:141-147
static Config = z.object({
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
  port: z.natural().max(65535).required(),
  compression: z.union([z.const('none'), z.const('gzip')]).default('none'),
  compressionLevel: z.number().step(1).min(0).max(9).default(1),
  compressionThresholdBytes: z.natural().default(1024),
})
```

```js
// 来源: <local-path> 116, 121-124
import z from '@deepseek-ai/schemastery'

const LimitsSchema = z.object({
  readLimit:   z.number().step(1).min(1).default(524288),
  mediaLimit:  z.number().step(1).min(1).default(20971520),
  uploadLimit: z.number().step(1).min(1).default(134217728),
  listLimit:   z.number().step(1).min(1).default(1e3),
})

// 让字段成为可被 Settings 页面实时编辑的“volatile”偏好
const volatilePrefs = Object.fromEntries(
  Object.entries(PrefsSchema.dict ?? {}).map(([key, field]) => [key, field.volatile()]),
)

export const Config = z.object({
  ...LimitsSchema.dict,     // 把子 schema 的字段摊平进来
  ...volatilePrefs,
})
```

**schemastery API 速查（README 已验证的部分）：**

```js
// 来源: /dsh/node_modules/@deepseek-ai/schemastery/README.md
const validate = Schema.number().default(10)
validate(0)     // 0
validate(null)  // 10   ← null/undefined 走 default
validate('')    // TypeError

const Config = Schema.object({
  foo: Schema.dict(Schema.string()).default({}),
  bar: Schema.array(Schema.string()).default([]),
})
const config = new Config()      // { foo: {}, bar: [] }
```

| 用法 | 含义 |
|---|---|
| `z.object({...})` | 对象 schema。`.dict` 可拿到字段表（用于摊平 / 遍历） |
| `z.string() / z.number() / z.boolean() / z.natural()` | 基础类型。`z.natural()` = 非负整数 |
| `z.array(item)` / `z.dict(value)` | 数组 / 字典 |
| `z.union([a, b])` / `z.const(v)` | 联合 / 字面量（用于枚举一个值） |
| `.default(v)` | 缺省值 |
| `.required()` | 必填 |
| `.min(n) / .max(n) / .step(n)` | 数值约束 |
| `.description(str)` | 文档（Settings 页面会显示） |
| `.volatile()` | **DSH 专有**：标记为可被 Settings 实时编辑并持久化到 profile patch 的字段 |
| `Schema.extend()` | 自定义 schema 类型（高级） |

- **Config 是可选的**：`dsh-command-goal` 的 `apply(ctx)` **没有接 config 参数**（`function apply(ctx) {...}`），也没导出 `Config`（`export { apply, inject, name }`）。**没有 Config 就是没有配置入口**（【已验证】）。
- 运行时校验：`ctx.commands...` 等注册方法都做严格类型检查并抛 `TypeError`（例如 commands 的 `input.hint must be a string`）——【已验证】见 8.1。

### 7.6 完整可复制的插件骨架

```
my-plugin/
├── package.json
├── cordis.patch.yml
└── src/index.ts
```

**`package.json`**（结构来源：`dsh-better-sidebar/package.json`）
```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "My DSH plugin.",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=20" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "manifestVersion": 1
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-llm": "^0.2.0-rc.2",
    "@deepseek-ai/dsh-agent": "^0.2.0-rc.2",
    "@deepseek-ai/dsh-session": "^0.2.0-rc.2",
    "@deepseek-ai/dsh-host-webserver": "^0.2.0-rc.2",
    "@deepseek-ai/dsh-settings": "^0.2.0-rc.2"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.4",
    "ws": "^8.18.0"
  }
}
```
> 版本号 `^0.2.0-rc.2` 是已安装插件 peerDeps 里实际写的范围（DSH 44.0.0 的包仍带 `-rc.2` 预发布标签）。
> 若要同时提供客户端半（GUI 页面/侧边栏），再加上 `"dsh": { "client": { "inject": [...], "platform": "web" } }` 并导出 `./client`。

**`cordis.patch.yml`**（结构来源：`dsh-better-sidebar/cordis.patch.yml`）
```yaml
# my-plugin bundle patch: one insert of the plugin row.
- insert:
    - id: my-plugin
      name: 'my-plugin'
      # config:
      #   someLimit: 1024
```

**`src/index.ts`**
```ts
// 结构来源: dsh-better-sidebar/lib/index.js:6039-6795,7199
//          /dsh/node_modules/@deepseek-ai/dsh-command-goal/lib/index.js:174-187
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

/** 依赖的 Service key（不是包名）。可由 Loader 覆写。 */
export const inject = ['webServer']

export interface Config {
  greeting?: string
}

export const Config = z.object({
  greeting: z.string().default('hello'),
})

export function apply(ctx: any, config: Config) {
  const greeting = config.greeting ?? 'hello'

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/my-plugin/ping',
    handler: (req: any, res: any) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, greeting }))
    },
  }), 'my-plugin: /my-plugin/ping')
}
```

---

## 8. 命令与持久化

### 8.1 `ctx.commands.register(...)` 精确契约 【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Service, service="commands")
register(definition: CommandDefinition): () => void
```

```
证据: /dsh/node_modules/@deepseek-ai/dsh-commands/lib/typert.host.js
export interface CommandDefinition {
    readonly definitionId?: CommandDefinitionId;
    readonly name: string;
    readonly description: string;
    readonly input?: CommandInputDescriptor;
    readonly recordInput?: boolean;
    readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

export interface CommandInvocation {
    readonly commandId: CommandId;
    readonly agent: Agent;
    readonly rawInput: string;
    readonly attachments: readonly (ImageBlock | FileBlock)[];
    readonly signal: AbortSignal;
}

export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: SessionSeq; }
  | { readonly kind: 'error';   readonly text: string; };

export interface CommandInputDescriptor {
    readonly hint: string;              // 必填、非空
    readonly attachments?: boolean;     // 允许提交附件
}

export interface CommandExecution {
    readonly commandId: CommandId;
    readonly result: CommandResult;
}

export interface CommandDescriptor {
    readonly definitionId?: CommandDefinitionId;
    readonly name: string;
    readonly description: string;
    readonly input?: CommandInputDescriptor;
}

export type CommandId = Branded<'CommandId'>;
export type CommandDefinitionId = Branded<'CommandDefinitionId'>;
```

**要点（全部已验证）：**

| 项 | 结论 |
|---|---|
| handler 收到什么 | `{ commandId, agent, rawInput, attachments, signal }` —— **`agent` 就是发起该命令的 agent** |
| handler 返回什么 | `{ kind: 'success', text? }` 或 `{ kind: 'error', text }`（**不是裸字符串**） |
| 输出怎么给用户 | 返回的 `text` 会被写进持久化事件 `command/done: { commandId, kind: 'success'\|'error', text?, sourceEventSeq? }`（【已验证】该事件在 `SessionEventMap` 与 `KNOWN_SESSION_EVENT_TYPES` 中） |
| `input.hint` | **必填、非空字符串**，否则注册时抛 `TypeError: command "x" input hint must be a string` / `must not be empty` |
| `input.attachments` | 必须是 boolean，否则抛 `TypeError` |
| 参数解析 | **DSH 不做结构化解析**，只把「命令名之后的所有字符」原样给你 |
| `recordInput` | 默认记录；`recordInput: false` 则不把 `args` 写进 `command/run` 事件 |
| 注册/注销通知 | `commands/change`（emit，无参）——客户端据此刷新命令列表 |
| 返回的 disposer | 幂等，删除该注册 |

**参数解析的真实实现（注意 leading space）：**

```
证据: /dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js:96-112
/**
* Parse an exact slash command without normalizing its trailing input.
*/
function parseCommand(line) {
	const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
	if (match === null) return void 0;
	const name = match[1];
	if (name === void 0) return void 0;
	return Object.freeze({
		name,
		rawInput: line.slice(match[0].length)
	});
}
```

- 命令名必须匹配 **`[a-z][a-z0-9_-]*`**（小写字母开头；**大写、数字开头都不合法**）。
- 名字后必须跟 **末尾 / 制表符 / 换行 / 空格**。
- **`/openwhale abc` → `rawInput === " abc"`（前面有一个空格！）**。请自己 `.trim()` 或 `.trimStart()`。
- `/openwhale` → `rawInput === ""`。

**真实注册示例：**

```
证据: /dsh/node_modules/@deepseek-ai/dsh-command-goal/lib/index.js:174-185
function apply(ctx) {
	ctx.commands.register({
		definitionId: CommandDefinitionId("@deepseek-ai/dsh-command-goal"),
		name: "goal",
		description: "Set or view the goal for a long-running task",
		input: {
			hint: "[<objective>|clear|edit <objective>|pause|resume]",
			attachments: true
		},
		handler: (invocation) => executeGoalCommand(ctx, invocation)
	});
}
```

### 8.2 「`/openwhale` 展示绑定二维码」最小示例

```ts
// 依据: dsh-commands/lib/typert.host.js 的 CommandDefinition/CommandInvocation/CommandResult
//       + dsh-command-goal/lib/index.js:174-185 的注册写法
//       + cmd 解析正则 dsh-commands/lib/index.js:103（rawInput 带前导空格）
export const inject = ['commands']

export function apply(ctx: any) {
  ctx.commands.register({
    definitionId: 'my-plugin/openwhale',
    name: 'openwhale',                     // 必须 [a-z][a-z0-9_-]*
    description: '显示绑定二维码 / 当前绑定状态',
    input: { hint: '[refresh|status|unbind]' },
    handler: ({ rawInput, agent, signal }) => {
      const arg = rawInput.trim()            // ← rawInput 前面带空格，必须 trim
      if (arg === 'status') {
        return { kind: 'success', text: `当前绑定：${'device-abc'}（会话 ${agent.id}）` }
      }
      if (arg === 'unbind') {
        // 清掉持久化设备信息（见 8.4）
        return { kind: 'success', text: '已解除绑定。' }
      }
      if (arg !== '' && arg !== 'refresh') {
        return { kind: 'error', text: `未知参数 "${arg}"，可用：refresh | status | unbind` }
      }
      // 二维码：文本形式直接用等宽字符画，客户端会按 Markdown 渲染
      const url = `http://127.0.0.1:${ctx.webServer.port}/openwhale/bind?token=${'TOKEN'}`
      return { kind: 'success', text: `扫码绑定：\n\n\`${url}\`\n\n或在浏览器打开上面的地址。` }
    },
  })
}
```

> **二维码图片怎么给？** 两条路（【推断】，因为没找到现成的「命令返回图片」示例）：
> 1. **纯文本 QR**（最省事，无新依赖）：用 `qrcode` 之类的库生成 ASCII/ANSI 文本，放进 `text`。
> 2. **图片**：`ctx.attachments.saveFile({ data: pngBytes, name: 'bind.png' })` → 拿 `FileAttachmentRef`，再用 `ctx.attachments.fileHostPath(ref)` 得到路径；或注册一个 `ctx.webServer` 路由 `/openwhale/bind.png` 直接吐 PNG 字节，让用户在浏览器打开。**`CommandResult` 里没有「附件/图片」字段**，所以命令本身无法直接返回图片。

### 8.3 `ctx.storage` / `ctx.storageDomain` 契约 【已验证】

```
证据: cordis_inspect_query(platform=host, provider=Service, service="storage")
readonly backend: BackendRegistry = new BackendRegistry()
mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void
form<K extends keyof StorageForms>(form: K): StorageForms[K]
```

```
证据: cordis_inspect_query(service="storageDomain")
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
get(name: string): DomainImpl | undefined
async closeAll(): Promise<void>
```

```
证据: api-catalog.js:5039 / 5003 / 7143
export interface DomainSpec {
    readonly name: string;
    readonly version: number;
    readonly layout?: 'single' | 'per-record';
    readonly compatibleVersions?: readonly number[];
    readonly invalidRecords?: 'backup-and-skip';
    readonly global?: DomainGlobalSpec<unknown>;
    readonly tables: Record<string, DomainTableSpec>;
}

export interface Domain<S extends DomainSpec> {
    readonly name: string;
    readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;
    close(): Promise<void>;
}

export interface StorageForms { }   // ← 开放接口，form key 由实现方声明
```

- **`ctx.storage` 是给「后端/数据形态实现者」用的**（`mount`/`form`），**普通插件不用**。
- **普通插件用 `ctx.storageDomain.open(spec)`**（README 原文："callers can access records through the public `ctx.storageDomain` API"）。
- 真实消费者（可作为你的模板）：
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js:378
  const domain = await this.ctx.storageDomain.open(workspaceDomainSpec);
  ```
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js:2619
  this.ready = ctx.storageDomain.open(scheduleDomain).then(async (domain) => {
  ```
  ```
  证据: /dsh/node_modules/@deepseek-ai/dsh-session-projection-cache/lib/index.js:152
  const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec);
  ```
- 默认没有挂载后端 → `storageDomain` 不存在。最小组成（README 原文）：
  ```yaml
  - name: '@deepseek-ai/dsh-storage'
  - name: '@deepseek-ai/dsh-storage-json'
    config:
      root: /var/lib/dsh/data
  - name: '@deepseek-ai/dsh-storage-domain'
    config:
      backend: json
  ```
- **失败码（stable codes，README 已验证）**：`backend-not-found`、`form-not-mounted`、`duplicate-backend`、`duplicate-mount`、`version-mismatch`。
- **【推断】** 我没找到 `StorageForms` 的具体 key 集合；从 `dsh-storage-domain/lib/invariant.js:20` 的 `ctx.storage.form("domain")` 可确认 form key `'domain'` 存在。

### 8.4 在 `$DSH_HOME` 下持久化自己的配置/设备——推荐做法

**$DSH_HOME 的解析（官方 helper，可复用）【已验证】：**

```
证据: /dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js
const DSH_HOME_DIR_NAME = ".dsh";
const DSH_HOME_ENV = "DSH_HOME";
/**
* Resolve the single-root DeepSeek Harness home.
*
* Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
* `~/.dsh`. ... An empty or whitespace-only `$DSH_HOME` is treated as unset ...
*/
function resolveDshHome(configured, env = process.env) {
	const fromEnv = env[DSH_HOME_ENV];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())));
}
function dshHomePath(...segments) {
	return join(resolveDshHome(), ...segments);
}
function dshCachePath(optionsOrSegment = {}, ...segments) { /* → <home>/cache/... */ }
export { DEFAULT_DSH_HOME_DISPLAY, DSH_HOME_DIR_NAME, DSH_HOME_ENV, canonicalizeWatchPath, defaultDshHome, dshCachePath, dshHomeDisplay, dshHomePath, expandHomePath, resolveDshHome };
```

本机实际值：`$DSH_HOME` 未显式设置时即 `~/.dsh` → `<local-path>`（profile 目录 `<local-path>` 已存在，与 README 的 "`$DSH_HOME/profiles/<name>`" 一致）。
```
证据: /dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:466
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a ...
```

**四条候选路径对比：**

| 方案 | 契约 | 适合什么 | 状态 |
|---|---|---|---|
| **A. `ctx.settings`**（`@deepseek-ai/dsh-settings`）| Config 里把字段标 `.volatile()`，并在 `apply` 里 `ctx.inject(['settings'], sctx => sctx.settings.configure({ auto: false }, ctx.fiber))` | **用户要能在 GUI 里看到并编辑**的插件配置/偏好 | 【已验证】有真实用法 |
| **B. `ctx.storageDomain.open(spec)`** | `DomainSpec` + `KvTable` 读写 | **结构化的、非会话的持久化数据**（设备表、工作区记录、缓存） | 【已验证】有真实用法 |
| **C. 直接用 `node:fs` 写 `$DSH_HOME/<your-dir>`** | `dshHomePath('my-plugin')` | **一两个小文件**（token、设备 id、二维码绑定信息） | 【已验证】官方自己也这么做 |
| **D. `ctx.storage.mount/form`** | `StorageForms` | 你是**存储后端/数据形态的实现者** | 不适用普通插件 |

**A 的证据（`ctx.settings` 是官方“插件配置”通道）：**
```
证据: /dsh/node_modules/@deepseek-ai/dsh-settings/README.md
"Edit fields that plugins declare with `.volatile()` and inspect their effective values. ...
 **Changes persist through the active profile's Cordis patch.**"
"A plugin that ships its own page registers `configure({ auto: false }, ctx.fiber)` as an effect inside an optional `ctx.inject(['settings'], ...)` child from `apply` ..."
```
```
证据: <local-path>
	ctx.inject(["settings"], (sctx) => {
		const ns = ownEntryId(ctx);
		if (ns === void 0) { ctx.logger?.warn?.(...); return; }
		ctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), "dsh-better-sidebar: settings page policy");
```
> 注意：`ctx.settings` 的**读取**是 `sctx.settings.describe({ redactSecrets: true })` → 按 `ns`（= profile entry id）找 descriptor → `descriptor.value` / `descriptor.revision`（【已验证】`:6808-6817`）。**写入**走 `configEditor`/Settings 服务，持久化到 profile 的 `cordis.patch.yml`。

**C 的证据（官方就是这么存本机数据的）：**
```
证据: /dsh/node_modules/@deepseek-ai/dsh-attachment-local/README.md
"Store images and generic file attachments durably **below `DSH_HOME`** on the machine running DSH."
"Attached images are kept below `<DSH_HOME>/attachments/v1` on this machine."
```
其他真实例子（从 grep 得到，已验证存在）：
- `<DSH_HOME>/.credentials.yaml`（`dsh-credentials-local`）
- `<DSH_HOME>/AGENTS.md`（`dsh-agent-instructions`：用户全局指令文件）
- `<DSH_HOME>/attachments/v1`（`dsh-attachment-local`）
- `<DSH_HOME>/profiles/<name>/`（profile 目录）
- `<DSH_HOME>/cache/`（`dshCachePath`）

**推荐结论（我的判断，标注为【推断/建议】，因为文档没有一句话直说“第三方小配置该用哪个”）：**
- **用户可见可改的配置** → 方案 A（`.volatile()` + `ctx.settings`），因为只有它能进 GUI 设置页并持久化到 profile patch。
- **插件自己的机器状态 / 设备凭据 / 绑定 token** → 方案 C：`dshHomePath('my-plugin')` + `node:fs`，与 `attachment-local`、`credentials-local` 一致。
  ```js
  // 依据: @deepseek-ai/dsh-home-paths 的 dshHomePath(...segments)
  import { mkdir, readFile, writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

  const dir  = dshHomePath('my-plugin')                    // <DSH_HOME>/my-plugin
  const file = join(dir, 'device.json')

  async function loadDevice() {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch { return undefined }
  }
  async function saveDevice(device) {
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify(device, null, 2), 'utf8')
  }
  ```
  > 【推断】建议加版本字段（如 `{ "version": 1, ... }`）以便将来迁移；并注意该目录**不在** session 沙箱的 workspaces 里，写入不受 `ctx.fs` 的 workspace 策略管辖（`dsh-attachment-local` 正是这样写的）。
- **结构化的多表数据**（例如要维护一张设备表 + 一张 token 表） → 方案 B（`ctx.storageDomain`），但要先确认 profile 里挂了 storage 三件套。
- **不要**用方案 D。

---

## 9. 可直接复制使用的最小代码片段（汇总索引）

每个片段都在上文出现，这里给来源对照表：

| # | 片段 | 主要来源 |
|---|---|---|
| 1 | 创建 + 驱动 agent（含 sessionId 自造、`whenIdle`、`dispose`） | `/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js:313-340` |
| 2 | `steer` / `inject` / `cancel` 变体 | `/dsh/node_modules/@deepseek-ai/dsh-agent/README.md` + `dsh-agent-loop/lib/index.js:806-821` |
| 3 | 监听 `session/event` 拿 assistant 文本 / 工具调用 / 工具结果 / turn 错误 | `dsh-api-session-controller/lib/index.js:1464` + `dsh-agent-preset-registry/lib/typert.host.js`（`SessionEventMap`） |
| 4 | 流式打字机：`ctx.on('agent/assistant-stream', ({agent, frame}) => …)` | `dsh-api-session-controller/lib/index.js:1388,1481` + `api-catalog.js:4531` |
| 5 | per-agent 口语化 persona（`setup(agentCtx, agent)` 或 `agent.ctx.inject(['systemPrompt'])`） | `dsh-file-reference-local/lib/index.js:339-351` + `dsh-system-prompt/lib/index.js:10-48,240-243` |
| 6 | 全局 persona 配置（`personaPrefix`） | `dsh-system-prompt/lib/index.js:201-207` |
| 7 | workspace 字节流读取（`readByteRange` 循环）+ `readBytes` 有界读 | `cordis_inspect_query(service="fs")` + `dsh-fs/README.md` |
| 8 | 把字节存成 attachment 并拿 host path | `dsh-attachment/lib/README.md` + `api-catalog.js:6223-6231` |
| 9 | HTTP 路由 + WebSocket upgrade + 读端口 | `dsh-better-sidebar/lib/index.js:6863-6876,7065-7077` + `dsh-host-webserver/lib/index.js:163-197,261-332` |
| 10 | 插件骨架（package.json + cordis.patch.yml + index.ts） | `dsh-better-sidebar/package.json` + `cordis.patch.yml` + `lib/index.js:7199` + `dsh-app-boot/lib/index.js:2721-2761` |
| 11 | `/openwhale` 命令 | `dsh-commands/lib/typert.host.js` + `dsh-command-goal/lib/index.js:174-185` + `dsh-commands/lib/index.js:103` |
| 12 | `<DSH_HOME>/my-plugin/device.json` 持久化 | `dsh-home-paths/lib/index.js` + `dsh-attachment-local/README.md` |

---

## 10. 不确定 / 未验证清单（供后续验证）

按重要性排序。**已标注每条的验证缺口。**

### 高优先级（会影响能否跑通代码）

1. **`MessageSourceMap` 是否真的没有 `'plugin'` kind。**
   `dsh-agent/README.md` 的 steer 示例用了 `source: { kind: 'plugin', plugin: 'my-plugin' }`，但 `dsh-agent-preset-registry/lib/typert.host.js` 的 `MessageSourceMap` 里**没有** `'plugin'`（列了 17 个其他 kind）。
   **缺口**：我只读了一个包的投影；未穷尽所有包的 `MessageSource` 合并声明（TS interface 合并可能来自我没读的模块）。**建议**：写一个 smoke test 传 `{ kind: 'plugin', plugin: 'x' }` 看 `session.append` 是否拒绝。**保守做法：用 `{ kind: 'user' }`。**

2. **`Api-catalog` / Inspector 投影会静默丢字段。** 已证实 `AssembleContext.agent` 被丢、`SessionEventMap` 被硬编码截断。**所以本报告中任何「声明来自 Inspector」的接口都可能不完整。**
   **缺口**：我没有逐个接口做源码穷举。**建议**：关键接口（`CreateAgentOptions`、`PromptSection`、`CommandDefinition`、`WebRoute`）我已用源码 / 多来源交叉验证；其余接口若报编译错，先怀疑投影不全。

3. **`ctx.fs` 是否真的没有无界字节流读取。**
   我基于 Service 投影的方法清单（无 `streamBytes`）判定「没有」，并给出 `readByteRange` 循环作为补偿方案。
   **缺口**：未验证具体后端（`fs-local` / `fs-sandbox`）是否**额外**暴露了非契约方法。**建议**：`Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.fs))` 打印一次。

4. **`readByteRange` 分块循环是否真的能读完整文件。**
   `readByteRange` 的语义（"a backend transfers at most the requested `length` beyond the prefix it skips"）来自 README，我**没有找到仓库内的现成循环示例**。**标记为【推断】。**

5. **`deliverables/presented` 事件的 payload 形状。**
   它存在于 `KNOWN_SESSION_EVENT_TYPES`，但**我没有读到它的字段**。这可能是「把 agent 产出文件声明为用户可见交付物」的正确通道。**未找到具体契约。**

6. **`SandboxExecutionPolicy` 的具体值 + `ctx.fs.writeText` 的 `sandboxPolicy` 该传什么。**
   只验证了参数位置（第 5 个）。**未找到取值与构造方式。**

### 中优先级（影响正确性细节）

7. **`Agent` 接口的完整 TS 声明。** 我从 `ReactLoopAgent` 类的实例字段 + README 反推（`id`/`session`/`ctx`/`inbox`/`status`/`followup`/`steer`/`inject`/`cancel`/`whenIdle`）。**可能还有我没枚举到的成员。** 同理 `Inbox` 结构接口的声明未读到（只有实现类的方法列表）。

8. **`AgentOptions.reasoningEffort` 的合法值（`ReasoningEffortId`）。** branded string，**未找到枚举**。`dsh-agent-default-model` 的 config 里有 `reasoningEffort: high`（见本机 `cordis.patch.yml:28`），**推测**合法值形如 `'low' | 'medium' | 'high'`，但**未验证**。

9. **`AgentOptions.maxTokens` 是否必须为正数、上限多少。** 未找到校验代码。

10. **`ctx.agents.create` 省略 `meta.cwd` 时的默认 cwd。** README 说 `meta` 是 "optional fresh-session workspace metadata"，但没说什么默认值。**未验证。**

11. **`SessionId` 的格式约束（长度/字符集）。** 未找到任何校验；但这不代表下游（文件名、HTTP 路由参数、持久化路径）能接受任意字符。**未验证。**

12. **`insert` patch 行的 `id` 是否必填 / 顺序控制手段。** 我确认了 `insert` **没有** `before`/`after` 字段，顺序即数组顺序；但没找到「insert 行的 id 必填」的规范文本（实现上可选）。

13. **`entryList` 的完整 item schema。** 我从 `patchStructure()` + `entryMetadata()` + `allOf` 组合推断 insert 行允许 `id/name/config/group/disabled/inject/intercept/isolate`，但**没有读到 `ref("entryList")` 的定义本身**。

14. **`name` 导出是否强制、是否必须等于 npm 包名。** 未找到规范文本；两个真实插件都导出了且等于包名。

15. **`StorageForms` 的具体 key 集合。** 接口声明是空的（`export interface StorageForms { }`），由实现方通过声明合并扩展。只从 `dsh-storage-domain/lib/invariant.js:20` 的 `ctx.storage.form("domain")` 确认了 `'domain'`。

16. **`ctx.storageDomain.open(spec)` 中 `tables` 的 `DomainTableSpec` / `KvTable` 精确方法（get/set/delete/list 的签名）。** 我读到了 `DomainSpec`/`Domain` 外层，**没有读到 `KvTable` 的方法签名**。要真写 storage 代码前必须补。

17. **`ctx.attachments` 的 `FileAttachmentRef` 是否可跨进程/重启复用。** README 说图片可以跨重启复用、对象"never deleted automatically"。**文件（generic file）路径跨重启的行为未明确验证。**

18. **`fileHostPath` 返回 `undefined` 的确切条件。** README 说"When the current execution filesystem maps the stored host object"，**没有给出判定函数**。建议总是做 `undefined` 分支。

19. **`tool/call` 的 `arguments` 是 JSON 字符串（已验证），但失败/流式半截参数如何处理。** `tool-call-delta` 的 `argumentsDelta` 会分片；`AssistantStreamAccumulator` 会合并。**未验证 `tool/call` 事件是否保证是完整合法 JSON。**

20. **`request/context` 的 `RequestContext.contextWindow` 语义** —— 未深究。

### 低优先级 / 超出本次范围

21. **客户端半（`dsh.client`）的完整 API** —— `dsh.client.inject` / `platform` / `manifestVersion` 的精确 schema、client plugin 的入口导出、Slot 注册。**本次完全未调研**（你只问了宿主半）。

22. **`ctx.settings` 的写入 API** —— 我验证了读取（`describe`）与 `configure`（页面策略），**写入方法的精确签名未读到**（README 说"Changes persist through the active profile's Cordis patch"，可能只经由 `configEditor`）。

23. **`ctx.connection.authenticatedUrl(base)` 的完整契约** —— 只看到一处用法。若要做需要鉴权的自定义路由，需要它的语义（补什么参数）。

24. **`webServer` 的 `compression` 中间件是否作用于已注册路由** —— 源码显示 gzip 包在 `handle` 外层（`this.server = createServer((req,res) => { const next = () => handle(req,res)...; if (this.gzip === undefined) next(); else this.gzip(req,res,next); })`），**默认 config 是 `compression: 'none'` 所以我判断默认不压缩；但"默认值来自 DSH profile 的实际配置"我未核实。**

25. **`dsh-image-gen` / `dsh-better-sidebar` 之外，`<local-path>` 里是否还有更适合作为模板的插件** —— 我只重点读了这两个。

26. **`@deepseek-ai/cordis` 的 `ctx.effect` / `ctx.inject` / `ctx.on` 的精确签名** —— 本次当作已知可用，**没有读 Cordis 自身的类型声明**（`/dsh/node_modules/@deepseek-ai/cordis/lib/types/context.js` 存在且有 `.map`，本可直接读）。

27. **`SESSION_FORMAT_VERSION = 4`（已验证）** 对第三方事件的影响细节：外部插件事件必须带 `ignorable: true`，否则**新版本写的日志旧版本会拒绝读**。具体怎么在 `session.append` 里加 `ignorable`（是 `SessionEvent` 上的字段，但 append 的入参形状未读）**未验证**。

---

## 附录 A：本次用到的探测命令

```powershell
# workdir: <repo>
node _recon\asar.mjs list  "^/dsh/node_modules/@deepseek-ai/[^/]+/package.json$" 100
node _recon\asar.mjs cat   "/dsh/node_modules/@deepseek-ai/dsh-agent/README.md" 200
node _recon\asar.mjs grep  "followup|whenIdle|steer\(" "^/dsh/node_modules/@deepseek-ai/dsh-agent(-loop)?/lib/.*\.js$" 60
# 关键：把大文件落到临时文件后再用 read/grep 精读（asar.mjs 默认 maxLines=2000，必须显式调大）
node _recon\asar.mjs cat "/dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js" 20000 | Set-Content _recon\_tmp_api-catalog.js -Encoding utf8
```

运行时 Inspector（等价于读 typert 投影，但更快）：

```
cordis_inspect_query { platform: "host", provider: "Service", method: "listService", input: { service: "agents" } }
cordis_inspect_query { platform: "host", provider: "Service", method: "listService", input: {} }              // 全量目录
cordis_inspect_query { platform: "host", provider: "Event",   method: "listEvents",  input: { event: "session/event" } }
cordis_inspect_query { platform: "host", provider: "Config",  method: "listConfigs", input: { name: "dsh-better-sidebar" } }
```

> `listService`（无 `service`）会返回很大的 JSON 并被 spill 到临时文件；在大上下文里**务必带 `service`**。

## 附录 B：确定性最强的三条"照抄即可"参考实现

| 需求 | 照抄这个文件 |
|---|---|
| 一站式 create → followup → whenIdle → 收尾 | `/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js`（全文 369 行） |
| 一个生产级宿主插件（HTTP 路由 + WS + settings + 自定义 schema） | `<local-path>`（7199 行，第 6039-7199 是 apply 主体） |
| per-agent 作用域注册的规范写法 | `/dsh/node_modules/@deepseek-ai/dsh-file-reference-local/lib/index.js:339-351` |
