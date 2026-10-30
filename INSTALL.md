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

## 3. 首次验证

按顺序做，哪一步不对就停下查第 4 节。

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

## 4. 常见问题


### 4.1 启动日志里没有 `[bym]`

| 检查 | 命令 / 位置 |
|---|---|
| 目录放对了吗 | `Yunzai/plugins/chatgpt-bym/index.js` 存在 |
| 依赖装了吗 | `ls plugins/chatgpt-bym/node_modules/js-yaml` |
| 重新装过吗 | 放插件后要在根目录再跑一次 `pnpm i` |
| 有报错吗 | 搜日志里的 `插件加载错误`、`Cannot find package` |
| Node 版本够吗 | `node -v` 必须 >= 23.11 |

### 4.2 加载了，但群里从来不说话

按概率从高到低查：

1. **`enable: false`** —— 最常见的。日志里会明确写「当前状态：已关闭」。
2. **群号不在 `trigger.groups`** —— 白名单模式下列表为空等于全禁。
3. **云崽的 `onlyReplyAt` 不是 0** —— 这是隐藏最深的一条：云崽在 `deal()` 里有一行 `if (!e.only_reply_at) return`，位置在插件匹配之前，插件根本不会被调用。改 `config/config/group.yaml` 的 `default.onlyReplyAt: 0`。
4. **群在 `other.yaml` 的 `blackGroup`** —— 出厂值有 `213938015`。
5. **冷却未过** —— `cooldownSeconds` 默认 60 秒，`maxPerHour` 默认 6 次。
6. **消息本身被过滤** —— @ 了别人、以 `#` 开头、长度不在 `minLength~maxLength`、命中 `muteKeywords`。
7. **概率太低** —— 默认 2%，发 10 条大概率一条都不中。用 `bym 在吗` 测（关键词必中）。

想看具体是哪个原因拦下的，把 `config.yaml` 里的日志级别调到 debug（在云崽的 `config/config/bot.yaml` 里设 `log_level: debug`），然后搜 `[bym] 跳过：`，后面就是原因。

### 4.3 配置好像被重置了，api key 变空

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

### 4.4 接口返回 401 / 403

Key 错、过期、或被中转站限制了模型。先用 `#bym 测试` 触发一次，看日志里的完整报错（插件会打 `[bym] 生成失败：...`）。

### 4.5 群友 @ 了机器人，它却不回

按可能性排：

1. `trigger.replyWhenAddressed` 被关掉了（默认 `true`）
2. `trigger.maxPerHour` 用完了 —— 被 @ 的豁免只针对冷却，上限仍然生效
3. 群不在白名单里 / `enable` 为 false
4. 消息里还带了屏蔽词（`muteKeywords`）
5. 云崽侧 `group.yaml` 的 `onlyReplyAt` 不为 0（见 2.5）

### 4.6 回复里冒出「作为一个 AI 语言模型」

说明出站守卫没拦住，检查：

- `guard.enable` 是不是被关了（默认 `true`）
- 看日志有没有 `[bym][guard] 拦下一句`。有日志说明拦住了（群里没发出去），只是你在别处看到的
- 如果模型换个说法绕过（比如「我本质上是一段程序」），本地规则识别不了。
  配 `guard.judgeModel` 用模型二次判定，代价是可疑回复多一次调用

> **用大肥鱼人设时注意**：那份人格允许「被问到是不是 AI 时不用否认」，
> 而守卫会把「我是 AI」这类句子当成自曝**拦下整条回复** —— 群里表现是「机器人卡住不说话」，
> 不是「它不承认自己是 AI」。日志里会有 `[bym][guard] 拦下一句`。
> 日常不触发（更常见的说法是「算是吧」）；真遇到了打开 `guard.allowSelfClaim`
> （锅巴面板：「允许自称 AI 身份」），只放行自称身份那几条，
> 厂商名、模型名、本机路径照样拦 —— 比整个关掉 guard 精准得多。

## 5. 更新与卸载


### 怎么更新才不丢配置

**1.4.1 起配置和记忆放在 `Yunzai/data/chatgpt-bym/`，不在插件目录里**，所以更新方式不再有讲究：

| 方式 | 会不会丢 |
|---|---|
| `#伪人更新` | 不会 |
| `git pull` | 不会 |
| 下载 zip 解压覆盖 | 不会 |
| 删掉旧目录再放新的 | 不会 |

**`#伪人更新`（推荐，1.4.6 起）**：主人发这条指令，插件自己拉远程代码：

- 已是最新 → 回「已是最新（main @ xxxxxxx）」
- 有更新 → 回更新的提交列表；`package.json` 或锁文件变了会提醒先 `pnpm install` 再重启
- 本地文件有改动 → 拒绝更新并说明（**不自动覆盖你的改动**）
- zip 安装（目录里没有 `.git`）→ 提示用 zip 覆盖的方式
- 更新完需要**重启云崽**才生效（代码已加载的部分不会热更）

`#伪人更新` 和 `#bym 更新` 等价，均为 `permission: 'master'`。

git pull 方式（等价于上面的指令）：

### 卸载

1. 从 `config/config/group.yaml` 里恢复 `onlyReplyAt`（如果你为它改过）
2. 删掉 `plugins/chatgpt-bym` 整个目录
3. 删掉 `Yunzai/data/chatgpt-bym/`（配置和记忆在这里）
4. 重启云崽

只删插件目录**不会**清掉配置和记忆——它们已经不在插件目录里了。要彻底卸载，第 3 步不能漏。

---

## 6. 最小可用配置

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
  defaultPresetId: bym_dafeiyu
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
