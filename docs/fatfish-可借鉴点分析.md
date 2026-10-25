# fatfish-qq-bot 可借鉴点分析

> 分析对象：[zouxinhao594-alt/fatfish-qq-bot](https://github.com/zouxinhao594-alt/fatfish-qq-bot)（「大肥鱼」QQ 陪伴机器人，MIT，单次 init 提交）
> 对照项目：本仓库的 `chatgpt-bym`（云崽伪人模式插件）
> 结论：**它的架构和我们的几乎同构，但它把"像人"这件事拆成了可执行的流水线步骤**，有 8 处值得借鉴，其中 2 处属于我们目前的安全缺口。

---

## 一、项目概览

### 1.1 定位差异

| | fatfish-qq-bot | chatgpt-bym |
|---|---|---|
| 宿主 | 独立进程，直连 OneBot11 网关 | 云崽（Yunzai）插件 |
| 依赖 | **零 npm 依赖**，全用 Node 内置模块 | 1 个（js-yaml） |
| 规模 | 41 个模块 / 8920 行 | 16 个模块 / 约 2100 行 |
| 功能面 | 聊天 + 语音克隆 + 唱歌 + 表情包 + QQ 空间日记 + 知识库 + 网页控制台 | 只做聊天 |
| 配置 | `data/config.json` + 自建网页控制台 | `config.yaml` + 锅巴面板 |

功能面差得很远，但**聊天的执行链路高度同构**：

```
它的： gate（该不该回）→ context（人格/记忆/历史）→ llm（出契约 JSON）
      → guard（禁自曝）→ outbound（拆条/脱敏）→ transport（发回 QQ）

我们的： trigger（该不该回）→ chatService（拼上下文）→ llmClient（纯文本）
       → humanize（拆条/延迟）→ reply
```

差别最大的是两头：**它的 gate 用模型判断"该不该接"，它出站前有一道 guard**。这两点正好是我们最薄的地方。

### 1.2 核心模块分工

| 模块 | 职责 | 行数 |
|---|---|---|
| `src/pipeline.mjs` | 一个回合的完整 10 步，含去重、回声守卫、多气泡、记忆落库 | 734 |
| `src/gate.mjs` | 门槛链 + 模型相关性打分 + 自主发言冷却 | 197 |
| `src/context.mjs` | 上下文装配（分层 system + 预算裁剪）+ 输出契约 | 137 |
| `src/llm.mjs` | OpenAI 兼容调用 + 契约 JSON 容错解析 | 269 |
| `src/guard.mjs` | 禁自曝（正则 + 可选模型判定）+ 异常话术白名单 | 60 |
| `src/outbound.mjs` | CQ 转真段、凭据脱敏、路径替换、分条 | 79 |
| `src/memory.mjs` | 长期记忆（近似去重 + 欠条销账） | 154 |
| `src/people.mjs` | **按 QQ 号记账**（跨群跨私聊认识同一个人） | 143 |
| `src/mood.mjs` / `relations.mjs` | 心情（时间 + 情绪词）与关系（主人/群友）影响语气和条数 | — |

### 1.3 它把「像人」拆成了什么

`pipeline.mjs:1-11` 的注释直接给出了 10 步，每一步都对应一个可测的具体行为：

```
1 收帧（归一化）
2 去重：self_id:message_id，512 条 / 60 秒窗口
3 门槛：白名单群 → 主人 → @必回 → 静默时段 → 醒词 → 相关性判定 → 频率
4 看图：图片交给视觉通道描述成文字（失败也不挡回话）
5 装配：人格（永不裁）+ 心情 + 关系 + 契约 + 记忆 + 历史 + 知识库 + 本轮
6 调模型：要求返回契约 JSON
7 补看：模型说要看网页 → 程序代抓 → 回灌 → 再想一次（最多一次）
8 守卫：逐条查是否自曝模型/厂商/技术栈
9 出站：CQ→真段、切分、脱敏、路径替换
10 记账：写事件、累 token、把模型说"值得记"的写进长期记忆
```

---

## 二、值得借鉴的 8 处

### 借鉴点 1：出站前拦"自曝"，异常翻译成人话

**位置**：`src/guard.mjs:1-19`（`EXPOSURE_RULES`、`userFacing`）、`src/guard.mjs:37-57`（`check`）

**它怎么做的**

四条正则覆盖四类泄漏（`guard.mjs:5-10`）：

```js
{ re: /\b(deepseek|openai|gpt-?\s?\d|claude|gemini|qwen|豆包|glm|llama…)\b/i, why: '厂商/模型名' },
{ re: /(大模型|语言模型|参数量?|上下文窗口|提示词|微调|训练数据|api key|temperature)/i, why: '技术栈术语' },
{ re: /(我是.{0,10}(模型|AI|机器人助理))|(我由.{0,16}(开发|训练|部署))/, why: '自述身份' },
{ re: /(errno|127\.0\.0\.1|localhost|\.exe\b|[A-Z]:\\)/i, why: '本机路径/接口/报错' },
```

命中后**不直接判死**——配了 `guardModel` 就交给廉价模型判断"这句话是否真的在暴露技术身份"，避免把"讲个故事里的模型"也拦掉；模型判定失败时**保守拦截**（`guard.mjs:52-56`）。

还有一条 `userFacing()`（`guard.mjs:13-19`）：任何异常都必须经它翻译才允许出现在群里——

```js
if (/超时|timeout|abort/.test(m)) return '我这边有点卡，等下再来呀'
if (/apiKey|401|403|key/.test(m)) return '我这会儿有点犯迷糊，等下再说呀'
```

**为什么值得借鉴**

我们的 `chatService.postProcess()` 只做了三件事：去整段引号、去 `我说：` 前缀、去 Markdown 星号。**模型如果说出"我是 GPT-4o-mini"或"我的提示词要求我……"，会原样发到群里。**

它在注释里写得很直白："提示词兜不住的，这里兜"——因为提示词里写一百遍"不要自曝"，小模型在长上下文里照样会漏。

**怎么用到我们这**

1. 新建 `utils/guard.js`，把 `EXPOSURE_RULES` 那四条搬过来（中文场景可再加 `通义|文心|豆包|混元`）。
2. 在 `apps/bym.js` 里，`sendHumanized()` 之前插一道：

```js
const guarded = guard.check(reply.text)
if (guarded.blocked) {
  logger.debug(`[bym] 拦下自曝内容：${guarded.why}`)
  return  // 或改为发一句通用话术
}
```

3. 异常路径现在是这样（`apps/bym.js`）：

```js
} catch (err) {
  logger.error(`[bym] 生成失败：${err.message}`)   // 群里什么都不发
  return
}
```

改成发一句 `userFacing(err)` 的话术，比"装死"更接近真人。配 `guard.userFacingOnError: true` 开关，默认关（有些群宁可不说话）。

4. 配置项加到 `config.js` 的 DEFAULTS：`guard.enabled`、`guard.model`（留空=只走正则）、`guard.replaceWith`、`guard.userFacingOnError`。

---

### 借鉴点 2：把关不是"掷骰子"，而是让模型打分

**位置**：`src/gate.mjs:74-127`（`judge`）、`src/gate.mjs:172-193`（三档决策）

**它怎么做的**

用一次独立的小模型调用给这条消息打 0~10 分（`gate.mjs:77-87`）：

```
10  = 直接在对机器人说话、点它的名
8-9 = 明确在提问，或话题正中它的领域
6-7 = 日常闲聊、分享、吐槽 —— 群里大多数消息都在这一档，接一句很自然
4-5 = 明显是在跟某个具体的人说话、或在聊很私人的事
0-3 = 抬杠引战、刷屏复读、纯表情、无关广告
拿不准时给 6，不要因为"怕打扰"就压分
```

然后三档决策（`gate.mjs:186-193`）：

```js
if (score >= A) return accept('')                       // A = autonomyThreshold，默认 7
if (score >= A - 2) return random() < autonomyChance ? accept('低分掷中') : 不接
return 不接
```

**两个踩坑记录值得抄进注释**：

- `gate.mjs:17-19`：把关调用给 `maxTokens=60`，推理模型先花一百多个 reasoning token 再吐正文 → 正文被截空 → **每条非 @ 消息都被判成"不接"**。所以给 600，空了还要重试一次。
- `gate.mjs:118-126`：模型没给出可用结果时走**启发式兜底**（有问号=7、纯"哈/嗯/哦"=1、长度≥12=5），不让整条链路死掉。

**为什么值得借鉴**

我们的 `utils/trigger.js` 只有五层硬规则（关键词 → 概率 → 冷却 → 黑白名单 → @别人），概率是**纯随机**的。

后果是：群里聊得正热闹时它可能突然插一句完全无关的；有人在讨论很私人的事它也可能凑上去。`probability: 0.02` 只能控制"频率"，控制不了"合不合适"。

**怎么用到我们这**

1. `utils/trigger.js` 的 `evaluate()` 里，概率那一层之前插入 `judgeRelevance(e, text, recent)`。
2. 复用现有的 `models/llmClient.js`，但**单独给一个模型名**（用小模型，便宜）：

```js
const judge = await chatCompletion({
  llm: { ...config.llm, model: config.trigger.gateModel || config.llm.model,
         maxTokens: 600,          // 别给 60，推理模型会吐空
         temperature: 0.2 },
  messages: [{ role: 'system', content: GATE_SYSTEM }, { role: 'user', content: user }],
})
```

3. 新增配置（`config.js` 的 `trigger` 段）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `gateEnabled` | `false` | 默认关，开了每条消息多一次调用 |
| `gateModel` | `''` | 留空复用 `llm.model`，建议单独填便宜的小模型 |
| `gateThreshold` | `7` | 达到就接 |
| `gateChance` | `0.5` | 落在 `[threshold-2, threshold)` 时掷骰子的概率 |
| `gateMaxTokens` | `600` | 低于 300 容易吐空 |
| `gateFallback` | `true` | 模型失败时用启发式（问号/长度）而不是直接不接 |

4. **成本控制**：`gateEnabled` 默认关，且在 `trigger.probability` 之前跑（先便宜地随机筛掉 90%，剩下的才打分）。否则每条群消息都要多一次 API 调用。

---

### 借鉴点 3：@ 我和主人必回，压过冷却

**位置**：`src/gate.mjs:138-153`

**它怎么做的**

```js
// @ 我 / 私聊：必回，压过所有"值不值得""冷却没冷却"的判断
// （踩过的坑：冷却把"明显在问它"的消息也挡了，用户看到的就是"它装死不回"）
if (mentioned || isPrivate) {
  if (!rateOk(...)) return { reply: false, reason: '触发频率上限' }
  return { reply: true, reason: '@ 我', score: 10 }
}
if (tier === 'owner' && cfg.ownerAlwaysReply !== false) {
  return { reply: true, reason: '主人', owner: true, score: 10 }
}
```

注意它压过的是**冷却和静默时段**，但**不压过频率上限**——频率上限留着防刷屏和防死循环（回声守卫也是同理）。

**为什么值得借鉴**

我们的 `apps/bym.js`：

```js
const bypassCooldown = decision.forced && config.trigger.bypassCooldownOnKeyword === true
const rate = checkRate(e.group_id, { bypassCooldown })
```

`bypassCooldownOnKeyword` **默认 false**——也就是说，即使有人在群里明确喊它（命中关键词），只要 60 秒内说过话，它也不回。我曾把这当成"防刷屏"的正确设计，但 fatfish 的踩坑记录说明相反：**用户感知到的是"叫不动"**。

真正的区别在于：**主动插话**要严格限流，**被点名**要尽量响应。两者不该共用一套冷却。

**怎么用到我们这**

1. `utils/rateLimit.js` 的 `checkRate()` 增加一个 `skipCooldown` 语义（不是现在的 `bypassCooldown`），调用方区分两种触发来源：

```js
const isAddressed = decision.forced || isAtBot(e)   // 关键词命中 或 @ 了机器人
const rate = checkRate(e.group_id, { skipCooldown: isAddressed })
// 每小时上限 maxPerHour 仍然生效，只跳冷却
```

2. `utils/trigger.js` 的 `precheck()` 里，`ignoreAtOthers` 的判断已经会放行"@ 机器人自己"，把 `isAtBot(e)` 的结果带进 `evaluate` 的返回值。
3. 配置改为：`trigger.addressedBypassCooldown`（默认 **true**），替换现在的 `bypassCooldownOnKeyword`（默认 false）。这是一个**默认值反转**，需要在变更记录里写清楚。
4. `maxPerHour` 保持对所有触发生效——这是它说的"防刷屏/防死循环"的底线。

---

### 借鉴点 4：去重与回声守卫

**位置**：`src/pipeline.mjs:2`（id 去重）、`:166-167`（内容去重与回声）、`:207-221`

**它怎么做的**

三层：

1. **id 去重**：`self_id:message_id`，512 条 / 60 秒窗口。
2. **内容级去重**：`groupId|userId|text`，同人 45 秒内说同样的话只处理一次。
   > 注释：NapCat 在某些情况下会把同一条消息投递多次，且 `message_id` 可能不同，靠 id 去重兜不住。
3. **回声守卫**：内容和 90 秒内自己发过的完全一样 → 丢掉。
   > 注释：防 NapCat 把我们的消息当新消息推回来，形成"我一直回我在"。

**为什么值得借鉴**

我们依赖云崽的 `msgThrottle`（`self_id:user_id:raw_message` 1 秒内去重），但那是**云崽层**的，1 秒窗口很短，而且插件自己没有任何防护。

如果我们哪天换协议端（或协议端重复投递），会出现：同一条消息触发两次 → 机器人发两条一样的 → 内容的回声又触发一次 → 死循环。我们目前完全没有拦这个的手段。

**怎么用到我们这**

1. 新建 `utils/dedupe.js`，两个 Map：

```js
// key -> 时间戳，超过窗口清掉
export function seenMessage(selfId, messageId) {...}     // 120 秒窗口，最多 512 条
export function seenContent(groupId, userId, text) {...} // 45 秒窗口
export function isSelfEcho(groupId, text) {...}          // 90 秒内自己发过的
```

2. `apps/bym.js` 的 `trySpeak()` 开头按顺序挡：id → 内容 → 回声。
3. `sendHumanized()` 发送成功后，把发出的文本写进回声表。
4. 这些是纯内存结构，不需要配置项；窗口大小做成常量即可。

---

### 借鉴点 5：输出契约 —— 让模型顺带给结构化信号

**位置**：`src/context.mjs:6-54`（`contractFor`）、`src/llm.mjs:231-265`（解析）、`src/pipeline.mjs:632-633`（记忆落库）

**它怎么做的**

每轮要求模型只输出一个 JSON（`context.mjs:35`）：

```json
{"segments":["一句话一条"],"mood":"摸鱼|困|炸毛…","sticker":"auto|none",
 "follow":"说完又想起的一小句","memory":["值得长期记住的一件事"]}
```

两个细节很实用：

- **`segments` + `|||`**：模型自己决定分几条（`outbound.mjs:21-28`），程序负责间隔和上限。我们现在的做法是**程序按标点硬切**，模型没有表达意图的机会。
- **`memory` 是回复的副产品**（`pipeline.mjs:632`：`for (const m of parsed.memory || []) memory.add(m)`）——**不额外调用模型**。我们现在是每轮发言后再单独跑一次 `extractFacts()`，既慢又贵。
- **契约解析失败不等于不该说话**（`pipeline.mjs:291-297`）：模型只要写了人话，把 CQ 码去掉照样发。

**为什么值得借鉴**

我们的记忆抽取是**额外一次完整 API 调用**（`apps/bym.js` 的 `extractFacts`），而且要求语料 ≥6 条才有意义——这就是为什么 `context.enable` 关着时记忆永远长不大。

改成"模型在回复里顺手给 memory"，成本从「一次额外调用」降到「几个 token」。

**怎么用到我们这**

不建议整体改 JSON 契约（我们的编排是纯文本管线，改动面太大）。**只取最有价值的两小块**：

1. **`memory` 字段**：在 `models/chatService.js` 的 system prompt 末尾追加：

```
如果这轮对话里出现了值得长期记住的事（群里的约定、固定安排、某人的稳定身份），
在回复最后另起一行写：<mem>用一句话描述</mem>，没有就不写这一行。
```

然后在 `postProcess()` 里用正则抠出 `<mem>…</mem>`，返回 `{ text, memories }`，由 `apps/bym.js` 直接 `addFact()`。
**收益**：省掉 `extractFacts()` 那次调用，记忆从"靠 context 攒够 6 条"变成"每轮都可能积累"。

2. **`|||` 分条意图**：`utils/humanize.js` 的 `splitText()` 开头先按 `|||` 切，再按标点切。模型想分几条，我们尊重它；没写就退回现有逻辑。零风险。

3. `follow`（补一句）可选：`models/chatService.js` 里若抠到 `<follow>`，以 `speaking.followUpChance`（默认 0）的概率追加一条——默认关，避免画蛇添足。

---

### 借鉴点 6：上下文预算裁剪

**位置**：`src/context.mjs:1-4`（优先级注释）、`:104-118`（裁剪循环）

**它怎么做的**

```
优先级 = 人格（永不裁）> 契约 > 本轮 > 记忆 > 最近 > 知识库 > 媒体描述
预算不够时从最不重要的倒着砍。
```

```js
for (const t of ['media', 'kb', 'hist', 'mem']) {   // 从最不重要开始
  if (total <= budget) break
  ...从 total 里减掉这一段
}
```

预算 = `contextWindowTokens * contextBudgetRatio`（默认 128000 × 0.25）。

**为什么值得借鉴**

我们的 `chatService.generateReply()` 是把「群聊记录 + 时间 + 记忆 + 本轮」全塞进一条 user 消息，**没有任何长度上限**。

`context.length: 20` 乘以每行几十字，加上 `injectLimit: 5` 条记忆，正常情况下还好；但只要有人发长文，或者把 `length` 调到 100，就会直接顶到模型上限——**而失败方式是 400 报错，群里什么都不发生**。

**怎么用到我们这**

在 `models/chatService.js` 拼 `content` 时加一次裁剪：

```js
// 预算按字符估（1 token ≈ 1.5 中文字），从最不重要的开始砍
const budget = config.context.maxChars || 6000
if (contextText.length > budget) {
  // 群记录按行砍（保留最近 N 行），记忆整体砍掉
}
```

配置加 `context.maxChars`（默认 6000，0 = 不限）。这比精确算 token 简单得多，对伪人场景够用。

---

### 借鉴点 7：记忆要防"复读"和"讨债"

**位置**：`src/memory.mjs:1-9`（两个坑）、`:50`（相似度）、`:66-70`（欠条）

**它怎么做的**

注释直接写了两个真实踩坑（`memory.mjs:3-9`）：

> 1. 只说同一句话的不同写法会各占一条（"青色让我叫他哥哥" ×4），注入时前几名全被同一件事占满 → 它翻来覆去只聊这个。所以要做近似去重。
> 2. 承诺类记忆只进不出（"九点给我做番茄鱼汤泡饭" 吃完还在），于是它每天追着你要那碗饭。所以承诺类最多留几条，新的挤掉旧的。

对应实现：`similarText()` 用 bigram + LCS 算相似度；承诺类单独限量，出现"已经兑现"的说法就销账。

**为什么值得借鉴**

我们的 `models/memory.js` 去重是这一行：

```js
const duplicated = bucket.facts.some(item =>
  item.fact === text ||
  (item.fact.length > 8 && (item.fact.includes(text) || text.includes(item.fact)))
)
```

**只能挡住完全包含关系**。"张三在字节做后端" 和 "张三在字节跳动做后端开发" 会各占一条；同一个事实换个说法重复几次，`injectLimit: 5` 的名额就被它占满——模型于是反复提同一件事。

**怎么用到我们这**

1. 把 `similarText(a, b)`（bigram 集合的 Jaccard 相似度，10 行左右）搬进 `models/memory.js`，去重阈值取 `0.75`。
2. `addFact()` 里改成：相似度超阈值 → 用新的替换旧的（更新 `at` 让时效重新计算），而不是新增。
3. 承诺类检测（`/给你|帮你|答应|下次|记得|一定/`）单独打 `kind: 'promise'` 标记，每群最多 3 条，注入时排在最后。
4. 这是纯逻辑改动，`tests/smoke.mjs` 里加 3 个用例就能覆盖。

---

### 借鉴点 8：按人记账，而不是按会话

**位置**：`src/people.mjs:1-9`

**它怎么做的**

> 按人记账的记忆：一本账挂在一个 QQ 号上，而不是挂在会话上。
> 为什么不用现有的 memory：memory 是一个平铺的池子（谁说的都往一块扔）。问题是同一个人换个群、换私聊，读到的就不像"同一个人"了。
> 这里按人分账：他是什么脾气、说过什么事实、聊过哪些话题、见过几次。

**为什么值得借鉴**

我们的 `memory.js` 是 `groups[groupId].facts` —— **完全按群隔离**。同一个人在 A 群聊过的爱好，到 B 群就不认识他了。

对"伪人"这个场景，按人记账更贴近真人：真人不会因为换了个群就不认识你。

**怎么用到我们这**

1. `models/memory.js` 加第二本账：`users[qq] = { facts: [], nicknames: [], lastSeenAt, count }`。
2. 写入时机：现有 `reply.contextItems` 里能拿到 `userId`，群聊上下文本身带 QQ 号。
3. 注入时机：`buildMemoryPrompt()` 目前是 `(groupId, queryText)`，改成同时查两本账——群账 + 当前发言人的个人账，个人账排在前面（更相关）。
4. **隐私提示**：跨群共享个人信息是有争议的，必须做成开关 `memory.crossGroupByUser`（默认 **false**），且只在白名单群之间共享。这一点 fatfish 没提，但对我们（可能跑在别人的群里）是必须的。

---

## 三、不建议借鉴的部分

诚实列出，避免为了"借鉴"而引入负担：

| 它的做法 | 为什么不建议 |
|---|---|
| 零 npm 依赖 | 它是一种取舍（自己手写 HTTP/WS/JSON 处理），我们对 `js-yaml` 一个依赖无所谓，没必要为此重写 YAML 解析 |
| 语音克隆 / 唱歌（GPT-SoVITS + RVC + Demucs） | 常驻内存约 12 GB，与伪人插件的定位（轻量、可跑在小机器上）冲突 |
| 表情包库（`stickers.mjs` 325 行） | **原作者自己默认关着**（`config.mjs:193 stickersEnabled: false`，而收藏默认开）。理由见下节「表情包为什么不抄」 |
| QQ 空间日记 | 依赖 SnowLuma 扩展动作 `send_qzone_msg`（README:57/209），我们的宿主是 TRSS + LLBot，标准 OneBot 网关没有这个能力 |
| 自建网页控制台 | 我们已经有锅巴面板，重复造轮子 |
| 心情/关系影响语气 | 值得做，但需要先有稳定的上下文管线；排在借鉴点 1-8 之后 |

### 表情包为什么不抄

它的表情包是**「看 → 学 → 发」三步**（`stickers.mjs:1-9`）：群友发表情 → 视觉模型描述一遍当标签 → 存库 → 发言时按话题匹配一张发出。看着很聪明，但有六个问题：

| # | 问题 | 依据 |
|---|---|---|
| 1 | **作者自己默认关着** | `config.mjs:193 stickersEnabled: false`；对比收藏是默认开（`stickerCollectEnabled: true`）。收集便宜无风险，发送贵且有观感风险 |
| 2 | **依赖链比表面长，我们有三个断点** | 视觉模型（打标签，我们 `vision.enable` 默认 false）、ffprobe（判尺寸，我们没装 FFmpeg）、`chooseSticker` 额外一次 LLM 调用（`capabilities.mjs:206-229`，≤120 张时把全库摘要丢给模型挑） |
| 3 | **发送层要改结构** | `stickers.mjs:296` 用 `file:///` 绝对路径；`capabilities.mjs:236-259` 整段注释在讲 NapCat 只取文件名去自己目录找 → ENOENT，所以要 base64 内联 + 体积上限兜底。而我们的 `humanize.js:134-163` 是纯文本切段 + 打字延迟的线性序列，插图片要改成混合序列（图片不该有打字时间） |
| 4 | **治理成本 > 功能成本** | 325 行里，孤儿索引清理、短标签回填、500 张上限淘汰、hash 去重、`recentPick` 防连发……一半是库治理 |
| 5 | **匹配率天然低到接近随机** | 作者注释（`stickers.mjs:232-238`）自陈「原来命中率极低，几乎每次都是随机挑 —— 标签等于白存」；改一版后阈值仍只有 `0.08`（`config.mjs:199`：低了乱发，高了等于随机）。2-gram 打分对图像语义本来就无能为力 |
| 6 | **触发频率和功能价值错配** | 我们默认每群每小时 6 次。表情包的价值在高频轻松，发言少 + 库大 = 匹配不上就随机发，等于给每个群发无关图片。另外从 A 群收的图发到 B 群是「群友产出外流」，fatfish 是自用规模可以不考虑，我们是多用户插件 |

**替代方案**：只做 `[face]` / `[mface]` 段——零素材库、零视觉模型、零文件传输。我们现在收消息时已经把 face 转成 `[捂脸]` 文本（`utils/message.js:50-52`），反过来让模型输出 `[捂脸]`、解析成 face 段发出去即可，约 30 行拿到大部分拟人感。真要做素材库，最小可行版是「手工放 20 张 + 按情绪标签挑」，60 行而不是 325 行，去掉视觉和 ffprobe 两个依赖。


---

## 四、落地优先级建议

| 优先级 | 借鉴点 | 理由 | 预计改动 | 状态 |
|---|---|---|---|---|
| **P0** | 1 禁自曝 | 现在是真实风险：模型说"我是 GPT"会直接发出去 | 新增 1 文件，改 2 处 | ✅ **已落地**（v1.2.0） |
| **P0** | 4 去重与回声守卫 | 死循环的唯一防线，成本极低 | 新增 1 文件，改 1 处 | ✅ **已落地**（v1.2.0） |
| **P1** | 3 @/主人必回压过冷却 | 用户体感最明显："叫它不应" | 改默认值 + 2 处调用 | ✅ **已落地**（v1.3.0） |
| **P1** | 5 契约的 memory 字段 | 同时解决"记忆长不大"和"多一次调用" | 改 prompt + 解析 | ✅ **已落地**（v1.3.0） |
| **P2** | 2 模型把关 | 效果最好，但每条消息多一次调用，必须做成可选 | 新增 1 模块 + 6 个配置项 | ✅ **已落地**（v1.3.0，默认关） |
| **P2** | 6 预算裁剪 | 只在长上下文时才出问题 | 改 1 个函数 | ✅ **已落地**（v1.3.0） |
| **P3** | 7 记忆去重与欠条 | 需要调相似度阈值，得观察真实数据 | 改 1 个模块 | 待定 |
| **P3** | 8 按人记账 | 涉及隐私边界，需要先定策略 | 改动较大 | 待定 |

### 已落地部分与原方案的差异

两处刻意没照抄，都是因为我们的场景和 fatfish 不同：

| 点 | fatfish 的做法 | 我们的做法 | 原因 |
|---|---|---|---|
| 误伤处理 | 可疑即拦，判不出来也拦（"宁可少说一句，不可漏底"） | 分「必拦 / 可疑」两档；可疑档只在配了 `judgeModel` 时才判，**判不出来放行** | 它是个人自用、消息量大，少说一句无所谓；我们是低频发言（每群每小时 6 次），一次误拦就是一次「叫它不应」 |
| 异常话术 | `userFacing()` 把异常翻成人话发到群里 | **不做**，异常只记日志 | 伪人不说话是常态；一旦开口解释"我刚才那句话不该讲"或"我这边有点卡"，人设立刻破裂 |

另外新增了一层 fatfish 没有的：**`tests/config.mjs` 扫源码验证配置访问器**。落地过程中真踩到了——加了 `guard` 段却忘了注册 `config.guard`，开关完全不生效且不报错。


---

## 五、一句话总结

fatfish 最值得抄的不是功能，而是**它把"像人"拆成了可验证的步骤，并且在每一步的文件头写下了自己踩过的坑**。

我们的链路结构已经对了，缺的是三样东西：**门口的语义判断**（借鉴点 2、3）、**出门的安检**（借鉴点 1）、**中间的记忆质量**（借鉴点 5、7）。

借鉴点 1、2、3、4、5、6 已在 v1.3.0 全部落地（`utils/guard.js`、`utils/dedup.js`、`utils/budget.js`、`models/gate.js`、`models/replyParser.js`，含 199 项单测 + 57 项仿真）。剩下 7、8 两点见上表。
