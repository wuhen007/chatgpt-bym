import { config } from '../config/config.js'
import { fetchImages } from './image.js'

/**
 * QQ 事件与内部消息格式之间的转换。
 *
 * 内部消息就用 OpenAI 的 content 数组格式（{type:'text'} / {type:'image_url'}），
 * 省掉一层中间表示：发给模型的东西和拼接出来的东西是同一份结构。
 */

/** 从 OneBot / icqq 的 elem 里挖出图片地址，两个分支字段名不一样 */
function pickImageUrl (elem) {
  if (!elem) return ''
  const data = elem.data || {}
  return elem.url || elem.file_url || elem.image_url || elem.src ||
    data.url || data.file_url || data.image_url || data.originUrl || data.origin_url ||
    data.preview || data.thumb || data.bigUrl || data.big_url || data.src || ''
}

/** 只在 message 是数组时可用；TRSS 的 e.message 可能是字符串（CQ 码） */
function messageElements (e) {
  return Array.isArray(e?.message) ? e.message : []
}

/**
 * 事件 -> 纯文本。用于触发词判断、概率命中后的“回复那条消息”场景。
 */
export function messageToText (e) {
  const elements = messageElements(e)
  const parts = []

  for (const elem of elements) {
    switch (elem?.type) {
      case 'text':
        parts.push(elem.text || '')
        break
      case 'at': {
        // 机器人被 @ 时不把 @ 本身写进文本，避免模型以为自己被点名提问。
        // TRSS/icqq 会把消息段摊平成 { type, qq }，原始 OneBot 报文中则是 { data: { qq } }，两种都认。
        const qq = String(elem.qq ?? elem.data?.qq ?? '')
        if (qq === String(e?.self_id || e?.bot?.uin || '')) break
        parts.push(`@${elem.text || qq}`)
        break
      }
      case 'image':
      case 'mface':
        // 图片单独走多模态通道，文本里只留占位
        parts.push('[图片]')
        break
      case 'face':
        parts.push(`[${elem.text || '表情'}]`)
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push(`[文件 ${elem.name || ''}]`)
        break
      case 'reply':
        break
      default:
        if (elem?.text) parts.push(elem.text)
    }
  }

  let text = parts.join('').trim()
  if (!text && typeof e?.raw_message === 'string') {
    // 兜底：从 CQ 码里剥出可读文本
    text = e.raw_message
      .replace(/\[CQ:[a-z]+(?:,[^\]]*)?\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return text
}

/** 当前消息里的图片地址 */
export function collectImageUrls (e) {
  return messageElements(e)
    .filter(elem => elem?.type === 'image' || elem?.type === 'mface')
    .map(pickImageUrl)
    .filter(Boolean)
}

/**
 * 被引用消息里的图片。取引用是异步的，且不同框架 API 不同，这里统一兜一次。
 */
export async function collectQuotedImageUrls (e) {
  if (!e?.source && !e?.reply_id) return []
  try {
    let quoted = null
    if (typeof e.getReply === 'function') {
      quoted = await e.getReply()
    } else if (e.isGroup && e.group?.getChatHistory) {
      const seq = e.source?.seq || e.reply_id
      quoted = (await e.group.getChatHistory(seq, 1)).pop()
    }
    const elements = Array.isArray(quoted?.message) ? quoted.message : []
    return elements
      .filter(elem => elem?.type === 'image' || elem?.type === 'mface')
      .map(pickImageUrl)
      .filter(Boolean)
  } catch (err) {
    globalThis.logger?.debug?.(`[bym][message] 获取引用消息失败：${err.message}`)
    return []
  }
}

/**
 * 组装本轮用户消息的 content。
 * 关掉 vision 或没有图片时，退化成纯字符串，兼容不支持 content 数组的接口。
 *
 * @param {string} text
 * @param {string[]} imageUrls
 * @returns {Promise<string|Array<object>>}
 */
export async function buildUserContent (text, imageUrls = []) {
  if (!config.vision.enable || imageUrls.length === 0) {
    return text
  }
  const images = await fetchImages(imageUrls)
  if (images.length === 0) return text

  const content = []
  if (text) content.push({ type: 'text', text })
  for (const image of images) {
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  return content
}

/** 取消息段里的 QQ 号，兼容摊平格式（TRSS/icqq）与原始 OneBot 的 data 包裹 */
function atTarget (elem) {
  if (elem?.type !== 'at') return ''
  return String(elem.qq ?? elem.data?.qq ?? '')
}

/**
 * 判断这条消息是不是在 @ 别人（而非机器人）。
 * 伪人插话前要避开这种定向对话。
 */
export function isAtOthers (e) {
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  return messageElements(e).some(elem => {
    const qq = atTarget(elem)
    return qq !== '' && qq !== selfId
  })
}

/** 是否 @ 了机器人自己 */
export function isAtBot (e) {
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  if (e?.atBot) return true
  return messageElements(e).some(elem => {
    const qq = atTarget(elem)
    return qq !== '' && qq === selfId
  })
}

/** 取发送者展示名：群名片 > 昵称 > QQ 号 */
export function displayName (e) {
  return e?.sender?.card || e?.sender?.nickname || String(e?.user_id || e?.sender?.user_id || '群友')
}

/** 把纯文本转成可发送的消息段。含 URL 图片时仍按文本发，避免被当成外链卡片。 */
export function textToSegments (text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}
