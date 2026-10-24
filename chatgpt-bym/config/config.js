import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// js-yaml 4.x 是 CJS（有 default），5.x 是纯 ESM（只有命名导出）。
// 直接 `import yaml from 'js-yaml'` 在 5.x 下会报 "does not provide an export named 'default'"，
// 把插件直接打死在启动阶段。这里两种都兼容。
import * as YAML from 'js-yaml'

const yaml = YAML.default ?? YAML

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录。用文件自身位置推导，插件改名/被软链也不会失效。 */
const pluginRoot = path.resolve(__dirname, '..')

// 支持用环境变量把配置与数据挪出插件目录：
// 1) 多个机器人实例共用一个插件目录时各自隔离；
// 2) 自动化测试可以指到临时目录，不污染真实配置。
const configDir = process.env.BYM_CONFIG_DIR ? path.resolve(process.env.BYM_CONFIG_DIR) : __dirname
export const dataDir = process.env.BYM_DATA_DIR
  ? path.resolve(process.env.BYM_DATA_DIR)
  : path.join(pluginRoot, 'data')
export const presetDir = process.env.BYM_DATA_DIR
  ? path.join(path.resolve(process.env.BYM_DATA_DIR), 'presets')
  : path.join(pluginRoot, 'presets')

const CONFIG_YAML = path.join(configDir, 'config.yaml')
const CONFIG_JSON = path.join(configDir, 'config.json')

/**
 * 默认配置。所有键都必须在这里有默认值：
 * 升级时靠它给老配置文件补齐新增项。
 */
const DEFAULTS = {
  // 总开关
  enable: false,
  // 管理指令前缀
  commandPrefix: '#bym',

  trigger: {
    // 白名单模式：只有 listed 里的群会触发；blacklist：列出的群不触发；all：所有群
    groupMode: 'whitelist',
    groups: [],
    // 命中即必触发的词（不区分大小写）
    hitKeywords: ['bym'],
    // 不命中关键词时的触发概率，0~1
    probability: 0.02,
    // 同群两次发言的最小间隔（秒），0 表示不限制
    cooldownSeconds: 60,
    // 同群每小时最多主动发言次数，0 表示不限制
    maxPerHour: 6,
    // 关键词命中时是否无视冷却。默认 false：热词不该变成刷屏开关
    bypassCooldownOnKeyword: false,
    // 忽略 @ 了别人的消息（避免抢答）
    ignoreAtOthers: true,
    // 忽略以指令前缀开头的消息
    ignoreCommandPrefixes: ['#', '/'],
    // 允许触发的最短/最长消息长度（字符）
    minLength: 1,
    maxLength: 200,
    // 消息里带这些词直接不接话（广告、接龙等）
    muteKeywords: ['[CQ:xml', '拼多多', '砍一刀'],
  },

  speaking: {
    // reply：回复触发它的那条消息；contextual：读完上下文后自主发言
    mode: 'reply',
    // contextual 模式下发给模型的指令
    contextualPrompt: '你现在不是在回复某一条特定消息，而是作为这个群里的一名普通群友自然参与当前聊天。请阅读前面的群聊上下文，选择一个自然的切入点发言，可以接续话题、补充信息、吐槽、提问或表达态度。不要解释任务，不要提及“上下文”“指令”“AI”或“机器人”，不要强行引用、@或逐句回答触发你的那条消息。直接输出一段适合发到群里的自然发言。',
    // 默认人设 ID（对应 presets/<id>.yaml）
    defaultPresetId: 'bym_default',
    // 统一人设前缀，会拼在每个预设的 system 前面
    presetPrefix: '',
    // 关键词 -> 预设映射：[{ keywords: ['原神'], presetId: 'genshin', priority: 10, recallSeconds: 0 }]
    presetMap: [],
    // 发完 N 秒后撤回，0 表示不撤回
    recallSeconds: 0,
    // 长回复拆成多条发送，模拟真人分段
    splitReplies: true,
    // 单条上限，超过就强制切分
    maxSegmentLength: 120,
    // 打字延迟：min + 字符数 * perChar，夹在 [min, max] 之间
    typingDelay: { minMs: 800, perCharMs: 35, maxMs: 6000 },
    // 多条之间的额外随机停顿
    gapDelay: { minMs: 300, maxMs: 1200 },
  },

  llm: {
    // OpenAI 兼容端点，会拼成 {baseURL}/chat/completions
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.9,
    topP: 1,
    maxTokens: 300,
    timeoutMs: 60000,
    // 流式（只影响耗时，不影响最终结果；拟人化分段发送需要完整文本，故默认关）
    stream: false,
    // 失败重试次数（429 / 5xx / 网络错误）
    retries: 2,
    // 附加请求头 / 请求体，用于中转站特殊要求
    extraHeaders: {},
    extraBody: {},
    // 备用渠道，主渠道不可用时依次尝试
    // [{ baseURL, apiKey, model }]
    fallback: [],
  },

  context: {
    // 是否把群聊记录喂给模型
    enable: true,
    // 拉取条数
    length: 20,
    // 群历史缓存（秒），0 关闭。开启后缓存期内新消息不会进入上下文
    cacheTTL: 0,
    // 头部模板
    header: '<settings>\nYou are a member of a chat group, whose name is ${group.name}, and the group id is ${group.id}.\n</settings>Latest several messages in the group chat:\n| 群名片 | 昵称 | qq号 | 群角色 | 时间 | 消息内容 |\n|---|---|---|---|---|---|',
    // 每条消息的模板
    message: '| ${message.sender.card} | ${message.sender.nickname} | ${message.sender.user_id} | ${message.sender.role} | ${message.time} | ${message.raw_message} |',
  },

  vision: {
    // 是否把消息/群上下文里的图片转成 base64 发给模型（模型需支持多模态）
    enable: false,
    // 单张图片 base64 后的大小上限
    maxImageSize: 1048576,
    // 宽高上限，超了不处理（不做缩放，避免引入 sharp）
    maxImageDimension: 2000,
    // 最多带几张图
    maxImages: 3,
    // 群上下文里的图片是否也带上
    includeContextImages: false,
  },

  memory: {
    // 轻量记忆（JSON），不依赖 sqlite3 / 向量库
    enable: false,
    // 每群注入最近/最相关的事实条数
    injectLimit: 5,
    // 是否用模型自动抽取记忆
    extract: true,
    // 抽取用模型，留空复用 llm.model
    extractModel: '',
    // 每群最多保留多少条事实
    maxFactsPerGroup: 200,
    // 抽取的系统提示词
    extractPrompt: '你是一个群聊记忆抽取助手。阅读给出的群聊记录，抽出值得长期记住的事实（成员身份/职业/所在地、群内的约定与梗、发生过的事件与决定、成员明确的偏好）。不要抽取寒暄、日常闲聊、与机器人互动的指令。返回 JSON 数组，每个元素形如 {"fact":"用一句话完整描述","topic":"主题词","importance":0.5}，importance 取 0~1。没有值得记的就返回 []。不要输出任何解释或代码块标记。',
  },
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone (value) {
  return structuredClone(value)
}

/**
 * 用默认值补齐用户配置里缺失的键（不覆盖用户已有值）。
 *
 * 注意「键存在但值不是对象」的情况：YAML 里把子项全注释掉只剩一个
 * `llm:`，读进来就是 null。此时必须用默认值覆盖，否则后续访问
 * config.llm.baseURL 会抛 TypeError。
 *
 * @returns {boolean} 是否有改动（有则需要回写文件）
 */
function fillDefaults (target, defaults) {
  let changed = false
  for (const [key, defValue] of Object.entries(defaults)) {
    const current = target[key]
    if (!(key in target) || (isPlainObject(defValue) && !isPlainObject(current))) {
      target[key] = clone(defValue)
      changed = true
      continue
    }
    if (isPlainObject(defValue)) {
      if (fillDefaults(current, defValue)) changed = true
    }
  }
  return changed
}

class BymConfig {
  constructor () {
    this.file = ''
    this.mtimeMs = 0
    this._timer = null
    this._watcher = null
    this.data = clone(DEFAULTS)
  }

  /**
   * 读取配置。优先 config.yaml，其次 config.json，都没有则生成一份 yaml。
   */
  load () {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(presetDir, { recursive: true })

    if (fs.existsSync(CONFIG_YAML)) {
      this.file = CONFIG_YAML
    } else if (fs.existsSync(CONFIG_JSON)) {
      this.file = CONFIG_JSON
    } else {
      this.file = CONFIG_YAML
      this.data = clone(DEFAULTS)
      this.save()
      globalThis.logger?.info?.(`[bym] 已生成默认配置：${this.file}`)
      return this
    }

    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = this.file.endsWith('.json') ? JSON.parse(raw) : (yaml.load(raw) || {})
      const merged = isPlainObject(parsed) ? parsed : {}
      if (fillDefaults(merged, DEFAULTS)) {
        globalThis.logger?.info?.('[bym] 配置缺少新增项，已补齐并回写')
      }
      this.data = merged
      this.mtimeMs = fs.statSync(this.file).mtimeMs
    } catch (err) {
      // 配置坏了不能让插件整个挂掉：保留默认值继续跑，并明确报错
      globalThis.logger?.error?.(`[bym] 配置解析失败，已回退默认值：${err.message}`)
      this.data = clone(DEFAULTS)
    }
    return this
  }

  save () {
    try {
      const text = this.file.endsWith('.json')
        ? JSON.stringify(this.data, null, 2)
        : yaml.dump(this.data, { lineWidth: 200, noRefs: true })
      fs.writeFileSync(this.file, text, 'utf8')
      this.mtimeMs = fs.statSync(this.file).mtimeMs
      return true
    } catch (err) {
      globalThis.logger?.error?.(`[bym] 配置写入失败：${err.message}`)
      return false
    }
  }

  /**
   * 监听配置文件，外部编辑后热加载。
   * 用 mtime 比对跳过自己写入造成的事件，避免“保存→重载→保存”抖动。
   */
  watch () {
    if (this._watcher) return
    this._watcher = fs.watchFile(this.file, { interval: 1000 }, (curr) => {
      if (!curr.mtimeMs || Math.abs(curr.mtimeMs - this.mtimeMs) < 1) return
      clearTimeout(this._timer)
      this._timer = setTimeout(() => {
        globalThis.logger?.info?.('[bym] 检测到配置文件变更，正在热加载')
        this.load()
      }, 300)
    })
  }

  unwatch () {
    if (this._watcher) {
      fs.unwatchFile(this.file)
      this._watcher = null
    }
  }

  /** 便捷读取：cfg.bym('trigger.probability', 0.1) */
  get (keyPath, fallback) {
    const value = String(keyPath).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), this.data)
    return value === undefined ? fallback : value
  }

  set (keyPath, value) {
    const keys = String(keyPath).split('.')
    const last = keys.pop()
    let target = this.data
    for (const key of keys) {
      if (!isPlainObject(target[key])) target[key] = {}
      target = target[key]
    }
    target[last] = value
    return this.save()
  }

  /**
   * 批量写入扁平 patch（键形如 `llm.apiKey`），只写一次盘。
   *
   * 锅巴的 setConfigData 会一次提交整张表单，逐项走 set() 等于把配置文件
   * 重写几十遍，还会让 fs.watchFile 反复触发。
   */
  apply (patch) {
    for (const [keyPath, value] of Object.entries(patch || {})) {
      const keys = String(keyPath).split('.')
      const last = keys.pop()
      let target = this.data
      for (const key of keys) {
        if (!isPlainObject(target[key])) target[key] = {}
        target = target[key]
      }
      target[last] = value
    }
    return this.save()
  }

  // 常用段落的快捷访问器
  get trigger () { return this.data.trigger }
  get speaking () { return this.data.speaking }
  get llm () { return this.data.llm }
  get context () { return this.data.context }
  get vision () { return this.data.vision }
  get memory () { return this.data.memory }
  get enabled () { return this.data.enable === true }
}

export const config = new BymConfig()
