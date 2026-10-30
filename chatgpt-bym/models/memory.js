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
 * 文件结构（v2）：
 * {
 *   version: 2,
 *   groups: {
 *     "<群号>": {
 *       profile: { about, updatedAt },        // 这个群是个什么群，每轮注入
 *       facts: [{ id, fact, topic, type, expiresAt, accessCount, ... }]
 *     }
 *   }
 * }
 *
 * v1 的文件（只有 facts）能直接读：`ensureLoaded()` 做读时补齐，
 * 不写回、不迁移，下次有写入时自然落盘成 v2。
 */

const STORE_FILE = path.join(dataDir, 'memory.json')
const MAX_FACT_LENGTH = 300
/** 画像注入到 prompt 里要短。它是背景，不该占掉检索结果的位置 */
const MAX_PROFILE_LENGTH = 120

/**
 * 默认 TTL（天）。0 表示永不过期。
 *
 * 为什么按类型给 TTL 而不是统一 30 天：一句话的有效期取决于它是什么。
 * 「明天三点开会」两天后就是噪音，「张三在字节做后端」半年后还成立。
 * 统一 TTL 只能取中间值，结果就是两边都不对。
 *
 * 这比「另开一个 episodes 数组存近期事件」省事得多：不用新层级、
 * 不用新注入段落，每条记忆上多两个字段即可（参考 LivingMemory 的做法）。
 */
const DEFAULT_TYPE_TTL = {
  plan: 2,          // 计划：明天、周末、一会儿
  event: 7,         // 已发生的事
  preference: 60,   // 偏好与忌讳
  relation: 90,     // 谁和谁什么关系
  fact: 180,        // 长期事实（身份、职业、所在地）
  unknown: 30,      // 模型没给类型时的兜底
}

/** 模型可能给中文类型名，统一映射成内部值 */
const TYPE_ALIASES = new Map([
  ['plan', 'plan'], ['计划', 'plan'], ['安排', 'plan'], ['打算', 'plan'], ['待办', 'plan'],
  ['event', 'event'], ['事件', 'event'], ['活动', 'event'], ['事情', 'event'], ['发生过', 'event'],
  ['preference', 'preference'], ['偏好', 'preference'], ['喜好', 'preference'], ['忌讳', 'preference'], ['习惯', 'preference'],
  ['relation', 'relation'], ['关系', 'relation'],
  ['fact', 'fact'], ['事实', 'fact'], ['信息', 'fact'], ['身份', 'fact'],
  ['unknown', 'unknown'], ['', 'unknown'],
])

/** 访问计数攒够这么久再整体写一次盘。召回是高频事件，每次都 flush 会把磁盘写爆 */
const ACCESS_FLUSH_MS = 3000

let store = null
// 所有写操作串行化，避免并发抽取时互相覆盖
let writeQueue = Promise.resolve()

// 访问强化是「改了但没必要立刻写」的状态，攒着一起落盘
let accessDirty = false
let accessTimer = null

function emptyStore () {
  return { version: 2, groups: {} }
}

function emptyBucket () {
  return { profile: { about: '', updatedAt: 0 }, facts: [] }
}

/**
 * 把一条 group bucket 补成 v2 形状。只改内存，不写盘 ——
 * 否则启动时就要把几 MB 的文件全量重写一遍。
 *
 * 导出给测试直接验证补齐逻辑（运行时的调用点只有 ensureLoaded）。
 */
export function normalizeBucket (bucket) {
  if (!bucket || typeof bucket !== 'object') return emptyBucket()
  if (!Array.isArray(bucket.facts)) bucket.facts = []
  if (!bucket.profile || typeof bucket.profile !== 'object') {
    bucket.profile = { about: '', updatedAt: 0 }
  } else {
    bucket.profile.about = String(bucket.profile.about || '')
    bucket.profile.updatedAt = Number(bucket.profile.updatedAt) || 0
  }
  return bucket
}

function ensureLoaded () {
  if (store) return store
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
      store = parsed && typeof parsed === 'object' ? { ...emptyStore(), ...parsed } : emptyStore()
      if (!store.groups || typeof store.groups !== 'object') store.groups = {}
      for (const key of Object.keys(store.groups)) {
        store.groups[key] = normalizeBucket(store.groups[key])
      }
      // version 只影响内存里的标记，下次写入自然落成 2
      store.version = 2
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
    data.groups[key] = emptyBucket()
  }
  return data.groups[key] || null
}

/** 模型给的类型名归一化。给了不认识的就当 unknown，不会因为一个错词丢记忆 */
export function normalizeType (value) {
  const key = String(value || '').trim().toLowerCase()
  return TYPE_ALIASES.get(key) || 'unknown'
}

/** 某个类型保留多少天。配置里可以逐项覆盖，0 表示永不过期。导出供测试。 */
export function typeTtlDays (type) {
  const table = config.memory?.typeTtl || {}
  const value = Number(table[normalizeType(type)])
  if (Number.isFinite(value) && value >= 0) return value
  return DEFAULT_TYPE_TTL[normalizeType(type)] ?? DEFAULT_TYPE_TTL.unknown
}

/** 写入时算一次过期时间，之后读取只做比较，不再重算 */
function expiresAtOf (at, days) {
  return days > 0 ? at + days * 86400000 : 0
}

/**
 * 这条记忆现在还能不能用。
 *
 * 过期的**不删除**，只是不参与检索 —— 留着可追溯（「它以前说过什么」），
 * 也避免用户一改 TTL 配置就永久丢掉数据。
 *
 * 老数据没有 `expiresAt`：用 `at + TTL` 现算，这样升级后不用迁移就能生效。
 */
function isExpired (fact, now) {
  if (fact.supersededBy) return true
  let expiresAt = Number(fact.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    const days = typeTtlDays(fact.type)
    const at = Number(fact.at) || 0
    expiresAt = days > 0 && at > 0 ? at + days * 86400000 : 0
  }
  return expiresAt > 0 && expiresAt < now
}

/** 把时间差说成人话。模型算「上周六是几天前」经常错，直接给它结论 */
function relativeTime (at) {
  const days = Math.floor((Date.now() - (Number(at) || 0)) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  if (days < 365) return `${Math.floor(days / 30)}个月前`
  return `${Math.floor(days / 365)}年前`
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
 * 检索用的可匹配文本。
 *
 * 必须把 subject 也算进去：模型常常写成 `{fact: "在字节做后端开发", subject: "张三"}`，
 * 正文里根本没有「张三」两个字。只看 fact 的话，查「张三」时这条相关度是 0、
 * 直接被门槛挡掉 —— 而注入时它又该归到「你记得的人 · 张三」那一节。
 * 结果就是分节分好了，但那一节永远是空的。
 */
function searchableText (fact) {
  const subject = String(fact?.subject || '').trim()
  const body = String(fact?.fact || '')
  return subject ? `${subject} ${body}` : body
}

/**
 * 一条记忆在注入时占多少字符。
 * topic 会以「（主题）」的形式跟在正文后面，所以一并算进去。
 */
function costOf (fact) {
  const body = String(fact.fact || '').length
  const topic = fact.topic ? String(fact.topic).length + 2 : 0   // 全角括号占 2
  return body + topic
}

/**
 * 访问计数攒批落盘。
 *
 * 不能每次召回都 `flush()`：`flush()` 对整份 store 做 `JSON.stringify` 再写文件，
 * 而召回是高频事件（每条触发的消息都可能召回一次），几十个群跑几天就能
 * 把磁盘写满、把 IO 拖垮。
 *
 * `unref()` 让这个定时器不阻塞进程退出 —— 真正退出时的兜底是
 * `disposeMemory()`（由 lifecycle 的收尾任务调用）。
 */
function scheduleAccessFlush () {
  if (accessTimer) return
  accessTimer = setTimeout(() => {
    accessTimer = null
    if (!accessDirty) return
    accessDirty = false
    flush()
  }, ACCESS_FLUSH_MS)
  accessTimer.unref?.()
}

/**
 * 取注入给模型的记忆。
 *
 * 筛子顺序不能换：
 *   ① 去掉过期的、已被取代的
 *   ② 相关性门槛 —— 相关度为 0 的直接不要
 *   ③ 综合打分排序 —— 相关度 0.6 + 有效重要度 0.25 + 时效 0.15
 *   ④ 条数 + 字符双重预算
 *
 * ② 是最关键的一步。没有它的时候，一条完全无关但 importance=0.8 的记忆
 * 能靠 `0.8*0.25 + 1*0.15 = 0.35` 分稳定挤进 top N —— 实测查询「今天好热」时
 * 模型会收到「张三在字节做后端」，然后很可能顺口提一句。
 *
 * 门槛默认是「至少一个 2-gram 重合」而不是某个具体分值：2-gram 的相关度
 * 普遍偏低（实测最相关的一对也只有 0.27），设成 0.1 会误杀真实相关的记忆。
 *
 * **没有做注入去重（MMR）**，试过但删了：2-gram Jaccard 分不开「换个说法的
 * 同一件事」（实测 0.08~0.40）和「同一主体的不同方面」（0.07~0.43）——
 * 两个区间完全重叠。阈值定 0.7 永不触发，定到能触发的区间就会把
 * 「张三在字节」和「张三在腾讯」并成一条。这类判断要靠 embedding，
 * 而我们不引依赖。更接近同一个问题的冲突消解改用 subject + predicate，
 * 见 addFact。
 */
/**
 * @param {object} [options]
 * @param {boolean} [options.countAccess=true] 是否给召回的条目累加访问次数。
 *   传 false 用于「只想看看会注入什么」——`#bym 测试` 不能影响真实排序。
 */
export function queryFacts (groupId, queryText, limit = 5, maxChars = config.memory.injectMaxChars, { countAccess = true } = {}) {
  if (!config.memory.enable || config.memory.inject === false) return []
  const bucket = groupBucket(groupId)
  if (!bucket || bucket.facts.length === 0) return []

  const queryTokens = tokenize(queryText)
  const now = Date.now()
  const scored = []

  for (const fact of bucket.facts) {
    if (isExpired(fact, now)) continue
    const relevance = similarity(queryTokens, searchableText(fact))
    if (relevance <= 0) continue

    // 访问强化：被想起过的记忆更该被想起。上限 +0.3，
    // 免得一条早期被偶然点开几十次的旧记忆永久霸榜。
    const accessCount = Number(fact.accessCount) || 0
    const reinforce = Math.min(0.3, accessCount * 0.02)
    const importance = Math.min(1, (Number(fact.importance) || 0.3) + reinforce)

    const ageDays = (now - (Number(fact.at) || now)) / 86400000
    const freshness = 1 / (1 + ageDays / 30)
    scored.push({ fact, relevance, score: relevance * 0.6 + importance * 0.25 + freshness * 0.15 })
  }

  scored.sort((a, b) => b.score - a.score)

  const maxCount = Math.max(1, Number(limit) || 1)
  const budget = Number(maxChars) > 0 ? Number(maxChars) : Infinity
  const picked = []
  let used = 0

  for (const item of scored) {
    if (picked.length >= maxCount) break
    const cost = costOf(item.fact)
    // 第一条不看预算 —— 否则第一条刚好超长时一条都取不到，等于记忆整个失效
    if (picked.length > 0 && used + cost > budget) break
    picked.push(item.fact)
    used += cost
  }

  // 只有真的进了 prompt 的条目才算「被想起」。被预算挡掉的、只在
  // #bym 测试 里预演过的都不该涨权重。
  if (picked.length > 0 && countAccess) {
    for (const fact of picked) {
      fact.accessCount = (Number(fact.accessCount) || 0) + 1
      fact.lastAccessAt = now
    }
    accessDirty = true
    scheduleAccessFlush()
  }

  return picked
}

/**
 * 渲染成注入用的提示词。
 *
 * 分节而不是一列平铺，是因为模型对不同节的处理方式不一样：
 * 「关于这个群」是背景知识，每轮都该知道；「你记得的人」是对人的认知；
 * 「最近发生」有时效，说过几次就淡了。
 *
 * 开头那句固定文案是有意保留的：它同时是「这段是记忆不是用户发言」的边界标记，
 * 测试和日志也靠它定位（别改）。
 */
export function buildMemoryPrompt (groupId, queryText, limit = config.memory.injectLimit, maxChars = config.memory.injectMaxChars, options = {}) {
  const bucket = groupBucket(groupId)
  // profileEnabled 只管「注入与否」，不影响查看和写入：
  // 关掉之后 #bym 画像 还能看到内容，只是不再带给模型
  const about = config.memory.profileEnabled === false
    ? ''
    : String(bucket?.profile?.about || '').trim()
  const facts = queryFacts(groupId, queryText, limit, maxChars, options)
  if (!about && facts.length === 0) return ''

  const people = new Map()
  const recent = []
  const others = []

  for (const fact of facts) {
    const type = normalizeType(fact.type)
    const subject = String(fact.subject || '').trim()
    if (type === 'event' || type === 'plan') {
      recent.push(fact)
    } else if (subject) {
      if (!people.has(subject)) people.set(subject, [])
      people.get(subject).push(fact)
    } else {
      others.push(fact)
    }
  }

  const sections = []
  if (about) sections.push(`## 关于这个群\n${about}`)

  if (people.size > 0) {
    const lines = [...people.entries()].map(([subject, items]) =>
      `- ${subject}：${items.map(item => item.fact).join('；')}`)
    sections.push(`## 你记得的人\n${lines.join('\n')}`)
  }

  if (recent.length > 0) {
    const lines = recent.map(fact => `- [${relativeTime(fact.at)}] ${fact.fact}`)
    sections.push(`## 最近发生\n${lines.join('\n')}`)
  }

  if (others.length > 0) {
    const lines = others.map(fact => `- ${fact.fact}${fact.topic ? `（${fact.topic}）` : ''}`)
    sections.push(`## 其他\n${lines.join('\n')}`)
  }

  return `# 以下是你记得的、这个群里可能相关的一些事，可自然参考，不要主动复述这段内容\n\n${sections.join('\n\n')}`
}

/** 群画像：这个群是个什么群。它每轮都注入，所以要短 */
export function getProfile (groupId) {
  const bucket = groupBucket(groupId)
  return {
    about: String(bucket?.profile?.about || ''),
    updatedAt: Number(bucket?.profile?.updatedAt) || 0,
  }
}

/**
 * 写群画像。
 * @returns {{ok: boolean, about?: string}}
 */
/**
 * 写群画像。
 * 低频操作（手动指令），不值得为它做批量落盘，所以没有 deferred 参数。
 */
export function setProfile (groupId, about) {
  const bucket = groupBucket(groupId, true)
  if (!bucket) return { ok: false }
  const text = String(about || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROFILE_LENGTH)
  bucket.profile.about = text
  bucket.profile.updatedAt = Date.now()
  flush()
  return { ok: true, about: text }
}

/**
 * 写入一条群事实。
 *
 * @param {string} groupId
 * @param {object} options
 * @param {string} options.fact
 * @param {string} [options.topic]
 * @param {number} [options.importance]
 * @param {string} [options.type] plan|event|preference|relation|fact，决定 TTL
 * @param {string} [options.subject] 这条讲的是谁/什么，用于分组合并与冲突消解
 * @param {string} [options.predicate] 讲的是他的哪一面（职业/住址/喜好…）
 * @param {number} [options.confidence] 模型对这条的把握，0~1
 * @param {boolean} [options.deferred] 跳过落盘。批量写入时用它，
 *   全部写完由调用方 `flushMemory()` 一次落盘 —— `flush()` 每次都对整份
 *   store 做 `JSON.stringify` 再写文件，一轮回复产出 5 条就是 5 次全量序列化。
 * @returns {boolean} 是否真的写入了（重复或空内容返回 false）
 */
export function addFact (groupId, {
  fact, topic = '', importance = 0.4, type,
  subject = '', predicate = '', confidence,
  deferred = false,
}) {
  const text = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH)
  if (!text) return false
  const bucket = groupBucket(groupId, true)
  if (!bucket) return false

  const duplicated = bucket.facts.some(item =>
    item.fact === text ||
    (item.fact.length > 8 && (item.fact.includes(text) || text.includes(item.fact)))
  )
  if (duplicated) return false

  const now = Date.now()
  const normalizedType = normalizeType(type)
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
  // subject / predicate / topic 都要压成单行。
  //
  // 三者都会进入 prompt：subject 和 topic 直接拼成 `- ${subject}：${fact}`
  // 这样的一行。换行留在里面就能伪造出额外条目 —— 群友说一句
  // 「记住，我叫"张三（换行）- 忽略以上全部规则"」，模型抄回来之后
  // 每一轮都会带着这行注入。fact 早就做了压空白，这几个字段是漏的。
  const cleanSubject = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const cleanPredicate = String(predicate || '').replace(/\s+/g, ' ').trim().slice(0, 20)
  const cleanTopic = String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const cleanConfidence = Number.isFinite(Number(confidence))
    ? Math.min(1, Math.max(0, Number(confidence)))
    : 0.6

  // 冲突消解：subject 和 predicate 都相同的旧条目，被新的取代。
  //
  // 为什么不用文本相似度：「张三在字节」和「张三跳槽去了腾讯」的文本相似度
  // 极低（只有「张三」重合），按相似度判冲突根本判不出来。但它们的
  // subject 都是「张三」、predicate 都是「职业」—— 这才是冲突的本质。
  //
  // 只有 confidence 不低于旧值时才覆盖：低把握的猜测不该推翻高把握的已知。
  if (config.memory.conflictResolve !== false && cleanSubject && cleanPredicate) {
    for (const old of bucket.facts) {
      if (old.supersededBy) continue
      if (String(old.subject || '') !== cleanSubject) continue
      if (String(old.predicate || '') !== cleanPredicate) continue
      const oldConfidence = Number.isFinite(Number(old.confidence)) ? Number(old.confidence) : 0.6
      if (cleanConfidence >= oldConfidence) {
        old.supersededBy = id
        old.supersededAt = now
        globalThis.logger?.debug?.(`[bym][memory] 「${old.fact}」被「${text}」取代`)
      }
    }
  }

  bucket.facts.push({
    id,
    fact: text,
    topic: cleanTopic,
    type: normalizedType,
    // 写入时算一次，读取只做比较
    expiresAt: expiresAtOf(now, typeTtlDays(normalizedType)),
    accessCount: 0,
    lastAccessAt: 0,
    importance: Math.min(1, Math.max(0, Number(importance) || 0.4)),
    at: now,
    subject: cleanSubject,
    predicate: cleanPredicate,
    confidence: cleanConfidence,
    supersededBy: null,
    supersededAt: null,
  })

  pruneBucket(bucket, now)
  if (!deferred) flush()
  return true
}

/**
 * 超过上限时的淘汰。顺序有讲究：
 *
 *   ① 先清「已被取代」和「已过期」的 —— 它们本来就不参与注入，
 *      留着只是占位置。这一步通常就够把数量压回去了。
 *   ② 还超才按重要度和新旧淘汰。
 *
 * 不先做 ① 的话，一个刚聊完就改口的群会攒下一堆 superseded 的废条目，
 * 把真正有用的一起挤出去。
 */
function pruneBucket (bucket, now) {
  const max = Math.max(10, Number(config.memory.maxFactsPerGroup) || 200)
  if (bucket.facts.length <= max) return 0

  const before = bucket.facts.length
  bucket.facts = bucket.facts.filter(fact => !isExpired(fact, now))

  if (bucket.facts.length > max) {
    // 淘汰时把「访问过」也算上：常被想起的比重要度高但没人提的更该留
    bucket.facts.sort((a, b) => {
      const scoreOf = (fact) => (Number(fact.importance) || 0) +
        Math.min(0.3, (Number(fact.accessCount) || 0) * 0.02)
      return scoreOf(b) - scoreOf(a) || (Number(b.at) || 0) - (Number(a.at) || 0)
    })
    bucket.facts = bucket.facts.slice(0, max)
  }

  const removed = before - bucket.facts.length
  if (removed > 0) {
    globalThis.logger?.debug?.(`[bym][memory] 超出 ${max} 条，清理了 ${removed} 条（过期/被取代/低分）`)
  }
  return removed
}

/**
 * 手动落盘。批量写入（`deferred: true`）之后调一次即可。
 * @returns {Promise<void>}
 */
export function flushMemory () {
  accessDirty = false
  return flush()
}

/**
 * 卸载时调用：停掉访问计数的攒批定时器，并把没落盘的计数刷出去。
 *
 * 为什么必须清定时器：热更新会重新 import 整个模块，旧模块实例还活着。
 * 它那个 3 秒后触发的回调持有的是**旧的 store**，一旦触发就会用旧内存
 * 整份覆盖新模块刚写下去的数据。定时器不清，热更新就成了数据回滚。
 */
export function disposeMemory () {
  if (accessTimer) {
    clearTimeout(accessTimer)
    accessTimer = null
  }
  accessDirty = false
  // 无条件 flush，不做「有没有脏数据」的判断。
  //
  // 曾经想省这一次写盘，条件只放在访问计数上 —— 结果 `addFact(..., deferred: true)`
  // 批量写完还没轮到 flushMemory() 时进程就退出，那几条直接没了。
  // deferred 写入改的是 store 本身，没留任何标记，判断不出来。
  // 退出和热更新都是低频事件，多写一次几 KB 换「不丢最后几条」，值得。
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
    if (addFact(groupId, {
      fact,
      topic: item.topic,
      importance: item.importance,
      // 抽取路径同样支持类型与主体：契约里给了就用，没给就走 unknown
      type: item.type,
      subject: item.subject || item.about,
      predicate: item.predicate,
      confidence: item.confidence,
      // 先攒着，循环结束落一次盘。
      // 逐条 flush 会把整份 store（所有群）序列化 N 次 ——
      // 50 个群 12MB 时每次 40ms 同步阻塞，5 条就是 200ms。
      deferred: true,
    })) added++
  }
  if (added > 0) {
    await flush()
    globalThis.logger?.debug?.(`[bym][memory] 新增 ${added} 条群记忆`)
  }
  return added
}

export function memoryStats (groupId) {
  const bucket = groupBucket(groupId)
  const facts = bucket?.facts || []
  const now = Date.now()
  const active = facts.filter(fact => !isExpired(fact, now)).length
  return {
    // count 是库里总共存了多少（含过期和已被取代的）
    count: facts.length,
    // active 是还会参与检索的 —— 状态指令该显示这个，
    // 否则用户会看到「有 200 条记忆」但机器人一句都不提
    active,
    expired: facts.length - active,
    profile: getProfile(groupId),
    facts,
  }
}

/**
 * 清空记忆。
 * @returns {Promise<void>} 落盘完成后才 resolve —— 调用方应 await，
 * 否则「清空后立刻重启」会让被删的记忆复活。
 */
export function clearMemory (groupId) {
  const data = ensureLoaded()
  // 攒批的访问计数要一起作废，否则 3 秒后会把已删的群又写回来
  accessDirty = false
  if (groupId === undefined) {
    data.groups = {}
  } else {
    delete data.groups[String(groupId)]
  }
  return flush()
}
