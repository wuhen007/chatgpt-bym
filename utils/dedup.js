/**
 * 入口去重与回声守卫。
 *
 * 云崽自己有 1 秒的 msgThrottle，但那只按时间，且不同分支行为不一致，
 * 而且它拦不住下面三种情况：
 *
 * 1. **id 重复**：协议端重连、多适配器并存时，同一条消息可能被投递两次，
 *    message_id 相同。不挡就是同一句话被回两遍。
 * 2. **内容重复**：更隐蔽 —— 同一条消息被重投时 message_id 可能不同，
 *    靠 id 完全兜不住。所以还要按「群 + 人 + 原文」比对。
 * 3. **回声**：QQ 客户端有时会把机器人自己刚发的消息当成新消息推回来。
 *    这个不挡就是「我一直在回我自己」的死循环，而且会不断自我强化 ——
 *    每轮回一句新的，新的话又被当成输入，停不下来。
 *
 * 三种都用短 TTL + 硬上限，长跑不会涨内存。
 */

/** 同一条 message_id 的窗口。协议端重投一般在一两秒内，给 60 秒很宽裕 */
const ID_TTL = 60_000
/** 同人同话的窗口。太短挡不住慢重投，太长会误伤"复读"玩梗的群友 */
const CONTENT_TTL = 45_000
/** 自己说过的话的回声窗口。必须比"发送 + 协议端回环"长得多 */
const ECHO_TTL = 90_000
/** 每张表的硬上限，防止被异常流量刷爆内存 */
const MAX_ENTRIES = 600

const seenId = new Map()
const seenContent = new Map()
const selfEcho = new Map()

const now = () => Date.now()

/** 插入顺序即时间顺序，删前面的就是删最老的 */
function sweep (map, ttl) {
  if (map.size === 0) return
  const ts = now()
  // 用 continue 而不是 break：同一个 key 被重新 set 过之后位置不变、时间变新，
  // 单调性被破坏，break 会把后面本该清掉的留在表里。表最多几百条，全扫无所谓。
  for (const [key, at] of map) {
    if (ts - at > ttl) map.delete(key)
  }
  // 硬上限兜底：TTL 之内也可能塞满（比如短时间大量刷屏）
  // 用 >= 而不是 >：调用方都是「先 sweep 再 set」，留一格余量才不会稳定在 601
  while (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/** 取消息的唯一标识。TRSS 给 message_id，部分分支只有 seq。 */
function idOf (e) {
  const id = e?.message_id ?? e?.messageId ?? e?.seq ?? e?.message_seq
  return id === undefined || id === null || id === '' ? '' : String(id)
}

function scopeOf (e) {
  return String(e?.group_id ?? e?.group?.group_id ?? 'priv')
}

function contentKeyOf (e, text) {
  const user = String(e?.user_id ?? e?.sender?.user_id ?? 'anon')
  return `${scopeOf(e)}|${user}|${String(text || '').trim()}`
}

/**
 * 回声的键。必须带上群号：机器人只在配置的群里说话，但「它说过的话」
 * 如果不带群号，A 群说过的一句话会把 B 群群友发的同样文本也当回声挡掉，
 * 表现是「那个群怎么不理我」，没有任何日志线索。
 */
function echoKeyOf (e, plain) {
  return `${scopeOf(e)}|${plain}`
}

/**
 * 检查这条消息是否该丢弃。
 *
 * @param {object} e 云崽事件
 * @param {string} text 已转成文本的消息内容
 * @returns {{dup: 'id'|'content'|'echo'|null}}
 */
export function checkIncoming (e, text) {
  const ts = now()
  const plain = String(text || '').trim()

  // ① id 去重（最便宜，先做）
  const id = idOf(e)
  if (id) {
    sweep(seenId, ID_TTL)
    if (seenId.has(id)) return { dup: 'id' }
    seenId.set(id, ts)
  }

  if (!plain) return { dup: null }

  // ② 回声守卫。必须排在内容去重之前 —— 回声会被重投多次，
  // 排在后面的话第二次就变成「content」，日志里看不出是自己的话绕回来了。
  sweep(selfEcho, ECHO_TTL)
  const echoKey = echoKeyOf(e, plain)
  if (selfEcho.has(echoKey)) return { dup: 'echo' }

  // ③ 内容去重
  sweep(seenContent, CONTENT_TTL)
  const ckey = contentKeyOf(e, plain)
  if (seenContent.has(ckey)) return { dup: 'content' }
  seenContent.set(ckey, ts)

  return { dup: null }
}

/**
 * 记下自己发出去的话，供回声守卫比对。
 * 由 sendHumanized 在每段发送成功后调用 —— 分段发的时候每段都要记，
 * 否则只能挡住最后一段的回声。键带群号，见 echoKeyOf。
 * @param {object} e 发送时的事件，用它的群号
 * @param {string} text 发出去的那一段
 */
export function rememberSelf (e, text) {
  const plain = String(text || '').trim()
  if (!plain) return
  sweep(selfEcho, ECHO_TTL)
  selfEcho.set(echoKeyOf(e, plain), now())
}

/** 测试与「清空记忆」用：丢弃全部记录 */
export function resetDedup () {
  seenId.clear()
  seenContent.clear()
  selfEcho.clear()
}

/** 测试用：看当前各表大小 */
export function dedupStats () {
  return { ids: seenId.size, contents: seenContent.size, echoes: selfEcho.size }
}

export { ID_TTL, CONTENT_TTL, ECHO_TTL, MAX_ENTRIES }
