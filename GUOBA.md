# 锅巴（Guoba-Plugin）适配说明

> 装了 [Guoba-Plugin](https://gitee.com/guoba-yunzai/guoba-plugin) 之后，本插件的所有配置都能在 Web 面板里改，不用手编 YAML。
> 面板字段以 `guoba.support.js` 为准；安装与基础配置见 [INSTALL.md](./INSTALL.md)。

---

## 一、锅巴是什么

云崽的**后台管理插件**（当前 1.4.2，兼容 Miao-Yunzai v3/v4 与 TRSS-Yunzai）。

它自己在云崽进程里起一个 Express 服务（默认 `:50831`），提供：

| 能力 | 说明 |
|---|---|
| 主人登录 | `#锅巴登录` 或控制台验证码 |
| 配置文件管理 | 直接编辑云崽的 `config/config/*.yaml` |
| **插件配置** | 读取插件的 `guoba.support.js`，渲染成表单 ← 本文重点 |
| 插件安装/卸载 | 从插件索引拉取 |
| 喵喵帮助编辑 | 改 miao-plugin 的帮助图 |

它不是一个「插件开发框架」，而是一个**约定式的表单容器**：插件自己声明有哪些配置项、怎么读、怎么写，锅巴只负责渲染和转发。

---

## 二、面板结构


### 3.2 面板结构（11 个分组，76 项）

| 分组 | 字段 |
|---|---|
| 基础设置 | `enable`、`commandPrefix` |
| 触发控制 | `trigger.groupMode`、`groups`、`hitKeywords`、`probability`、`cooldownSeconds`、`maxPerHour`、`bypassCooldownOnKeyword`、`replyWhenAddressed`、`addressedBypassCooldown`、`ignoreAtOthers`、`ignoreCommandPrefixes`、`minLength`、`maxLength`、`muteKeywords` |
| 发言风格 | `speaking.mode`、`contextualPrompt`、`defaultPresetId`、`presetPrefix`、`presetMap`、`groupPresets`、`recallSeconds`、`splitReplies`、`maxSegmentLength`、`typingDelay.*`、`gapDelay.*` |
| 防自曝与去重 | `guard.enable`、`guard.judgeModel`、`guard.retry`、`guard.allowSelfClaim`、`dedup.enable` |
| 语义把关（进阶） | `gate.enable`、`gate.model`、`gate.threshold` |
| 模型接口 | `llm.baseURL`、`apiKey`、`model`、`temperature`、`topP`、`maxTokens`、`timeoutMs`、`stream`、`retries`、`extraHeaders`、`extraBody`、`fallback` |
| 群聊上下文 | `context.enable`、`length`、`maxChars`、`cacheTTL`、`header`、`message` |
| 图片识别 | `vision.enable`、`maxImageSize`、`maxImageDimension`、`maxImages`、`includeContextImages` |
| 群记忆 | `memory.enable`、`write`、`inject`、`injectLimit`、`injectMaxChars`、`extract`、`extractModel`、`maxFactsPerGroup`、`conflictResolve`、`profileEnabled` |
| 记忆保留天数 | `memory.typeTtl.plan`、`.event`、`.preference`、`.relation`、`.fact`、`.unknown` |

`apiKey` 用 `InputPassword`（不明文显示），枚举用 `RadioGroup`（按钮样式），开关用 `Switch`，数值用 `InputNumber`（带上下限，前端就挡住非法值）。

`groupPresets` 是「群号 → 人设 ID」的映射，键是动态的，所以用 JSON 文本框而不是固定字段（和 `presetMap` 一样走 `JSON_FIELDS`，保存时校验必须是对象）。


## 三、排错

### 4.1 面板里找不到「伪人模式」

按顺序查：

1. 锅巴有没有扫到这个插件 —— 需要 `plugins/chatgpt-bym/index.js` 存在（有 `index.js` 或 `.git/` 才被当插件）。
2. 有没有 `guoba.support.js`。
3. 锅巴日志里搜 `载入"chatgpt-bym"插件的"guoba.support.js"失败` —— 加载报错会打在这里。
4. `#锅巴重启` 让锅巴重新扫描一遍（它会重新 import 所有 `guoba.support.js`）。
5. 插件目录名改过？`pluginInfo.name` 要跟着改。

### 4.2 面板显示正常，保存没反应

- 看浏览器 Network 里 `POST /plugin/chatgpt-bym/config` 的返回：`code` 非 0 就是被拒了，`message` 里写了原因（通常是 JSON 填错）。
- 保存后去 `plugins/chatgpt-bym/config/config.yaml` 看值有没有变。变了但机器人行为没变 → 查是不是改了要重启的项（`commandPrefix`）。

### 4.3 保存后机器人行为没变化

本插件读配置是**每次发言时现取**，理论上立即生效。两个例外：

1. `commandPrefix`（需重载插件）。
2. 群白名单没包含当前群（保存了但那个群本来就不在范围内）。

用 `#bym 状态` 看一眼它认为的当前配置，比猜快。

### 4.4 JSON 字段填什么

| 字段 | 格式 |
|---|---|
| `speaking.presetMap` | `[{"keywords":["原神"],"presetId":"bym_tsundere","priority":10}]` |
| `llm.fallback` | `[{"baseURL":"https://backup/v1","apiKey":"sk-...","model":"deepseek-flash"}]` |
| `llm.extraHeaders` | `{"X-Custom":"value"}` |
| `llm.extraBody` | `{"enable_thinking":false}` |

留空即清空（数组变 `[]`，对象变 `{}`）。

---
