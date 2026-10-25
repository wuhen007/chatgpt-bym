import { config } from '../config/config.js'

/**
 * 触发闸门：决定“这条群消息要不要让伪人接话”。
 *
 * 顺序很重要——先排除成本低的（开关、黑白名单、长度），
 * 再做需要读内容的判断，最后才是概率。概率必须放在最后，
 * 否则 Math.random() 会白白消耗在注定被过滤的消息上（也让命中日志失真）。
 */

export const SKIP = {
  DISABLED: '插件未开启',
  NOT_GROUP: '非群聊消息',
  GROUP_FILTERED: '群不在允许范围',
  EMPTY: '消息为空',
  TOO_SHORT: '消息过短',
  TOO_LONG: '消息过长',
  COMMAND: '指令消息',
  MUTED: '命中屏蔽词',
  AT_OTHERS: '在 @ 别人',
  SELF: '机器人自己发的',
  NO_LUCK: '未命中概率',
}

/** 群白/黑名单 */
export function isGroupAllowed (groupId) {
  const { groupMode, groups } = config.trigger
  const list = (groups || []).map(String)
  if (groupMode === 'all') return true
  if (list.length === 0) return groupMode !== 'whitelist' // 白名单为空时默认全禁，避免误开
  const id = String(groupId)
  return groupMode === 'blacklist' ? !list.includes(id) : list.includes(id)
}

/**
 * 前置过滤，返回跳过原因；通过则返回 null。
 * @param {object} e 云崽事件
 * @param {string} text 已转好的纯文本
 * @param {{addressed?: boolean}} [options] 已经算过「是否 @ 了机器人」时传进来，省一次扫描
 */
export function precheck (e, text, options = {}) {
  if (!config.enabled) return SKIP.DISABLED
  if (!e?.isGroup) return SKIP.NOT_GROUP
  if (!isGroupAllowed(e.group_id)) return SKIP.GROUP_FILTERED

  const trigger = config.trigger
  const content = String(text || '').trim()
  if (!content) return SKIP.EMPTY
  if (content.length < Math.max(1, Number(trigger.minLength) || 1)) return SKIP.TOO_SHORT
  if (content.length > Math.max(1, Number(trigger.maxLength) || 200)) return SKIP.TOO_LONG

  const prefixes = trigger.ignoreCommandPrefixes || []
  if (prefixes.some(prefix => prefix && content.startsWith(prefix))) return SKIP.COMMAND

  const mute = trigger.muteKeywords || []
  if (mute.some(word => word && content.includes(word))) return SKIP.MUTED

  const selfId = String(e?.self_id || e?.bot?.uin || '')
  const senderId = String(e?.user_id || e?.sender?.user_id || '')
  if (selfId && senderId === selfId) return SKIP.SELF

  // 用原始消息段判断而不是正则扫文本：@ 后面跟的东西不一定是昵称，
  // 正则会被“邮箱是 a@b.com”这类内容误伤。
  //
  // 被点名时不受 ignoreAtOthers 限制：一句话同时 @ 了我和别人，
  // 说明确实在叫我，让给「@ 别人就不插话」挡掉就成了装死。
  if (trigger.ignoreAtOthers) {
    const addressed = options.addressed ?? isAddressed(e)
    if (!addressed && hasAtOthers(e)) return SKIP.AT_OTHERS
  }

  return null
}

/**
 * 这条消息是不是在跟机器人说话（@ 了它，或者回复了它的消息）。
 *
 * 只认消息段，不用正则扫文本 —— 文本里的 "@" 可能是邮箱。
 * 三种来源都要认：
 * - `e.atBot`：部分分支直接给的布尔（TRSS 有）
 * - 摊平格式：TRSS/icqq 把 `data` 摊平了，读 `elem.qq`
 * - 原始 OneBot：读 `elem.data.qq`
 */
export function isAddressed (e) {
  if (e?.atBot === true) return true
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  if (!selfId || !Array.isArray(e?.message)) return false
  return e.message.some(elem => {
    if (elem?.type !== 'at') return false
    return String(elem.qq ?? elem.data?.qq ?? '') === selfId
  })
}

function hasAtOthers (e) {
  const selfId = String(e?.self_id || e?.bot?.uin || '')
  if (!Array.isArray(e?.message)) return false
  return e.message.some(elem => {
    if (elem?.type !== 'at') return false
    // 摊平格式（TRSS/icqq）与原始 OneBot 的 data 包裹都要认
    const qq = String(elem.qq ?? elem.data?.qq ?? '')
    return qq !== '' && qq !== selfId
  })
}

/**
 * 判断是否被关键词强制命中。
 * 关键词不做大小写敏感匹配：群里打字很少有人规规矩矩。
 */
export function matchKeyword (text) {
  const words = config.trigger.hitKeywords || []
  const content = String(text || '').toLowerCase()
  return words.some(word => word && content.includes(String(word).toLowerCase()))
}

/**
 * 完整判定。概率在这里只掷一次骰子，
 * 调用方拿到 forced 后仍需过冷却（除非显式配置允许绕过）。
 *
 * 三档优先级：被点名 > 命中关键词 > 概率。
 * 「被点名」单独标出来（`addressed`）是因为它的冷却策略和关键词不同：
 * 名字都叫了还不理，比「偶尔插错话」难解释得多。
 *
 * @returns {{pass: boolean, forced: boolean, addressed: boolean, reason: string|null, dice: number}}
 */
export function evaluate (e, text) {
  // 只扫一次消息段：precheck 和下面的「被点名」判断共用这个结果
  const addressed = isAddressed(e)
  const skipped = precheck(e, text, { addressed })
  if (skipped) return { pass: false, forced: false, addressed: false, reason: skipped, dice: 0 }

  // 被 @ 时必回。关掉这个开关的话，@ 会退回「走关键词/概率」的正常路径，
  // 而不是直接不回答 —— 否则一关就等于「叫它也不应」。
  if (addressed && config.trigger.replyWhenAddressed !== false) {
    return { pass: true, forced: true, addressed: true, reason: null, dice: 0 }
  }

  const forced = matchKeyword(text)
  if (forced) return { pass: true, forced: true, addressed: false, reason: null, dice: 0 }

  const probability = Math.min(1, Math.max(0, Number(config.trigger.probability) || 0))
  const dice = Math.random()
  if (dice >= probability) {
    return { pass: false, forced: false, addressed: false, reason: SKIP.NO_LUCK, dice }
  }
  return { pass: true, forced: false, addressed: false, reason: null, dice }
}
