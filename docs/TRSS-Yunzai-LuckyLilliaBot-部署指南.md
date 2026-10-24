# TRSS-Yunzai + LuckyLilliaBot 部署与对接指南

> 适用范围：**仅 TRSS 版 Yunzai**（[TimeRainStarSky/Yunzai](https://github.com/TimeRainStarSky/Yunzai)，当前 v3.1.3）
> QQ 端：**LuckyLilliaBot**（[LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot)，当前 8.3.2）
> 不涉及 Miao-Yunzai、Yunzai-Bot 等其他分支。

---

## 0. 先看懂这两条进程

```
┌──────────────────────────┐        OneBot 11 反向 WS       ┌────────────────────────┐
│  LuckyLilliaBot (LLBot)  │  ──────────────────────────▶  │   TRSS-Yunzai          │
│  · 登录 QQ               │   ws://127.0.0.1:2536/        │   · 加载插件           │
│  · 收发消息              │        OneBotv11              │   · 执行指令           │
│  · 协议转换              │                               │   · 业务逻辑           │
│  WebUI :3080             │                               │   HTTP 服务 :2536      │
└──────────────────────────┘                               └────────────────────────┘
        │                                                             │
        └──────────────────── 都是独立的 Node 进程 ────────────────────┘
```

两个关键认知，先记住能省掉一半排错时间：

1. **它们是两个互不包含的进程**，各自启动、各自保活。Yunzai 挂了不影响 LLBot 登录，LLBot 挂了 Yunzai 只会看到连接断开。
2. **TRSS 是 WS 服务端，LLBot 是客户端**。所以「反向 WebSocket」这个词是站在 LLBot 视角说的：由 LLBot 主动连到 Yunzai 的 `2536` 端口。填地址的地方在 **LLBot**，不在 Yunzai。

---

## 1. 环境与依赖

| 组件 | 版本 / 要求 | 是否必需 | 说明 |
|---|---|---|---|
| Node.js | **>= 23.11**（官方对接页给的是 24） | 必需 | TRSS 用了 `Promise.withResolvers`、`import.meta.dirname` 等新 API。Node 18/20 会在启动时直接报错或降级警告 |
| pnpm | 任意较新版本 | 必需 | TRSS 用 workspace 管理 `lib/modules/*` 的本地包，`npm i` 不保证链接正确 |
| Git | 任意 | 必需 | 拉代码、后续 `#更新` |
| Redis 或 Valkey | 5.x / 7.x 均可 | 必需 | TRSS 启动第一个动作就是连 Redis。`valkey` 是 Redis 的 fork，协议兼容，只是二进制名字不同 |
| Chrome / Chromium | 任意较新版本 | 可选 | 只在需要把文字渲染成图片时用到（如某些插件的图卡）。不装则相关功能报错，不影响文字对话 |
| 内存 | >= 1 GB（含 Chromium 建议 2 GB） | — | |
| 系统 | Windows / Linux / macOS / Android(Termux) | — | |

> **Node 版本是最常见的卡点**：`node -v` 低于 23.11 时，要么升级 Node，要么用 nvm/fnm 切版本。TRSS 不会给你一句友好的提示，通常是 `Promise.withResolvers is not a function` 或 `Cannot find module` 之类的间接错误。

---

## 2. 安装 TRSS-Yunzai

### 2.1 方式一：脚本安装（推荐新手）

打开 <https://TRSS.me>（或镜像 <https://gitee.com/TimeRainStarSky/TRSS_Script>），按页面提示一键安装。脚本会处理 Node、Redis、依赖和目录。

### 2.2 方式二：手动安装（推荐可控部署）

```bash
# 1) 拉代码（主源不通时依次换镜像）
git clone --depth 1 https://git.trss.me/Yunzai
# 备选：
# git clone --depth 1 https://github.com/TimeRainStarSky/Yunzai
# git clone --depth 1 https://gitee.com/TimeRainStarSky/Yunzai
# git clone --depth 1 https://gitcode.com/TimeRainStarSky/Yunzai

cd Yunzai

# 2) 安装 pnpm 与依赖
npm i -g pnpm
pnpm i
# 国内网络：
# npm i -g pnpm --registry=https://registry.npmmirror.com
# pnpm i --registry=https://registry.npmmirror.com
```

启动方式：

| 场景 | 命令 |
|---|---|
| 前台运行（调试用） | `node .` |
| 停止 | `node . stop` |
| 守护模式 | `node . daemon` |
| pm2 后台（生产用） | `pnpm start` / `pnpm stop` / `pnpm restart` / `pnpm log` |
| 开机自启 | `pnpm start && pnpm pm2 save && pnpm pm2 startup` |

### 2.3 方式三：Docker

```bash
bash <(curl -L https://git.trss.me/Yunzai/raw/main/lib/tools/docker.sh)
```

可用参数：`DIR`（安装目录，默认 `$HOME/Yunzai`）、`CMD`（启动命令，默认 `tsyz`）、`DKNAME`、`GITURL`、`NPMURL` 等。容器管理命令：`tsyz` 进入、`tsyz start/restart/stop/log`。

### 2.4 首次启动会做什么

启动后仓库里会出现：

```
Yunzai/
├── config/
│   ├── default_config/     # 出厂默认值（只读参考，改这里没用）
│   │   ├── bot.yaml  db.yaml  group.yaml  milky.yaml
│   │   ├── other.yaml  redis.yaml  renderer.yaml  satori.yaml  server.yaml
│   ├── config/             # 你的实际配置（首次启动从 default_config 复制）
│   └── pm2.yaml
├── data/                   # 数据库、缓存、账号数据
├── lib/                    # 核心库
├── plugins/
│   ├── adapter/            # 协议适配器：OneBotv11 / Milky / Satori / ComWeChat / OPQBot / stdin
│   ├── system/             # 系统指令：设置主人、状态、退群…
│   └── other/              # 更新、重启、安装
└── package.json
```

> **改配置只改 `config/config/*.yaml`**。`config/default_config/` 只是默认值模板，启动时会被复制过来补充缺失文件；两者是「默认值 + 用户值」合并的关系（`getAllCfg` = default 打底、config 覆盖）。

---

## 3. 需要修改的关键配置文件与字段

### 3.1 `config/config/server.yaml` —— 必看

```yaml
# 服务器地址
url: http://localhost:2536
# 服务器端口
port: 2536
# 服务器缺省跳转地址
redirect: https://git.trss.me/Yunzai
# 服务器鉴权
auth:
```

| 字段 | 怎么改 | 为什么 |
|---|---|---|
| `port` | 默认 `2536`，**与 LLBot 反连地址里的端口必须一致**。改这里就要同步改 LLBot | 这是 Yunzai 唯一的 HTTP/WS 服务端口，所有适配器共用 |
| `auth` | **保持为空**（`auth:` 后面什么都不写） | 一旦配了 `auth`，所有 HTTP 和 WS 握手都要带对应 Header。LLBot 的 `ws-reverse` 只支持 `token` 字段、无法自定义 Header，会直接被 **401 Unauthorized** 拒掉 |

### 3.2 `config/config/redis.yaml` —— 必看

```yaml
path: redis-server      # ← 用 Valkey 的机器改成 valkey-server
host: 127.0.0.1
port: 6379
username:
password:
db: 0
```

| 字段 | 说明 |
|---|---|
| `path` | 只在本机没起 Redis 时用到：Yunzai 会 `spawn` 这个命令自动拉起一个。用 Valkey 就必须改成 `valkey-server`，否则报 `spawn redis-server ENOENT` |
| `host` | 填 `127.0.0.1` 才允许自动拉起；填远程地址只尝试连接，连不上直接报错 |
| `password` | 有密码必须填，否则一直重连 |

### 3.3 `config/config/other.yaml` —— 必看（有个坑）

```yaml
autoFriend: 1
autoGroup: 0
autoQuit: 50

masterQQ:
  - "stdin"
master:
  - "stdin:stdin"

disablePrivate: false
disableMsg: "私聊功能已禁用…"
disableAdopt: [stoken]

whiteGroup:
whiteUser:
blackGroup:
  - 213938015          # ← 默认黑名单，注意
blackUser:
  - 528952540          # ← 默认黑名单，注意
```

| 字段 | 说明 |
|---|---|
| `masterQQ` / `master` | 主人账号。**不建议手改**——用第 5 步的 `#设置主人` 自动写入，格式是 `Bot号:主人号`（bot_id:user_id） |
| `blackGroup` / `blackUser` | 默认带了两个示例黑名单。**如果你要用的群恰好是 `213938015`，机器人会完全不响应**，务必先清空 |
| `autoQuit` | 被好友拉进人数少于该值的群会自动退群，默认 50。小群测试时先改成 0 |
| `disablePrivate` | 建议保持 `false`，否则私聊只能触发少数指令，`#设置主人` 会受影响 |

### 3.4 `config/config/group.yaml` —— 按需

```yaml
default:
  groupCD: 500        # 群内指令冷却（毫秒）
  singleCD: 2000      # 群内单人冷却
  onlyReplyAt: 0      # 0 全部响应 / 1 仅 @Bot / 2 非主人需 @
  botAlias:           # 开启 onlyReplyAt 后，这些称呼也认
    - 云崽
    - 云宝
```

**机器人"在群里不说话"十有八九是 `onlyReplyAt`**。测试阶段建议先设 `0`。

> 如果你打算装「伪人/主动陪聊」类插件（如 `chatgpt-bym`），**`onlyReplyAt` 必须为 `0`**。
> TRSS 在 `deal()` 里有一行 `if (!e.only_reply_at) return`，位置在插件规则匹配**之前**——
> 非 0 时这类插件连被调用的机会都没有，表现为"其他功能正常，就是不会主动说话"。

`enable` / `disable` 可以按群开关功能；还支持 `Bot号:群号` 四级覆盖。

### 3.5 `config/config/bot.yaml` —— 可选

| 字段 | 用途 |
|---|---|
| `log_level` | 排错时改 `debug`（能看到 WS 收发的原始报文），平时 `info` |
| `chromium_path` | Chromium 不在默认位置时指定绝对路径 |
| `puppeteer_ws` | 连接远程 Chromium 的 ws 地址（本机内存吃紧时很有用） |
| `update_time` / `restart_time` | 自动更新 / 自动重启的分钟数，`0` 为关闭 |
| `cache_group_member` | 缓存群成员列表，建议保持 `true`（否则每条消息都要拉成员信息） |

### 3.6 三个协议适配器的配置（按你选的协议看）

TRSS 内置三种协议适配器，都放在 `plugins/adapter/`：

| 适配器 | 配置文件 | 连接方向 | 默认值 |
|---|---|---|---|
| OneBotv11 | 无独立配置文件，路径由适配器固定为 `/OneBotv11` | **LLBot → Yunzai**（反向 WS） | 端口跟 `server.yaml` |
| Milky | `config/config/milky.yaml` | **Yunzai → LLBot**（主动连） | `port: 3000` |
| Satori | `config/config/satori.yaml` | **Yunzai → LLBot**（主动连） | `http://127.0.0.1:5140/satori/v1` |

`milky.yaml`：

```yaml
enable: false            # 改成 true
host: 127.0.0.1
port: 3000               # 注意：LLBot 的 Milky 默认是 3010，必须对齐
prefix: ""
access_token: ""         # 与 LLBot 的 milky.http.accessToken 一致
connection: ws
ws:
  heartbeat: 30
  reconnect_interval: 10
http_timeout: 15
```

`satori.yaml`：

```yaml
enable: false            # 改成 true
http_endpoint: http://127.0.0.1:5600/v1          # LLBot 的 Satori；注意不是 /satori/v1
ws_endpoint: ws://127.0.0.1:5600/v1/events
token: ""                # 与 LLBot 的 satori.token 一致
platform: satori
timeout: 60000
heartbeat_interval: 10000
```

> 文件里原本的注释已经点明了这一点：`liteloader onebot：http://127.0.0.1:5600/v1`。LLBot 的 Satori 路由是 `/v1`，TRSS 默认值指向的是 `server-satori` 的 `/satori/v1`，直接照抄默认值会 404。

---

## 4. LuckyLilliaBot 的安装与对接配置

### 4.1 选择形态

| 形态 | 适用 | 说明 |
|---|---|---|
| Desktop | Windows / macOS 桌面 | 图形界面，「对接框架」页面可一键装 Yunzai |
| CLI | 服务器 / 无头 | 解压后 `LuckyLillia.exe --help` 查看参数，可无参直接运行，`--update` 在线更新 |
| Docker | 服务器 | 镜像 `linyuchen/llbot`，配套 `pmhq` 容器 |

下载地址：<https://github.com/LLOneBot/LuckyLilliaBot/releases>（产物已改名为 `LuckyLillia.zip` / `LuckyLillia-*.tar.xz`）。

### 4.2 先解决 auth_token（当前版本的硬门槛）

当前版本登录走网络签名，**没有 auth_token 无法完成登录**（表现为二维码不出来、或进程在签名阶段直接退出）。token 从 <https://auth.luckylillia.com> 获取，写入：

```
<LLBot 目录>/data/auth_token.txt
```

（`--dev` 模式的 token 单独放 `data/auth_token.dev.txt`，不会污染正式 token。）

### 4.3 启动并登录 QQ

```bash
# CLI
./LuckyLillia            # 无参运行
./LuckyLillia --help     # 看参数
```

首次启动会打印终端二维码；也可以打开 WebUI：

```
http://127.0.0.1:3080
```

WebUI 密码在 `data/webui_token.txt`（一行明文）。登录成功后 `data/` 下会生成 `config_<QQ号>.json`。

> **`config_<uin>.json` 是按 QQ 号分文件的**。登录前用的是默认配置，登录后才会读写你账号对应的那份。所以「改了配置没生效」先确认改的是不是 `config_<你的QQ号>.json`。

### 4.4 开 OneBot11 反向 WS（推荐路径）

在 WebUI 里进入 OneBot 11 配置，添加一个 `ws-reverse` 连接；或者直接编辑 `data/config_<uin>.json`：

```json
{
  "ob11": {
    "enable": true,
    "connect": [
      {
        "type": "ws-reverse",
        "enable": true,
        "url": "ws://127.0.0.1:2536/OneBotv11",
        "heartInterval": 60000,
        "token": "",
        "reportSelfMessage": false,
        "reportOfflineMessage": false,
        "messageFormat": "array",
        "debug": false
      }
    ]
  }
}
```

逐字段说明：

| 字段 | 值 | 原因 |
|---|---|---|
| `type` | `ws-reverse` | 由 LLBot 主动连 Yunzai |
| `url` | `ws://127.0.0.1:2536/OneBotv11` | 端口取 `server.yaml` 的 `port`；路径**必须**是 `/OneBotv11`（大小写敏感，适配器 `path` 就是这个字符串） |
| `token` | 留空 | TRSS 的 OneBotv11 适配器不做 token 校验；填了也不会错，但没意义 |
| `messageFormat` | `array` | **必须是 `array`**。`string`（CQ 码）模式下 TRSS 拿不到结构化消息段，图片、@、回复都会异常 |
| `reportSelfMessage` | `false` | 上报自己发的消息。伪人/对话类插件通常不需要，开了容易自问自答 |
| `heartInterval` | `60000` | 心跳间隔，保持默认即可 |
| `debug` | `false` | 排错时临时开，能看到原始消息体 |

同一份配置里如果有多个 `connect`，只把要用的那个 `enable` 设为 `true`，其余保持 `false`，否则会同时起多个端点抢事件。

### 4.5 备选：Milky / Satori（Yunzai 主动连 LLBot）

如果你更希望「Yunzai 连过去」（比如 LLBot 跑在另一台机器、或需要走公网），用这两个：

**Milky**（LLBot 侧）：

```json
"milky": {
  "enable": true,
  "reportSelfMessage": false,
  "http": { "host": "127.0.0.1", "port": 3010, "prefix": "", "accessToken": "" }
}
```

对应 TRSS `milky.yaml`：`enable: true`、`port: **3010**`、`access_token` 同上。

**Satori**（LLBot 侧）：

```json
"satori": { "enable": true, "host": "127.0.0.1", "port": 5600, "token": "" }
```

对应 TRSS `satori.yaml`：`enable: true`、`http_endpoint: http://127.0.0.1:5600/v1`、`ws_endpoint: ws://127.0.0.1:5600/v1/events`。

三种协议怎么选：

| | OneBot11（反连） | Milky | Satori |
|---|---|---|---|
| 谁发起连接 | LLBot | Yunzai | Yunzai |
| TRSS 侧配置量 | **零**（改 LLBot 即可） | 改 `milky.yaml` | 改 `satori.yaml` |
| 跨机器部署 | 需要把 Yunzai 的 2536 暴露出去 | 天然支持（填对方 IP） | 天然支持 |
| 官方文档覆盖 | **有专门章节** | 有适配器，无专门教程 | 同左 |
| 建议 | **首选** | 备选 | 备选 |

---

## 5. 联调验证（四步，从底层往上查）

### 第 1 步：确认 TRSS 的 WS 服务起来了

看 Yunzai 启动日志，应该有一行：

```
[WebSocket] 连接地址：ws://localhost:2536/[OneBotv11]
```

方括号里是**已注册的 WS 路径**。如果这里没有 `OneBotv11`，说明适配器没加载（`plugins/adapter/OneBotv11.js` 缺失或语法错误），跟 LLBot 无关。

### 第 2 步：确认 LLBot 连上了

- LLBot 侧：WebUI 的 OneBot11 连接状态显示已连接，或日志出现握手成功。
- TRSS 侧：出现

  ```
  [WebSocket] 建立连接        ws://127.0.0.1:2536/OneBotv11
  ```

  断开时会打印 `断开连接`。

### 第 3 步：确认能收到消息

TRSS 日志里出现 `[Adapter] 加载适配器[1个]` 后，随便在群里发句「你好」，日志（`log_level: debug` 时）能看到消息体。

### 第 4 步：设置主人

私聊机器人发送：

```
#设置主人
```

它会回「请输入验证码」，同时**日志里打印**：

```
[你的QQ号] 设置主人验证码 XXXXXXXXXXXX
```

把这个验证码直接发在同一个私聊里，回复「设置主人完成」。写入的是 `config/config/other.yaml` 的 `master` 与 `masterQQ`。

> 这一步不做的话，`#更新`、`#重启` 等主人指令全部不可用，很多插件也会拒绝服务。

---

## 6. 常见问题与排查

### 6.1 连接层

| 现象 | 原因 | 排查 / 处理 |
|---|---|---|
| LLBot 连不上，TRSS 日志 `WebSocket 处理器 OneBotv11 不存在` + 返回 **404** | 路径不对。TRSS 用 `url.pathname.split("/")[1]` 取第一段匹配，多一段、少一段、大小写不对都会 404 | 地址必须是 `ws://IP:2536/OneBotv11`。`/onebotv11`、`/OneBot11`、`/OneBotv11/` 后面的多余路径都可能出问题 |
| 握手返回 **401 Unauthorized** | `server.yaml` 里配了 `auth` | 把 `auth:` 清空。LLBot 的 `ws-reverse` 不能带自定义 Header，无法通过 TRSS 的 auth 校验 |
| **ECONNREFUSED / 连接被拒** | Yunzai 没起、端口不对、或只监听了回环 | ① 确认 `node .` 在跑；② 对比 `server.yaml` 的 `port` 与 LLBot 的 `url`；③ 跨机器时确认防火墙放行 2536 |
| 连上后立刻断开、反复重连 | 两个进程抢同一个账号 / 同一个 LLBot 同时开了多个 connect | 只保留一个 `enable: true` 的连接项 |
| 启动报 `EADDRINUSE 2536` | 端口被占用（常见：上一个 Yunzai 没退干净、或另一个 Yunzai 实例） | `node . stop`、`lsof -i:2536` / `netstat -ano \| findstr 2536`，必要时改 `server.yaml` 的 `port`（同时改 LLBot 的 url） |

### 6.2 TRSS 启动层

| 现象 | 原因 | 处理 |
|---|---|---|
| `Promise.withResolvers is not a function` / `import.meta.dirname` 相关报错 | Node 版本过低 | 升到 **>= 23.11**（推荐 24）。`node -v` 先确认 |
| Redis 一直重连 / `spawn redis-server ENOENT` | 本机没装 Redis，或 `redis.yaml` 的 `path` 不对 | 装 Redis；用 Valkey 就把 `path` 改成 `valkey-server`；远程 Redis 直接填 `host/port/password` |
| `Redis 连接错误，请确认连接地址正确` | `host` 不是 `127.0.0.1` 时 Yunzai 不会尝试自动拉起 | 远程模式必须保证 Redis 已运行且可连通 |
| `pnpm i` 后启动报 `Cannot find module 'lodash'` 之类 | 之前用 `npm i` 装的 | 删 `node_modules` 与 `pnpm-lock.yaml`，重新 `pnpm i`（`lodash`/`md5`/`oicq` 等是 workspace 链接包，必须用 pnpm） |
| 图片渲染报 Chromium 相关错误 | 没装 Chrome，或路径没配 | 装 Chrome，或在 `bot.yaml` 里填 `chromium_path` |

### 6.3 业务层（连上了但机器人不响应）

| 现象 | 原因 | 处理 |
|---|---|---|
| 私聊正常、群里完全不理人 | `group.yaml` 的 `onlyReplyAt` 设成了 1 或 2 | 改回 `0`，或 @ 机器人测试 |
| 某个群怎么都不响应，其他群正常 | 该群在 `other.yaml` 的 `blackGroup` 里（**默认就有 `213938015`**） | 删掉该群号 |
| 某个用户不响应 | `blackUser` 里有他（默认 `528952540`） | 同上 |
| 收到消息但所有图片/表情/At 都是乱的 | LLBot 的 `messageFormat` 是 `string` | 改成 `array` |
| 机器人自己的消息被当成用户消息处理，出现自问自答 | `reportSelfMessage: true` | 改 `false` |
| 群里隔很久才回一句 | `groupCD`/`singleCD` 冷却 | 调小 `groupCD`（默认 500ms）、`singleCD`（默认 2000ms） |
| 主干指令能用，插件不响应 | 插件未安装 / 未加载 / 自身报错 | 看启动日志里插件加载段；`bot.yaml` 的 `log_level` 改 `debug` 复现 |
| 刚进小群机器人自己退了 | `other.yaml` 的 `autoQuit: 50` | 改 0 |
| 被邀请进群没反应 | `autoGroup: 0`（仅主人可拉） | 改 1（所有人），或由主人操作 |

### 6.4 LLBot 侧

| 现象 | 原因 | 处理 |
|---|---|---|
| WebUI 打不开 | 只监听 `127.0.0.1`，或端口被占 | 默认 `http://127.0.0.1:3080`；远程访问需改 `webui.host` 为 `0.0.0.0` 并做安全隔离 |
| WebUI 要密码但不知道 | 密码在 `data/webui_token.txt` | 直接读该文件；改完重启生效 |
| 二维码不出来 / 登录阶段进程退出 | **缺 auth_token**，或 token 无效 | 到 <https://auth.luckylillia.com> 取 token 写入 `data/auth_token.txt`；无效 token 会导致签名 401 并让进程退出 |
| 改了 `config_<uin>.json` 不生效 | 登录前用的是默认配置，登录后才会写/读带 uin 的那份 | 先登录成功，再改 `data/config_<QQ号>.json`，保存后 LLBot 会自动重载（有约 2 秒防抖） |
| WebUI 里改了协议配置，TRSS 没反应 | LLBot 已重载但 TRSS 侧连接是旧的 | 在 LLBot 里把该连接关掉再开；或重启 Yunzai |
| 登录后频繁掉线 | 账号风控 / 同账号多端登录 | 退出其他设备；换登录方式（扫码 / 密码） |

### 6.5 一个快速自检脚本

在 Yunzai 所在机器上执行，能一次排掉三种最常见的问题：

```bash
# 1) 端口是否在监听（Windows 用 netstat -ano | findstr 2536）
lsof -i:2536

# 2) 手动试一次 WS 握手（需要 websocat：https://github.com/vi/websocat）
websocat ws://127.0.0.1:2536/OneBotv11
#   连上后 Yunzai 日志出现「建立连接」＝ 服务端正常，问题一定在 LLBot 侧配置

# 3) Redis 是否可用
redis-cli -h 127.0.0.1 -p 6379 ping     # 期望 PONG
valkey-cli -h 127.0.0.1 -p 6379 ping    # Valkey 版本

# 4) Node 版本
node -v                                  # 必须 >= v23.11
```

---

## 7. 附：端口对照表

| 端口 | 归属 | 用途 | 可改 |
|---|---|---|---|
| **2536** | TRSS-Yunzai | HTTP + WS 服务（`/OneBotv11` 就在这），管理接口 | `server.yaml` → `port` |
| 6379 | Redis / Valkey | 缓存 | `redis.yaml` → `port` |
| **3080** | LuckyLilliaBot | WebUI | `config_<uin>.json` → `webui.port` |
| 3000 | LLBot | OneBot11 HTTP | `ob11.connect[type=http]` |
| 3001 | LLBot | OneBot11 正向 WS（LLBot 当服务端） | `ob11.connect[type=ws]` |
| **3010** | LLBot | Milky HTTP（**不是 3000**） | `milky.http.port` |
| **5600** | LLBot | Satori（路由前缀 `/v1`） | `satori.port` |

> 记忆方法：**只有 2536 和 3080 是你必须记住的**，其余都是可选协议端口。Milky 的 3010 和 TRSS 默认的 3000 不一致，是这套组合里最容易踩的坑；OneBot11 反连方案完全不涉及这些端口。

---

## 8. 版本与来源

| 项目 | 版本 | 核实方式 |
|---|---|---|
| TRSS-Yunzai | 3.1.3（`package.json`） | 浅克隆仓库核对 `config/default_config/*`、`plugins/adapter/*`、`lib/bot.js` |
| LuckyLilliaBot | 8.3.2 | 仓库 `src/main/config/default_config.json`、`src/main/config/index.ts` |

关键事实来源：

- TRSS 安装与协议端说明：<https://github.com/TimeRainStarSky/Yunzai>（README）
- LLBot 对接云崽的官方步骤：<https://luckylillia.com/guide/install_yunzai>
- LLBot 默认端口与配置结构：仓库 `src/main/config/default_config.json`
- LLBot 配置文件命名 `config_<uin>.json` / `webui_token.txt` / `auth_token.txt`：仓库 `src/main/config/index.ts`
- WS 404 / 401 行为：TRSS `lib/bot.js` 的 `wsConnect` 与 `serverAuth`
