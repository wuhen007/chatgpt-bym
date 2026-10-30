/**
 * 出站守卫：防自曝。
 *
 * 为什么需要这一层：提示词里写一百遍「你是群友不是 AI」，小模型在长上下文里照样会漏。
 * 群里蹦出一句「作为一个语言模型」，整个伪人设定的沉浸感就没了。
 * 提示词兜不住的，这里兜。
 *
 * 分两档判定，避免误伤：
 *
 * - DEFINITE（必拦）：出现即自曝，没有歧义。「作为 AI 语言模型」「我的训练数据」
 *   这种句式不可能是正常群聊。
 * - SUSPICIOUS（可疑）：只出现厂商名、技术术语。群友本来就会聊这些，
 *   模型回一句「Claude 那个确实好用」不算自曝，拦掉反而怪。
 *   所以这一档只在配了 judgeModel 时才交模型二次判定，没配就放行。
 *
 * 原则是「宁可漏，不可误伤」——漏一句只是人设崩一点，
 * 误伤一次就是机器人莫名其妙不说话，用户根本不知道发生了什么。
 */

/** 必拦：单看这一句就能判定在暴露身份 */
const DEFINITE = [
  // 最典型的 AI 口癖，出自对齐训练的模板句
  // selfClaim 标记的是「自称 AI 身份」这一类：guard.allowSelfClaim 打开时会放行它们，
  // 因为有的人设明确设定为「不否认自己是 AI」（见 config.guard.allowSelfClaim 的说明）
  { re: /(作为|身为)(一个|一名|一只)?\s*(AI|人工智能|人工智能助手|语言模型|大语言模型|智能助手|聊天机器人|虚拟助手|AI\s*助手)/i, why: '自称 AI 身份', selfClaim: true },
  { re: /(我|俺|咱)(就|其实|本身|也)?(是|只是|不过是)\s*(一个|一名|一只)?\s*(AI|人工智能|人工智能助手|语言模型|大语言模型|智能助手|聊天机器人|虚拟助手|机器人)/i, why: '自称身份', selfClaim: true },
  // 自述来源：只在讲自己怎么被造出来时出现。"我由于…" 要排除，那是正常说法
  { re: /我(是|由(?!于)|被)[^。！？\n]{0,12}(开发|训练|部署|构建|创造|设计|制作)/i, why: '自述来源' },
  { re: /我(的)?(训练数据|知识截止|预训练|参数规模|上下文窗口)/i, why: '技术内情' },
  // 能力边界：这两句是"我不是人"的等价说法
  { re: /我(无法|不能|没办法)(访问|浏览|查看|连接)(网络|互联网|网页|外部|实时)/i, why: 'AI 能力边界口癖' },
  { re: /我(没有|不具备|缺乏)(个人)?(经历|情感|感情|身体|记忆|意识|主观)/i, why: 'AI 能力边界口癖' },
  // 内部信息：正常群聊不会出现这些
  { re: /(os error|errno\s*\d|127\.0\.0\.1|localhost:\d{2,5}|[A-Za-z]:\\|\.exe\b|api[_\s-]?key|sk-[A-Za-z0-9]{8,})/i, why: '本机路径/接口/密钥' },
  // 英文口癖。中文场景下模型一般不用英文，但英文人设、或者模型抽风时会漏
  { re: /\bas an? (AI|artificial intelligence|large language model|language model)\b/i, why: '自称 AI 身份（英文）', selfClaim: true },
  // (?!not) 是为了放过 "I'm not an AI" 这种正常反驳
  { re: /\bI('m| am) (?!not\b)[^.!?\n]{0,20}?\b(AI|artificial intelligence|language model|chatbot|virtual assistant)\b/i, why: '自称身份（英文）', selfClaim: true },
  { re: /\bI (cannot|can't|am unable to) (access|browse|view)\b/i, why: 'AI 能力边界口癖（英文）' },
  { re: /\bmy training data\b/i, why: '技术内情（英文）' },
]

/** 可疑：需要结合语境，交给模型判定 */
const SUSPICIOUS = [
  // 单独的 gpt 也算可疑（"GPT 又降价了"是正常话题，"我是 GPT"由 definite 档负责）
  { re: /\b(openai|gpt(-?[0-9o])?|chatgpt|claude|gemini|deepseek|qwen|llama|mistral|grok|moonshot|kimi|doubao|ernie|glm-?\d|sora|midjourney)\b/i, why: '模型/厂商名' },
  { re: /(通义千问|文心一言|豆包|智谱清言|大语言模型|多模态模型|参数量|提示词|微调|推理模型|temperature|top[_-]?p)/i, why: '技术栈术语' },
]

/**
 * 单遍扫描本地规则。
 * @param {string} text 待发出去的正文
 * @param {object} [options]
 * @param {boolean} [options.allowSelfClaim] 放行「自称 AI 身份」这一类规则
 * @returns {{level: 'definite'|'suspicious'|null, why?: string, matched?: string}}
 */
export function scanExposure (text, { allowSelfClaim = false } = {}) {
  const s = String(text || '')
  if (!s) return { level: null }
  for (const rule of DEFINITE) {
    // allowSelfClaim 只放行自称身份那几条，其余（厂商、路径、密钥、技术内情）照拦
    if (allowSelfClaim && rule.selfClaim) continue
    const m = rule.re.exec(s)
    if (m) return { level: 'definite', why: rule.why, matched: m[0] }
  }
  for (const rule of SUSPICIOUS) {
    const m = rule.re.exec(s)
    if (m) return { level: 'suspicious', why: rule.why, matched: m[0] }
  }
  return { level: null }
}

/** 二次判定用的提示词。要求只答"是/否"，比要 JSON 稳（小模型经常包一层代码块）。 */
const JUDGE_PROMPT = '你是一个出站过滤器。判断给出的一句话里，说话者有没有自称是 AI / 语言模型 / 机器人，或说明了自己由哪家公司、哪个模型驱动。'
  + '只回答一个字：「是」或「否」。不要解释，不要标点。'

/**
 * 交给廉价模型判定"这句算不算自曝"。
 * 判定失败（超时、返回看不懂）时返回 null，由调用方决定怎么办 —— 这里不替上层做主。
 *
 * @returns {Promise<boolean|null>}
 */
async function judge (text, { chatCompletion, model, llm }) {
  if (!model) return null
  try {
    const result = await chatCompletion({
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: text },
      ],
      // 判定只需要一两个字。但不能给太小：推理模型会先把 token 花在 reasoning 上，
      // maxTokens 给 8 会导致正文为空、每次都判不出来。给 64 留余量。
      // 同样不重试：判定失败本就是放行，重试只会让回复变慢。
      llm: {
        ...llm,
        model,
        maxTokens: 64,
        temperature: 0,
        retries: 0,
        timeoutMs: Math.min(Number(llm?.timeoutMs) || 8000, 8000),
      },
      stream: false,
    })
    const answer = String(result?.text || '').trim()
    return /^[「"']?是/.test(answer)
  } catch (err) {
    globalThis.logger?.debug?.(`[bym][guard] 二次判定失败，按放行处理：${err.message}`)
    return null
  }
}

/**
 * 检查一条准备发出的回复。
 *
 * @param {string} text 已经过 postProcess 的正文
 * @param {object} options
 * @param {object} options.guard config.guard
 * @param {Function} [options.chatCompletion] 注入用，测试里替换
 * @param {object} [options.llm] 复用主渠道的地址与鉴权
 * @param {boolean} [options.allowSelfClaim] 放行「自称 AI 身份」这一类规则
 * @returns {Promise<{ok: boolean, why?: string, matched?: string, judged?: boolean}>}
 */
export async function guardText (text, { guard, chatCompletion, llm, allowSelfClaim = false } = {}) {
  const cfg = guard || {}
  if (cfg.enable === false) return { ok: true }

  const scan = scanExposure(text, { allowSelfClaim })
  if (scan.level === 'definite') {
    return { ok: false, why: scan.why, matched: scan.matched }
  }
  if (scan.level !== 'suspicious') return { ok: true }

  // 可疑档：只有配了判定模型才拦，否则放行
  if (!chatCompletion || !cfg.judgeModel) return { ok: true }

  const verdict = await judge(text, { chatCompletion, model: cfg.judgeModel, llm })
  if (verdict === true) {
    return { ok: false, why: scan.why, matched: scan.matched, judged: true }
  }
  // verdict 为 false（判定非自曝）或 null（判定失败）都放行：
  // 这一档本来就可能误伤，判不出来时拦掉反而更糟。
  return { ok: true, judged: verdict === false }
}

