import fs from 'node:fs'
import path from 'node:path'
import { dataDir, config } from '../config/config.js'
import { chatCompletion } from './llmClient.js'

/**
 * 轻量群记忆。
 *
 * 为什么不用 sqlite / 向量库：原项目的记忆模块依赖 sqlite3 原生模块与 sqlite-vec，
 * 装不上的环境会直接让插件起不来。伪人只需要“记得群里聊过什么”，
 * 用 JSON + 关键词重合度打分已经足够，且零原生依赖、可整文件备份。
 *
 * 文件结构：
 * { version: 1, groups: { "<群号>": { facts: [{ id, fact, topic, importance, at }] } } }
 */

const STORE_FILE = path.join(dataDir, 'memory.json')
const MAX_FACT_LENGTH = 300

let store = null
// 所有写操作串行化，避免并发抽取时互相覆盖
let writeQueue = Promise.resolve()

function emptyStore () {
  return { version: 1, groups: {} }
}

function ensureLoaded () {
  if (store) return store
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      store = parsed && typeof parsed === 'object' ? { ...emptyStore(), ...parsed } : emptyStore()
      if (!store.groups || typeof store.groups !== 'object') store.groups = {}
    } else {
      store = emptyStore()
    }
  } catch (err) {
    globalThis.logger?.error?.(`[bym][memory] 读取失败，使用空记忆：${err.message}`)
    store = emptyStore()
  }
  return store
}

/** 原子写：先写临时文件再 rename，避免进程被杀时留下半截 JSON */
function flush () {
  const snapshot = JSON.stringify(ensureLoaded(), null, 2)
  writeQueue = writeQueue.then(async () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${STORE_FILE}.tmp`
      await fs.promises.writeFile(tmp, snapshot, 'utf8')
      await fs.promises.rename(tmp, STORE_FILE)
    } catch (err) {
      globalThis.logger?.error?.(`[bym][memory] 写入失败：${err.message}`)
    }
  })
  return writeQueue
}

function groupBucket (groupId, create = false) {
  const data = ensureLoaded()
  const key = String(groupId)
  if (!data.groups[key] && create) {
    data.groups[key] = { facts: [] }
  }
  return data.groups[key] || null
}

/**
 * 简易分词：中文按 2-gram，英文/数字按单词。
 * 不引第三方分词库，中文短句的召回已经够用。
 */
export function tokenize (text) {
  const tokens = new Set()
  const source = String(text || '').toLowerCase()
  for (const word of source.match(/[a-z0-9_]{2,}/g) || []) tokens.add(word)
  const cjk = source.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const segment of cjk.split(/\s+/)) {
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.add(segment.slice(i, i + 2))
    }
    if (segment.length === 1) tokens.add(segment)
  }
  return tokens
}

function similarity (queryTokens, fact) {
  if (queryTokens.size === 0) return 0
  const factTokens = tokenize(fact)
  if (factTokens.size === 0) return 0
  let hit = 0
  for (const token of queryTokens) {
    if (factTokens.has(token)) hit++
  }
  return hit / Math.sqrt(queryTokens.size * factTokens.size)
}

/**
 * 取注入给模型的记忆。相关度 + 重要度 + 时间衰减三者加权，
 * 保证“最近聊的”和“最重要的”都能进来。
 */
export function queryFacts (groupId, queryText, limit = 5) {
  if (!config.memory.enable) return []
  const bucket = groupBucket(groupId)
  if (!bucket || bucket.facts.length === 0) return []

  const queryTokens = tokenize(queryText)
  const now = Date.now()
  const scored = bucket.facts.map(fact => {
    const relevance = similarity(queryTokens, fact.fact)
    const importance = Number(fact.importance) || 0.3
    const ageDays = (now - (Number(fact.at) || now)) / 86400000
    const freshness = 1 / (1 + ageDays / 30)
    return { fact, score: relevance * 0.6 + importance * 0.25 + freshness * 0.15 }
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
    .map(item => item.fact)
}

/** 渲染成一段提示词。放不下就靠条数上限控制。 */
export function buildMemoryPrompt (groupId, queryText, limit = config.memory.injectLimit) {
  const facts = queryFacts(groupId, queryText, limit)
  if (facts.length === 0) return ''
  const lines = facts.map(fact => `- ${fact.fact}${fact.topic ? `（${fact.topic}）` : ''}`)
  return `# 以下是你记得的、这个群里可能相关的一些事，可自然参考，不要主动复述这段内容\n${lines.join('\n')}`
}

/** 写入一条事实，做长度截断与近似去重 */
/**
 * 写入一条群事实。
 *
 * @param {string} groupId
 * @param {object} options
 * @param {string} options.fact
 * @param {string} [options.topic]
 * @param {number} [options.importance]
 * @param {boolean} [options.deferred] 跳过落盘。批量写入时用它，
 *   全部写完由调用方 `flushMemory()` 一次落盘 —— `flush()` 每次都对整份
 *   store 做 `JSON.stringify` 再写文件，一轮回复产出 5 条就是 5 次全量序列化。
 * @returns {boolean} 是否真的写入了（重复或空内容返回 false）
 */
export function addFact (groupId, { fact, topic = '', importance = 0.4, deferred = false }) {
  const text = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH)
  if (!text) return false
  const bucket = groupBucket(groupId, true)
  if (!bucket) return false

  const duplicated = bucket.facts.some(item =>
    item.fact === text ||
    (item.fact.length > 8 && (item.fact.includes(text) || text.includes(item.fact)))
  )
  if (duplicated) return false

  bucket.facts.push({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    fact: text,
    topic: String(topic || '').slice(0, 40),
    importance: Math.min(1, Math.max(0, Number(importance) || 0.4)),
    at: Date.now(),
  })

  const max = Math.max(10, Number(config.memory.maxFactsPerGroup) || 200)
  if (bucket.facts.length > max) {
    // 超出上限时淘汰“最不重要且最旧”的，而不是简单丢最早的
    bucket.facts.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0) || b.at - a.at)
    bucket.facts = bucket.facts.slice(0, max)
  }
  if (!deferred) flush()
  return true
}

/**
 * 手动落盘。批量写入（`deferred: true`）之后调一次即可。
 * @returns {Promise<void>}
 */
export function flushMemory () {
  return flush()
}

/** 给抽取用的模型看的历史片段 */
function formatTranscript (lines) {
  return lines
    .map(item => {
      const name = item.name || item.userId || '群友'
      const time = item.time ? `[${item.time}] ` : ''
      return `${time}${name}: ${item.text}`
    })
    .join('\n')
}

function safeParseJSON (text) {
  const cleaned = String(text || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 模型偶尔会多说一句再给数组，退一步用括号切片抢救
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1))
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }
}

/**
 * 从一段群聊记录里抽取记忆。异步调用，失败只打日志不打扰用户。
 * @param {string} groupId
 * @param {Array<{name?: string, userId?: string, text: string, time?: string}>} lines
 */
export async function extractFacts (groupId, lines) {
  if (!config.memory.enable || !config.memory.extract) return 0
  const usable = (lines || []).filter(item => item?.text && String(item.text).trim().length > 1)
  if (usable.length < 6) return 0

  const llm = {
    ...config.llm,
    model: config.memory.extractModel || config.llm.model,
    temperature: 0.2,
    maxTokens: Math.max(512, Number(config.llm.maxTokens) || 300),
    stream: false,
    // 抽取不需要备用渠道反复重试，避免一条消息打爆额度
    fallback: [],
    retries: 1,
  }

  const { text } = await chatCompletion({
    llm,
    messages: [
      { role: 'system', content: config.memory.extractPrompt },
      { role: 'user', content: formatTranscript(usable.slice(-60)) },
    ],
  })

  const items = safeParseJSON(text)
  let added = 0
  for (const item of items) {
    if (!item) continue
    const fact = typeof item === 'string' ? item : (item.fact || item.text || item.value)
    if (!fact) continue
    if (addFact(groupId, { fact, topic: item.topic, importance: item.importance })) added++
  }
  if (added > 0) globalThis.logger?.debug?.(`[bym][memory] 新增 ${added} 条群记忆`)
  return added
}

export function memoryStats (groupId) {
  const bucket = groupBucket(groupId)
  return { count: bucket?.facts.length || 0, facts: bucket?.facts || [] }
}

/**
 * 清空记忆。
 * @returns {Promise<void>} 落盘完成后才 resolve —— 调用方应 await，
 * 否则「清空后立刻重启」会让被删的记忆复活。
 */
export function clearMemory (groupId) {
  const data = ensureLoaded()
  if (groupId === undefined) {
    data.groups = {}
  } else {
    delete data.groups[String(groupId)]
  }
  return flush()
}
