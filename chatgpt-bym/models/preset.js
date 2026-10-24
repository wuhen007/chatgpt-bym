import fs from 'node:fs'
import path from 'node:path'
// 同 config.js：兼容 js-yaml 4.x(CJS) 与 5.x(纯 ESM)
import * as YAML from 'js-yaml'
import { presetDir, config } from '../config/config.js'

const yaml = YAML.default ?? YAML

/**
 * 预设 = 人设。一个 yaml/json 文件一个预设，文件名即 ID。
 * 字段：name / system / temperature / maxTokens / recallSeconds / enabled
 */

const CACHE_TTL = 5000
let cache = { at: 0, presets: new Map() }

function parseFile (filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const data = filePath.endsWith('.json') ? JSON.parse(raw) : (yaml.load(raw) || {})
  if (!data || typeof data !== 'object') return null
  return data
}

function normalize (id, data) {
  const system = String(data.system || data.prompt || '').trim()
  return {
    id,
    name: String(data.name || id),
    system,
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
 * 解析出本次要用人设：关键词规则 > 配置默认 > 兜底内置人设。
 * 最后一个兜底很重要：预设目录被清空时插件不该哑掉。
 */
export function resolvePreset (text) {
  const byKeyword = pickPresetByKeywords(text, config.speaking.presetMap)
  if (byKeyword) return byKeyword

  const byId = getPreset(config.speaking.defaultPresetId)
  if (byId) return byId

  return {
    id: 'builtin',
    name: '内置默认',
    system: FALLBACK_SYSTEM,
    enabled: true,
  }
}

const FALLBACK_SYSTEM = `你是一个 QQ 群里的普通群友，不是客服也不是助手。
说话口语化、简短，一般不超过两句话，允许有语气词。
除非被明确问到，否则不要提供结构化列表、不要总结、不要解释自己在做什么。
不要暴露你是 AI 或机器人。`
