# chatgpt-bym

云崽（Yunzai）的**伪人模式**独立插件：让机器人在群里像普通群友一样，按概率或关键词偶尔插一句话。

不依赖 `chaite`、不依赖任何原生模块（`sqlite3` / `sharp` / `nodejieba`），
只通过 OpenAI 兼容的 HTTP 接口调用大模型。

> **来源与致谢**
>
> 本插件的功能设计、提示词结构与拟人化策略，来自 **ikechan8370** 的开源项目
> [chatgpt-plugin](https://github.com/ikechan8370/chatgpt-plugin) 中的「伪人模式（BYM）」。
> 原项目以 **GPL-3.0** 发布，本插件作为其衍生作品同样以 GPL-3.0 发布（见仓库根目录 LICENSE）。
>
> 与原实现的主要差异：去掉 chaite 内核、去掉 sqlite3/sqlite-vec 原生依赖、
> 修正若干行为问题、补充测试与文档。逐条对照见「八、取舍与能力对照」与「十四、变更记录」。

---

## 一、为什么要重写而不是照搬

原项目里伪人模式并不是一个独立功能，它寄生在三套基础设施上：

| 原依赖 | 伪人实际用到的部分 | 剥离方式 |
|---|---|---|
| `chaite` 的 `sendMessage()` | 渠道负载均衡、预设、流式、工具调用、历史入库 | 换成 `fetch` 直连 `{baseURL}/chat/completions` |
| `ChatPreset` | 一个 `systemOverride` + 温度/max_tokens | 换成 `presets/*.yaml`（一个文件一个人设） |
| `HistoryManager` + SQLite 三库 | 只为了把群上下文写进历史以命中 prompt cache | 直接砍掉：伪人每次都重新拉群上下文，跨轮记忆交给 `memory.json` |
| `memoryService` + `sqlite-vec` | 群事实注入 + 用户画像 | 换成 JSON + 2-gram 关键词打分（见「取舍」） |
| `visionService` + 图片缓存 | 让模型看见图 | 直接转 base64 data URL，超限就丢弃 |

净效果：**从 189 个文件 / 约 1.4 万行，降到 20 个文件 / 约 2100 行**（含 2 个测试脚本），
且 `pnpm i` 只装一个纯 JS 的 `js-yaml`。

---

## 二、目录与模块职责

```
chatgpt-bym/
├── index.js                 # 插件加载：读配置、动态加载 apps/、注册插件类
├── package.json
├── config/
│   ├── config.js            # 配置单例：默认值补全 + YAML/JSON + 热加载
│   └── config.yaml          # 首次启动自动生成的配置，改这个文件
├── data/                    # 运行时生成：memory.json（轻量记忆）
├── apps/
│   ├── bym.js               # 主入口：触发判定 -> 生成 -> 拟人化发送（一个流程一行注释）
│   └── admin.js             # 管理指令：#bym 状态/开/关/重载/测试/记忆
├── models/
│   ├── llmClient.js         # OpenAI 兼容客户端：重试、备用渠道、SSE、reasoning
│   ├── chatService.js       # 编排：人设 + 群上下文 + 记忆 + 本轮消息 -> 文本
│   ├── gate.js              # 语义把关：给消息打分，决定这时候该不该插话
│   ├── replyParser.js       # 回复解析：纯文本 / JSON 契约（记忆作为副产品）
│   ├── preset.js            # 人设加载与关键词选人设
│   └── memory.js            # 轻量群记忆：JSON 存取、打分、模型抽取
├── utils/
│   ├── dedup.js             # 入口去重（id / 内容 / 回声）
│   ├── trigger.js           # 触发闸门（8 道过滤 + 被点名/关键词/概率三档）
│   ├── rateLimit.js         # 冷却 + 每小时上限 + 配额退还
│   ├── groupContext.js      # 跨框架拉群历史 + 模板渲染 + TTL 缓存
│   ├── message.js           # 事件 -> 文本/图片；多模态 content 组装
│   ├── image.js             # 图片下载、尺寸嗅探、data URL 转换
│   ├── budget.js            # 上下文预算裁剪（记忆 → 群记录 → 本轮）
│   ├── guard.js             # 出站守卫：防自曝（本地规则 + 可选模型判定）
│   └── humanize.js          # 分段、打字延迟、随机停顿、撤回
├── presets/
│   ├── bym_default.yaml
│   └── bym_tsundere.yaml
└── tests/
    ├── smoke.mjs                # 逻辑冒烟测试（44 项，不联网）
    ├── llm.mjs                  # 接口层测试（10 项，起本地假 OpenAI 服务）
    ├── guoba.mjs                # 锅巴面板契约（23 项）
    ├── config.mjs               # 配置接入：扫源码验证、数组类型修正（31 项）
    ├── guard.mjs                # 出站守卫：必拦 + 不误伤 + 降级（31 项）
    ├── dedup.mjs                # 去重与回声，含 TTL 与硬上限（17 项）
    ├── budget.mjs               # 上下文裁剪顺序与边界（15 项）
    ├── gate.mjs                 # 语义把关：打分解析、阈值、降级（26 项）
    └── replyParser.mjs          # JSON 契约解析与坏输出退化（26 项）
```

分层原则：**apps 只做「要不要说、说完怎么发」，models 只做「说什么」，utils 是无状态工具。**
想换模型厂商只动 `llmClient.js`，想换人设只动 `presets/`。

---

## 三、安装

> **只想尽快跑起来？看 [INSTALL.md](./INSTALL.md)**。那一份是面向操作的分步教程（依赖检查、逐步验证、常见问题排查），下面这段是精简版。

1. 把整个 `chatgpt-bym` 目录放进 `云崽根目录/plugins/`；
2. 在插件目录里安装唯一依赖：

   ```bash
   cd plugins/chatgpt-bym
   pnpm install     # 或 npm install
   ```

3. 重启机器人，首次启动会生成 `config/config.yaml`；
4. 编辑配置填 `llm.apiKey`，把 `enable` 改为 `true`，再把群号加进 `trigger.groups`；
5. 群里发 `#bym 状态` 确认。

> `package.json` 里的 `js-yaml` 锁在 `^4.1.0`（CJS，兼容性最好）。代码同时兼容 5.x（纯 ESM、无 default 导出）——**不要**把 `import yaml from 'js-yaml'` 改回去，那样在 5.x 下会直接启动失败。

> 插件目录名可以改：所有路径都从 `import.meta.url` 推导，不再写死 `./plugins/chatgpt-plugin`。

---

## 四、配置项

`config/config.yaml`，改完保存即热加载（`fs.watchFile` + 300ms 防抖，用 mtime 跳过自身写入）。

```yaml
enable: false                 # 总开关
commandPrefix: '#bym'         # 管理指令前缀

trigger:
  groupMode: whitelist        # whitelist | blacklist | all
  groups: ['123456789']       # 白/黑名单群号
  hitKeywords: ['bym']        # 命中即必触发的词
  probability: 0.02           # 未命中关键词时的触发概率
  cooldownSeconds: 60         # 同群两次发言最小间隔
  maxPerHour: 6               # 同群每小时上限
  bypassCooldownOnKeyword: false  # 关键词是否无视冷却
  replyWhenAddressed: true    # @ 机器人时必定接话
  addressedBypassCooldown: true   # 被 @ 时无视冷却（绕不过每小时上限）
  ignoreAtOthers: true        # @ 别人的消息不插话
  ignoreCommandPrefixes: ['#', '/']
  minLength: 1
  maxLength: 200
  muteKeywords: ['砍一刀']     # 命中直接不接话

speaking:
  mode: reply                 # reply 回复那条消息 | contextual 读完上下文自主发言
  contextualPrompt: '...'     # contextual 模式下发给模型的指令
  defaultPresetId: bym_default
  presetPrefix: ''            # 统一人设前缀，拼在每个预设前面
  presetMap:                  # 关键词换人设
    - keywords: ['原神']
      presetId: bym_tsundere
      priority: 10
      recallSeconds: 0
  recallSeconds: 0            # 发完 N 秒撤回
  splitReplies: true          # 长回复拆成多条
  maxSegmentLength: 120
  typingDelay: { minMs: 800, perCharMs: 35, maxMs: 6000 }
  gapDelay: { minMs: 300, maxMs: 1200 }

guard:                        # 出站守卫，见「六、⑤」
  enable: true                # 拦掉自曝的回复
  judgeModel: ''              # 二次判定模型，留空只用本地规则
  retry: false                # 命中后重试一次（多一次请求）

dedup:                        # 入口去重与回声守卫，见「六、①」
  enable: true

gate:                         # 语义把关，见「六、④」。默认关
  enable: false
  model: ''                   # 判定模型，留空复用 llm.model
  threshold: 6                # 0-10，低于此分不接话

llm:
  baseURL: https://api.openai.com/v1
  apiKey: ''
  model: gpt-4o-mini
  temperature: 0.9
  topP: 1
  maxTokens: 300
  timeoutMs: 60000
  stream: false               # 分段发送需要完整文本，默认关
  retries: 2
  extraHeaders: {}            # 中转站需要的自定义头
  extraBody: {}               # 例如 { "enable_thinking": false }
  fallback: []                # 备用渠道 [{ baseURL, apiKey, model }]

context:
  enable: true
  length: 20                  # 拉多少条群记录
  maxChars: 8000              # 上下文字数预算，超了按 记忆→群记录→本轮 裁
  cacheTTL: 0                 # 群历史缓存秒数，0 关闭
  header: '...'               # 上下文模板（含 ${group.name} 等占位符）
  message: '...'              # 单条消息模板

vision:
  enable: false               # 模型支持多模态才开
  maxImageSize: 1048576       # base64 后体积上限
  maxImageDimension: 2000     # 宽高上限，超限直接丢弃（不缩放）
  maxImages: 3
  includeContextImages: false

memory:
  enable: false
  injectLimit: 5
  extract: true               # 是否用模型抽取记忆
  extractModel: ''            # 留空复用 llm.model
  maxFactsPerGroup: 200
  extractPrompt: '...'
```

### 人设文件

`presets/<id>.yaml`，文件名即 ID：

```yaml
name: 默认群友
system: |
  你是一个 QQ 群里的普通群友……
temperature: 0.9      # 可省略，省略则用 llm.temperature
maxTokens: 200        # 可省略
recallSeconds: 0      # 可省略，覆盖全局撤回时间
enabled: true
```

预设目录被清空也不会哑掉：`preset.js` 里有一份内置兜底人设。

---

## 五、API 调用

### 请求

`{baseURL}/chat/completions`，`POST`，`Authorization: Bearer <apiKey>`。
`baseURL` 写 `https://xxx/v1`、`https://xxx`、甚至完整端点 `https://xxx/v1/chat/completions` 都可以，`endpointOf()` 会归一化。

```jsonc
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "system", "content": "人设 + 运行时铁律" },
    { "role": "user", "content": [
      { "type": "text", "text": "群聊记录表格 + 当前时间 + 记忆" },
      { "type": "text", "text": "下面这条消息来自「张三」，请自然地接话：" },
      { "type": "text", "text": "今晚开黑吗" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ]}
  ],
  "temperature": 0.9,
  "top_p": 1,
  "max_tokens": 300,
  "stream": false
}
```

设计要点：

- **只发一条 user 消息**（content 数组）。不少中转站/自建网关对连续多条 `user` 会报 role 交替错误；代价是 prompt cache 命中率不如原项目的「静态 system + 多条 user」方案，见「可优化点」。
- **人设只放 system，且保持静态**。时间、记忆、群记录都放 user 里——放 system 会让每次请求的 system 都不同，KV cache 全废。
- **多模态按需**：`vision.enable=false` 时直接发纯字符串，兼容老接口。

### 响应与容错

- 非流式：取 `choices[0].message.content`；思考内容兼容 `reasoning_content` / `reasoning` / `reasoning_details`。
- 流式：逐行解析 SSE，`[DONE]` 不一定有，靠 reader 结束兜底；流式没拿到内容时自动退回非流式解析一次。
- 重试：只对 408/409/425/429/5xx 和网络错误重试，指数退避 `500 * 2^n`；401/403 这类直接换渠道，不浪费额度。
- 渠道：`[主渠道, ...fallback]` 依次尝试，任一成功即返回；全失败抛 `LLMError`，由 `apps/bym.js` 记录日志后静默放弃（不会在群里报错）。

---

## 六、消息收发对接

一条群消息要过六道关，顺序不能换：

```
新消息 → ① 去重与回声 → ② 触发闸门 → ③ 组织上下文 → ④ 语义把关 → ⑤ 出站守卫 → ⑥ 拟人化发送
```

顺序是有理由的：

- ① 必须在任何有副作用的动作**之前**，否则重复消息各自吃掉一次频率配额。
- ② 里概率放最后，否则 `Math.random()` 白白消耗在注定被过滤的消息上。
- ④ 在 ③ 之后，因为它需要群上下文；但又在生成之前，所以拒掉时不会白花一次生成的钱。
- ⑤ 在 ⑥ 之前，拦掉的内容不该被切段、算打字延迟。

### ① 入口去重与回声守卫（`utils/dedup.js`）

三层，TTL 硬编码不给配置——它们是安全边界，调松了反而出问题：

| 层 | 键 | 窗口 | 挡什么 |
|---|---|---|---|
| id 去重 | `message_id`（退回 `seq`） | 60s | 协议端重连、多适配器并存时的重复投递 |
| 内容去重 | `群 + 人 + 原文` | 45s | **换了 id 的重投** —— 纯 id 去重兜不住 |
| 回声守卫 | 自己发出去的原话 | 90s | 自己的消息被推回来 |

云崽自己有 1 秒 `msgThrottle`，但它只按时间、且挡不住后两种。

**回声是最危险的那层。** 协议端把机器人自己的消息当新消息推回来 → 我们当输入 → 生成新回复 → 又被推回。每轮内容不同、永远不重复，所以「靠内容去重」也挡不住，只有"记住自己说过什么"才行。不挡的话就是「我一直在回我自己」，而且会不断自我强化。

两个实现细节：

- `rememberSelf()` 在 `sendHumanized` 里**逐段**调用。只记最后一段的话，前面几段的回声照样能进来。
- 回声检查排在内容去重**之前**。否则第二次回声会被标成 `content`，日志里就看不出是自己的话绕回来了。

### ② 触发闸门（`utils/trigger.js`）

先做零成本的过滤（开关、黑白名单、长度、指令前缀、屏蔽词、自己发的），再按三档优先级决定接不接：

| 档 | 条件 | 冷却 | 语义把关 |
|---|---|---|---|
| 被点名 | `@` 了机器人，或 `e.atBot` 为真 | **默认豁免**（`addressedBypassCooldown`） | 跳过（明确信号） |
| 关键词 | 命中 `hitKeywords` | 默认不豁免（`bypassCooldownOnKeyword`） | 跳过（明确信号） |
| 概率 | 掷骰子过 `probability` | 从不豁免 | 可以进（`gate.enable`） |

三个细节：

- **被点名压过「不接 @ 别人的话」**。一句话同时 @ 了我和别人，说明确实在叫我；让 `ignoreAtOthers` 挡掉就成了装死。
- **豁免只针对冷却，绕不过 `maxPerHour`**。那是防刷屏的底线——被 @ 十次不该回十条。
- **关掉 `replyWhenAddressed` 不等于「@ 了也不理」**，而是退回按关键词/概率判断。这个语义区别很重要，否则一关就等于把功能关了。

被点名时还会**强制 `reply` 模式**（即使配置是 `contextual`），并且 prompt 换成「在群里直接 @ 了你，请正面回答」。`contextual` 的语义是「自己找切入点插话」，拿它回答点名会答非所问。

### ③ 组织上下文

`utils/message.js`：

- `messageToText(e)`：遍历 `e.message` 数组，`text` 拼接、`at` 转 `@昵称`（@ 的是机器人自己时丢弃，避免模型误以为自己被点名）、`image` 记 `[图片]` 占位、`face` / `record` / `video` / `file` 转占位符；消息非数组（TRSS 下是 CQ 码字符串）时从 `raw_message` 剥 CQ 码兜底。
- `collectImageUrls(e)` / `collectQuotedImageUrls(e)`：分别取当前消息和引用消息里的图片，后者用 `e.getReply()`，拿不到就用 `group.getChatHistory(seq, 1)`。
- `buildUserContent(text, urls)`：`vision.enable` 打开且确实取到图时，返回 OpenAI content 数组；否则返回纯字符串。

群上下文（`utils/groupContext.js`）要处理两个分支：

- **Miao / icqq**：`getChatHistory` 只能按 `seq` 往前翻，所以先取最新一条拿 seq，再循环翻页，最多 10 轮防死循环。
- **TRSS**：支持 `getChatHistory(0, n)` 直接取最近 n 条，取回来要 `reverse()` 成 oldest-first。

两者都统一成 **oldest-first** 后渲染成 Markdown 表格。渲染时对每个代入值做转义：

> 群友可以把昵称改成带 `|` 和换行的内容，直接拼进表格就能伪造出额外的行，冒充别人的 QQ 号或群角色。所以 `renderTemplate()` 必须转义 `|`、换行、反斜杠，并且**一次扫完所有占位符**（链式 `replace` 会让先代入的内容被二次扫描，构成模板注入）。

#### 预算裁剪（`utils/budget.js`）

群记录 + 记忆 + 本轮消息全塞进一条 user，长度是三者相加。平时没事（20 条 × 30 字 ≈ 700 字），但把 `context.length` 调大、或者群里开始刷长消息，就会一路涨到把请求撑爆——表现是上游 400，日志里只有一行 `context length exceeded`，看不出是哪里超的。

超过 `context.maxChars`（默认 8000）后按「丢了最不心疼」的顺序裁：

| 顺序 | 裁什么 | 怎么裁 |
|---|---|---|
| ① | 记忆 | 整段丢。本来就是参考，这一轮不用也能接话 |
| ② | 群记录 | 从**最早的**开始丢，最新的语境最有用。至少保留最近一条，除非连它都放不下 |
| ③ | 本轮消息 | 前两者丢光了还不够才硬截，补省略号 |

**人设（system）永不裁**——裁掉人设等于换了个机器人，比报错更糟。

群记录被裁光时，`contextual` 会自动退回 `reply`，否则模型会凭空发言。图片不在字符预算里，它们由 `vision.maxImages` / `maxImageSize` 控制，走的是另一个维度。

### ④ 语义把关（`models/gate.js`，默认关）

概率闸门只控频率，控不住「合不合适」——掷到骰子的时候，群里可能正在两个人吵架、在刷广告接龙、有人发自言自语的牢骚。这些场合插一句比不说话糟得多。

让模型给这条消息打 0-10 分，低于 `gate.threshold`（默认 6）就不接话。

**成本控制是这块设计的关键。** 一次判定 = 一次 API 调用，每条群消息都判是不可接受的。所以顺序是：

```
概率筛（本地零成本） → 命中者才进 gate → 通过才生成
```

`probability=0.02` 意味着 100 条消息只有 2 条真正花这次调用。另外**被点名和关键词命中不进 gate**——那是明确信号，不需要模型再确认。

打分锚点比阈值更重要。不给锚点，模型会把日常闲聊打成 3 分然后全拒掉：

```
- 0-2：广告、刷屏、机器指令、纯表情
- 3-5：自言自语、明显在和某个人一对一说话
- 6-7：日常闲聊。**群里大多数消息都在这一档**
- 8-10：在问所有人、有争议、有笑点、提到了这个成员
```

判不出来（超时、返回看不懂）时**放行**，退回原来的纯概率行为——不能因为 gate 挂了就整个不说话。

被 gate 拒掉的那一轮会**退还频率配额**（`refundSpoken`）。不退的话，被拒的轮次白白吃掉 `maxPerHour`，用户会看到「明明有额度却一直不说话」，无从排查。

### ⑤ 出站守卫（`utils/guard.js`）

模型回复里出现自曝时，这一轮不发。提示词里写一百遍「你是群友不是 AI」，小模型在长上下文里照样会漏；群里蹦出一句「作为一个语言模型」，整个设定就没了。

分两档判定，这一档设计是整块的核心：

| 档 | 内容 | 处理 |
|---|---|---|
| DEFINITE | 「作为 AI 语言模型」「我的训练数据」「我由 X 开发」、本机路径 / `api_key` / `127.0.0.1` | 直接拦 |
| SUSPICIOUS | 只出现厂商名、模型名、技术术语 | **只有配了 `guard.judgeModel` 才交模型判定**，没配就放行 |

为什么不能一刀切：群友本来就在聊这些，模型回一句「Claude 那个确实好用」不算自曝。拦掉就是误伤，而误伤的代价是「机器人莫名其妙不说话，用户完全不知道发生了什么」。原则是**宁可漏，不可误伤**。

判定失败（超时、返回看不懂）时**放行**。这一点和 fatfish 的取舍相反——它选了保守拦截，但那会让一次网关抖动直接变成一次静默不发言。

三个行为约定：

- **群里不会有任何提示**。拦了就是静默，不道歉、不解释。伪人不说话是常态，但一旦开口说「我刚才那句话不该讲」就彻底破功。
- **`guard.retry` 默认关**。开着命中后会带着强约束再问一次模型（多一次请求、回复变慢）。默认关的理由：如果经常命中，说明人设提示词有问题，该去改 prompt 而不是靠重试。
- **只在正文上判**，不看 reasoning。

### ⑥ 拟人化发送（`utils/humanize.js`）

`sendHumanized()`：

1. **切分**：先按换行分段，超长段按句末标点切，单句仍超长则退到逗号处硬切，最后把相邻碎片合并到接近 `maxSegmentLength`。
2. **打字延迟**：`clamp(minMs + 字数 * perCharMs, minMs, maxMs)`，再乘 1~1.35 的随机抖动——固定延迟比长延迟更容易被认出是脚本。
3. **停顿**：多条之间额外等 `gapDelay` 的随机时长。
4. **撤回**：优先用 `e.reply()` 返回的 `message_id` 调 `group.recallMsg()`；拿不到 id 时退回 icqq 的 `{ recallMsg }` 选项（其他分支会忽略，不会报错）。
5. **不引用**：`e.reply(msg, false)`，伪人引用原消息会让“插话”变得很刻意。
6. **记回声**：每段发出后 `rememberSelf(segment)`，供 ① 的回声守卫比对。

#### 记忆作为回复的副产品

原来每轮发言后要**单独调一次模型**抽取记忆，现在改成在回复时顺带产出（`models/replyParser.js`）。

记忆开启时，在 user 消息末尾追加一段契约：

```json
{"say": "你要发到群里的话", "memory": ["值得长期记住的事"]}
```

模型一次输出两样东西，省掉一次完整调用。

**为什么不全程用 JSON**：JSON 契约会污染所有路径（分段、清洗、拟人化都得改），而且小模型输出 JSON 经常坏。所以只在需要时启用，记忆关闭时还是纯文本——零解析风险。

**解析失败必须退化，不能吞回复**：

| 模型输出 | 处理 |
|---|---|
| 正常 JSON | 拆出 `say` / `memory` |
| 完全不是 JSON | **整段当回复**，标 `degraded`，这一轮不记记忆 |
| JSON 坏了（少引号） | 同上 |
| `say` 是空串 | 记忆收下，正文判失败，退回独立抽取 |
| `say` 不是字符串 | 整段当回复 |

只有 `degraded` 时才退回老的 `extractFacts()`（那条路要额外一次调用，且要求 ≥6 条语料，只作兜底）。

---

## 七、插件加载与触发逻辑的改造点

### 加载

原 `index.js` 用 `fs.readdirSync('./plugins/chatgpt-plugin/apps')`——依赖当前工作目录和插件目录名。
新版改成从 `import.meta.url` 推导绝对路径，插件改名、软链、甚至工作目录不同都不会失效。

另一个改动是**一个文件可以导出多个插件类**：原逻辑只取 `Object.keys(mod)[0]`，多导出的类会被静默丢掉。

### 触发（这是最关键的改造）

原 `apps/bym.js` 的 `bym(e)` 是 `await` 到底的。但伪人的发送带 1~6 秒打字延迟，
`await` 意味着**这条消息的整条插件链都被卡住**，表现为签到、抽卡等无关功能一起变慢。

新版：

```js
async onMessage (e) {
  this.trySpeak(e).catch(err => logger.error(err))   // fire-and-forget
  return false                                        // 立刻放行后续插件
}
```

配套的两个正确性措施：

1. **先记账再请求**。`markSpoken()` 必须在调用模型之前执行，否则模型响应那几秒内到达的群消息会各自通过冷却检查，一次触发变成连发。
2. **关键词命中不等于可以刷屏**。`bypassCooldownOnKeyword` 默认 `false`：热词命中仍然受冷却与每小时上限约束。

### 触发闸门（`utils/trigger.js`）

原项目只有「概率 / 关键词」两层判断。新版加了 8 道过滤，顺序按“成本从低到高”：

```
开关 -> 是否群聊 -> 群白/黑名单 -> 空/过短/过长 -> 指令前缀
     -> 屏蔽词 -> 自己发的 -> @了别人 -> 关键词(强制) -> 概率
```

几个容易踩的坑：

- **白名单为空时默认全禁**（`groupMode: whitelist` + `groups: []`）。反过来（空即全开）会在任何群里都接话。
- **概率判断放最后**。`Math.random()` 每掷一次就消耗一次运气，放在前面会让 debug 日志里的“骰子值”与真实判定脱节。
- **忽略 @ 别人的消息**。群里的定向对话被机器人插嘴是最容易被踢的行为。

### 发言方式（reply / contextual）

- `reply`：把触发它的那条消息原样发给模型，附一句「请自然地接话」。
- `contextual`：丢掉触发消息，改成发 `contextualPrompt`，让模型自己在上下文里找切入点。

`contextual` **依赖群上下文**：`context.enable=false` 或没拉到历史时，`resolveMode()` 自动退回 `reply`，否则模型会对着空上下文“凭空发言”。

---

## 八、取舍与能力对照

| 能力 | 原项目 | 本插件 | 说明 |
|---|---|---|---|
| 概率触发 | 有 | 有 | |
| 关键词强制触发 | 有 | 有 | 另加冷却约束 |
| 关键词换人设 | 有（presetMap） | 有 | 支持规则级撤回时间覆盖 |
| 群上下文 | 有（+快照对齐、图片 ref） | 有（简化） | 无快照，无 prompt cache 优化 |
| 群/用户记忆 | SQLite + sqlite-vec 向量 | JSON + 2-gram 打分 | 见下 |
| 图片多模态 | 有（ref 缓存 + 独立识图渠道） | 有（直转 base64） | 超限丢弃，不缩放 |
| 工具调用 / MCP | 有 | 无 | 伪人不需要 |
| 管理面板 | 有（Vue 前端） | 无（指令足够） | |
| 历史持久化 | 有（三库分离） | 无 | 伪人每次独立发言 |
| 撤回 | 有 | 有 | 手动 recall + 选项兜底 |
| 分段发送 | 无（整段发） | 有 | 更像人 |

### 记忆为什么降级

原记忆模块 2000+ 行，核心价值是语义检索。权衡：

- 伪人的记忆注入量很小（`injectLimit: 5`），语义检索相对关键词的边际收益不明显；
- `sqlite3` 是原生模块，在 aarch64 / 无编译环境的机器上经常装不上，装不上整个插件就起不来；
- JSON 方案可以直接 `cat data/memory.json` 排障，也能整文件备份。

打分公式 `相关度 * 0.6 + 重要度 * 0.25 + 时间衰减 * 0.15`，
相关度用 2-gram 重合度除以 `sqrt(|q| * |f|)` 归一化，避免长事实天然占优。

如果确实需要向量检索，接入点只有 `memory.js` 的 `queryFacts()` 一个函数，替换实现即可。

---

## 九、在 TRSS-Yunzai 上的注意点（实测）

针对 TRSS 的插件生命周期与事件语义做过仿真验证，部署时有三处必须确认：

1. **`config/config/group.yaml` 的 `onlyReplyAt` 必须为 `0`**。
   TRSS 的 `deal()` 里有一行 `if (!e.only_reply_at) return`，位置在规则匹配**之前**——非 0 时插件根本不会被调用，表现为「其他功能正常，就是不会主动说话」。
2. **`config/config/other.yaml` 的 `blackGroup` 要清掉出厂值**（默认含 `213938015`）。黑白名单同样在插件之前生效。
3. **构造函数不能有副作用**。TRSS 的 `loadPlugin` 每个类会 `new` 两次（init + rule），`deal()` 里每条消息还会再 `new` 一次并把 `e` 传进来。所以冷却、频率这类状态必须放模块级（本插件就是这么做的），不能挂实例字段。
4. **`config/config/server.yaml` 的 `auth` 留空**。LLBot 的 `ws-reverse` 只能配 token、不能加自定义 Header，一旦配了 auth 必然 401。

关于撤回：插件**不**使用 `e.reply` 的 `{ recallMsg }` 选项。TRSS 对该选项的实现是「撤回回复 **+ 撤回触发它的用户消息**」，在陪聊场景下把群友的话撤掉非常突兀；插件改为只撤自己发出的那一条，各分支行为一致。

## 十、可优化点与已知限制

1. **prompt cache**：目前所有内容塞一条 user。若后端支持且命中率重要，把 `chatService.js` 里 `content` 拆成 `[群上下文] [时间+记忆] [本轮]` 三条 user，并让群上下文**只追加不滑动**（保留旧消息在前）——这正是原项目 `groupContextCache` 快照对齐在做的事。
2. **图片不缩放**：只嗅探尺寸后丢弃。要缩放就得引 `sharp`（原生模块）或用云崽自带的浏览器截图能力，后者更重。
3. **无工具调用**：如果想让伪人会查天气、搜图，需要在 `llmClient.js` 加 `tools` 透传 + 工具执行循环。
4. **与 `chatgpt-plugin` 共存**：两者都用 `^[^#]` 这类宽正则监听群消息。同时装时建议只保留一个的伪人功能——把本插件的 `priority` 调到比对方大（数字大 = 后执行）或反过来，取决于想让谁先说话。更干净的做法是把 `chatgpt-plugin` 的 `bym.enable` 关掉。
5. **TRSS 分支未实测**：`getChatHistory` 的返回顺序在两个分支上不一致，代码里已分别处理，但只在 Miao/icqq 上验证过行为。
6. **去重表、回声表只在内存里**，重启后清空。正常情况下没影响（重投都发生在秒级），但如果协议端在机器人重启后重放历史消息，90 秒窗口内的回声可能漏过。
7. **守卫是关键词级，不是语义级**。中英文最典型的自曝句式都覆盖了，但模型换个说法（「我没有身体」→「我本质上是一段程序」）仍可能绕过。真正可靠的办法是配 `guard.judgeModel`，代价是每条可疑回复多一次调用。定位是「兜底」，不是「保证」。

---

## 十一、管理指令

| 指令 | 作用 |
|---|---|
| `#bym 状态` | 当前配置、预设、本群频率与记忆条数 |
| `#bym 开` / `#bym 关` | 开关（写回配置文件） |
| `#bym 重载` | 重载配置、预设、群上下文缓存 |
| `#bym 测试 <文本>` | 走完整链路生成但不发送，用于调 prompt |
| `#bym 记忆` | 查看本群记忆（按重要度排序） |
| `#bym 清空记忆` | 清空本群记忆与频率记录（私聊为全局） |

均为 `permission: 'master'`。

---

## 十二、自测

不装云崽、不填 API Key 也能跑：

```bash
node tests/smoke.mjs       # 配置、分段、触发闸门（含被点名）、冷却退配额、记忆、预设、输出清洗、发送
node tests/llm.mjs         # 端点归一化、请求体、流式聚合、5xx 重试、401 换渠道
node tests/guoba.mjs       # 锅巴契约：schema 合法性、扁平 map 读写往返、非法 JSON 拒绝
node tests/config.mjs      # 扫源码验证每个 config.xxx 都能解析（防「加了配置段却忘注册访问器」）
node tests/guard.mjs       # 出站守卫：必拦句式、不误伤、判定失败降级
node tests/dedup.mjs       # 去重与回声：三种重复、TTL 过期、硬上限
node tests/budget.mjs      # 上下文裁剪：顺序、边界、参数容错
node tests/gate.mjs        # 语义把关：打分解析、阈值、失败放行、请求参数
node tests/replyParser.mjs # JSON 契约：正常解析与六种坏输出的退化
```

合计 **223 项**，全部不联网。另有 `sim-lab/` 里的 58 项仿真（协议层 7 + 业务层 51），
需要 TRSS 宿主桩件，跑法见该目录的 `sync.mjs` 说明。

`config.mjs` 是唯一一个「测代码结构而不是测行为」的测试，它值得单独说一句：它扫描全部源码里的 `config.xxx` 用法，逐个断言能解析到真实值。加这个是因为踩过坑——配置段访问器以前是手写 getter 列表，新增 `guard` 段时漏了注册，`config.guard` 变成 `undefined`，所有 `config.guard?.xxx` 静默走默认分支，表现为「面板改了开关完全没反应」而且不报错。现在漏一个就会在测试里失败。

`smoke.mjs` 会把 `BYM_CONFIG_DIR` / `BYM_DATA_DIR` 指向系统临时目录并在结束时删除，
不会污染插件目录里的真实配置。

这两个环境变量在生产里也有用：多个机器人实例共用一个插件目录时，
给每个实例指定独立的配置与数据目录即可（否则会互相覆盖 `memory.json`）。

---

## 十三、锅巴（Guoba）适配

插件根目录带 `guoba.support.js`。装了 [Guoba-Plugin](https://gitee.com/guoba-yunzai/guoba-plugin) 之后，所有配置都能在 Web 面板里改，不用手编 YAML。

> 锅巴的接入机制（扫描规则、`supportGuoba` 契约、组件白名单、扁平 map 读写）分析，以及面板字段对照表和排错，见 **[GUOBA.md](./GUOBA.md)**。这一节只讲要点。

### 为什么能直接用

锅巴和云崽跑在**同一个进程**。它扫描 `plugins/*/guoba.support.js`，`import` 后调用导出的 `supportGuoba()`（`server/service/interface/IPluginService.js`）。

所以这里 `import` 到的 `config` 就是插件运行时真正在用的那个单例——面板点保存，内存立刻生效，**不需要重启，也不经过热加载**。

### 结构

```js
export function supportGuoba () {
  return {
    pluginInfo: { name, title, icon, ... },
    configInfo: {
      schemas: [...],                           // 表单定义
      getConfigData () { ... },                 // 给前端填表
      setConfigData (data, { Result }) { ... }  // 保存
    }
  }
}
```

`component` 用锅巴前端注册过的名字（`Input` / `InputPassword` / `InputNumber` / `InputTextArea` / `Switch` / `RadioGroup`），分组用 `SOFT_GROUP_BEGIN`。

> 这些名字不是猜的：从锅巴 1.4.2 的前端构建产物里能直接读到组件映射表（`componentMap.set(...)`）。

### 数组和对象怎么编辑

锅巴没有可靠的标签输入组件，所以按类型分开处理：

| 类型 | 面板上的样子 | 涉及字段 |
|---|---|---|
| 字符串数组 | 一行一项的文本框 | `trigger.groups`、`hitKeywords`、`ignoreCommandPrefixes`、`muteKeywords` |
| 对象数组 | JSON 文本框 | `speaking.presetMap`、`llm.fallback` |
| 对象 | JSON 文本框 | `llm.extraHeaders`、`llm.extraBody` |

`getConfigData()` 把数组转成文本，`setConfigData()` 转回来。JSON 解析失败时返回 `Result.error`，并且**整张表单一项都不写**——避免「改了一半」这种更难受的状态。

这套做法和锅巴自己处理 `base.gitInstallWhitelist` 完全一致，属于已验证路径。

### 批量写入

面板一次提交整张表单，逐项走 `config.set()` 会把配置文件重写几十遍，还会让 `fs.watchFile` 反复触发。所以给配置类加了一个 `apply(patch)`：所有 keyPath 改完只写一次盘。

### 三个注意点

- `pluginInfo.name` 必须等于插件目录名（小写），锅巴用它做路由 key。
- 改了 `commandPrefix` 仍然要重启——指令正则是插件加载时编译的，面板改不了。
- `guoba.support.js` 解析失败不影响插件运行，只是面板里看不到这个插件的配置（锅巴会在日志里报错）。

### 自测

不装锅巴也能验证契约：

```bash
node tests/guoba.mjs   # 23 项
```

覆盖：`supportGuoba` 返回值契约、组件名白名单、schema 字段完整性、字段路径是否存在、数组/JSON 往返、非法 JSON 拒绝、空值不写脏数据。

其中「每个 field 都能在真实配置里找到」这条，会在写错配置路径时立刻失败——它比人工核对 60 多个字段名可靠。

---

## 十四、变更记录

### 1.3.1

按 Ponytail 审核报告（`../docs/审核报告-v1.3.0.md`）修完 17 条 finding。九条属于「改完不生效／根本没生效」这类看不见的问题：

| 类型 | 变化 |
|---|---|
| 修复 | **数组配置写成标量会崩在每条群消息上**：`fillDefaults` 只校验对象段不校验数组，`groups: 123456` 会让 `(groups \|\| []).map` 抛 `is not a function`。现在标量会**包成单元素数组**（保住用户意图）并打 warn |
| 修复 | `refundSpoken` 并发下退掉别人的记录：`markSpoken` 返回 token，退款按 token 精确删。`stamps` 由数组改为 `Map` |
| 修复 | 语义把关与自曝判定的请求继承了主渠道 `retries: 2`，上游抖动最坏白等 1.5 秒。判定层现在 `retries: 0`、超时上限 8 秒 |
| 修复 | 模型只返回 `memory` 不给 `say` 时，`replyParser` 收下的记忆被 `bym.js` 的提前 return 丢掉。记忆落库提到正文判空之前，抽成 `saveMemory()` |
| 修复 | `parseScore` 只看第一行，模型输出「评分：\n7」时静默失效 → gate 开着等于没开。改为三级解析（JSON → 标签附近数字 → 全文第一个数字） |
| 修复 | `cleanMemory` 遇到 `"memory": "字符串"` 直接丢弃。现在字符串包成单元素数组 |
| 新增 | 记忆契约加防注入约束：不接受「你要记住」「帮我记一下」这类指令性内容，尤其不记欠款、承诺、谁对谁错 |
| 变更 | `memory` 条目支持 `{fact, importance}` 形式，`importance` 来自模型 —— 之前硬编码 0.5 让打分公式里那一维完全失效。字符串条目仍按 0.5 处理 |
| 优化 | `addFact` 支持 `deferred` 跳过落盘，批量写完 `flushMemory()` 一次。一轮 5 条记忆从 6 次全量写盘降到 2 次 |
| 优化 | 预算把记忆契约本身（约 240 字）算进去；契约从 user 消息中段移到**最后**（它是输出格式要求，不是上下文） |
| 优化 | `isAddressed` 每条消息只扫一次；图片缓存加 5 分钟 TTL（原来只按条数淘汰） |
| 优化 | `#bym 状态` 补上守卫/语义把关/去重的开关状态 |
| 删除 | `config.get()`（全仓库零调用，12 行）、`guard.js` 的多余 `export { DEFINITE, SUSPICIOUS }` |

### 1.3.0

三块都是「让伪人更像人」的补强，其中前两块修的是**用户能直接感知到的缺陷**：

| 类型 | 变化 |
|---|---|
| 修复 | **`@` 机器人根本不保证回**：`evaluate()` 里没有 `atBot` 判断，点名了也只按概率走。现在被点名必回（`trigger.replyWhenAddressed`），并默认豁免冷却（`trigger.addressedBypassCooldown`），但绕不过 `maxPerHour` |
| 修复 | 被点名时强制 `reply` 模式并换 prompt（「在群里直接 @ 了你，请正面回答」）。`contextual` 的语义是「自己找切入点插话」，拿它回答点名会答非所问 |
| 修复 | 一句话同时 @ 了我和别人时，不再被 `ignoreAtOthers` 挡掉（那是在叫我，不是「插别人的话」） |
| 新增 | `utils/budget.js`：上下文预算裁剪。超过 `context.maxChars`（默认 8000）后按「记忆 → 群记录（从最早的丢）→ 本轮消息」裁，人设永不裁。裁光上下文时 `contextual` 自动退回 `reply` |
| 新增 | `models/gate.js`：语义把关（`gate.enable`，**默认关**）。概率命中后再让模型给 0-10 分，低于 `gate.threshold` 不接话。被点名和关键词不进 gate |
| 新增 | `refundSpoken()`：被 gate 拒掉的那一轮退还频率配额（否则「明明有额度却一直不说话」） |
| 新增 | `models/replyParser.js`：记忆改成回复的副产品（JSON 契约 `{say, memory}`），省掉原来每轮那次独立抽取调用。解析失败自动退回纯文本，绝不吞回复 |

`memory.extract` 的语义变了：从「发言后单独抽取一次」变成「回复时顺带产出」。
`memory.extractModel` / `memory.extractPrompt` 现在只用于退回路径（模型没按契约输出时）。

### 1.2.0

两个「兜底」能力，都是纯增量、不动原有链路：

| 类型 | 变化 |
|---|---|
| 新增 | `utils/guard.js`：出站守卫。回复里出现自曝时这一轮不发。分「必拦」「可疑」两档，后者只在配了 `judgeModel` 时才判，避免把群友正常聊模型当成自曝 |
| 新增 | `utils/dedup.js`：入口去重与回声守卫。id 60s / 内容 45s / 回声 90s 三层，挡住协议端重投和「我回我自己」的死循环 |
| 新增 | `config.guard`（`enable` / `judgeModel` / `retry`）、`config.dedup`（`enable`）两段，锅巴面板同步加了「防自曝与去重」分组 |
| 新增 | `tests/guard.mjs`（30 项）、`tests/dedup.mjs`（17 项）、`tests/config.mjs`（22 项）；仿真新增 G6/G7 共 11 项 |
| 修复 | **配置段访问器漏注册**：`config.guard` 曾是 `undefined`，导致开关与重试项静默失效。改为集中注册的表驱动方式，并加 `tests/config.mjs` 扫源码防复发 |

### 1.1.0

新增锅巴适配：

| 类型 | 变化 |
|---|---|
| 新增 | `guoba.support.js`：装了 Guoba-Plugin 后可在 Web 面板里调整全部配置（60+ 项，按 8 个分组） |
| 新增 | `config.apply(patch)`：批量写入扁平 keyPath，只写一次盘（面板一次提交整张表单） |
| 新增 | `tests/guoba.mjs`：23 项契约测试，含「schema 字段路径是否真实存在」的防拼错检查 |

### 1.0.1

修掉 1.0.0 里审核出的问题，行为有变化，建议升级：

| 类型 | 变化 |
|---|---|
| 修复 | `js-yaml` 5.x（纯 ESM、无 default 导出）会让插件启动即崩。改为 `import * as YAML`，4.x / 5.x 通吃 |
| 修复 | 配置里某个段留空（YAML 中 `llm:` 后面没内容 = `null`）会导致第一次对话抛 `Cannot read properties of null`。现在会用默认值覆盖非对象段 |
| 修复 | Miao/icqq 分支的群聊记录顺序错乱：跨两批时输出 20,19,…,16,40,39,…,21。改为 `unshift` + 去重 + `slice(-count)`，与 TRSS 分支一致，都是 oldest-first |
| 修复 | 模型输出被 `slice(0, 500)` 静默砍在半句。已删除 |
| 修复 | `recallSeconds > 0` 时会双重撤回，且云崽会连用户原消息一起撤。改为只撤自己那条 |
| 修复 | `clearMemory` 落盘是 fire-and-forget。现在返回 Promise，调用方 await |
| 修复 | `@` 识别只认摊平格式，原始 OneBot 的 `{data:{qq}}` 认不出。两种都支持 |
| 修复 | `~` / `～` 被当作句末标点，`好~` 会被切成两条。已从切分符里移除 |
| 改进 | 记忆抽取语料不足时打 debug 日志说明原因（需要 `context.enable`） |
| 改进 | `#bym重载` 会提示「改过 commandPrefix 需重启」 |
| 清理 | 删除 5 处死代码（`unknownKeys`、`reloadMemory`、两处多余 export、`resolvePreset` 的无用参数） |

配套的仿真测试（27 项）与协议层测试（7 项）在 `../sim-lab`，插件自带单测 38 项。
