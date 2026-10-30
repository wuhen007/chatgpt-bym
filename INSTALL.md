# chatgpt-bym 安装教程

从零把「伪人模式」跑起来。全文按「装依赖 → 放插件 → 填配置 → 验证」的顺序写，每步都有可检查的结果。

> 适用版本：1.3.1
> 如果你还没装云崽和协议端，先看仓库外的《TRSS-Yunzai + LuckyLilliaBot 部署指南》，本教程假设那一步已经完成。

---

## 0. 你会得到什么

装好之后：群里有人聊天，机器人会**按概率或关键词**偶尔插一句，像个普通群友。

它不回复每一条消息，也不需要 @ 它 —— 这正是「伪人」和普通问答插件的区别。当然，**@ 它的时候一定会回**。

```
新消息 → 去重与回声 → 触发闸门(开关/白名单/关键词/@/概率/冷却)
      → 组织上下文(群记录 + 记忆，超长则裁剪) → 语义把关(可选)
      → 调大模型 → 出站守卫(防自曝) → 拆成几条 + 打字延迟 → 发出去
```

每一步都可能让这一轮「不说话」。**不说话是常态**，日志里能看到是哪一关拦下的（debug 级别）。

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
3. 模型名，默认 `deepseek-flash`（旧的 deepseek-chat 已于 2026-07 下线）
4. 允许它说话的群号

---

## 2. 安装

### 2.1 放入插件目录

把整个仓库放进云崽的 `plugins/` 下。**仓库根目录就是插件本体**，不需要再套一层目录：

```
Yunzai/
└── plugins/
    └── chatgpt-bym/          ← clone 下来的目录名
        ├── index.js
        ├── package.json
        ├── apps/
        ├── config/
        ├── models/
        ├── presets/
        ├── utils/
        └── tests/
```

推荐直接 clone：

```bash
cd Yunzai/plugins
git clone <本仓库地址> chatgpt-bym
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

第一次启动会生成 `config.yaml`，里面是全部默认值。

> **1.4.1 起配置不在插件目录里**：正常是 `Yunzai/data/chatgpt-bym/config.yaml`（宿主的 data 目录）。
> 只有在检测不到云崽（不在 `plugins/` 布局下、或宿主 `package.json` 的 name 不含 yunzai）时，
> 才退回插件目录 `plugins/chatgpt-bym/config/`。日志里会写明用的是哪一个。

启动日志里应该出现：

```
**************************************
[bym] 伪人模式插件加载完成
[bym] 当前状态：已关闭，触发概率 0.02
**************************************
```

看到这两行就说明插件已经被加载了。**此时它不会说话**，因为 `enable: false`。

### 2.4 填最小配置

打开 `data/chatgpt-bym/config.yaml`（在插件目录里配置时是 `plugins/chatgpt-bym/config/config.yaml`），至少改这四处：

```yaml
enable: true                     # 总开关

trigger:
  groupMode: whitelist           # 白名单模式
  groups: ['123456789']          # 改成你的群号
  hitKeywords: ['bym']           # 发这个词必触发，用来测试
  probability: 0.02              # 其他消息 2% 概率接话

llm:
  baseURL: https://api.deepseek.com   # 或任何 OpenAI 兼容端点
  apiKey: sk-xxxx                    # 你的 key
  model: deepseek-flash
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
| 默认路径 | `Yunzai/data/chatgpt-bym/config.yaml`（宿主的 data 目录，**不在插件目录里**） |
| 旧版本 | 1.4.1 之前是 `plugins/chatgpt-bym/config/config.yaml`，升级时会自动复制到新位置 |
| 也支持 | `config.json`（同目录，优先级低于 yaml） |
| 生效方式 | 保存即热加载（`fs.watchFile` + 300ms 防抖） |
| 例外 | `commandPrefix` 改了要重载插件或重启（指令正则是加载时的快照） |
| 缺字段 | 启动时用默认值补齐**到内存**，不改写文件（免得清掉你手写的注释） |
| 写坏时 | 备份成 `config.yaml.broken`，以默认值运行且**拒绝写盘**，改好缩进自动恢复 |

> **为什么不在插件目录里**：插件目录会被更新覆盖。用「下载 zip 解压覆盖」或「删掉旧目录再放新的」更新时，放在里面的配置和记忆会一起没掉。云崽的 `data/` 是宿主持久化目录，换插件版本不碰它。

如果检测不到云崽（不在 `plugins/` 布局下、或 `package.json` 的 name 不含 yunzai），会退回插件目录 `plugins/chatgpt-bym/config/`，行为和 1.4.1 之前一致。

想放到别处可以用环境变量 `BYM_CONFIG_DIR` / `BYM_DATA_DIR` 指定（测试和双实例隔离也靠它）。

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
| `replyWhenAddressed` | `true` | `@` 机器人时必定接话。关掉不等于「@ 了也不理」，而是退回按关键词/概率判断 |
| `addressedBypassCooldown` | `true` | 被 `@` 时无视冷却。**绕不过 `maxPerHour`** —— 被 @ 十次也不该回十条 |
| `ignoreAtOthers` | `true` | 消息 @ 了别人时不插话。同时 @ 了机器人的除外（那是在叫我） |
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
| `presetMap` | `[]` | 关键词换人设，见 3.11 |
| `recallSeconds` | `0` | 发完几秒撤回。**只撤自己那条**，不撤群友消息 |
| `splitReplies` | `true` | 长回复拆成多条 |
| `maxSegmentLength` | `120` | 单条上限，超过才拆 |
| `typingDelay` | `{minMs:800, perCharMs:35, maxMs:6000}` | 打字延迟 = min + 字数×perChar，夹在上限内，再抖动 0~35% |
| `gapDelay` | `{minMs:300, maxMs:1200}` | 多条之间的随机停顿 |

> `mode: contextual` 依赖群聊记录。`context.enable: false` 时会自动退回 `reply`，不会凭空发言。

### 3.4 `llm` —— 接口

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `https://api.deepseek.com` | 写 `.../v1`、`...`、或完整 `.../v1/chat/completions` 都行，会自动归一化 |
| `apiKey` | `''` | 会拼成 `Authorization: Bearer <key>` |
| `model` | `deepseek-flash` | 旧的 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07 下线 |
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
| `maxChars` | `8000` | 上下文字数预算。超了按「记忆 → 群记录（从最早的丢）→ 本轮消息」裁，**人设永不裁** |
| `cacheTTL` | `0` | 群历史缓存秒数。开了能省次数，但缓存期内新消息进不去 |
| `header` / `message` | 表格模板 | 可用 `${group.name}`、`${message.sender.card}` 等占位符 |

> `maxChars` 平时用不上（20 条 × 30 字 ≈ 700 字）。但把 `length` 调到 50 以上、或者群里开始刷长消息时，
> 没有它就会一路涨到把请求撑爆，表现是上游 400、日志里只有 `context length exceeded`。

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
| `enable` | `false` | 总开关 |
| `inject` | `true` | 读：是否把记忆带进 prompt。关掉后只写不读（想先观察它在记什么时用） |
| `write` | `true` | 写：是否记录新记忆。关掉后只读不写（记忆满了或观察期用） |
| `injectLimit` | `5` | 每轮注入几条 |
| `injectMaxChars` | `1200` | 单次注入的字数预算。5 条各 500 字会吃掉 2500 字，把群记录挤掉。填 0 表示只按条数 |
| `extract` | `true` | **兼容项**，`extract: false` 仍然不写。新配置请用 `write` |
| `extractModel` | `''` | 仅用于回退路径：模型没按格式返回时才退回独立抽取 |
| `maxFactsPerGroup` | `200` | 每群上限，超了先清过期和被取代的，仍超才淘汰低分旧条目 |
| `conflictResolve` | `true` | 同一个人同一方面说了新的，旧的不再被提起（记录仍保留可查） |
| `profileEnabled` | `true` | 是否把群画像带进 prompt |
| `typeTtl` | 见下 | 各类型记忆保留天数，0 表示永不过期 |

```yaml
typeTtl:
  plan: 2          # 计划：明天、周末、一会儿
  event: 7         # 已发生的事
  preference: 60   # 偏好与忌讳
  relation: 90     # 谁和谁什么关系
  fact: 180        # 长期事实（身份、职业、所在地）
  unknown: 30      # 模型没给类型时的兜底
```

> **不再需要 `context.enable` 为 true。** 1.3.0 起记忆是「回复的副产品」：
> 模型回话的同时顺带返回 `{say, memory}`，一次调用产出两样东西。
> 旧版本需要单独抽取、且要求至少 6 条语料，那个限制已经没有了。

> **为什么按类型过期**：一句话的有效期取决于它是什么。「明天三点开会」两天后就是噪音，
> 「张三在字节做后端」半年后还成立。统一 TTL 只能取中间值，两边都不对。
> 过期的条目只是不再被提起，不会删除 —— 想回头看用 `#bym 记忆`。

### 3.8 `guard` —— 出站守卫（防自曝）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 回复里出现「我是 AI」「我的训练数据」这类话时，这一轮不发 |
| `judgeModel` | `''` | 二次判定模型。留空只用本地规则；填了之后，出现 Claude/GPT 等可疑词会多调一次廉价模型 |
| `retry` | `false` | 命中后带着强约束重问一次（多一次请求、回复变慢） |

> 被拦时群里**不会有任何提示** —— 伪人不说话是常态，但一旦开口解释「我刚才那句话不该讲」就破功了。
> 判定失败（超时、返回看不懂）时放行，不会因为守卫挂了就整个不说话。

### 3.9 `gate` —— 语义把关（可选，默认关）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `false` | 概率命中后再让模型给这条消息打 0-10 分，低于阈值就不接话 |
| `model` | `''` | 判定模型，留空复用 `llm.model`。建议填个便宜的小模型 |
| `threshold` | `6` | 低于这个分数不接话。`6` 表示「日常闲聊及以上」 |

> **每条命中的消息会多一次 API 调用**，所以默认关。`probability=0.02` 时大约 100 条消息才多 2 次。
> 它的价值是挡掉「在吵架」「在刷广告」「在自言自语」这些不该插嘴的场合 —— 纯概率分辨不了这些。
> 被它拒掉的轮次会**退还频率配额**，不会白占 `maxPerHour`。

### 3.10 `dedup` —— 入口去重

| 字段 | 默认 | 说明 |
|---|---|---|
| `enable` | `true` | 挡住协议端重投的重复消息，以及机器人自己消息绕回来导致的死循环 |

> 建议保持开启。这层挡的是「我一直在回我自己」，停了会不断自我强化。

### 3.11 人设文件

`presets/<id>.yaml`，文件名就是 `defaultPresetId` 用的 ID。最简单的写法只有一个 `system`：

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

想把「是谁、怎么说话」拆开调，可以加结构化字段（全部可选）：

```yaml
name: 小张

identity:
  age: 24
  city: 杭州
  job: 后端开发
  signature: 常年加班。

speech:
  style: 口语、随意
  length: 一到两句
  catchphrases: ['确实', '也行']
  never: ['用列表', '用敬语']    # 写要避免的行为，不是禁止的条目

persona:
  groupAware: true               # 是否把群名告诉模型，默认 true

system: |                        # 自由文本，写结构化表达不了的细节
  你刚进群不久，和大家混得还行。
```

好处是改口癖只改一行 `catchphrases`，不用碰整段 prompt。老文件一个字段都不改也能用。

关键词换人设：

```yaml
speaking:
  presetMap:
    - keywords: ['原神']
      presetId: bym_tsundere
      priority: 10          # 命中多条时取优先级最高的
      recallSeconds: 5      # 可选，覆盖该预设的撤回时间
```

给单个群固定人设（优先级高于关键词）：

```yaml
speaking:
  groupPresets:
    '123456789': bym_tsundere
```

也可以不改文件，在群里直接说 `#bym 人设 bym_tsundere`；`#bym 人设 off` 取消，回到全局默认。

> 为什么群级设定压过关键词：关键词规则是「聊到原神就换个人设」，属于话题级的临时切换；
> 群绑定是「这个群就是这个人」。在「原神群」里聊到加班，不该把群友变成通用助手。

预设目录被清空也不会哑掉，代码里有内置兜底人设。

### 3.12 环境变量（可选）

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

### 5.3 配置好像被重置了，api key 变空

先做三条检查，能直接定性：

```bash
cd Yunzai
ls -la data/chatgpt-bym/ plugins/chatgpt-bym/config/ plugins/chatgpt-bym/data/   # 三处都看一眼
grep -rn "apiKey" data/chatgpt-bym/config.yaml                                  # 看有没有值（别把 key 贴给别人）
grep -n "配置解析失败\|已生成默认配置\|已把 config.yaml" logs/*.log 2>/dev/null
```

> 1.4.1 起真实配置在 `data/chatgpt-bym/config.yaml`。`plugins/chatgpt-bym/config/` 里如果还有一份，那是迁移前留下的旧文件，改了不生效。

然后分清是哪一种，处理方式完全不同：

**情况 A：`data/chatgpt-bym/config.yaml` 不存在**

说明插件启动时没找到配置，生成了默认值。日志里会有：

```
[bym] 已生成默认配置：.../data/chatgpt-bym/config.yaml
```

两个可能：

- **你还没迁移过**（还停在 1.4.0 或更早）→ 旧配置在 `plugins/chatgpt-bym/config/config.yaml`，升级到 1.4.1 会自动搬过去。
- **旧配置随插件目录一起被删了**（删目录重装）→ 只能从备份恢复。但**群记忆和配置是两回事**，如果 `plugins/chatgpt-bym/data/memory.json` 或 `data/chatgpt-bym/memory.json` 还在，记忆就没丢。

**情况 B：文件还在，但内容变成了默认值**

先看同目录下有没有 `config.yaml.broken`：

- **有** → 这个文件就是你的原配置，直接改名回 `config.yaml` 即可。它说明你的 YAML 在某次启动时解析失败过。
- **没有，且日志里有 `[bym] 配置解析失败`** → 你的 YAML 有语法问题。1.4.1 起插件会拒绝写盘，文件不会再被程序改坏；改好缩进后自动恢复。
- **没有，日志也没有报错** → 你大概率用的是 1.4.0 或更早的版本，撞上了那个已修复的缺陷：配置解析失败后，插件把内存换成默认值，随后任意一次写配置（`#bym 开`、锅巴保存、`#bym 人设`）就把整份默认值落盘了。升级到 1.4.1 后不会再发生。

**还有一种常见情况：key 填在了 `config.example.yaml` 里**

`config/config.example.yaml` 是**仓库自带的模板文件**，升级（尤其是 zip 覆盖）时一定会被新版本覆盖掉。它里面的内容只是参考，插件根本不读它。

如果你之前是打开 example 填的 key，那更新一次就没了。正确的做法是改 `data/chatgpt-bym/config.yaml`（或者旧版本的 `config/config.yaml`），那是插件真正读的文件。

**怎么避免手写 YAML 出错**：用空格缩进（不用 Tab）、冒号用半角 `:`、字符串里有特殊字符就加引号。最稳的做法是通过锅巴面板改，或者复制 `config.example.yaml` 再改值。

### 5.4 `Cannot read properties of null (reading 'baseURL')`

配置文件里 `llm:` 这一行下面什么都没写（YAML 里等于 `null`）。

1.0.1 起会自动用默认值补上；如果你还在旧版，手写一个 `llm:` 块或删掉那行即可。

### 5.5 `does not provide an export named 'default'`

1.0.0 在 `js-yaml` 5.x 下的报错。1.0.1 已改成 `import * as YAML`，两个大版本都兼容。看到这条说明跑的还是旧文件。

### 5.6 接口返回 401 / 403

Key 错、过期、或被中转站限制了模型。先用 `#bym 测试` 触发一次，看日志里的完整报错（插件会打 `[bym] 生成失败：...`）。

### 5.7 接口返回 429

限流。三个地方一起调：

- `trigger.maxPerHour` 降到 2~3
- `trigger.cooldownSeconds` 加到 120 以上
- `llm.retries` 保持 2（会自动退避重试），不要调大

### 5.8 请求超时

`llm.timeoutMs` 默认 60 秒。慢模型调到 120000；如果是网络问题，换 `baseURL` 或加备用渠道 `fallback`。

### 5.9 回复只发了一半 / 被截断

1.0.0 有个 `slice(0, 500)` 会砍在 500 字，1.0.1 已删除。仍然只发一半的话，检查 `speaking.maxSegmentLength`（这是**分段**，不是截断，会继续发后面的段）。

### 5.10 撤回把群友的消息也撤了

1.0.0 的行为：用了 `e.reply` 的 `recallMsg` 选项，云崽的实现是「撤回复 + 撤用户原消息」。1.0.1 改成只撤自己那条。

### 5.11 记忆一直是 0 条

按可能性排：

1. **`memory.enable` 没开**（默认就是 `false`）
2. **模型没按格式返回**。1.3.0 起记忆由回复顺带产出，要求模型输出 `{"say":"...","memory":[...]}`。
   小模型经常只给纯文本，这时会退到 `[bym][memory] 跳过抽取` 的日志。
   判断方法：把日志调到 debug，看有没有 `[bym][memory] 从回复中记录 N 条`。
   频繁出现 `跳过抽取` 说明该换稍大一点的模型，或者别用记忆功能。
3. 模型按要求返回了，但给了空数组（这一轮确实没有值得记的信息）

用 `#bym 记忆` 看当前群的事实列表。注意「记忆是 0 条」和「记忆开启了但没注入」是两件事 ——
注入看的是相关度，可能记了 50 条但这一轮一条都不相关。

1.4.0 起每条记忆都有过期时间。`#bym 状态` 显示的是「有效条数 / 总条数」，
有效数远小于总数说明大部分已经过期了 —— 那不是坏了，是设计如此（`event` 7 天、`plan` 2 天）。
`#bym 记忆` 里过期的条目标着「已过期」，被新说法取代的标着「已取代」。

### 5.12 切了人设但群里的语气没变

按顺序检查：

1. **用了 `#bym 人设 <id>` 但没有这个 ID**。指令会直接回「人设「xxx」不存在」。
2. **看了别的群**。`#bym 人设` 设的是**本群**，别的群不受影响。
3. **人设文件被删了或写了 `enabled: false`**。这种情况会打 warn 日志并退回默认人设，
   群里不会有提示 —— `#bym 状态` 里看「本群人设」那一行。
4. **改的是 `defaultPresetId` 但本群有 `groupPresets` 绑定**。群绑定优先级更高，先 `#bym 人设 off`。
5. **想验证效果**：`#bym 测试 你好` 会走完整链路但不发群，能看到回复。

注意改 `presets/*.yaml` 会即时生效（5 秒缓存），不用重启。

### 5.13 群友 @ 了机器人，它却不回

按可能性排：

1. `trigger.replyWhenAddressed` 被关掉了（默认 `true`）
2. `trigger.maxPerHour` 用完了 —— 被 @ 的豁免只针对冷却，上限仍然生效
3. 群不在白名单里 / `enable` 为 false
4. 消息里还带了屏蔽词（`muteKeywords`）
5. 云崽侧 `group.yaml` 的 `onlyReplyAt` 不为 0（见 2.5）

### 5.14 改动 `groups` 后插件整个不工作了

大概率是把数组写成了单个值：

```yaml
trigger:
  groups: 123456789      # ✗ 不是数组
```

1.3.1 起会自动修正成 `[123456789]` 并在日志里打一行 warn：
`配置项 trigger.groups 应为数组，已自动修正为 [123456789]`。
如果看到这行说明配置被自动改了，去改回正确写法即可。旧版本会直接崩在每条消息上。

### 5.15 改配置不生效

- 保存后等 1~2 秒（热加载有防抖）
- 改的是 `config/config.yaml` 而不是 `config/config.js` 里的默认值
- 改了 `commandPrefix` → 需要重载插件或重启（指令正则是加载时编译的）

### 5.16 和 chatgpt-plugin 同时装，两个都抢话

两个插件都用 `^[^#]` 这类宽正则监听群消息。选一个：

- 把 `chatgpt-plugin` 的 `bym.enable` 设为 `false`（推荐）
- 或调 `priority` 决定谁先处理（数字小的先执行）

### 5.17 分段太碎 / 太长

- 太碎 → 调大 `maxSegmentLength`（如 200）
- 太长 → 调小到 60~80
- 完全不想拆 → `splitReplies: false`

### 5.18 回复里冒出「作为一个 AI 语言模型」

说明出站守卫没拦住，检查：

- `guard.enable` 是不是被关了（默认 `true`）
- 看日志有没有 `[bym][guard] 拦下一句`。有日志说明拦住了（群里没发出去），只是你在别处看到的
- 如果模型换个说法绕过（比如「我本质上是一段程序」），本地规则识别不了。
  配 `guard.judgeModel` 用模型二次判定，代价是可疑回复多一次调用

### 5.19 回复风格不对

改 `presets/bym_default.yaml` 的 `system`，比改 `contextualPrompt` 更有效——前者每条消息都会带上，后者只在 contextual 模式生效。

---

## 6. 升级与卸载

### 怎么更新才不丢配置

**1.4.1 起配置和记忆放在 `Yunzai/data/chatgpt-bym/`，不在插件目录里**，所以更新方式不再有讲究：

| 方式 | 会不会丢 |
|---|---|
| `git pull` | 不会 |
| 下载 zip 解压覆盖 | 不会 |
| 删掉旧目录再放新的 | 不会 |

以前这三种里第三种是「一定全丢」——配置和记忆都在被删的目录里。换位置就是为了这个。

**从 1.4.1 之前的版本升级**，启动时会自动搬迁，日志里会有这两行：

```
[bym] 已把 config.yaml、memory.json 从插件目录复制到 .../Yunzai/data/chatgpt-bym
[bym] 以后配置和记忆都在新位置，改插件目录里那份不会生效。旧文件已保留...
```

- **看到了** → 搬成功。旧文件没删，确认新位置正常后可以自己删掉 `plugins/chatgpt-bym/config/` 和 `data/`。
- **没看到** → 原来就没有旧配置，或者插件没被认出来是云崽（不在 `plugins/` 布局下 / `package.json` 的 name 不含 yunzai）。后者会继续用插件目录，行为和以前一样。
- **迁移过来的仍是默认值** → 说明旧配置在升级前就已经被覆盖了（1.4.0 及更早版本的缺陷），只能重填。

> 只复制不删除是有意的：搬迁出问题时你还留着原件。但这也意味着**新旧两份同时存在时，改旧的那份不生效**。

### 升级后要确认的两件事

1. **新增的配置项只补在内存里，不改写你的文件**（1.4.1 起）。这样你手写的注释不会被 `yaml.dump` 清掉。想知道加了什么，对照 `config/config.example.yaml` 看。
2. **配置文件写坏了不会被覆盖**（1.4.1 起）。解析失败时插件会：备份原文件到 `config.yaml.broken`、以默认值继续跑、**拒绝任何写盘操作**。你在编辑器里把缩进修好，1 秒后自动重新加载。

   这条是 1.4.0 及以前的一处数据丢失缺陷：那时解析失败只把内存换成默认值，之后任何一次写配置（`#bym 开`、锅巴保存、切群人设）都会把整份默认值落盘，**api key 和所有设置永久消失**。

数组项如果被写成了单个值（`groups: 123456`），1.3.1 起会自动修正成数组并打 warn。

**从 1.0.x 升到 1.3.x 有三处行为变化**，升级后确认一下：

| 变化 | 影响 | 要不要动 |
|---|---|---|
| `@` 机器人现在**必定回复**（`replyWhenAddressed`） | 原来只按概率，@ 了也可能不理 | 想保持旧行为就设 `false` |
| 记忆改成「回复副产品」，不再要求 6 条语料 | 原来必须开 `context.enable` 才记，现在不需要 | 无需操作，记忆可能会开始增长 |
| 新增出站守卫，自曝的回复不再发出 | 偶尔会「这一轮没说话」，日志有 `[bym][guard] 拦下一句` | 想全放行就设 `guard.enable: false` |

**1.3.x → 1.4.0** 是纯增量，不需要改任何配置：

| 变化 | 说明 |
|---|---|
| 人设支持结构化字段 | 老 yaml 一个字段不改也能用；给了 `identity`/`speech` 才分节拼装 |
| 人设可以按群指定 | `speaking.groupPresets` 默认为空，行为与之前一致 |
| prompt 开始带群名 | 发言会更贴群里的语境。不想带就给人设加 `persona.groupAware: false` |
| 记忆有了过期时间 | **旧记忆按 `at + 30 天` 算**。升级后第一次跑，60 天前的记忆会开始消失（不删除，只是不再被提起）。想让老记忆永久保留就把 `memory.typeTtl.unknown` 设成 0 |
| 记忆注入按节分 | `关于这个群` / `你记得的人` / `最近发生` / `其他`，模型用得更准 |
| 记忆文件升到 v2 | 不用迁移，旧文件直接读；下次写入时自动落成新格式 |

### 卸载

1. 从 `config/config/group.yaml` 里恢复 `onlyReplyAt`（如果你为它改过）
2. 删掉 `plugins/chatgpt-bym` 整个目录
3. 删掉 `Yunzai/data/chatgpt-bym/`（配置和记忆在这里）
4. 重启云崽

只删插件目录**不会**清掉配置和记忆——它们已经不在插件目录里了。要彻底卸载，第 3 步不能漏。

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
  baseURL: https://api.deepseek.com
  apiKey: sk-你的key
  model: deepseek-flash
  temperature: 0.9
  maxTokens: 300

context:
  enable: true
  length: 20
  maxChars: 8000

vision:
  enable: false

memory:
  enable: false

# 下面三段有默认值，写出来是为了让你知道它们存在
guard:
  enable: true       # 防自曝。建议保持开启
  judgeModel: ''     # 想更准就填个便宜模型
  retry: false

gate:
  enable: false      # 语义把关。开了每条命中的消息多一次调用

dedup:
  enable: true       # 去重与回声。建议保持开启
```

配套的云崽侧（`config/config/group.yaml`）：

```yaml
default:
  onlyReplyAt: 0
```
