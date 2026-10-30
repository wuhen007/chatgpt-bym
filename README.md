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
> 修正若干行为问题、补充测试与文档。

### 它和普通 AI 插件的区别

普通问答插件是「有问必答」，伪人是「该不该说」：

| 能力 | 说明 |
|---|---|
| 被点名必回 | `@` 必定接话，并压过冷却（但绕不过每小时上限） |
| 概率接话 | 没被点名时按 `probability` 掷骰子，默认 2% |
| 语义把关 | 可选，让模型判断「这时候插话合不合适」（在吵架/刷广告就不插） |
| 防自曝 | 回复里出现「我是 AI」「我的训练数据」时这一轮不发 |
| 去重与回声 | 挡住协议端重投，以及「我回我自己」的死循环 |
| 拟人化发送 | 按标点分条、按字数算打字延迟、不引用原消息 |
| 群记忆 | 记忆由回复顺带产出；按类型过期，同一个人换说法会消解旧条目 |
| 人设 | 支持结构化字段（身份/说话方式）；可给每个群单独指定 |

## 一、目录与模块职责

```
.
├── index.js                 # 插件加载：读配置、动态加载 apps/、注册插件类
├── package.json
├── guoba.support.js         # 锅巴面板定义（10 组、70+ 项）
├── config/
│   ├── config.js            # 配置单例：默认值补全 + YAML/JSON + 热加载 + 损坏保护
│   ├── config.example.yaml  # 全量配置模板（带注释），只做参考
│   └── config.yaml          # 仅旧版本/检测不到云崽时用；正常在 Yunzai/data/chatgpt-bym/
├── apps/
│   ├── bym.js               # 主入口：触发判定 -> 生成 -> 拟人化发送（一个流程一行注释）
│   └── admin.js             # 管理指令：#bym 状态/开/关/重载/测试/记忆
├── models/
│   ├── llmClient.js         # OpenAI 兼容客户端：重试、备用渠道、SSE、reasoning
│   ├── chatService.js       # 编排：人设 + 群上下文 + 记忆 + 本轮消息 -> 文本
│   ├── gate.js              # 语义把关：给消息打分，决定这时候该不该插话
│   ├── replyParser.js       # 回复解析：纯文本 / JSON 契约（记忆作为副产品）
│   ├── preset.js            # 人设加载与关键词选人设
│   └── memory.js            # 群记忆：JSON 存取、类型化 TTL、访问强化、冲突消解
├── utils/
│   ├── dedup.js             # 入口去重（id / 内容 / 回声）
│   ├── trigger.js           # 触发闸门（8 道过滤 + 被点名/关键词/概率三档）
│   ├── rateLimit.js         # 冷却 + 每小时上限 + 配额退还
│   ├── groupContext.js      # 跨框架拉群历史 + 模板渲染 + TTL 缓存
│   ├── message.js           # 事件 -> 文本/图片；多模态 content 组装
│   ├── image.js             # 图片下载、尺寸嗅探、data URL 转换
│   ├── budget.js            # 上下文预算裁剪（记忆 → 群记录 → 本轮）
│   ├── guard.js             # 出站守卫：防自曝（本地规则 + 可选模型判定）
│   ├── lifecycle.js         # 进程退出收尾：信号 → 记忆刷盘 + 停监听
│   ├── updater.js           # 自更新：#伪人更新 拉取远程，ff-only 保护本地改动
│   └── humanize.js          # 分段、打字延迟、随机停顿、撤回
├── presets/
│   ├── bym_dafeiyu.yaml     # 默认人设：大肥鱼（蓝色鲸鱼娘，从 AstrBot 迁移）
│   ├── bym_default.yaml     # 结构化人设示例（identity / speech / system）
│   └── bym_tsundere.yaml
├── tests/
│   ├── smoke.mjs                # 逻辑冒烟测试（46 项，不联网）
│   ├── llm.mjs                  # 接口层测试（11 项，起本地假 OpenAI 服务）
│   ├── guoba.mjs                # 锅巴面板契约、密码框保护（28 项）
│   ├── config.mjs               # 配置接入：扫源码验证、数组修正、损坏保护、路径迁移、默认值、布尔归一（61 项）
│   ├── guard.mjs                # 出站守卫：必拦 + 不误伤 + 降级 + 自称放行（47 项）
│   ├── dedup.mjs                # 去重与回声，含跨群隔离、TTL 与硬上限（18 项）
│   ├── budget.mjs               # 上下文裁剪顺序与边界（15 项）
│   ├── gate.mjs                 # 语义把关：打分解析、阈值、降级（26 项）
│   ├── replyParser.mjs          # JSON 契约解析与坏输出退化（28 项）
│   ├── lifecycle.mjs            # 退出收尾：幂等、失败隔离、超时保护（16 项）
│   ├── memory.mjs               # 记忆：门槛、TTL、冲突消解、攒批落盘、注入防护（51 项）
│   ├── preset.mjs               # 人设：结构化字段、群级绑定、prompt 拼装、警告去重（28 项）
│   ├── updater.mjs              # 自更新：no-git/最新/有更新/冲突/网络失败/并发锁（11 项，离线）
│   └── audit-probes.mjs         # 审核探针（不是回归测试）：逐条验证历次审核结论是否仍成立
```

分层原则：**apps 只做「要不要说、说完怎么发」，models 只做「说什么」，utils 是无状态工具。**
想换模型厂商只动 `llmClient.js`，想换人设只动 `presets/`。

---

## 二、安装

> **只想尽快跑起来？看 [INSTALL.md](./INSTALL.md)**。那一份是面向操作的分步教程（依赖检查、逐步验证、常见问题排查），下面这段是精简版。

1. 把整个仓库放进 `云崽根目录/plugins/` —— **仓库根目录就是插件本体**，不用再套一层目录：

   ```bash
   cd Yunzai/plugins
   git clone <本仓库地址> chatgpt-bym    # 目录名随意，插件内部路径都自动推导
   ```

2. 在插件目录里安装唯一依赖：

   ```bash
   cd plugins/chatgpt-bym
   pnpm install     # 或 npm install
   ```

3. 重启机器人，首次启动会在 `Yunzai/data/chatgpt-bym/config.yaml` 生成配置；
4. 编辑配置填 `llm.apiKey`，把 `enable` 改为 `true`，再把群号加进 `trigger.groups`；
5. 群里发 `#bym 状态` 确认。

> `package.json` 里的 `js-yaml` 锁在 `^4.1.0`（CJS，兼容性最好）。代码同时兼容 5.x（纯 ESM、无 default 导出）——**不要**把 `import yaml from 'js-yaml'` 改回去，那样在 5.x 下会直接启动失败。

> 插件目录名可以改：所有路径都从 `import.meta.url` 推导，不再写死 `./plugins/chatgpt-plugin`。

---

## 三、管理指令

| 指令 | 作用 |
|---|---|
| `#bym 状态` | 当前配置、本群人设、记忆有效条数、最近写入时间 |
| `#bym 开` / `#bym 关` | 开关（写回配置文件） |
| `#bym 重载` | 重载配置、预设、群上下文缓存 |
| `#bym 测试 <文本>` | 走完整链路生成但不发送，用于调 prompt 和看人设效果 |
| `#bym 人设` | 列出所有人设，标出本群在用的那个 |
| `#bym 人设 <id>` | 本群切到该人设（写群级配置，不影响其他群） |
| `#bym 人设 off` | 取消本群指定，回到全局默认 |
| `#bym 画像` | 查看本群画像 |
| `#bym 画像 设置 <文本>` | 手动指定本群画像 |
| `#bym 画像 清空` | 清掉本群画像 |
| `#bym 记忆` | 查看本群记忆（带类型、过期/被取代标记） |
| `#bym 清空记忆` | 清空本群记忆与频率记录（私聊为全局） |
| `#伪人更新` / `#bym 更新` | 拉取远程代码，报告更新了什么、要不要装依赖 |

均为 `permission: 'master'`。

`#bym 人设 <id>` 写的是**群级**配置而不是 `defaultPresetId`：在 A 群调成沙雕人设不该毁掉 B 群的严肃场景。

`#bym 状态` 里显示的是「有效条数 / 总条数」而不是单纯的条数。库里有 200 条但已全部过期时，只看总数会让人以为记忆在正常工作。

`#伪人更新` 的行为（`utils/updater.js`）：

- **先 fetch 再比较**，「已是最新」和「有更新」在拉之前就知道，话能说对
- **`git pull --ff-only`**：本地没动过才快进。本地有改动时拒绝并提示，绝不自动 merge ——
  自动合并出的冲突会让插件处于「改了一半」的状态，比不更新糟
- **`package.json` 或锁文件变了**会提醒 `pnpm install`
- **zip 安装**（目录里没有 `.git`）会说明用 zip 覆盖，且配置和记忆不受影响
- **更新后不会热生效**：Node 加载过的模块不会因文件变化重载，更新完要重启云崽。
  不替用户重启 —— 整个机器人掉线几秒，不该由一条群消息静默触发

---

## 四、许可证

[GNU General Public License v3.0](./LICENSE)

原项目 `chatgpt-plugin` 版权归 ikechan8370 所有；本仓库的修改与新增部分同样以 GPL-3.0 授权。
