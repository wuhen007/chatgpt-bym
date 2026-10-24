/**
 * 锅巴（Guoba-Plugin）适配。
 *
 * 锅巴的加载方式（server/service/interface/IPluginService.js）：
 *   扫描 plugins/<插件>/guoba.support.js → import → 调用导出的 supportGuoba()
 * 返回 { pluginInfo, configInfo: { schemas, getConfigData, setConfigData } }。
 *
 * 关键约定：
 * - 锅巴与云崽跑在同一个进程，所以这里 import 到的 config 就是插件真正在用的那个单例；
 *   改完内存即生效，不需要重启，也不需要再走一遍热加载。
 * - setConfigData 收到的 data 是「扁平 map」，键是 schema 里的 field（如 `llm.apiKey`），
 *   不是嵌套对象。
 * - schemas 里的 component 必须是锅巴前端注册过的名字（Input / InputPassword /
 *   InputNumber / InputTextArea / Switch / Select / RadioGroup / Divider / SOFT_GROUP_BEGIN 等）。
 */
import { config } from './config/config.js'

/**
 * 数组字段：锅巴没有可靠的标签输入组件，统一用「一行一项」的文本框。
 * 锅巴自己也这么处理 `base.gitInstallWhitelist`，属于已验证的路径。
 */
const LIST_FIELDS = new Set([
  'trigger.groups',
  'trigger.hitKeywords',
  'trigger.ignoreCommandPrefixes',
  'trigger.muteKeywords',
])

/** 结构化字段：填 JSON。value 是期望的顶层类型，用于校验。 */
const JSON_FIELDS = new Map([
  ['speaking.presetMap', 'array'],
  ['llm.fallback', 'array'],
  ['llm.extraHeaders', 'object'],
  ['llm.extraBody', 'object'],
])

/** 字段中文名，报错时指得清是哪个填错了 */
const FIELD_LABELS = {
  'speaking.presetMap': '关键词换人设',
  'llm.fallback': '备用渠道',
  'llm.extraHeaders': '附加请求头',
  'llm.extraBody': '附加请求体',
}

function getPath (obj, keyPath) {
  return String(keyPath).split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj)
}

function setPath (obj, keyPath, value) {
  const keys = String(keyPath).split('.')
  const last = keys.pop()
  let target = obj
  for (const key of keys) {
    if (target[key] === null || typeof target[key] !== 'object') target[key] = {}
    target = target[key]
  }
  target[last] = value
}

/** 结构化字段转成文本框内容：空值给空串，避免显示成 "[]" 或 "{}" */
function stringifyJSON (value) {
  if (Array.isArray(value)) return value.length ? JSON.stringify(value, null, 2) : ''
  if (value && typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value, null, 2) : ''
  return ''
}

export function supportGuoba () {
  return {
    pluginInfo: {
      // 必须与插件目录名一致（小写），锅巴用它做路由 key
      name: 'chatgpt-bym',
      title: '伪人模式',
      description: '让机器人在群里像普通群友一样偶尔插一句话（OpenAI 兼容接口）',
      author: ['chatgpt-bym'],
      authorLink: [''],
      link: '',
      isV3: true,
      isV2: false,
      showInMenu: 'auto',
      icon: 'mdi:account-voice',
      iconColor: '#4f7cff',
    },

    configInfo: {
      schemas: [
        // ─────────────────────────── 基础 ───────────────────────────
        { label: '基础设置', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'enable',
          label: '启用伪人模式',
          bottomHelpMessage: '总开关。关掉后插件仍然加载，但不会在群里说话',
          component: 'Switch',
        },
        {
          field: 'commandPrefix',
          label: '管理指令前缀',
          helpMessage: '修改后需要重启或重载插件才会生效（指令正则是加载时编译的）',
          bottomHelpMessage: '默认 `#bym`，例如 `#bym 状态`',
          component: 'Input',
          required: true,
          componentProps: { placeholder: '#bym' },
        },

        // ─────────────────────────── 触发 ───────────────────────────
        { label: '触发控制', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'trigger.groupMode',
          label: '群范围模式',
          bottomHelpMessage: '白名单：只在这些群说话；黑名单：除了这些群都说话；全部：所有群',
          component: 'RadioGroup',
          componentProps: {
            buttonStyle: 'solid',
            options: [
              { label: '白名单', value: 'whitelist' },
              { label: '黑名单', value: 'blacklist' },
              { label: '全部群', value: 'all' },
            ],
          },
        },
        {
          field: 'trigger.groups',
          label: '群号列表',
          helpMessage: '白名单模式下列表为空 = 全部禁用（不是全开）',
          bottomHelpMessage: '一行一个群号，例如：`123456789`',
          component: 'InputTextArea',
          componentProps: { placeholder: '123456789\n987654321', rows: 3 },
        },
        {
          field: 'trigger.hitKeywords',
          label: '必触发关键词',
          bottomHelpMessage: '消息包含这些词就一定接话，用于测试和定点召唤。一行一个',
          component: 'InputTextArea',
          componentProps: { placeholder: 'bym\n小助手', rows: 2 },
        },
        {
          field: 'trigger.probability',
          label: '触发概率',
          bottomHelpMessage: '未命中关键词时，每条消息有多大概率接话。0.02 = 2%',
          component: 'InputNumber',
          required: true,
          componentProps: { min: 0, max: 1, step: 0.01, precision: 2 },
        },
        {
          field: 'trigger.cooldownSeconds',
          label: '冷却时间（秒）',
          bottomHelpMessage: '同一个群两次发言的最小间隔，0 为不限制',
          component: 'InputNumber',
          componentProps: { min: 0, max: 3600, step: 10 },
        },
        {
          field: 'trigger.maxPerHour',
          label: '每小时上限',
          bottomHelpMessage: '同一个群每小时最多主动发言几次，0 为不限制。调低可应对接口限流',
          component: 'InputNumber',
          componentProps: { min: 0, max: 60 },
        },
        {
          field: 'trigger.bypassCooldownOnKeyword',
          label: '关键词无视冷却',
          bottomHelpMessage: '开启后必触发关键词不再受冷却和上限约束，慎用（容易被刷屏）',
          component: 'Switch',
        },
        {
          field: 'trigger.ignoreAtOthers',
          label: '不接 @ 别人的话',
          bottomHelpMessage: '消息里 @ 了其他人时视为定向对话，不插嘴',
          component: 'Switch',
        },
        {
          field: 'trigger.ignoreCommandPrefixes',
          label: '忽略的消息前缀',
          bottomHelpMessage: '这些开头的消息不接话。一行一个，例如 `#` 与 `/`',
          component: 'InputTextArea',
          componentProps: { placeholder: '#\n/', rows: 2 },
        },
        {
          field: 'trigger.minLength',
          label: '最短消息长度',
          bottomHelpMessage: '少于这个字数不接话，避免对“嗯”“？”接话',
          component: 'InputNumber',
          componentProps: { min: 1, max: 100 },
        },
        {
          field: 'trigger.maxLength',
          label: '最长消息长度',
          bottomHelpMessage: '超过这个字数不接话（避开长文、公告）',
          component: 'InputNumber',
          componentProps: { min: 10, max: 5000 },
        },
        {
          field: 'trigger.muteKeywords',
          label: '屏蔽词',
          bottomHelpMessage: '消息包含这些词直接跳过，比如广告、接龙。一行一个',
          component: 'InputTextArea',
          componentProps: { placeholder: '砍一刀\n拼多多', rows: 2 },
        },

        // ─────────────────────────── 发言 ───────────────────────────
        { label: '发言风格', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'speaking.mode',
          label: '发言方式',
          bottomHelpMessage: '回复模式：接着触发它的那条消息说；自主模式：读完群聊记录自己找切入点',
          component: 'RadioGroup',
          componentProps: {
            buttonStyle: 'solid',
            options: [
              { label: '回复模式', value: 'reply' },
              { label: '自主融入', value: 'contextual' },
            ],
          },
        },
        {
          field: 'speaking.contextualPrompt',
          label: '自主模式的指令',
          helpMessage: '仅在「自主融入」模式下使用',
          bottomHelpMessage: '发给模型的行动指令，决定它怎么挑话题',
          component: 'InputTextArea',
          componentProps: { rows: 4, showCount: true, maxlength: 2000 },
        },
        {
          field: 'speaking.defaultPresetId',
          label: '默认人设 ID',
          bottomHelpMessage: '对应插件目录 `presets/<ID>.yaml`，默认 `bym_default`',
          component: 'Input',
          required: true,
          componentProps: { placeholder: 'bym_default' },
        },
        {
          field: 'speaking.presetPrefix',
          label: '统一人设前缀',
          bottomHelpMessage: '会拼在每个预设的 system 前面，适合放通用语气要求',
          component: 'InputTextArea',
          componentProps: { rows: 2 },
        },
        {
          field: 'speaking.presetMap',
          label: '关键词换人设',
          bottomHelpMessage: 'JSON 数组，留空表示不使用。格式：[{"keywords":["原神"],"presetId":"bym_tsundere","priority":10}]',
          component: 'InputTextArea',
          componentProps: { rows: 4, placeholder: '[\n  { "keywords": ["原神"], "presetId": "bym_tsundere", "priority": 10 }\n]' },
        },
        {
          field: 'speaking.recallSeconds',
          label: '撤回时间（秒）',
          bottomHelpMessage: '发完 N 秒后撤回自己那条，0 为不撤回。不会撤群友的消息',
          component: 'InputNumber',
          componentProps: { min: 0, max: 120 },
        },
        {
          field: 'speaking.splitReplies',
          label: '长回复分段发送',
          bottomHelpMessage: '开启后按句子拆成多条，更像真人打字',
          component: 'Switch',
        },
        {
          field: 'speaking.maxSegmentLength',
          label: '单条最大字数',
          bottomHelpMessage: '超过才会拆分成多条。60~120 之间比较自然',
          component: 'InputNumber',
          componentProps: { min: 20, max: 500 },
        },
        {
          field: 'speaking.typingDelay.minMs',
          label: '打字延迟下限（毫秒）',
          bottomHelpMessage: '发送前至少等这么久',
          component: 'InputNumber',
          componentProps: { min: 0, max: 10000, step: 100 },
        },
        {
          field: 'speaking.typingDelay.perCharMs',
          label: '每字耗时（毫秒）',
          bottomHelpMessage: '延迟 = 下限 + 字数 × 该值，再受右上上限约束',
          component: 'InputNumber',
          componentProps: { min: 0, max: 500, step: 5 },
        },
        {
          field: 'speaking.typingDelay.maxMs',
          label: '打字延迟上限（毫秒）',
          bottomHelpMessage: '无论多长都不超过这个时间',
          component: 'InputNumber',
          componentProps: { min: 0, max: 60000, step: 100 },
        },
        {
          field: 'speaking.gapDelay.minMs',
          label: '多条间隔下限（毫秒）',
          bottomHelpMessage: '分多条发送时，两条之间至少停顿多久',
          component: 'InputNumber',
          componentProps: { min: 0, max: 10000, step: 100 },
        },
        {
          field: 'speaking.gapDelay.maxMs',
          label: '多条间隔上限（毫秒）',
          component: 'InputNumber',
          componentProps: { min: 0, max: 30000, step: 100 },
        },

        // ─────────────────────────── 接口 ───────────────────────────
        { label: '模型接口', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'llm.baseURL',
          label: '接口地址',
          bottomHelpMessage: 'OpenAI 兼容端点。写 `https://xxx/v1`、`https://xxx` 或完整端点都能识别',
          component: 'Input',
          required: true,
          componentProps: { placeholder: 'https://api.openai.com/v1' },
        },
        {
          field: 'llm.apiKey',
          label: 'API Key',
          bottomHelpMessage: '会以 `Authorization: Bearer <key>` 发送',
          component: 'InputPassword',
          componentProps: { placeholder: 'sk-...' },
        },
        {
          field: 'llm.model',
          label: '模型名称',
          bottomHelpMessage: '例如 `gpt-4o-mini`、`deepseek-chat`',
          component: 'Input',
          required: true,
          componentProps: { placeholder: 'gpt-4o-mini' },
        },
        {
          field: 'llm.temperature',
          label: '温度',
          bottomHelpMessage: '越大越随机。伪人建议 0.8 ~ 1.0',
          component: 'InputNumber',
          componentProps: { min: 0, max: 2, step: 0.1, precision: 1 },
        },
        {
          field: 'llm.topP',
          label: 'Top P',
          bottomHelpMessage: '采样范围，一般保持 1',
          component: 'InputNumber',
          componentProps: { min: 0.1, max: 1, step: 0.05, precision: 2 },
        },
        {
          field: 'llm.maxTokens',
          label: '最大输出长度',
          bottomHelpMessage: '按 token 计。300 大约 2~3 句，调太大容易变成小作文',
          component: 'InputNumber',
          componentProps: { min: 50, max: 4000, step: 50 },
        },
        {
          field: 'llm.timeoutMs',
          label: '请求超时（毫秒）',
          bottomHelpMessage: '慢模型可以调到 120000',
          component: 'InputNumber',
          componentProps: { min: 5000, max: 300000, step: 5000 },
        },
        {
          field: 'llm.stream',
          label: '流式响应',
          helpMessage: '分段发送需要完整文本，一般不用开',
          component: 'Switch',
        },
        {
          field: 'llm.retries',
          label: '失败重试次数',
          bottomHelpMessage: '只对超时、429、5xx 重试；401 会直接换下一个渠道',
          component: 'InputNumber',
          componentProps: { min: 0, max: 5 },
        },
        {
          field: 'llm.extraHeaders',
          label: '附加请求头',
          bottomHelpMessage: 'JSON 对象，中转站要求自定义头时使用。留空表示不加',
          component: 'InputTextArea',
          componentProps: { rows: 3, placeholder: '{\n  "X-Custom": "value"\n}' },
        },
        {
          field: 'llm.extraBody',
          label: '附加请求体',
          bottomHelpMessage: 'JSON 对象，例如 `{"enable_thinking": false}`。留空表示不加',
          component: 'InputTextArea',
          componentProps: { rows: 3, placeholder: '{\n  "enable_thinking": false\n}' },
        },
        {
          field: 'llm.fallback',
          label: '备用渠道',
          bottomHelpMessage: 'JSON 数组，主渠道不可用时依次尝试。格式：[{"baseURL":"...","apiKey":"...","model":"..."}]',
          component: 'InputTextArea',
          componentProps: { rows: 4, placeholder: '[\n  { "baseURL": "https://backup/v1", "apiKey": "sk-...", "model": "gpt-4o-mini" }\n]' },
        },

        // ─────────────────────────── 上下文 ───────────────────────────
        { label: '群聊上下文', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'context.enable',
          label: '注入群聊记录',
          bottomHelpMessage: '关掉后模型不知道群里在聊什么，只能对着触发消息回一句。群记忆也依赖它',
          component: 'Switch',
        },
        {
          field: 'context.length',
          label: '拉取条数',
          bottomHelpMessage: '调大更连贯，但更贵更慢。20 一般够用',
          component: 'InputNumber',
          componentProps: { min: 1, max: 100 },
        },
        {
          field: 'context.cacheTTL',
          label: '历史缓存（秒）',
          bottomHelpMessage: '0 为关闭。开启后能省请求，但缓存期内新消息进不去',
          component: 'InputNumber',
          componentProps: { min: 0, max: 60 },
        },
        {
          field: 'context.header',
          label: '上下文头部模板',
          bottomHelpMessage: '可用占位符 `${group.name}`、`${group.id}`',
          component: 'InputTextArea',
          componentProps: { rows: 3 },
        },
        {
          field: 'context.message',
          label: '单条消息模板',
          bottomHelpMessage: '可用 `${message.sender.card}`、`${message.sender.nickname}`、`${message.raw_message}` 等',
          component: 'InputTextArea',
          componentProps: { rows: 3 },
        },

        // ─────────────────────────── 图片 ───────────────────────────
        { label: '图片识别', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'vision.enable',
          label: '启用图片识别',
          helpMessage: '模型必须支持多模态，否则接口会报错',
          bottomHelpMessage: '开启后群友发的图会转成 base64 一起发过去',
          component: 'Switch',
        },
        {
          field: 'vision.maxImageSize',
          label: '单图体积上限（字节）',
          bottomHelpMessage: '按 base64 后的大小算，超了直接丢弃。默认 1048576（1 MB）',
          component: 'InputNumber',
          componentProps: { min: 65536, max: 20971520, step: 65536 },
        },
        {
          field: 'vision.maxImageDimension',
          label: '图片边长上限（像素）',
          bottomHelpMessage: '宽或高超过就丢弃（不做缩放，避免引入图像处理依赖）',
          component: 'InputNumber',
          componentProps: { min: 200, max: 8000, step: 100 },
        },
        {
          field: 'vision.maxImages',
          label: '单轮最多几张',
          bottomHelpMessage: '0 表示不带图。图片很费 token，建议 1~3',
          component: 'InputNumber',
          componentProps: { min: 0, max: 10 },
        },
        {
          field: 'vision.includeContextImages',
          label: '带上群聊记录里的图',
          bottomHelpMessage: '非常费 token，一般不开',
          component: 'Switch',
        },

        // ─────────────────────────── 记忆 ───────────────────────────
        { label: '群记忆', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'memory.enable',
          label: '启用群记忆',
          helpMessage: '依赖「注入群聊记录」开启，否则抽取不到语料',
          bottomHelpMessage: '开启后会把群里的长期事实记下来，聊天时按相关度带进去',
          component: 'Switch',
        },
        {
          field: 'memory.injectLimit',
          label: '每轮注入条数',
          bottomHelpMessage: '带进提示词的历史事实条数，太多会挤占上下文',
          component: 'InputNumber',
          componentProps: { min: 0, max: 20 },
        },
        {
          field: 'memory.extract',
          label: '自动抽取新记忆',
          bottomHelpMessage: '每次发言后让模型总结一段群聊事实。会额外消耗一次接口调用',
          component: 'Switch',
        },
        {
          field: 'memory.extractModel',
          label: '抽取用模型',
          bottomHelpMessage: '留空则复用上面的模型名称。建议用便宜的小模型',
          component: 'Input',
          componentProps: { placeholder: '留空复用' },
        },
        {
          field: 'memory.maxFactsPerGroup',
          label: '每群记忆上限',
          bottomHelpMessage: '超出后淘汰「不重要且较旧」的条目',
          component: 'InputNumber',
          componentProps: { min: 10, max: 2000, step: 10 },
        },
      ],

      /** 供前端填充表单：把数组/对象转成文本框能显示的字符串 */
      getConfigData () {
        const form = structuredClone(config.data)
        for (const field of LIST_FIELDS) {
          const value = getPath(config.data, field)
          setPath(form, field, Array.isArray(value) ? value.join('\n') : '')
        }
        for (const field of JSON_FIELDS.keys()) {
          setPath(form, field, stringifyJSON(getPath(config.data, field)))
        }
        return form
      },

      /** 前端点确定后调用。data 是扁平 map，键为 schema.field */
      setConfigData (data, { Result }) {
        const patch = {}

        for (const [keyPath, rawValue] of Object.entries(data || {})) {
          if (LIST_FIELDS.has(keyPath)) {
            // 一行一项；顺带把全角逗号分隔也当分隔符，群里粘贴群号时常见
            patch[keyPath] = String(rawValue ?? '')
              .split(/\r?\n/)
              .flatMap(line => line.split(/[,，]/))
              .map(item => item.trim())
              .filter(Boolean)
            continue
          }

          if (JSON_FIELDS.has(keyPath)) {
            const expected = JSON_FIELDS.get(keyPath)
            const text = String(rawValue ?? '').trim()
            if (!text) {
              patch[keyPath] = expected === 'array' ? [] : {}
              continue
            }
            let parsed
            try {
              parsed = JSON.parse(text)
            } catch (err) {
              return Result.error(`${FIELD_LABELS[keyPath] || keyPath} 不是合法的 JSON：${err.message}`)
            }
            if (expected === 'array' && !Array.isArray(parsed)) {
              return Result.error(`${FIELD_LABELS[keyPath] || keyPath} 必须是 JSON 数组`)
            }
            if (expected === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null)) {
              return Result.error(`${FIELD_LABELS[keyPath] || keyPath} 必须是 JSON 对象`)
            }
            patch[keyPath] = parsed
            continue
          }

          patch[keyPath] = rawValue
        }

        // 数值字段前端可能传空串，传空会让 trigger.probability 变成 ""，
        // 之后 Math.max(0, Number('') || 0) 恰好还能用，但配置里留下脏值不体面
        for (const [keyPath, value] of Object.entries(patch)) {
          if (value === '' && typeof getPath(config.data, keyPath) === 'number') {
            delete patch[keyPath]
          }
        }

        config.apply(patch)
        return Result.ok({}, '保存成功，已即时生效')
      },
    },
  }
}
