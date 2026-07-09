# 从零开发一个 OpenCode 插件：架构、生态、SDK 与一次完整的实战复盘

> 作者按：最近我给 OpenCode 写了一个小插件 `opencode-tab-status`——把 AI 跑任务时的状态（思考 / 工具 / 完成 / 等待）实时显示到 Windows Terminal 的标签页标题上。看似简单，但从"想法"到"能 npm 一键安装、有测试、有 CI 自动发布"，中间踩了不少坑，也把 OpenCode 的插件体系和 SDK 摸了一遍。这篇文章把**开发经验**和**OpenCode 生态设计**揉在一起，既是给后来者的避坑指南，也算是对这个插件的一次正式介绍。

---

## 一、为什么需要一个"标签页状态"插件

如果你像我一样，经常在终端里同时开 **五六个 OpenCode 会话**——一个改后端、一个写前端、一个跑调研、还有两个是临时起的——那么问题马上就来了：

Windows Terminal 的每个标签页标题默认是 `管理员: Windows PowerShell` 或者 `opencode`。**你根本分不清哪个 tab 在跑、哪个已经跑完、哪个正卡在等你点"允许执行"**。

切过去看？太浪费注意力。不看？又怕某个 agent 早跑完了自己在那空转，或者更糟——它其实在等你确认某个危险命令，你却没切过去。

所以我的需求很朴素：

1. **一眼知道每个 tab 在干嘛**（状态前置）。
2. **状态要视觉区分强**（用 emoji 图标而不是文字，省 tab 空间）。
3. **切到已有会话时，能看到它的标题和模型**（而不是一片空白的"空闲"）。
4. **工具需要用户确认/提问时，有清晰的"等待"状态**，提醒我去处理。
5. **最终完成时是绿色的 ✅**，代表这一轮交互结束、可以继续输入了。

这 5 条，就是 `opencode-tab-status` 的全部产品需求。下面讲我是怎么把它落地的，以及过程中对 OpenCode 插件体系的理解。

---

## 二、OpenCode 插件架构：它是怎么"挂"进去的

OpenCode 的插件是一个 **JavaScript / TypeScript 模块**，导出一个（或多个）异步函数，函数接收上下文对象、返回一个"钩子（hooks）对象"。

最小骨架：

```js
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  console.log("Plugin initialized!")
  return {
    // 钩子实现放在这里
  }
}
```

上下文里几个关键字段：

- `client`：一个 OpenCode SDK 客户端，用来和 AI / 服务交互（比如写结构化日志 `client.app.log()`）。
- `$`：Bun 的 shell API，可以直接跑命令。
- `project` / `directory` / `worktree`：当前项目、工作目录、git worktree 路径。

插件有两种加载方式，我两种都用过：

| 方式 | 位置 | 适合 |
|------|------|------|
| 本地文件 | `~/.config/opencode/plugins/`（全局）或 `.opencode/plugins/`（项目级） | 开发调试、个人自用 |
| npm 包 | 在 `opencode.json` 写 `"plugin": ["opencode-tab-status"]` | 分发、复用、给他人一键安装 |

npm 插件启动时由 **Bun 自动安装**，依赖缓存在 `~/.cache/opencode/node_modules/`。加载顺序也有讲究：全局配置 → 项目配置 → 全局插件目录 → 项目插件目录，所有来源的钩子会**按顺序依次执行**。

### 钩子的两种形态

OpenCode 的插件钩子分两类：

**（1）事件订阅（`event` hook）**

一个统一的 `event` 钩子，内部用 `event.type` 区分所有事件：

```js
return {
  event: async ({ event }) => {
    if (event.type === "session.idle") { /* 一轮结束 */ }
  }
}
```

**（2）具名前置/后置钩子**

比如 `tool.execute.before` / `tool.execute.after`，签名是 `(input, output)`，可以**修改**传给工具或返回的参数：

```js
return {
  "tool.execute.before": async (input, output) => {
    if (input.tool === "bash") {
      output.args.command = escape(output.args.command)
    }
  }
}
```

这种"能改写 input/output"的能力非常强——权限拦截、环境变量注入、命令改写都靠它。

---

## 三、OpenCode 的事件宇宙：你能"听见"什么

理解插件开发，一半是理解**事件清单**。OpenCode 把运行时几乎所有的变化都暴露成了事件，我的插件主要消费这几类：

**会话事件（Session）**
- `session.created` / `session.updated`：拿到会话标题、模型、token、花费。
- `session.status`：状态 `busy` / `idle`。
- `session.idle`：**会话真正把控制权交还给你**的专用事件——这是判断"本轮结束"的黄金信号。
- `session.error`：出错了。
- `session.compacting` / `experimental.session.compacting`：上下文压缩（长会话自动摘要）。

**消息 / 部件事件（Message / Part）**
- `message.part.updated`：流式更新。工具调用的开始/进行/完成，都在这里。
- `message.updated`：消息级更新，能拿到模型、token、花费。

**权限事件（Permission）**
- `permission.asked` / `permission.replied`：工具需要你确认时触发——这是"等待状态"的关键来源。

**TUI 事件**
- `tui.prompt.append` / `tui.command.execute`：你在输入框打字、执行斜杠命令时触发，同样代表"在等你"。

**工具事件**
- `tool.execute.before` / `tool.execute.after`：工具执行前后。

**还有**：文件事件（`file.edited` / `file.watcher.updated`）、LSP 事件、Todo 事件、Shell 事件（`shell.env`）、命令事件（`command.executed`）等。生态里的红队/安全类插件、环境注入类插件，基本都挂在 `shell.env` 和 `tool.execute.before` 上。

---

## 四、实战复盘：把状态机写对，比想象中难

需求看起来就是"显示个标题"，但真正写起来，最大的坑不是"怎么写 OSC"，而是**状态机怎么不误报**。

### 坑 1：Edit 工具执行完会"假完成"

最早版本里，每当一个工具（比如 `Edit`）执行完成，我都会把状态设回"空闲/完成"。结果现象是：agent 调了 Edit 改完文件 → 标题一闪而过 `✅完成` → 紧接着又开始 `💭思考`。

用户（也就是我自己）看到那一闪的 ✅，以为真的干完了，结果 agent 还在继续。这是**典型的误报**。

根因：OpenCode 在工具之间会发出**短暂的 `session.status = idle`**，这只是"工具间隙"的瞬时空闲，并不代表一轮交互结束。

**解法：引入 `inTurn` 标志位。**

我不再用"工具完成 = 空闲"这种朴素逻辑，而是加了一个 `inTurn`（回合进行中）状态：

- 会话 `busy` → `inTurn = true`。
- 工具完成 → `inTurn` **保持 true**（回合还在继续）。
- 只有当收到**专用的 `session.idle` 事件**时，才把 `inTurn = false`、状态归位到"完成"。
- 任何"瞬时 idle"只要 `inTurn` 还是 true，就忽略。

这一改，假完成彻底消失。

### 坑 2：完成状态被终端"吞掉"

另一个怪现象：会话结束后过一会，tab 标题从 `✅完成` 变成了 `管理员: Windows PowerShell`。

根因：我当初在插件里写了 `process.on("exit", () => setTabTitle(""))`——想优雅退出时清空标题。但终端 shell 在 OpenCode 退出后会**自动接管**标题，清空动作反而让标题回退到了 shell 默认名。

**解法：干脆不在退出时清标题。** 让最后一帧 `✅完成` 自然留在那，shell 接管时再覆盖。这样用户回看 tab 时，知道"这个会话是正常跑完的"。

### 坑 3：OSC 转义序列直接写 stdout 就行

最初我纠结要不要搞个"companion 进程"去读状态再改标题。试过之后发现完全不需要——**插件的 stdout 直接就能到达交互终端的 tty**。只要往 `process.stdout` 写 OSC 0 序列，标题就变了：

```js
const ESC = "\x1b"
const setTabTitle = (text) => {
  process.stdout.write(`${ESC}]0;${text}${ESC}\\`)
}
```

OSC 0 会同时设置窗口标题和 tab 标题。注意：**Windows Terminal 的 tab 标题是纯文本，不渲染 ANSI 颜色**，所以"绿色 ✅"其实靠的是 emoji 字形（🌱💭🔧✅⏳⚠️）来做视觉区分，而不是 ANSI 颜色码。这一点对设计很关键——别在 tab 标题里堆颜色码，没用。

### 坑 4：状态前置，但别堆文字

终端 tab 宽度有限。最初我显示 `✅完成 · 标题 · 模型`，空间吃紧。用户反馈"重要信息放前面、状态要视觉区分强"。最后定下的布局（状态永远最前）：

```
<状态图标> · <标题> · <模型> · [<工具名>] · <用量>
```

并且**默认只显示图标、不显示"完成/思考"文字**（`STATUS_TAB_ICON_ONLY` 默认开），用 `✅` 而不是 `✅完成`——省空间，一眼可辨。需要文字时设 `STATUS_TAB_ICON_ONLY=0` 即可恢复。

---

## 五、可测试性：把"状态机"和"副作用"拆开

这是整个项目里我最满意的一个设计决定。

插件入口（`plugins/opencode-tab-status.js`）负责"副作用"：往 stdout 写 OSC、发通知。而核心逻辑抽成一个**纯函数模块**（`src/status.js`）：

```js
export function createStatus(opts) {
  const state = { phase: "idle", inTurn: false, waiting: false, ... }
  return {
    apply(event) { /* 只算状态，返回 "done"/"error"/null */ },
    title() { /* 根据 state 拼标题字符串 */ }
  }
}
```

`apply(event)` 是**纯函数**：喂事件、读标题，没有任何 I/O。这意味着它能被 `node --test` 直接单元测试，而且测试还能覆盖那些"容易误报"的边界：

- 工具之间瞬时 idle **不**闪完成。
- 真正的 `session.idle` **才**显示完成，且通知只触发一次。
- 权限询问时 `⏳等待` 优先级最高，哪怕工具还在跑。
- 无 emoji 模式下自动回退显示文字，状态不丢失。

最终写了 **12 个单元测试，全过**。这让我后来敢放心改逻辑——每次改动跑一遍测试，边界立刻知道有没有破。

> 经验：**任何带"状态"的插件，都应该把状态机做成可测试的纯函数。** 你debug的90%时间会花在"某个事件序列下状态不对"，纯函数测试正好精准覆盖这些序列。

---

## 六、插件 vs SDK：OpenCode 的两种扩展姿势

讲完实战，回到更大的图景。OpenCode 给开发者提供了**两条正交的扩展路径**：插件（Plugin）和 SDK。

### 插件：在 OpenCode 进程内"挂钩子"

插件跑在 OpenCode 自己的运行时里，**被动响应事件**。适合：

- 监听/改写/拦截 OpenCode 自身行为（权限、工具、环境变量、通知）。
- 往 TUI 注入 UI（toast、prompt 追加、打开选择器）。
- 给所有会话统一加能力（统计、审计、安全红队、状态展示）。

插件能做的事，文档里列得很精彩：
- **安全类**：`opencode-vibeguard` 在 LLM 调用前把密钥/PII 替换成占位符，本地再还原；`env-protection` 禁止读 `.env`。
- **成本/可观测**：`opencode-wakatime` 统计使用时长；`opencode-helicone-session` 注入 Helicone 会话头做请求分组；`opencode-sentry-monitor` 接 Sentry 做 AI 监控。
- **能力增强**：`oh-my-opencode` 提供后台 agent、预置 LSP/AST/MCP 工具；`opencode-background-agents` 实现 Claude Code 风格的后台异步 agent；`opencode-supermemory` 跨会话持久记忆；`opencode-firecrawl` 接 Firecrawl 做网页抓取。
- **编排/工作流**：`opencode-conductor`（Context→Spec→Plan→Implement）、`micode`（Brainstorm→Plan→Implement）、`opencode-goal-plugin`（`/goal` 自动持续直到目标完成）。
- **通知类**：`opencode-notifier`、`opencode-notificator` 在权限/完成/错误时弹桌面通知——和我的 tab 状态插件是"互补"关系：一个在 tab 上、一个弹窗。

插件还能**自定义工具**（用 `tool()` 辅助函数，基于 Zod schema），甚至**改写上下文压缩（compaction）提示词**。

### SDK：把 OpenCode 当"引擎"往外调

`@opencode-ai/sdk` 是一个类型安全的 JS/TS 客户端，它**启动/连接一个 OpenCode server**，让你在 OpenCode 之外用代码驱动它：

```js
import { createOpencode } from "@opencode-ai/sdk"
const { client } = await createOpencode()
const session = await client.session.create({ body: { title: "My session" } })
const result = await client.session.prompt({
  path: { id: session.id },
  body: { parts: [{ type: "text", text: "Hello!" }] },
})
```

SDK 暴露的能力几乎等于 OpenCode 的全部surface：
- **会话管理**：`session.create / list / get / prompt / command / shell / abort / share`。
- **文件/检索**：`find.text / find.files / find.symbols / file.read / file.status`。
- **TUI 控制**：`tui.appendPrompt / showToast / openSessions`（可以代码控制界面）。
- **结构化输出**：`session.prompt` 支持 `format: { type: "json_schema" }`，让模型返回**经校验的 JSON**——非常适合做"抽取/分类"类管道。
- **事件流**：`event.subscribe()` 用 SSE 实时监听所有事件（这和我插件里 `event` 钩子拿到的是同一套事件）。

SDK 适合**在 OpenCode 之外**构建东西：
- **机器人/客户端**：`kimaki`（Discord 机器人控制 OpenCode 会话）、`opencode.nvim`（Neovim 编辑器集成）、`portal`（移动端 Web UI）、`OpenCode-Obsidian`（Obsidian 内嵌）。
- **自定义 Agent / 编排**：用 SDK 把 OpenCode 当推理引擎，外面套自己的流程控制、多 agent 协作、定时任务。
- **Vercel AI SDK  provider**：`ai-sdk-provider-opencode-sdk` 让 OpenCode 直接接入 Vercel AI SDK 生态。

### 怎么选？一张表

| 维度 | 插件（Plugin） | SDK |
|------|---------------|-----|
| 运行位置 | OpenCode 进程内 | OpenCode 之外（你的程序/服务） |
| 触发方式 | 被动，响应事件/钩子 | 主动，你调 API |
| 典型产物 | 给 OpenCode 加能力/改行为 | 用 OpenCode 做引擎的外部应用 |
| 能否改写工具输入输出 | ✅（`tool.execute.before`） | ❌（只能发 prompt） |
| 能否控制 TUI | ✅ | ✅（但那是另一个进程控制界面） |
| 典型场景 | 通知、安全、状态、审计、自定义工具 | 机器人、编辑器集成、Web UI、自定义编排 |

**简单说**：想改 OpenCode 自己 → 写插件；想用 OpenCode 去造别的东西 → 用 SDK。

我的 `opencode-tab-status` 显然是插件：它要"挂"在 OpenCode 内部，被动监听状态、改写 tab 标题。如果用 SDK 反而别扭——你得在外面另起一个进程订阅事件流，再想办法改终端标题，多此一举。

---

## 七、发布：从"本地 js"到"npm 一键装"

开发时我把插件放在 `~/.config/opencode/plugins/status-tab.js` 直接跑，调顺了之后要分发，就得上 npm。

### 包的结构（轻量是底线）

```
opencode-tab-status/
├── plugins/opencode-tab-status.js   # 自包含插件入口（无相对 import，靠 Bun 直载）
├── src/status.js                    # 纯状态机（被测试覆盖）
├── test/status.test.mjs            # 12 个单测
├── index.js                         # 同时 export 插件和状态机
├── package.json                    # type: module, 零依赖
├── README.md
└── LICENSE                         # MIT
```

几个关键点：
- **`"type": "module"` 必须有**，否则 Bun 不会把 `.js` 当 ESM 加载。
- **插件入口自包含**：我故意把状态机逻辑内联进 `plugins/opencode-tab-status.js`，而不是 `import "../src/status.js"`。原因是 OpenCode 从 npm 加载插件时，相对路径解析有时很脆；自包含一份最稳。代价是 `src/` 和 `plugins/` 要手动保持同步（靠测试兜底）。
- **零运行时依赖**：整个包 gzip 后几 KB，对终端插件来说这是体面的。

### CI：用 GitHub OIDC 自动发布，告别 OTP

我账号开了 npm 2FA，每次 `npm publish` 要动态码，很烦。于是给仓库加了 `.github/workflows/publish.yml`：**打 `v*` tag 就自动发布**，走 npm 的 **Trusted Publishing（OIDC）**——不用存 token、不用输 OTP。

```yaml
name: Publish to npm
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write        # OIDC 必需
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
      - run: npm test
      - run: npm publish --access public --provenance
        env:
          NODE_AUTH_TOKEN: ''
```

踩过的坑：零依赖、没 `package-lock.json`，所以 **不能写 `cache: npm` 也不能 `npm ci`**，否则 setup-node / install 直接报错退出。改成直接 `npm test` 即可。

发布后，用户在 `opencode.json` 加一行 `"plugin": ["opencode-tab-status"]`，启动即装，完事。

> 顺带提醒：如果你的 npm 被设成淘宝镜像（`registry.npmmirror.com`），`npm login` 会走镜像登录页，和官网账号不是一套体系，登不上也发不了。发官方包务必 `npm login --registry https://registry.npmjs.org/`。

---

## 八、插件能做什么，不能做什么（边界感）

写了这么一圈，我对 OpenCode 插件的能力边界有了清晰认知：

**能做（且擅长）：**
- 监听全部运行时事件，做展示/统计/审计。
- 拦截并改写工具调用（`tool.execute.before/after`）、注入环境变量（`shell.env`）。
- 往 TUI 推 toast、追加 prompt、打开各类选择器。
- 注册自定义工具、改写压缩提示词。
- 用 `client.app.log()` 写结构化日志。

**不太适合（该用 SDK 或别的手段）：**
- 完全替换 OpenCode 的交互模型（那是 SDK + 自建前端的事，比如 `opencode.nvim`）。
- 跨进程/跨机器的复杂编排（用 SDK 起多个 session 更自然）。
- 重度的 UI（TUI 钩子只能做轻量交互）。

状态展示、通知、安全、可观测、能力增强——这才是插件的甜蜜区。`opencode-tab-status` 正好落在最经典的那个格子里：**被动监听 + 轻量副作用（改标题/响铃）**。

---

## 九、关于 `opencode-tab-status`

最后，正式介绍一下这个插件本身。

**它解决什么**：多 OpenCode 会话并开时，一眼看清每个终端 tab 在干嘛。

**状态图标：**

| 图标 | 含义 |
|------|------|
| 🌱 | 刚打开，还没会话 |
| 💭 | 模型思考中 |
| 🔧 | 正在跑工具（显示工具名） |
| ✅ | 本轮完成，可以接着输入 |
| ⏳ | 等待你确认 / 回答（最高优先级） |
| ⚠️ | 出错 |
| 🗜️ | 上下文压缩中 |

**特性：**
- **纯插件、零依赖、零 companion 进程**——放进插件目录或 `opencode.json` 配一行即可。
- **状态前置 + 默认只显示图标**，省 tab 空间。
- **切到已有会话**显示该会话标题+模型（而不是空白空闲）。
- **工具间隙不会误报完成**（靠 `inTurn` + 专用 `session.idle` 判断）。
- **等待状态清晰**（权限询问/输入框交互时 `⏳`），提醒你去切 tab 处理。
- **完成/错误可响铃通知**（`STATUS_TAB_NOTIFY=1`）。
- **可配置**：语言、图标-only、字段顺序、通知，全部环境变量控制。
- **有测试**：12 个单测覆盖状态机边界。

**安装：**
```json
// opencode.json
{ "plugin": ["opencode-tab-status"] }
```
或本地复制 `plugins/opencode-tab-status.js` 到 `~/.config/opencode/plugins/`。

**仓库**：https://github.com/xwh5/opencode-tab-status （MIT，欢迎 star / PR）

---

## 十、写在最后

从一个"想看清 tab 在干嘛"的小抱怨，到一个能 npm 一键安装、有测试、有 CI 自动发布的开源插件，这段路让我对 OpenCode 的扩展模型有了实操层面的理解：**插件负责"在内部挂钩子改行为"，SDK 负责"在外部当引擎造应用"，两者正交、各司其职**。

如果你也在用 OpenCode，强烈建议试一下写插件——门槛比想象中低（一个 `export const` 函数就起步），回报却不小。哪怕只是像我这样，给 tab 标题加个状态图标，日常多开会话的体验都会肉眼可见地变好。

欢迎来仓库提 issue、给建议，或者干脆 fork 一个属于你自己的状态风格。Happy hacking。
