import { config } from '../config/config.js'
import { rememberSelf } from './dedup.js'

/**
 * 拟人化发送。
 *
 * 三件事决定了“像人”还是“像机器人”：
 * 1. 一次只发一小段（真人不会发五百字长文）；
 * 2. 发之前有打字时间，且和字数相关；
 * 3. 多条之间有不定长的停顿。
 */

/**
 * 句末标点。中英文都算。
 * 刻意不含 `~` / `～`：那是语气词（"好~"、"行吧～"），当句末会把一句话切成两条。
 */
const SENTENCE_END = /[。！？!?…；;]/

function splitLongPiece (piece, maxLen) {
  if (piece.length <= maxLen) return [piece]
  const out = []
  let buffer = ''
  for (const char of piece) {
    buffer += char
    if (SENTENCE_END.test(char) && buffer.trim().length > 0) {
      out.push(buffer.trim())
      buffer = ''
    } else if (buffer.length >= maxLen) {
      // 一整句都超过上限时按长度硬切，尽量落在逗号处
      const lastComma = Math.max(buffer.lastIndexOf('，'), buffer.lastIndexOf(','))
      if (lastComma > maxLen * 0.5) {
        out.push(buffer.slice(0, lastComma + 1).trim())
        buffer = buffer.slice(lastComma + 1)
      } else {
        out.push(buffer.trim())
        buffer = ''
      }
    }
  }
  if (buffer.trim()) out.push(buffer.trim())
  return out
}

/**
 * 把模型输出切成若干条要发送的消息。
 * @param {string} text
 * @param {number} maxLen 单条上限
 * @returns {string[]}
 */
export function splitText (text, maxLen = 120) {
  const limit = Math.max(20, Number(maxLen) || 120)
  const raw = String(text || '').trim()
  if (!raw) return []

  const paragraphs = raw.split(/\n+/).map(line => line.trim()).filter(Boolean)
  const segments = []
  let current = ''

  for (const paragraph of paragraphs) {
    for (const piece of splitLongPiece(paragraph, limit)) {
      if (!piece) continue
      // 能并进上一条就并，避免一句一条碎成刷屏
      if (current && current.length + piece.length <= limit) {
        current += piece
      } else {
        if (current) segments.push(current)
        current = piece
      }
    }
  }
  if (current) segments.push(current)

  // 极短尾巴并回上一条（“哈哈”这种单独发反而更像人，所以只合并标点结尾的碎段）
  if (segments.length > 1) {
    const last = segments[segments.length - 1]
    if (last.length <= 2 && /[，,、]$/.test(segments[segments.length - 2])) {
      segments[segments.length - 2] += last
      segments.pop()
    }
  }
  return segments
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 打字延迟：基础值 + 每字耗时，再叠加 0~35% 的抖动 */
export function typingDelayMs (length) {
  const conf = config.speaking.typingDelay || {}
  const min = Math.max(0, Number(conf.minMs) || 0)
  const perChar = Math.max(0, Number(conf.perCharMs) || 0)
  const max = Math.max(min, Number(conf.maxMs) || min)
  const base = clamp(min + length * perChar, min, max)
  return Math.round(base * (1 + Math.random() * 0.35))
}

function gapDelayMs () {
  const conf = config.speaking.gapDelay || {}
  const min = Math.max(0, Number(conf.minMs) || 0)
  const max = Math.max(min, Number(conf.maxMs) || min)
  return Math.round(min + Math.random() * (max - min))
}

export function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * 撤回一条消息。优先用返回的 message_id 手动撤，
 * 拿不到就退回 icqq 的 recallMsg 选项（其他分支会忽略该选项，不会报错）。
 */
function scheduleRecall (e, sent, recallSeconds) {
  if (!recallSeconds || recallSeconds <= 0) return
  const messageId = sent?.message_id ?? sent?.data?.message_id ?? sent?.messageId
  const timer = setTimeout(async () => {
    try {
      if (messageId && typeof e.group?.recallMsg === 'function') {
        await e.group.recallMsg(messageId)
      }
    } catch (err) {
      globalThis.logger?.debug?.(`[bym][humanize] 撤回失败：${err.message}`)
    }
  }, recallSeconds * 1000)
  // 定时器不该拖住进程退出
  timer.unref?.()
}

/**
 * 分段发送。
 * @param {object} e 云崽事件
 * @param {string} text 模型输出
 * @param {{recallSeconds?: number}} [options]
 */
export async function sendHumanized (e, text, options = {}) {
  const speaking = config.speaking
  const maxLen = Math.max(20, Number(speaking.maxSegmentLength) || 120)
  const segments = speaking.splitReplies === false
    ? [String(text || '').trim()].filter(Boolean)
    : splitText(text, maxLen)
  if (segments.length === 0) return 0

  const recallSeconds = Number(options.recallSeconds ?? speaking.recallSeconds) || 0
  let sentCount = 0

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (index > 0) await sleep(gapDelayMs())
    await sleep(typingDelayMs(segment.length))
    try {
      // 刻意不使用 e.reply 的 { recallMsg } 选项：
      // TRSS 的实现是「撤回回复 + 撤回触发它的那条用户消息」，
      // 伪人撤回自己的话可以理解，把群友的消息也撤掉就过分了。
      // 这里统一由 scheduleRecall 只撤自己这一条，行为在各分支上一致。
      const sent = await e.reply(segment, false)
      // 记下实际发出去的每一段，供回声守卫比对。
      // 必须逐段记：只记最后一段的话，前面几段的回声照样挡不住。
      rememberSelf(segment)
      scheduleRecall(e, sent, recallSeconds)
      sentCount++
    } catch (err) {
      globalThis.logger?.error?.(`[bym][humanize] 发送失败：${err.message}`)
      break
    }
  }
  return sentCount
}
