import { config } from '../config/config.js'

/**
 * 发言频率与冷却。
 *
 * 伪人是“偶然插话”，不是“有问必答”。没有这层限制时，
 * 一条命中的关键词就能把机器人变成刷屏机。
 *
 * stamps 用 Map<token, 时间戳> 而不是数组，是为了让 `refundSpoken` 能精确退还
 * **自己那一次**。用数组时只能弹最后一个，而同群并发时最后一条可能是别人刚记的：
 * 数量上恰好抵消，但留下的时间戳属于「没说话的人」、删掉的是「说了话的人」，
 * 冷却起点会被算早。低频场景影响很小，但记账错乱是最难查的那类问题。
 */

const HOUR = 3600 * 1000

/** @type {Map<string, {lastAt: number, stamps: Map<string, number>}>} */
const state = new Map()

/** token 只需要在本进程内唯一 */
let seq = 0

function bucket (groupId) {
  const key = String(groupId)
  if (!state.has(key)) state.set(key, { lastAt: 0, stamps: new Map() })
  return state.get(key)
}

function prune (entry, now) {
  const cutoff = now - HOUR
  for (const [token, at] of entry.stamps) {
    if (at < cutoff) entry.stamps.delete(token)
  }
}

/** 把 lastAt 校正为「剩下最新的一条」；表空了就归零 */
function syncLastAt (entry) {
  let latest = 0
  for (const at of entry.stamps.values()) if (at > latest) latest = at
  entry.lastAt = latest
}

/**
 * @param {string} groupId
 * @param {{bypassCooldown?: boolean}} [options] 被点名/关键词命中时是否无视冷却
 * @returns {{ok: boolean, reason: string|null, retryAfterMs: number}}
 */
export function checkRate (groupId, { bypassCooldown = false } = {}) {
  const entry = bucket(groupId)
  const now = Date.now()
  prune(entry, now)

  const cooldownMs = Math.max(0, Number(config.trigger.cooldownSeconds) || 0) * 1000
  if (!bypassCooldown && cooldownMs > 0 && entry.lastAt > 0) {
    const elapsed = now - entry.lastAt
    if (elapsed < cooldownMs) {
      return { ok: false, reason: `冷却中（还需 ${Math.ceil((cooldownMs - elapsed) / 1000)} 秒）`, retryAfterMs: cooldownMs - elapsed }
    }
  }

  const maxPerHour = Math.max(0, Number(config.trigger.maxPerHour) || 0)
  if (maxPerHour > 0 && entry.stamps.size >= maxPerHour) {
    // Map 的迭代顺序就是插入顺序，第一条即最早的那次
    const oldest = entry.stamps.values().next().value ?? now
    const retryAfterMs = oldest + HOUR - now
    return { ok: false, reason: `本群每小时上限 ${maxPerHour} 次已用完`, retryAfterMs }
  }

  return { ok: true, reason: null, retryAfterMs: 0 }
}

/**
 * 记一次发言，返回可用于退款的 token。
 * @returns {string} token
 */
export function markSpoken (groupId) {
  const entry = bucket(groupId)
  const now = Date.now()
  const token = `${now}-${++seq}`
  entry.lastAt = now
  entry.stamps.set(token, now)
  prune(entry, now)
  return token
}

/**
 * 退还一次配额。
 *
 * 只有「已经 markSpoken 但最终没说话」时才该调 —— 目前唯一场景是语义把关判了不接话。
 * 不退的话，被 gate 拒掉的那几条会白白吃掉 maxPerHour，
 * 用户会看到「明明还有额度却一直不说话」，无从排查。
 *
 * @param {string} groupId
 * @param {string} [token] markSpoken 的返回值。不传则退最后一个（容错用）
 */
export function refundSpoken (groupId, token) {
  const entry = bucket(groupId)
  if (entry.stamps.size === 0) return

  if (token !== undefined && token !== null) {
    // 精确退还自己那一次；token 已经被 prune 掉时什么都不做
    if (entry.stamps.delete(token)) syncLastAt(entry)
    return
  }

  const keys = [...entry.stamps.keys()]
  entry.stamps.delete(keys[keys.length - 1])
  syncLastAt(entry)
}

export function resetRate (groupId) {
  if (groupId === undefined) state.clear()
  else state.delete(String(groupId))
}

export function rateStats (groupId) {
  const entry = bucket(groupId)
  prune(entry, Date.now())
  return {
    lastAt: entry.lastAt,
    inLastHour: entry.stamps.size,
    maxPerHour: Number(config.trigger.maxPerHour) || 0,
    cooldownSeconds: Number(config.trigger.cooldownSeconds) || 0,
  }
}
