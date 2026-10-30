/**
 * 上下文预算裁剪。
 *
 * 为什么需要：群记录、记忆、本轮消息全塞进一条 user 消息里，长度是三者相加。
 * 平时没事（20 条 × 30 字 ≈ 700 字），但只要用户把 `context.length` 调大、
 * 或者群里开始刷长消息，就会一路涨到把请求撑爆 —— 表现是上游返回 400，
 * 而日志里只有一行 "context length exceeded"，看不出是哪里超的。
 *
 * 裁剪顺序按「丢了最不心疼」排：
 *
 *   ① 记忆   —— 本来就是参考，这一轮不用也能接话
 *   ② 群记录 —— 从最早的开始丢，最近的语境最有用
 *   ③ 本轮消息 —— 只在前两者都丢光了还不够时硬截，并补省略号
 *
 * 人设（system）永不裁。裁掉人设等于换了个机器人，比报错更糟。
 *
 * 图片不在字符预算里：它们由 `vision.maxImages` / `maxImageSize` 控制，
 * 走的是另一个维度（token 而不是字符）。
 */

/** 中文一个字约 1~1.5 token，8000 字对 8k 窗口的模型也留得住输出空间 */
const DEFAULT_MAX_CHARS = 8000
/** 本轮消息至少留这么多，再少就没法接话了 */
const MIN_USER_CHARS = 20

/**
 * @param {object} parts
 * @param {string} parts.system      人设，永不裁
 * @param {string} parts.groupHeader 群记录的表头模板渲染结果，保留
 * @param {string[]} parts.groupLines 群记录的消息行，从前往后丢
 * @param {string} parts.memory      记忆注入文本，最先丢
 * @param {string} parts.userText    本轮消息
 * @param {number} [parts.maxChars]
 * @returns {{groupText: string, memory: string, userText: string, dropped: object, totalChars: number}}
 */
export function fitBudget ({ system = '', groupHeader = '', groupLines = [], memory = '', userText = '', maxChars } = {}) {
  const budget = Math.max(500, Number(maxChars) || DEFAULT_MAX_CHARS)

  let lines = Array.isArray(groupLines) ? groupLines.slice() : []
  let mem = String(memory || '')
  let user = String(userText || '')

  const total = () => String(system).length +
    String(groupHeader || '').length +
    (lines.length ? lines.join('\n').length + 1 : 0) +
    mem.length +
    user.length

  const dropped = { memory: false, groupLines: 0, truncatedUser: false }

  // ① 记忆整段丢。不逐条丢是因为记忆注入本来就只有几条，
  //    逐条丢省不下多少，反而让提示词里出现「前两条有、后三条没」的怪状态。
  if (total() > budget && mem) {
    dropped.memory = true
    mem = ''
  }

  // ② 群记录从最早的开始丢。shift 是 O(n)，但 n 最多几十，而且只在超预算时才进这个循环。
  while (total() > budget && lines.length > 1) {
    lines.shift()
    dropped.groupLines += 1
  }
  // 只剩最后一条也放不下时，连它一起丢 —— 留着一条孤零零的旧消息没什么用
  if (total() > budget && lines.length === 1) {
    lines = []
    dropped.groupLines += 1
  }

  // ③ 还超就只能截本轮消息了。这种情况说明 system + 本轮本身就超预算，
  //    通常是 `context.length` 或者单条消息长度被设得过分离谱。
  if (total() > budget) {
    const overflow = total() - budget
    const keep = Math.max(MIN_USER_CHARS, user.length - overflow - 1)
    if (keep < user.length) {
      user = user.slice(0, keep) + '…'
      dropped.truncatedUser = true
    }
  }

  const groupText = lines.length ? [groupHeader, ...lines].join('\n') : ''

  return {
    groupText,
    memory: mem,
    userText: user,
    dropped,
    totalChars: total(),
  }
}

/** 有没有发生裁剪，用于决定要不要打日志 */
export function hasDropped (dropped) {
  return Boolean(dropped && (dropped.memory || dropped.groupLines > 0 || dropped.truncatedUser))
}

export { DEFAULT_MAX_CHARS }
