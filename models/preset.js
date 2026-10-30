import fs from 'node:fs'
import path from 'node:path'
// 同 config.js：兼容 js-yaml 4.x(CJS) 与 5.x(纯 ESM)
import * as YAML from 'js-yaml'
import { presetDir, config } from '../config/config.js'

const yaml = YAML.default ?? YAML

/**
 * 预设 = 人设。一个 yaml/json 文件一个预设，文件名即 ID。
 * 字段：name / system / temperature / maxTokens / recallSeconds / enabled
 *
 * 另有三个**可选**的结构化字段，用来替代 system 里那堆自然语言描述：
 *   identity: { age, city, job, signature }
 *   speech:   { style, length, catchphrases[], never[] }
 *   persona:  { groupAware }   —— 是否在 prompt 里告诉模型「你在哪个群」
 *
 * 结构化不是必需的：老 yaml 只写 system 照常工作。两者同时存在时，
 * 结构化部分在前（模型对开头更敏感），system 作为补充跟在后面。
 */

const CACHE_TTL = 5000
let cache = { at: 0, presets: new Map() }

function parseFile (filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const data = filePath.endsWith('.json') ? JSON.parse(raw) : (yaml.load(raw) || {})
  if (!data || typeof data !== 'object') return null
  return data
}

function str (value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function toList (value, max = 8) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : [])
  return list.map(str).filter(Boolean).slice(0, max)
}

/**
 * 结构化身份。全空时返回 null —— 否则模板会拼出「你是小张，岁，在做。」这种句子，
 * 比不写结构化字段更糟。
 */
function normalizeIdentity (value) {
  if (!value || typeof value !== 'object') return null
  const identity = {
    age: str(value.age),
    city: str(value.city),
    job: str(value.job),
    signature: str(value.signature),
  }
  return Object.values(identity).some(Boolean) ? identity : null
}

function normalizeSpeech (value) {
  if (!value || typeof value !== 'object') return null
  const speech = {
    style: str(value.style),
    length: str(value.length),
    catchphrases: toList(value.catchphrases),
    never: toList(value.never),
  }
  const has = speech.style || speech.length || speech.catchphrases.length || speech.never.length
  return has ? speech : null
}

function normalize (id, data) {
  const system = String(data.system || data.prompt || '').trim()
  return {
    id,
    name: String(data.name || id),
    system,
    identity: normalizeIdentity(data.identity),
    speech: normalizeSpeech(data.speech),
    // 默认 true：多知道一个群名只会让发言更贴切，不会跑偏。
    // 显式 false 才关，用于调试时固定 prompt 便于对比输出差异。
    groupAware: data.persona?.groupAware !== false,
    temperature: Number.isFinite(data.temperature) ? data.temperature : undefined,
    maxTokens: Number.isFinite(data.maxTokens) ? data.maxTokens : undefined,
    recallSeconds: Number.isFinite(data.recallSeconds) ? data.recallSeconds : undefined,
    enabled: data.enabled !== false,
  }
}

/** 扫描预设目录。文件不多，加 5 秒缓存避免每条群消息都读盘。 */
export function loadPresets (force = false) {
  const now = Date.now()
  if (!force && cache.presets.size > 0 && now - cache.at < CACHE_TTL) return cache.presets

  const presets = new Map()
  try {
    if (!fs.existsSync(presetDir)) fs.mkdirSync(presetDir, { recursive: true })
    for (const file of fs.readdirSync(presetDir)) {
      if (!/\.(ya?ml|json)$/i.test(file)) continue
      const id = file.replace(/\.(ya?ml|json)$/i, '')
      try {
        const data = parseFile(path.join(presetDir, file))
        if (!data) continue
        const preset = normalize(id, data)
        if (preset.enabled) presets.set(id, preset)
      } catch (err) {
        globalThis.logger?.warn?.(`[bym] 预设 ${file} 解析失败：${err.message}`)
      }
    }
  } catch (err) {
    globalThis.logger?.error?.(`[bym] 预设目录读取失败：${err.message}`)
  }

  cache = { at: now, presets }
  return presets
}

export function getPreset (id) {
  const presets = loadPresets()
  return presets.get(String(id || '')) || null
}

/**
 * 按关键词选预设。规则形如
 * [{ keywords: ['原神'], presetId: 'genshin', priority: 10, recallSeconds: 0 }]
 * 命中多条时取 priority 最大的一条。
 */
export function pickPresetByKeywords (text, rules = []) {
  if (!text || !Array.isArray(rules) || rules.length === 0) return null
  const lower = String(text).toLowerCase()
  const hits = rules
    .filter(rule => Array.isArray(rule?.keywords) && rule.keywords.some(word => word && lower.includes(String(word).toLowerCase())))
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
  if (hits.length === 0) return null
  const preset = getPreset(hits[0].presetId)
  if (!preset) return null
  return {
    ...preset,
    // 规则级覆盖优先于预设文件里的值
    recallSeconds: Number.isFinite(hits[0].recallSeconds) ? hits[0].recallSeconds : preset.recallSeconds,
  }
}

/**
 * 已经警告过「绑的人设不存在」的 groupId。
 *
 * 这个函数在每轮发言时都会调用。没有去重的话，一个绑错人设的群
 * 会按发言频率一直刷同一条 warn，把真正的错误盖掉。
 * 绑定恢复正常后把这个群从集合里删掉，下次再绑错还能再提示一次。
 */
const warnedMissingPreset = new Set()

/**
 * 取本群绑定的人设。
 *
 * 绑了但人设不存在时**返回 null 并告警**，而不是静默返回空：
 * 用户 `#bym 人设 抄错的名字` 之后如果毫无反馈，会以为切换成功了，
 * 然后困惑于「为什么群里说话没变」。
 */
export function getGroupPreset (groupId) {
  const map = config.speaking.groupPresets
  if (!groupId || !map || typeof map !== 'object') return null
  const id = map[String(groupId)]
  if (!id) return null
  const preset = getPreset(id)
  if (!preset) {
    const key = `${groupId}:${id}`
    if (!warnedMissingPreset.has(key)) {
      warnedMissingPreset.add(key)
      globalThis.logger?.warn?.(`[bym] 群 ${groupId} 绑定的人设「${id}」不存在（文件缺失或 enabled: false），已退回默认人设。修好之前不再重复提示`)
    }
    return null
  }
  warnedMissingPreset.delete(`${groupId}:${id}`)
  return preset
}

/**
 * 写群级人设绑定。
 *
 * 刻意整段替换而不是 `config.set('speaking.groupPresets.123456', ...)`：
 * 群号作为路径片段会被 `.` 切错（虽然 QQ 群号是纯数字，但这个函数也会被
 * 指令层用任意字符串调用）。整段读改写只多一次对象拷贝，没有这类风险。
 *
 * @param {string|number} groupId
 * @param {string|null} presetId 传 null / 'off' / 空 表示解绑
 * @returns {{ok: boolean, id?: string, reason?: string}}
 */
export function setGroupPreset (groupId, presetId) {
  const key = String(groupId || '').trim()
  if (!key) return { ok: false, reason: '缺少群号' }

  const map = { ...(config.speaking.groupPresets || {}) }
  const target = String(presetId || '').trim()

  if (!target || target.toLowerCase() === 'off' || target === '取消') {
    delete map[key]
    if (config.set('speaking.groupPresets', map) === false) {
      return { ok: false, reason: '配置写入失败（配置文件处于只读保护模式，见日志）' }
    }
    return { ok: true, id: null }
  }

  if (!getPreset(target)) {
    return { ok: false, reason: `人设「${target}」不存在` }
  }

  map[key] = target
  // set 会在只读保护模式下拒绝写盘并返回 false
  if (config.set('speaking.groupPresets', map) === false) {
    return { ok: false, reason: '配置写入失败（配置文件处于只读保护模式，说明上次解析失败过，见日志）' }
  }
  return { ok: true, id: target }
}

/**
 * 解析出本次要用人设。优先级：
 *
 *   群绑定 > 关键词规则 > 默认 ID > 兜底内置人设
 *
 * 最后一个兜底很重要：预设目录被清空时插件不该哑掉。
 */
export function resolvePreset (text, groupId) {
  const byGroup = getGroupPreset(groupId)
  if (byGroup) return byGroup

  const byKeyword = pickPresetByKeywords(text, config.speaking.presetMap)
  if (byKeyword) return byKeyword

  const byId = getPreset(config.speaking.defaultPresetId)
  if (byId) return byId

  return {
    id: 'builtin',
    name: '内置默认',
    system: FALLBACK_SYSTEM,
    enabled: true,
    groupAware: true,
  }
}

const FALLBACK_SYSTEM = `你是一个 QQ 群里的普通群友，不是客服也不是助手。
说话口语化、简短，一般不超过两句话，允许有语气词。
除非被明确问到，否则不要提供结构化列表、不要总结、不要解释自己在做什么。
不要暴露你是 AI 或机器人。`
