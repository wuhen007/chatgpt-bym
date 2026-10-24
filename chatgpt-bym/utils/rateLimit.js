import { config } from '../config/config.js'

/**
 * 发言频率与冷却。
 *
 * 伪人是“偶然插话”，不是“有问必答”。没有这层限制时，
 * 一条命中的关键词就能把机器人变成刷屏机。
 */

const HOUR = 3600 * 1000

/** @type {Map<string, {lastAt: number, stamps: number[]}>} */
const state = new Map()

function bucket (groupId) {
  const key = String(groupId)
  if (!state.has(key)) state.set(key, { lastAt: 0, stamps: [] })
  return state.get(key)
}

function prune (entry, now) {
  const cutoff = now - HOUR
  while (entry.stamps.length > 0 && entry.stamps[0] < cutoff) entry.stamps.shift()
}

/**
 * @param {string} groupId
 * @param {{bypassCooldown?: boolean}} [options] 关键词命中时是否无视冷却
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
  if (maxPerHour > 0 && entry.stamps.length >= maxPerHour) {
    const retryAfterMs = entry.stamps[0] + HOUR - now
    return { ok: false, reason: `本群每小时上限 ${maxPerHour} 次已用完`, retryAfterMs }
  }

  return { ok: true, reason: null, retryAfterMs: 0 }
}

export function markSpoken (groupId) {
  const entry = bucket(groupId)
  const now = Date.now()
  entry.lastAt = now
  entry.stamps.push(now)
  prune(entry, now)
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
    inLastHour: entry.stamps.length,
    maxPerHour: Number(config.trigger.maxPerHour) || 0,
    cooldownSeconds: Number(config.trigger.cooldownSeconds) || 0,
  }
}
