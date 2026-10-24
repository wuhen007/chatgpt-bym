# chatgpt-bym

云崽（Yunzai）的**伪人模式**插件：让机器人在 QQ 群里像普通群友一样，按概率或关键词偶尔插一句话。

不用 @ 它，它不会回复每一条消息。这是它和普通问答插件的区别。

- 通过 OpenAI 兼容接口调模型，可以接官方、中转站或本地部署
- 零原生依赖（不需要 sqlite3 / sharp / nodejieba），`pnpm i` 只装一个 `js-yaml`
- 支持 TRSS-Yunzai，适配 [锅巴面板](https://gitee.com/guoba-yunzai/guoba-plugin) 可视化配置
- 附完整部署文档、契约测试与仿真测试

---

## 来源与致谢

**本项目不是从零开始的。**

它的功能设计、提示词结构、拟人化策略，直接来自 **ikechan8370** 的开源项目 `chatgpt-plugin` 中的「伪人模式（BYM）」：

| | |
|---|---|
| 原项目 | <https://github.com/ikechan8370/chatgpt-plugin> |
| 原作者 | ikechan8370 |
| 原始功能 | `apps/bym.js` —— 伪人模式 |
| 许可证 | GNU General Public License v3.0 |

本仓库是在原项目基础上**剥离并重写**的独立插件，主要改动：

1. **去掉 `chaite` 内核依赖**：原实现通过 chaite 的 `sendMessage()` 走渠道负载均衡、预设、工具调用；这里改为用 `fetch` 直连 `{baseURL}/chat/completions`，因此可以脱离 chaite 独立运行。
2. **去掉原生模块依赖**：原记忆系统依赖 `sqlite3` + `sqlite-vec`（需要编译），在任何装不上原生模块的机器上会直接让插件起不来。这里改为 JSON 存储 + 2-gram 关键词打分。
3. **修正若干行为问题**：见 [`chatgpt-bym/README.md`](./chatgpt-bym/README.md) 的变更记录（配置段留空导致崩溃、跨批次群记录顺序错乱、长回复被截断、撤回误撤用户消息、`js-yaml` 5.x 兼容等）。
4. **补充测试与文档**：契约测试、协议层仿真、TRSS + LuckyLilliaBot 部署指南、安装教程、锅巴适配说明。

原项目的**代码与版权归 ikechan8370 所有**；本仓库不包含原项目的源码副本（仅在 `.gitignore` 中排除的本地参考目录里存在，未提交）。

依据 GPL-3.0，本项目同样以 **GPL-3.0** 发布，完整许可证见 [LICENSE](./LICENSE)。

### 同时感谢

- [Yunzai-Bot](https://github.com/Le-niao/Yunzai-Bot)（乐神）与 [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai)（喵喵）—— 云崽生态的源头
- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) —— 本插件实际运行的宿主，其插件生命周期与事件语义是本项目适配的依据
- [LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot) —— QQ 协议端
- [Guoba-Plugin](https://gitee.com/guoba-yunzai/guoba-plugin) —— 可视化配置面板

---

## 目录结构

```
.
├── README.md                  # 本文件
├── LICENSE                    # GPL-3.0
├── docs/
│   ├── TRSS-Yunzai-LuckyLilliaBot-部署指南.md
│   └── 模拟测试报告-TRSS-LLBot-伪人插件.md
└── chatgpt-bym/               # 插件本体（整个目录放进云崽 plugins/ 即可）
    ├── INSTALL.md             # 安装教程
    ├── GUOBA.md               # 锅巴面板适配说明与分析
    ├── README.md              # 设计说明与变更记录
    ├── guoba.support.js       # 锅巴配置定义（60+ 项）
    ├── index.js
    ├── apps/                  # 插件类：伪人主逻辑 + 管理指令
    ├── models/                # 接口客户端、编排、预设、记忆
    ├── utils/                 # 触发闸门、群上下文、拟人化发送、图片
    ├── presets/               # 人设文件
    ├── config/
    │   └── config.example.yaml
    └── tests/                 # 61 项自测（不需要云崽宿主）
```

---

## 快速开始

```bash
cd Yunzai/plugins
git clone <本仓库地址> chatgpt-bym
cd chatgpt-bym
pnpm install
```

然后编辑 `config/config.yaml`（首次启动自动生成，或从 `config/config.example.yaml` 复制），至少填四处：

```yaml
enable: true
trigger:
  groups: ['你的群号']
llm:
  baseURL: https://api.openai.com/v1
  apiKey: sk-xxxx
  model: gpt-4o-mini
```

重启云崽，群里发 `#bym 状态` 验证。

**完整步骤见 [chatgpt-bym/INSTALL.md](./chatgpt-bym/INSTALL.md)**，其中「云崽侧的三个前提」是最容易卡住的地方（`onlyReplyAt` 必须为 0、清掉出厂黑名单、`server.yaml` 的 auth 留空）。

---

## 文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](./chatgpt-bym/INSTALL.md) | 环境依赖、安装步骤、全字段配置、14 条常见问题排查 |
| [GUOBA.md](./chatgpt-bym/GUOBA.md) | 锅巴插件机制分析、面板字段对照、排错 |
| [chatgpt-bym/README.md](./chatgpt-bym/README.md) | 设计取舍、能力对照、变更记录 |
| [部署指南](./docs/TRSS-Yunzai-LuckyLilliaBot-部署指南.md) | TRSS-Yunzai 安装 + LuckyLilliaBot 对接 + 端口对照 |
| [模拟测试报告](./docs/模拟测试报告-TRSS-LLBot-伪人插件.md) | 33 个场景的测试过程、发现的问题与修复 |

---

## 自测

```bash
cd chatgpt-bym
node tests/smoke.mjs   # 28 项：配置、分段、触发、冷却、记忆、预设、发送
node tests/llm.mjs     # 10 项：端点归一化、请求体、流式、重试、换渠道
node tests/guoba.mjs   # 23 项：锅巴契约、schema 合法性、读写往返
```

不需要云崽，也不需要真实 API Key（测试会起本地假服务并隔离配置目录）。

---

## 许可证

[GNU General Public License v3.0](./LICENSE)

原项目 `chatgpt-plugin` 版权归 ikechan8370 所有；本仓库的修改与新增部分同样以 GPL-3.0 授权。
