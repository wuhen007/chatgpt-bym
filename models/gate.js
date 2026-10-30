/**
 * 语义把关：这条消息值不值得接话。
 *
 * 概率闸门只控频率，控不住「合不合适」—— 掷到骰子的时候，
 * 群里可能正在两个人吵架、可能在刷广告接龙、也可能有人发自言自语的牢骚。
 * 这些场合插一句，比不说话糟得多。
 *
 * 成本控制是这块设计的关键。一次判定 = 一次 API 调用，
 * 每条群消息都判是不可接受的。所以调用顺序是：
 *
 *   概率筛（本地、零成本） → 命中者才进 gate → 通过才生成
 *
 * 默认 probability=0.02，意味着 100 条消息只有 2 条真正花这次调用。
 * 另外「被点名」和「命中关键词」不进 gate —— 那是明确信号，不需要模型再确认。
 *
 * 判不出来（超时、返回看不懂）时**放行**：这一层是锦上添花，
 * 失败就退回原来的纯概率行为，不能因为 gate 挂了就整个不说话。
 */

/** 打分锚点很关键。不给锚点，模型会把日常闲聊打成 3 分，全部拒掉。 */
const JUDGE_PROMPT = [
  '你在帮一个 QQ 群里的普通成员决定「这条消息值不值得接话」。',
  '给 0-10 分，标准如下：',
  '- 0-2：广告、刷屏、机器指令、纯表情、看不懂的接龙',
  '- 3-5：自言自语、明显在和某个人一对一说话、没有可接的内容',
  '- 6-7：日常闲聊。**群里大多数消息都在这一档**',
  '- 8-10：在问所有人、有争议、有笑点、提到了这个成员',
  '只输出一个 JSON：{"score": 6, "why": "不超过12字"}',
].join('\n')

/**
 * 从模型输出里抠出分数。三级宽容解析：
 *
 *   ① 标准 JSON（可能被代码块包着）
 *   ② 「评分 / 分数 / score」后面紧跟的数字 —— 处理 "评分：\n7" 这种分行输出
 *   ③ 全文第一个独立出现的 0-10 数字
 *
 * 只认第一行（原来的写法）会在模型把标签和分数分行时抠不出东西，
 * 然后走「解析不出 → 放行」，表现是 **gate 开着但等于没开**，而且只有 debug 日志。
 *
 * @returns {number|null} null 表示解析不出来
 */
export function parseScore (raw) {
  const s = String(raw || '').trim()
  if (!s) return null

  // ① 标准 JSON
  const jsonText = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(jsonText.slice(start, end + 1))
      const n = Number(obj?.score)
      if (Number.isFinite(n) && n >= 0 && n <= 10) return n
    } catch { /* 落到下面 */ }
  }

  // ② 带标签的数字。「评分：7」「score = 7」「打分\n7 分」都认得
  const labeled = s.match(/(?:score|评分|分数|打分)[^0-9]{0,8}?(10|[0-9])\b/i)
  if (labeled) {
    const n = Number(labeled[1])
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n
  }

  // ③ 全文第一个独立数字。注意 `\b` 是为了避免从 "15" 里抠出 "1"
  const m = s.match(/\b(10|[0-9])\b/)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n
  }
  return null
}

/**
 * @param {object} options
 * @param {string} options.text       触发它的那条消息
 * @param {string} [options.context]  最近几条群聊记录（有就带上，判断更准）
 * @param {string} [options.speaker]  发言人昵称
 * @param {object} options.llm        主渠道（地址与鉴权）
 * @param {Function} options.chatCompletion
 * @param {object} options.gate       config.gate
 * @returns {Promise<{should: boolean, score: number|null, why: string, degraded: boolean}>}
 */
export async function judgeRelevance ({ text, context = '', speaker = '', llm, chatCompletion, gate } = {}) {
  const cfg = gate || {}
  const threshold = Number.isFinite(Number(cfg.threshold)) ? Number(cfg.threshold) : 6

  const userParts = []
  if (context) userParts.push(`最近的群聊：\n${context}`)
  userParts.push(`需要判断的这条消息${speaker ? `（${speaker}）` : ''}：\n${text}`)

  try {
    const result = await chatCompletion({
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: userParts.join('\n\n') },
      ],
      // 只输出一个小 JSON。不能给太小：推理模型会先把 token 花在 reasoning 上，
      // 正文变空，导致每次都判不出来（每次都放行，等于这一层不存在）。
      llm: {
        ...llm,
        model: cfg.model || llm?.model,
        maxTokens: 96,
        temperature: 0,
        // 判定层刻意不重试：它的意义是「便宜快速问一句」。
        // 继承主渠道的 retries=2 会在上游抖动时白等约 1.5 秒，
        // 而判定失败本来就是放行 —— 重试拿不到任何收益，只是让回复变慢。
        retries: 0,
        timeoutMs: Math.min(Number(llm?.timeoutMs) || 8000, 8000),
      },
      stream: false,
    })

    const score = parseScore(result?.text)
    if (score === null) {
      return { should: true, score: null, why: '判定结果解析不出分数，按放行处理', degraded: true }
    }
    return {
      should: score >= threshold,
      score,
      why: `评分 ${score}（阈值 ${threshold}）`,
      degraded: false,
    }
  } catch (err) {
    // 失败退回原行为，不因为 gate 挂了就不说话
    return { should: true, score: null, why: `判定失败，按放行处理：${err.message}`, degraded: true }
  }
}
