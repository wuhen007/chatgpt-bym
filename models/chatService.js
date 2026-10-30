import { config } from '../config/config.js'
import { chatCompletion } from './llmClient.js'
import { resolvePreset } from './preset.js'
import { buildGroupContext, formatTime } from '../utils/groupContext.js'
import { buildMemoryPrompt } from './memory.js'
import { buildUserContent, collectImageUrls, collectQuotedImageUrls, displayName } from '../utils/message.js'
import { guardText } from '../utils/guard.js'
import { fitBudget, hasDropped } from '../utils/budget.js'
import { judgeRelevance } from './gate.js'
import { parseReply, MEMORY_CONTRACT } from './replyParser.js'

/**
 * 一次伪人发言的完整编排：确定人设 -> 拼上下文 -> 调模型 -> 拿到文本。
 *
 * 只产出一条 user 消息，是为了兼容性：不少中转站/自建网关对连续多条 user
 * 消息支持不好（会报 role 交替错误）。如果确认后端支持，可以把
 * context / dynamic / 本轮 拆成多条，换取 prompt cache 命中（见 README 的「可优化点」）。
 */

/**
 * 人设 system。结构化的部分在前，`system` 自由文本作为补充跟在后面。
 *
 * 为什么结构化放前面：模型对 system 开头的内容权重大，把「你是谁/你怎么说话」
 * 放在最前面比塞在自由文本中间有效。而自由文本在最后，正好用来表达
 * 那些没法程序化描述的细节（态度、立场、和群友的关系）。
 *
 * 末尾补一条运行时铁律：模型很容易在长上下文里「变回助手」，
 * 这句兜底比在预设里反复强调有效。
 *
 * 导出供测试（运行时只有本文件的 generateReply 调它）。
 */
export function buildSystemPrompt (preset, groupName) {
  const prefix = String(config.speaking.presetPrefix || '').trim()
  const sections = []

  if (preset?.identity) {
    const parts = []
    const who = preset.name ? `你是${preset.name}` : '你'
    const age = preset.identity.age ? `${preset.identity.age} 岁` : ''
    const { city, job } = preset.identity
    const place = city && job ? `在${city}做${job}` : (city ? `在${city}` : (job ? `做${job}` : ''))
    const head = [who, age, place].filter(Boolean).join('，')
    parts.push(head ? `${head}。` : '')
    if (preset.identity.signature) parts.push(preset.identity.signature)
    sections.push(`# 你是谁\n${parts.filter(Boolean).join('')}`)
  }

  if (preset?.speech) {
    const lines = []
    // 两个短句各带句号拼在一行：「口语、随意。每次只说一到两句。」
    // 用逗号连成一句会读不断（「口语、随意，偶尔带点语气词，每次只说一到两句」）。
    const head = [preset.speech.style, preset.speech.length ? `每次只说${preset.speech.length}` : '']
      .filter(Boolean)
      .map(text => (/[。.！!？?]$/.test(text) ? text : `${text}。`))
    if (head.length) lines.push(head.join(''))
    if (preset.speech.catchphrases?.length) {
      lines.push(`偶尔用这些口头禅：${preset.speech.catchphrases.join('、')}`)
    }
    if (preset.speech.never?.length) {
      lines.push(`绝对不要：${preset.speech.never.join('、')}`)
    }
    if (lines.length) sections.push(`# 你怎么说话\n${lines.join('\n')}`)
  }

  // 群名。'unknown' 是拉不到群信息时的占位，别把它写进 prompt。
  const name = String(groupName || '').trim()
  if (preset?.groupAware !== false && name && name !== 'unknown') {
    sections.push(`# 你在哪\n这里是 QQ 群「${name}」。你是群里的普通成员，不是助手。`)
  }

  const body = String(preset?.system || '').trim()
  sections.push(body)

  // 最后兜底的必要说明：结构化字段只描述了「怎么说话」，没说「不要自称 AI」。
  // 这句和结构化无关，任何预设都要带上。
  sections.push('记住：你是这个群里的普通成员。不要自称 AI、助手或机器人，不要输出 Markdown 列表和标题，不要解释你正在做什么。')

  return [prefix, ...sections].filter(Boolean).join('\n\n')
}

/** 群名，拿不到时返回空串（让调用方决定用不用） */
function groupNameOf (e) {
  const name = e?.group?.name || e?.group_name || ''
  return String(name || '').trim()
}

/**
 * 判定本次用哪种发言方式。
 * contextual 依赖群上下文，拿不到上下文时自动退回 reply，否则模型会“凭空发言”。
 * 导出供测试。
 */
export function resolveMode (hasContext, addressed = false) {
  // 被点名时必须正面回答。contextual 是「自己找切入点插话」，
  // 拿它来回答「@机器人 你觉得呢」会答非所问。
  if (addressed) return 'reply'
  const mode = String(config.speaking.mode || 'reply').toLowerCase()
  if (mode === 'contextual' && hasContext) return 'contextual'
  return 'reply'
}

/**
 * @param {object} e 云崽事件
 * @param {{text: string, forced: boolean, addressed?: boolean}} trigger 触发信息
 * @returns {Promise<{text: string, reasoning: string, mode: string, preset: object, contextItems: Array<object>, model: string}>}
 */
export async function generateReply (e, trigger) {
  const triggerText = String(trigger?.text || '')
  // 群级人设绑定优先于关键词规则，见 preset.js 的 resolvePreset
  const preset = resolvePreset(triggerText, e?.group_id)

  // 群上下文与图片互不依赖，并发取
  const [groupContext, currentImages, quotedImages] = await Promise.all([
    buildGroupContext(e),
    Promise.resolve(collectImageUrls(e)),
    collectQuotedImageUrls(e),
  ])
  const hasContext = Boolean(groupContext.text)
  const mode = resolveMode(hasContext, trigger?.addressed === true)

  // 语义把关：概率筛过之后，再让模型看一眼「这时候插话合不合适」。
  // 必须排在概率后面 —— 每条消息都判一次是不可接受的成本。
  // 被点名和命中关键词是明确信号，不浪费这次调用。
  if (config.gate?.enable === true && trigger?.forced !== true) {
    const verdict = await judgeRelevance({
      text: triggerText,
      context: groupContext.text,
      speaker: displayName(e),
      llm: config.llm,
      chatCompletion,
      gate: config.gate,
    })
    if (!verdict.should) {
      globalThis.logger?.debug?.(`[bym][gate] 判定不接话：${verdict.why}`)
      return {
        text: '',
        skipped: true,
        skipReason: verdict.why,
        gateScore: verdict.score,
        reasoning: '',
        mode: 'none',
        preset,
        model: '',
        contextItems: [],
      }
    }
  }

  const memoryQuery = hasContext
    ? groupContext.items.slice(-6).map(item => item.text).join(' ')
    : triggerText

  // dryRun（`#bym 测试`）不累加访问计数：那只是管理员想看效果，
  // 不该改变「哪些记忆更常被想起」的排序。
  const memoryPrompt = buildMemoryPrompt(
    e.group_id,
    memoryQuery,
    undefined,
    undefined,
    { countAccess: trigger?.dryRun !== true }
  )

  const systemPrompt = buildSystemPrompt(preset, groupNameOf(e))
  const contextualPrompt = String(config.speaking.contextualPrompt || '').trim() || '请结合上面的群聊内容，自然地接一句话。'
  // 被点名叫到的人应该正面接话，而不是像平时那样「顺口插一句」。
  // 同一条 user 消息里的措辞差别，比在 system 里加一句约束更有效。
  const lead = trigger?.addressed
    ? `「${displayName(e)}」在群里直接 @ 了你，请针对下面这句话正面回答：`
    : `下面这条消息来自「${displayName(e)}」，请自然地接话：`

  // 记忆开启时改成 JSON 契约：回话的同时顺带产出「值得记住的事」，
  // 省掉原来那次独立的抽取调用（那一轮本来就已经在调模型了）。
  //
  // 三个条件都要满足才加契约：
  // - enable：总开关
  // - write：这一侧是「要不要写」，只读模式下不该要求模型输出 memory（白占字数还增加解析风险）
  // - extract：老配置的兼容项，extract:false 的升级用户不该突然开始写
  const wantMemory = config.memory.enable === true &&
    config.memory.write !== false &&
    config.memory.extract !== false

  // 预算裁剪。固定的部分（人设 + 指令 + 契约）算进 system，只有正文参与截断，
  // 这样截出来的永远是消息本身，不会把指令切成半句。
  //
  // 契约本身也要算进去：它是裁剪之后才追加的，漏算的话「刚好卡线」的那一轮
  // 加上 240 多字的契约就超出预算了。
  const fit = fitBudget({
    system: systemPrompt + (mode === 'contextual' ? contextualPrompt : lead) + (wantMemory ? MEMORY_CONTRACT : ''),
    groupHeader: groupContext.header,
    groupLines: groupContext.lines,
    memory: memoryPrompt,
    userText: triggerText,
    maxChars: config.context.maxChars,
  })
  if (hasDropped(fit.dropped)) {
    globalThis.logger?.debug?.(
      `[bym][budget] 超出 ${config.context.maxChars} 字，` +
      `已丢弃：记忆=${fit.dropped.memory ? '是' : '否'}、群记录 ${fit.dropped.groupLines} 条` +
      `${fit.dropped.truncatedUser ? '、本轮消息被截断' : ''}`
    )
  }

  // 群记录被裁光时 contextual 就没依据了，退回 reply，否则模型会凭空发言
  const effectiveMode = (mode === 'contextual' && !fit.groupText) ? 'reply' : mode

  // 只有真正进到 prompt 里的记录才算「这次用到的上下文」，
  // 记忆抽取拿它当语料，别把已经裁掉的消息也算进去。
  const usedItems = fit.groupText ? groupContext.items.slice(fit.dropped.groupLines) : []

  // 动态段：时间。放在这里而不是 system，是为了让 system 保持静态（便于 prompt cache）
  const timeLine = `当前时间：${formatTime(Date.now())}`

  const content = []
  if (fit.groupText) content.push({ type: 'text', text: fit.groupText })
  content.push({ type: 'text', text: timeLine })
  if (!fit.groupText && config.context.enable) {
    content.push({ type: 'text', text: '（没有取到群聊记录，只根据下面这条消息自然地接一句即可）' })
  }
  if (fit.memory) content.push({ type: 'text', text: fit.memory })

  if (effectiveMode === 'contextual') {
    content.push({ type: 'text', text: contextualPrompt })
  } else {
    const images = [...currentImages, ...quotedImages]
    content.push({ type: 'text', text: lead })
    const userContent = await buildUserContent(fit.userText, images)
    if (typeof userContent === 'string') {
      content.push({ type: 'text', text: userContent })
    } else {
      // 多模态时 userContent 是数组，拆开后并入同一条消息
      content.push(...userContent)
    }
  }

  // 契约必须排在最后：它是「输出格式要求」，不是上下文的一部分。
  // 放在中间的话模型容易把它当成需要参考的资料，而不是必须遵守的格式。
  if (wantMemory) content.push({ type: 'text', text: MEMORY_CONTRACT })

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content },
  ]

  const llm = {
    ...config.llm,
    // 预设可以覆盖采样参数：不同人设的语气需要不同的温度
    temperature: Number.isFinite(preset.temperature) ? preset.temperature : config.llm.temperature,
    maxTokens: Number.isFinite(preset.maxTokens) ? preset.maxTokens : config.llm.maxTokens,
  }

  // 解析一次并清洗。记忆开启时按 JSON 契约解析，解析失败自动退回「整段当回复」。
  const parseOnce = (raw) => {
    const parsed = parseReply(raw, { expectMemory: wantMemory })
    return { ...parsed, text: postProcess(parsed.say) }
  }

  const result = await chatCompletion({ messages, llm })
  let parsed = parseOnce(result.text)
  let text = parsed.text

  // 出站守卫：提示词兜不住的自曝，这里兜。
  // 注意拦掉的是「这一轮不发」，不是「发个错误提示」——伪人不该在群里解释自己为什么不说。
  //
  // allowSelfClaim 来自 guard 配置：有人设（默认的大肥鱼）明确设定「不否认自己是 AI」，
  // 那句话撞上自称规则会被整轮吞掉，群里表现是「机器人卡住不说话」而不是「它不承认」。
  const allowSelfClaim = config.guard?.allowSelfClaim === true
  let verdict = await guardText(text, { guard: config.guard, chatCompletion, llm, allowSelfClaim })

  if (!verdict.ok && config.guard?.retry === true) {
    // 重试一次：把命中的原因变成强约束追加到 system 末尾。
    // 只重复调模型，不重跑群上下文和记忆检索（那些没变）。
    const reinforce = `\n\n【本轮必须遵守】上一次的回复里出现了不该说的话（${verdict.why || '暴露身份'}）。`
      + '重新组织一句：绝对不要出现模型名、厂商名、训练/参数/提示词之类的技术细节、本机路径或报错、'
      + (allowSelfClaim
        // 放行了自称身份，就别再要求「不要出现我是 AI」——那正好和这个人设相反
        ? '以及任何「我是助手 / 机器人 / 程序」的表述。'
        : '以及任何「我是 AI / 程序 / 模型 / 助手」的表述。')
    try {
      const retryResult = await chatCompletion({
        messages: [
          { role: 'system', content: `${messages[0].content}${reinforce}` },
          messages[1],
        ],
        llm,
      })
      parsed = parseOnce(retryResult.text)
      text = parsed.text
      verdict = await guardText(text, { guard: config.guard, chatCompletion, llm, allowSelfClaim })
    } catch (err) {
      globalThis.logger?.warn?.(`[bym][guard] 重试失败，放弃本轮：${err.message}`)
    }
  }

  if (!verdict.ok) {
    globalThis.logger?.warn?.(`[bym][guard] 拦下一句（${verdict.why || '自曝'}${verdict.matched ? `：${verdict.matched}` : ''}）：${String(text).slice(0, 60)}`)
    return {
      text: '',
      blocked: true,
      blockedReason: verdict.why || '自曝',
      reasoning: result.reasoning,
      mode: effectiveMode,
      preset,
      model: result.model,
      contextItems: usedItems,
    }
  }

  return {
    text,
    reasoning: result.reasoning,
    mode: effectiveMode,
    preset,
    model: result.model,
    contextItems: usedItems,
    // 契约里的记忆条目。开启记忆时由模型顺带产出，不需要额外调用
    memory: parsed.memory,
    // 想要记忆但模型没按契约来 —— 调用方可据此决定要不要退回独立抽取
    memoryDegraded: wantMemory && parsed.degraded,
  }
}

/**
 * 模型输出清洗。
 * 小模型经常自作主张加引号、加“（笑）”以外的旁白、或者在前面写“我说：”。
 */
export function postProcess (raw) {
  let text = String(raw || '').trim()
  if (!text) return ''

  // 去掉整段包裹的引号
  const quoted = text.match(/^["“「']([\s\S]+)["”」']$/)
  if (quoted) text = quoted[1].trim()

  text = text
    // 去掉“我说：”“回复：”这类前缀
    .replace(/^(我(说|回复|答道)|回复|回答|AI|助手)\s*[:：]\s*/i, '')
    // 去掉 markdown 强调符号，QQ 不渲染
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // 去掉括号旁白（仅当整段只有旁白时保留，这里只清理行首行尾的）
    .replace(/^[（(][^）)]{0,20}[）)]\s*/, '')
    .trim()

  // 不做长度截断：输出上限由 llm.maxTokens 控制，超长内容由 humanize 分段发送。
  // 以前这里有一句 `slice(0, 500)`，会把长回复砍在半句上且不加省略号。
  return text
}

/** 供「测试」指令使用：不落库、不发群，直接返回文本 */
export async function dryRun (e, text) {
  // dryRun 标记会一路传到记忆检索，跳过访问计数的累加
  return await generateReply(e, { text, forced: true, dryRun: true })
}
