# chatgpt-bym 安装教程

从零把「伪人模式」跑起来。全文按「装依赖 → 放插件 → 填配置 → 验证」的顺序写，每步都有可检查的结果。

> 适用版本：1.0.1
> 如果你还没装云崽和协议端，先看仓库外的《TRSS-Yunzai + LuckyLilliaBot 部署指南》，本教程假设那一步已经完成。

---

## 0. 你会得到什么

装好之后：群里有人聊天，机器人会**按概率或关键词**偶尔插一句，像个普通群友。

它不回复每一条消息，不需要 @ 它。这正是「伪人」和普通问答插件的区别。

```
群消息 → 触发闸门(开关/白名单/关键词/概率/冷却) → 拉群聊记录 + 记忆
      → 调大模型 → 拆成几条 + 打字延迟 → 发出去
```

---

## 1. 环境依赖

### 1.1 必需

| 依赖 | 版本 | 用途 | 不装会怎样 |
|---|---|---|---|
| 云崽（TRSS-Yunzai） | 3.x | 插件宿主 | 插件无法加载 |
| Node.js | **>= 23.11** | 插件运行时（用全局 `fetch`） | 云崽自身起不来 |
| pnpm | >= 8 | 安装依赖 | — |
| Redis 或 Valkey | 5.x / 7.x | 云崽运行必需（不是本插件的要求） | 云崽启动即报错 |
| 协议端 | LLBot / 任一 OneBot11 实现 | 登录 QQ、收发消息 | 收不到消息 |
| 大模型接口 | OpenAI 兼容 | 生成回复 | 每次生成都失败 |

### 1.2 插件自身的依赖

只有一个：`js-yaml`（纯 JS，无原生编译）。

- 代码同时兼容 **4.x（CJS）** 和 **5.x（纯 ESM）**，装哪个都能跑。
- `package.json` 里锁的是 `^4.1.0`，因为 4.x 的兼容性最好。
- 如果手工装，别装完去改代码里的 `import * as YAML`——那是为了兼容 5.x 特意写的。

### 1.3 可选

| 依赖 | 什么时候需要 |
|---|---|
| Chrome / Chromium | 云崽把文字渲染成图片时用；本插件不渲染，但同群其他插件可能需要 |
| 多模态模型 | 只有 `vision.enable: true` 时才需要 |

### 1.4 你需要准备的四样东西

1. 模型接口地址，形如 `https://xxx/v1`
2. API Key
3. 模型名，如 `gpt-4o-mini`
4. 允许它说话的群号

---

## 2. 安装

### 2.1 放入插件目录

把整个 `chatgpt-bym` 目录放到云崽的 `plugins/` 下：

```
Yunzai/
└── plugins/
    └── chatgpt-bym/
        ├── index.js
        ├── package.json
        ├── apps/
        ├── config/
        ├── models/
        ├── presets/
        └── utils/
```

**目录名可以改**：插件内部所有路径都由 `import.meta.url` 推导，不依赖目录叫什么。

### 2.2 安装依赖

云崽的 `pnpm-workspace.yaml` 里有 `packages: ['plugins/**']`，所以插件是 workspace 的一个包。两种方式等价：

**方式 A（推荐）在云崽根目录：**

```bash
cd Yunzai
pnpm i
```

**方式 B 只装这个插件：**

```bash
cd Yunzai/plugins/chatgpt-bym
pnpm install
# 国内网络：
# pnpm install --registry=https://registry.npmmirror.com
```

验证依赖装好了：

```bash
ls node_modules/js-yaml/package.json
```

> 如果是**先装了云崽、后放插件**，必须重新在根目录跑一次 `pnpm i`，否则 workspace 不会把新包算进去。

### 2.3 首次启动，让它生成配置

```bash
cd Yunzai
node .
```

第一次启动会在 `plugins/chatgpt-bym/config/` 下生成 `config.yaml`，里面是全部默认值。

启动日志里应该出现：

```
**************************************
[bym] 伪人模式插件加载完成
[bym] 当前状态：已关闭，触发概率 0.02
**************************************
```

看到这两行就说明插件已经被加载了。**此时它不会说话**，因为 `enable: false`。

### 2.4 填最小配置

打开 `plugins/chatgpt-bym/config/config.yaml`，至少改这四处：

```yaml
enable: true                     # 总开关

trigger:
  groupMode: whitelist           # 白名单模式
  groups: ['123456789']          # 改成你的群号
  hitKeywords: ['bym']           # 发这个词必触发，用来测试
  probability: 0.02              # 其他消息 2% 概率接话

llm:
  baseURL: https://api.openai.com/v1
  apiKey: sk-xxxx                # 你的 key
  model: gpt-4o-mini
```

保存即可，配置会自动热加载（约 1 秒内生效），**不需要重启**。

### 2.5 云崽侧的三个前提

这三处不是本插件的配置，但不改它插件就没反应：

| 文件 | 字段 | 要求 |
|---|---|---|
| `config/config/group.yaml` | `onlyReplyAt` | **必须是 `0`**。非 0 时云崽在进入插件前就 return 了，伪人连被调起的机会都没有 |
| `config/config/other.yaml` | `blackGroup` | 清掉出厂自带的 `213938015`，否则那个群永远不响应 |
| `config/config/server.yaml` | `auth` | 留空。LLBot 的反向 WS 不能带自定义 Header |

---

## 3. 配置说明

### 3.1 文件位置与生效方式

| 项 | 说明 |
|---|---|
| 默认路径 | `plugins/chatgpt-bym/config/config.yaml` |
| 也支持 | `config.json`（同名同目录，优先级低于 yaml） |
| 生效方式 | 保存即热加载（`fs.watchFile` + 300ms 防抖） |
| 例外 | `commandPrefix` 改了要重载插件或重启（指令正则是加载时的快照） |
| 缺字段 | 启动时用默认值补齐并回写，不会因为少写一项就崩 |

### 3.2 `trigger` —— 什么时候说话

| 字段 | 默认 | 说明 |
|---|---|---|
| `groupMode` | `whitelist` | `whitelist` / `blacklist` / `all` |
| `groups` | `[]` | 群号数组。**白名单为空 = 全部禁用**（不是全开） |
| `hitKeywords` | `['bym']` | 命中即必触发，不区分大小写 |
| `probability` | `0.02` | 未命中关键词时的触发概率，0~1 |
| `cooldownSeconds` | `60` | 同群两次发言最小间隔 |
| `maxPerHour` | `6` | 同群每小时上限 |
| `bypassCooldownOnKeyword` | `false` | 关键词命中是否无视冷却。默认 false，避免热词变刷屏 |
| `ignoreAtOthers` | `true` | 消息 @ 了别人时不插话 |
| `ignoreCommandPrefixes` | `['#','/']` | 这些开头的消息不接话 |
| `minLength` / `maxLength` | `1` / `200` | 只处理这个长度区间的消息 |
| `muteKeywords` | `['[CQ:xml', ...]` | 命中直接跳过（广告、接龙） |

### 3.3 `speaking` —— 怎么说话

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `reply` | `reply` 回复触发它那条；`contextual` 读完上下文自己找切入点 |
| `contextualPrompt` | 长文本 | 仅 contextual 模式使用，可改成人设化的指令 |
| `defaultPresetId` | `bym_default` | 对应 `presets/bym_default.yaml` |
| `presetPrefix` | `''` | 拼在每个预设 system 前面的统一人设 |
| `presetMap` | `[]` | 关键词换人设，见 3.8 |
| `recallSeconds` | `0` | 发完几秒撤回。**只撤自己那条**，不撤群友消息 |
| `splitReplies` | `true` | 长回复拆成多条 |
| `maxSegmentLength` | `120` | 单条上限，超过才拆 |
| `typingDelay` | `{minMs:800, perCharMs:35, maxMs:6000}` | 打字延迟 = min + 字数×perChar，夹在上限内，再抖动 0~35% |
| `gapDelay` | `{minMs:300, maxMs:1200}` | 多条之间的随机停顿 |

> `mode: contextual` 依赖群聊记录。`context.enable: false` 时会自动退回 `reply`，不会凭空发言。

### 3.4 `llm` —— 接口

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | 写 `.../v1`、`...`、或完整 `.../v1/chat/completions` 都行，会自动归一化 |
| `apiKey` | `''` | 会拼成 `Authorization: Bearer <key>` |
| `model` | `gpt-4o-mini` | |
| `temperature` | `0.9` | 伪人建议 0.8~1.0 |
| `topP` | `1` | |
| `maxTokens` | `300` | 太长会变成小作文，300 大约 2~3 句 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `stream` | `false` | 分段发送需要完整文本，一般不用开 |
| `retries` | `2` | 只对 408/429/5xx/网络错误重试；401 直接换渠道 |
| `extraHeaders` | `{}` | 中转站要求的自定义头 |
| `extraBody` | `{}` | 例如 `{ enable_thinking: false }` |
| `fallback` | `[]` | 备用渠道，形如 `[{baseURL, apiKey, model}]`，主渠道不可用时依次尝试 |

### 3.5 `context` —— 群聊记录

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 关掉后模型不知道群里在聊什么，只能对着触发消息回一句 |
| `length` | `20` | 拉多少条。调大更连贯，但更贵更慢 |
| `cacheTTL` | `0` | 群历史缓存秒数。开了能省次数，但缓存期内新消息进不去 |
| `header` / `message` | 表格模板 | 可用 `${group.name}`、`${message.sender.card}` 等占位符 |

### 3.6 `vision` —— 图片

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `false` | 只有多模态模型才开 |
| `maxImageSize` | `1048576` | base64 后的体积上限，超了直接丢弃 |
| `maxImageDimension` | `2000` | 宽高上限，超了丢弃（不缩放，避免引入图像库） |
| `maxImages` | `3` | 单轮最多几张 |
| `includeContextImages` | `false` | 群聊记录里的图也一起发（很贵） |

### 3.7 `memory` —— 群记忆

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `false` | 开启后会按相关度注入历史事实 |
| `injectLimit` | `5` | 每轮注入几条 |
| `extract` | `true` | 是否用模型抽取新事实 |
| `extractModel` | `''` | 留空复用 `llm.model` |
| `maxFactsPerGroup` | `200` | 每群上限，超了淘汰不重要且旧的 |
| `extractPrompt` | 长文本 | 抽取的提示词 |

> **前提**：抽取用的语料来自群聊记录，所以 `context.enable` 必须为 `true`，否则一轮只有 1 条消息，达不到「至少 6 条」的抽取门槛。日志里会打 `跳过抽取：可用语料 N 条`。

### 3.8 人设文件

`presets/<id>.yaml`，文件名就是 `defaultPresetId` 用的 ID：

```yaml
name: 默认群友
system: |
  你是一个 QQ 群里的普通群友，刚进群不久，和大家混得还行。
  说话口语、随意、简短，一般一到两句话。
  不主动暴露自己是模型或机器人。
temperature: 0.9     # 可省略，省略则用 llm.temperature
maxTokens: 200       # 可省略
recallSeconds: 0     # 可省略，覆盖全局撤回时间
enabled: true
```

关键词换人设：

```yaml
speaking:
  presetMap:
    - keywords: ['原神']
      presetId: bym_tsundere
      priority: 10          # 命中多条时取优先级最高的
      recallSeconds: 5      # 可选，覆盖该预设的撤回时间
```

预设目录被清空也不会哑掉，代码里有内置兜底人设。

### 3.9 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `BYM_CONFIG_DIR` | 配置文件所在目录，默认插件目录下的 `config/` |
| `BYM_DATA_DIR` | 数据目录（`memory.json`、`presets/`），默认插件目录下的 `data/` |

用途：多个机器人实例共用一个插件目录时各自隔离；或把配置放到受控目录。

---

## 4. 首次验证

按顺序做，哪一步不对就停下查第 5 节。

### 第 1 步：加载

重启云崽，日志出现 `[bym] 伪人模式插件加载完成`。

没出现 → 看 5.1。

### 第 2 步：状态

在群里（必须是 `trigger.groups` 里那个群）发：

```
#bym 状态
```

应该回一大段：开关状态、接口地址、模型、触发参数、群范围、冷却、预设列表。

如果回了「暂无权限，只有主人才能操作」——先设主人（私聊机器人发 `#设置主人`，按提示操作）。

### 第 3 步：干跑

```
#bym 测试 今晚开黑吗
```

它会走完整链路（拉群记录 → 调模型）但**不发送**，把结果回给你。这一步能同时验证：接口通不通、模型回什么、用了哪个人设。

### 第 4 步：真跑

发一条含关键词的消息：

```
bym 在吗
```

等几秒（打字延迟），它应该发出一条回复。

没发 → 看 5.2。

---

## 5. 常见问题

### 5.1 启动日志里没有 `[bym]`

| 检查 | 命令 / 位置 |
|---|---|
| 目录放对了吗 | `Yunzai/plugins/chatgpt-bym/index.js` 存在 |
| 依赖装了吗 | `ls plugins/chatgpt-bym/node_modules/js-yaml` |
| 重新装过吗 | 放插件后要在根目录再跑一次 `pnpm i` |
| 有报错吗 | 搜日志里的 `插件加载错误`、`Cannot find package` |
| Node 版本够吗 | `node -v` 必须 >= 23.11 |

### 5.2 加载了，但群里从来不说话

按概率从高到低查：

1. **`enable: false`** —— 最常见的。日志里会明确写「当前状态：已关闭」。
2. **群号不在 `trigger.groups`** —— 白名单模式下列表为空等于全禁。
3. **云崽的 `onlyReplyAt` 不是 0** —— 这是隐藏最深的一条：云崽在 `deal()` 里有一行 `if (!e.only_reply_at) return`，位置在插件匹配之前，插件根本不会被调用。改 `config/config/group.yaml` 的 `default.onlyReplyAt: 0`。
4. **群在 `other.yaml` 的 `blackGroup`** —— 出厂值有 `213938015`。
5. **冷却未过** —— `cooldownSeconds` 默认 60 秒，`maxPerHour` 默认 6 次。
6. **消息本身被过滤** —— @ 了别人、以 `#` 开头、长度不在 `minLength~maxLength`、命中 `muteKeywords`。
7. **概率太低** —— 默认 2%，发 10 条大概率一条都不中。用 `bym 在吗` 测（关键词必中）。

想看具体是哪个原因拦下的，把 `config.yaml` 里的日志级别调到 debug（在云崽的 `config/config/bot.yaml` 里设 `log_level: debug`），然后搜 `[bym] 跳过：`，后面就是原因。

### 5.3 `Cannot read properties of null (reading 'baseURL')`

配置文件里 `llm:` 这一行下面什么都没写（YAML 里等于 `null`）。

1.0.1 起会自动用默认值补上；如果你还在旧版，手写一个 `llm:` 块或删掉那行即可。

### 5.4 `does not provide an export named 'default'`

1.0.0 在 `js-yaml` 5.x 下的报错。1.0.1 已改成 `import * as YAML`，两个大版本都兼容。看到这条说明跑的还是旧文件。

### 5.5 接口返回 401 / 403

Key 错、过期、或被中转站限制了模型。先用 `#bym 测试` 触发一次，看日志里的完整报错（插件会打 `[bym] 生成失败：...`）。

### 5.6 接口返回 429

限流。三个地方一起调：

- `trigger.maxPerHour` 降到 2~3
- `trigger.cooldownSeconds` 加到 120 以上
- `llm.retries` 保持 2（会自动退避重试），不要调大

### 5.7 请求超时

`llm.timeoutMs` 默认 60 秒。慢模型调到 120000；如果是网络问题，换 `baseURL` 或加备用渠道 `fallback`。

### 5.8 回复只发了一半 / 被截断

1.0.0 有个 `slice(0, 500)` 会砍在 500 字，1.0.1 已删除。仍然只发一半的话，检查 `speaking.maxSegmentLength`（这是**分段**，不是截断，会继续发后面的段）。

### 5.9 撤回把群友的消息也撤了

1.0.0 的行为：用了 `e.reply` 的 `recallMsg` 选项，云崽的实现是「撤回复 + 撤用户原消息」。1.0.1 改成只撤自己那条。

### 5.10 记忆一直是 0 条

- `memory.enable` 没开
- `context.enable` 关了 → 语料不足，不会抽取（日志有提示）
- 群里说话太少，攒不到 6 条
- 用 `#bym 记忆` 看当前群的事实列表

### 5.11 改配置不生效

- 保存后等 1~2 秒（热加载有防抖）
- 改的是 `config/config.yaml` 而不是 `config/config.js` 里的默认值
- 改了 `commandPrefix` → 需要重载插件或重启（指令正则是加载时编译的）

### 5.12 和 chatgpt-plugin 同时装，两个都抢话

两个插件都用 `^[^#]` 这类宽正则监听群消息。选一个：

- 把 `chatgpt-plugin` 的 `bym.enable` 设为 `false`（推荐）
- 或调 `priority` 决定谁先处理（数字小的先执行）

### 5.13 分段太碎 / 太长

- 太碎 → 调大 `maxSegmentLength`（如 200）
- 太长 → 调小到 60~80
- 完全不想拆 → `splitReplies: false`

### 5.14 回复风格不对

改 `presets/bym_default.yaml` 的 `system`，比改 `contextualPrompt` 更有效——前者每条消息都会带上，后者只在 contextual 模式生效。

---

## 6. 升级与卸载

### 升级

```bash
cd Yunzai/plugins/chatgpt-bym
git pull            # 或用新目录覆盖
pnpm install        # 依赖有变化时
```

`config/config.yaml` 会保留；新增的配置项会在下次启动时自动补齐并回写。

### 卸载

1. 从 `config/config/group.yaml` 里恢复 `onlyReplyAt`（如果你为它改过）
2. 删掉 `plugins/chatgpt-bym` 整个目录
3. 重启云崽

数据都在插件目录内（`data/memory.json`），删目录即清空。要保留记忆就先备份。

---

## 7. 最小可用配置

复制下面这份，改四个值就能跑：

```yaml
enable: true

trigger:
  groupMode: whitelist
  groups: ['你的群号']
  hitKeywords: ['bym']
  probability: 0.02
  cooldownSeconds: 60
  maxPerHour: 6

speaking:
  mode: reply
  defaultPresetId: bym_default
  recallSeconds: 0
  splitReplies: true
  maxSegmentLength: 120

llm:
  baseURL: https://api.openai.com/v1
  apiKey: sk-你的key
  model: gpt-4o-mini
  temperature: 0.9
  maxTokens: 300

context:
  enable: true
  length: 20

vision:
  enable: false

memory:
  enable: false
```

配套的云崽侧（`config/config/group.yaml`）：

```yaml
default:
  onlyReplyAt: 0
```
