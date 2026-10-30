# 锅巴（Guoba-Plugin）适配说明

> 本文分两部分：先说锅巴是怎么把第三方插件接进它的面板的（读源码得到的结论），
> 再说 `chatgpt-bym` 具体怎么适配、面板里能改什么、出问题怎么查。
>
> 安装与基础配置见 [INSTALL.md](./INSTALL.md)。

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

## 二、接入机制（源码结论）

依据：`server/service/interface/IPluginService.js`、`server/controller/biz/PluginController.js`。

### 2.1 发现插件

```
遍历 plugins/ 下每个目录
  └─ 该目录里有 index.js 或 .git/   ← 才算「插件」
       └─ 再找 guoba.support.js     ← 有才「支持锅巴」
```

不支持锅巴的插件照样出现在列表里，只是点进去没有配置项。

### 2.2 加载约定

```js
let { supportGuoba } = await import(jsPath + '?' + Date.now())
if (typeof supportGuoba === 'function') {
  let supportObject = supportGuoba()
  if (supportObject.pluginInfo) plugin = Object.assign(plugin, supportObject.pluginInfo)
  GuobaSupportMap.set(plugin.name, supportObject)
} else {
  throw 'supportGuoba必须要定义成一个方法！'
}
```

四个要点：

1. **必须是具名导出 `supportGuoba`**，且是函数。`export default` 不认。
2. URL 后面拼了时间戳，所以每次刷新锅巴都会**重新执行**这个模块——不要在模块顶层做重活，也不要假设它只跑一次。
3. `pluginInfo.name` 会覆盖掉目录名（默认是小写目录名），并作为 `GuobaSupportMap` 的 key。
4. 加载失败只打一行日志，**不影响插件本身运行**。

### 2.3 配置读写

`PluginController` 的两个接口：

| 动作 | 调用 | 说明 |
|---|---|---|
| 读 | `await configInfo.getConfigData()` | 返回值直接给前端填表 |
| 写 | `await configInfo.setConfigData(req.body, { Result })` | 若返回 `Result` 实例就原样返回，否则包一层 `Result.ok` |

**`req.body` 是扁平 map**，键就是 schema 里的 `field`：

```js
{ 'llm.apiKey': 'sk-xxx', 'trigger.groups': '111\n222', 'enable': true }
```

不是嵌套对象。所以 `setConfigData` 里要自己把 `a.b.c` 展开。

### 2.4 表单格式

```js
configInfo: {
  schemas: [
    { label: '分组名', component: 'SOFT_GROUP_BEGIN' },   // 分组标题，无 field
    {
      field: 'trigger.probability',        // 扁平 map 的键，支持点号路径
      label: '触发概率',
      helpMessage: '显示在右侧问号里',
      bottomHelpMessage: '显示在输入框下方',
      component: 'InputNumber',
      required: true,
      componentProps: { min: 0, max: 1, step: 0.01 }
    }
  ],
  getConfigData () {},
  setConfigData (data, { Result }) {}
}
```

`component` 必须是锅巴前端注册过的名字。**这份白名单不是猜的**——它在构建产物
`server/static/assets/BasicForm.js` 里，形如 `componentMap.set("InputTextArea", Input.TextArea)`。
提取出来一共有这些：

```
Input InputPassword InputSearch InputTextArea InputNumber InputGroup InputCountDown
Switch Select RadioGroup RadioButtonGroup Checkbox CheckboxGroup Cascader TreeSelect
ApiSelect ApiRadioGroup ApiCascader ApiTransfer ApiTree ApiTreeSelect AutoComplete
DatePicker RangePicker TimePicker MonthPicker WeekPicker Upload Slider Rate StrengthMeter
Divider SOFT_GROUP_BEGIN EasyCron IconPicker GTags GButtons GColorPicker GSubForm
GSelectGroup GSelectFriend
```

`SOFT_GROUP_BEGIN` 和 `Divider` 在源码里同属 `DividerComponent`，都是分组用的。

---

## 三、chatgpt-bym 的适配

### 3.1 文件

仓库根的 `guoba.support.js`，导出 `supportGuoba()`。

因为**锅巴与云崽跑在同一个进程**，这里 `import { config } from './config/config.js'` 拿到的
就是插件运行时真正在用的那个单例。所以面板点保存 → 内存立刻变 → 下一条消息就生效，
**不需要重启，也不经过文件热加载**。

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

### 3.3 数组和对象怎么编辑

锅巴虽然有 `GTags`，但它的 `componentProps` 没有公开文档，用它等于赌。所以走**已验证的路径**——
锅巴自己处理 `base.gitInstallWhitelist` 的方式：文本框 + 读写时转换。

| 类型 | 面板上的样子 | 字段 |
|---|---|---|
| 字符串数组 | 一行一项 | `trigger.groups`、`hitKeywords`、`ignoreCommandPrefixes`、`muteKeywords` |
| 对象数组 | JSON 文本 | `speaking.presetMap`、`llm.fallback` |
| 对象 | JSON 文本 | `llm.extraHeaders`、`llm.extraBody` |

`getConfigData()` 负责数组 → 文本，`setConfigData()` 负责文本 → 数组：

```js
// 读：数组变成可读的文本
setPath(form, 'trigger.groups', config.data.trigger.groups.join('\n'))
// 写：一行一项，顺带认全角逗号（群里粘贴群号常见）
'123456\n789012'  →  ['123456', '789012']
```

**JSON 填错的处理**：返回 `Result.error('备用渠道 不是合法的 JSON：...')`，
并且**整张表单一项都不写**。宁可让用户改完重提，也不要写进去一半——那种状态最难排查。

### 3.4 批量写入

面板一次提交整张表单（几十个字段）。逐项调 `config.set()` 会把配置文件重写几十遍，
还会让 `fs.watchFile` 反复触发。所以给配置类加了 `apply(patch)`：所有 keyPath 改完只写一次盘。

```js
config.apply({
  'llm.model': 'deepseek-flash',
  'trigger.groups': ['111'],
})
```

内部会更新 `mtimeMs`，热加载的 `fs.watchFile` 据此跳过自身写入，不会「保存 → 重载 → 再保存」抖动。

### 3.5 三个注意点

| 项 | 原因 |
|---|---|
| `pluginInfo.name` 必须等于目录名（小写） | 锅巴用它做路由 key，不一致会导致前端请求 404 |
| 改 `commandPrefix` 仍需重启 | 指令正则是插件加载时编译的快照，锅巴只能改配置值 |
| 锅巴读不到 `presets/*.yaml` | 人设是独立文件，不在配置里；想改人设正文直接编辑文件 |

---

## 四、排错

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

## 五、自测

不装锅巴也能验证适配契约：

```bash
node tests/guoba.mjs    # 23 项
```

覆盖：

| 组 | 检查 |
|---|---|
| 契约 | 返回值结构、`pluginInfo.name` 与目录名一致 |
| schema | 组件名在白名单内、分组有 label、字段不重复、**每个 field 都能在真实配置里找到** |
| 读 | 嵌套对象、数组转文本、对象转 JSON 文本、深拷贝不污染 |
| 写 | 扁平 map 展开、落盘、多行转数组、JSON 解析、空值清空、非法 JSON 拒绝、空串不写脏值、往返一致 |

其中「每个 field 都能在真实配置里找到」这条最有用：写错一个路径（比如把 `speaking.typingDelay.minMs`
写成 `speaking.typingDelay.minms`）会立刻失败，而不是等用户发现面板上的值保存后消失。

---

## 六、参考

| 内容 | 位置 |
|---|---|
| 插件扫描与加载 | `Guoba-Plugin/server/service/interface/IPluginService.js` `readLocalPlugins()` |
| 配置读写接口 | `Guoba-Plugin/server/controller/biz/PluginController.js` `getPluginConfig` / `setPluginConfig` |
| 组件白名单 | `Guoba-Plugin/server/static/assets/BasicForm.js`（`componentMap.set(...)`） |
| 官方示例 schema | `Guoba-Plugin/guoba.support.js`（锅巴自己的配置） |
