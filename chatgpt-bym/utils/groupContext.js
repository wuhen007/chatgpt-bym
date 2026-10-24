import { config } from '../config/config.js'

/**
 * 拉取并渲染群聊上下文。
 *
 * 这一步是伪人“看得懂群里在聊什么”的唯一来源。原项目做得更复杂（快照对齐、
 * 图片 ref、历史入库以命中 prompt cache），独立插件里全部砍掉：
 * 只保留「拉历史 + 渲染成表格」的最小闭环，换取零数据库依赖。
 */

const CACHE_MAX_GROUPS = 32

/** 同群连续触发时复用刚拉到的历史，避免每次两条网络往返 */
const cache = new Map()

function cacheTTLMs () {
  const seconds = Number(config.context.cacheTTL)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return seconds * 1000
}

/** 判断宿主分支：TRSS 用 Bot.bots 管理多账号，Miao 没有 */
function isTrss () {
  try {
    return Boolean(global.Bot?.bots)
  } catch {
    return false
  }
}

/** 北京时间，避免服务器时区是 UTC 时把“凌晨三点”写进提示词 */
export function formatTime (timestamp) {
  let value = typeof timestamp === 'string' ? parseInt(timestamp, 10) : Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return '-'
  if (String(Math.trunc(value)).length <= 10) value *= 1000
  const date = new Date(value + 8 * 3600 * 1000)
  const pad = num => String(num).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/**
 * 一次性替换模板占位符，并对代入值做转义。
 *
 * 转义不是洁癖：群友可以把昵称改成带 `|` 和换行的内容，直接代入就能伪造出
 * 额外的表格行，冒充别人的 QQ 号或群角色。占位符也必须一次扫完，
 * 否则先代入的内容会被后面的替换再扫一遍（模板注入）。
 */
export function renderTemplate (template, values = {}) {
  return String(template ?? '').replace(/\$\{([\w.]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match
    return String(values[key] ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r\n|\r|\n/g, ' ')
  })
}

function chatId (chat) {
  return String(chat?.messageId || chat?.message_id || chat?.seq || chat?.message_seq || '')
}

/**
 * 拉群历史，返回 oldest-first 的数组。
 * @returns {Promise<Array<object>>}
 */
export async function fetchGroupHistory (e, length) {
  const groupId = String(e?.group_id || e?.group?.group_id || '')
  if (!groupId) return []
  const count = Math.max(1, Math.min(200, Number(length) || 20))

  const ttl = cacheTTLMs()
  const key = `${e?.self_id || e?.bot?.uin || ''}:${groupId}:${count}`
  if (ttl > 0) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.chats
  }

  let chats = []
  try {
    const bot = e?.bot || global.Bot
    const group = bot?.pickGroup?.(groupId) || e?.group
    if (!group?.getChatHistory) return []

    if (isTrss()) {
      // TRSS 支持直接取最近 N 条
      chats = await group.getChatHistory(0, count)
      chats = Array.isArray(chats) ? chats : []
    } else {
      // Miao(icqq)：先取最新一条拿 seq，再沿着 seq 往前翻，直到够数。
      //
      // getChatHistory(seq, n) 返回的是 newest-first，且包含 seq 这一条。
      // 所以每批要翻成 oldest-first 后 unshift 到最前面（更早的批次在更前面），
      // 同时按 messageId 去重（批次之间必然有一条重叠）。
      // 之前是 push + 最后整体 reverse，跨两批时顺序会错乱。
      const latest = await group.getChatHistory(0, 1)
      let seq = latest?.[0]?.seq || latest?.[0]?.message_id
      const collected = []
      const seen = new Set()
      let guard = 0
      while (seq && collected.length < count && guard++ < 10) {
        const batch = await group.getChatHistory(seq, Math.min(20, count - collected.length + 1))
        if (!Array.isArray(batch) || batch.length === 0) break

        const olderFirst = [...batch].reverse().filter(item => {
          const id = chatId(item)
          if (!id || seen.has(id)) return false
          seen.add(id)
          return true
        })
        collected.unshift(...olderFirst)

        const oldest = batch[batch.length - 1]
        const oldestSeq = oldest?.seq || oldest?.message_id
        if (!oldestSeq || oldestSeq === seq) break
        seq = oldestSeq
      }
      chats = collected.slice(-count)
    }
  } catch (err) {
    globalThis.logger?.warn?.(`[bym][context] 拉取群历史失败：${err.message}`)
    return []
  }

  // 群名片/头衔这些字段有时只在缓存的群成员信息里
  try {
    const memberCache = (e?.bot || global.Bot)?.gml
    for (const chat of chats) {
      const member = memberCache?.get?.(chat?.sender?.user_id)
      if (member) chat.sender = member
    }
  } catch {
    // 拿不到就用原始 sender，不影响主流程
  }

  if (isTrss()) {
    chats = chats.slice().reverse()
  }

  if (ttl > 0 && chats.length > 0) {
    cache.delete(key)
    cache.set(key, { at: Date.now(), chats })
    while (cache.size > CACHE_MAX_GROUPS) {
      cache.delete(cache.keys().next().value)
    }
  }
  return chats
}

/**
 * 渲染成模型可读的表格文本。
 * @returns {Promise<{header: string, text: string, items: Array<{id: string, text: string, name: string, userId: string, at: number}>}>}
 */
export async function buildGroupContext (e) {
  const ctx = config.context
  if (!ctx.enable) return { header: '', text: '', items: [] }

  const chats = await fetchGroupHistory(e, ctx.length)
  if (chats.length === 0) return { header: '', text: '', items: [] }

  const groupId = String(e?.group_id || e?.group?.group_id || 'unknown')
  const groupName = e?.group?.name || e?.group_name || 'unknown'

  const header = renderTemplate(ctx.header, {
    'group.id': groupId,
    'group.group_id': groupId,
    'group.name': groupName,
  })

  const items = []
  const lines = []
  for (const chat of chats) {
    if (!chat) continue
    const sender = chat.sender || {}
    const id = chatId(chat)
    const raw = String(chat.raw_message || chat.message || '').replace(/\[CQ:[^\]]+\]/gi, ' ').trim()
    const time = formatTime(chat.time)

    const line = renderTemplate(ctx.message, {
      'message.sender.card': sender.card || '-',
      'message.sender.nickname': sender.nickname || '-',
      'message.sender.user_id': sender.user_id || '-',
      'message.sender.role': sender.role || '-',
      'message.time': time,
      'message.messageId': id || '-',
      'message.raw_message': raw || '-',
    })
    lines.push(line)
    items.push({
      id,
      text: raw,
      name: sender.card || sender.nickname || String(sender.user_id || ''),
      userId: String(sender.user_id || ''),
      at: Number(chat.time) || 0,
    })
  }

  if (lines.length === 0) return { header: '', text: '', items: [] }
  return { header, text: [header, ...lines].join('\n'), items }
}

export function clearContextCache () {
  cache.clear()
}
