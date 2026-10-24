import { config } from '../config/config.js'
import { chatCompletion } from './llmClient.js'
import { resolvePreset } from './preset.js'
import { buildGroupContext, formatTime } from '../utils/groupContext.js'
import { buildMemoryPrompt } from './memory.js'
import { buildUserContent, collectImageUrls, collectQuotedImageUrls, displayName } from '../utils/message.js'

/**
 * 一次伪人发言的完整编排：确定人设 -> 拼上下文 -> 调模型 -> 拿到文本。
 *
 * 只产出一条 user 消息，是为了兼容性：不少中转站/自建网关对连续多条 user
 * 消息支持不好（会报 role 交替错误）。如果确认后端支持，可以把
 * context / dynamic / 本轮 拆成多条，换取 prompt cache 命中（见 README 的「可优化点」）。
 */

/**
 * 人设 system。前缀 + 预设正文，末尾补一条运行时铁律：
 * 模型很容易在长上下文里“变回助手”，这句兜底比在预设里反复强调有效。
 */
function buildSystemPrompt (preset) {
  const prefix = String(config.speaking.presetPrefix || '').trim()
  const body = String(preset?.system || '').trim()
  const parts = [prefix, body].filter(Boolean)
  parts.push('记住：你是这个群里的普通成员。不要自称 AI、助手或机器人，不要输出 Markdown 列表和标题，不要解释你正在做什么。')
  return parts.join('\n\n')
}

/**
 * 判定本次用哪种发言方式。
 * contextual 依赖群上下文，拿不到上下文时自动退回 reply，否则模型会“凭空发言”。
 */
export function resolveMode (hasContext) {
  const mode = String(config.speaking.mode || 'reply').toLowerCase()
  if (mode === 'contextual' && hasContext) return 'contextual'
  return 'reply'
}

/**
 * @param {object} e 云崽事件
 * @param {{text: string, forced: boolean}} trigger 触发信息
 * @returns {Promise<{text: string, reasoning: string, mode: string, preset: object, contextItems: Array<object>, model: string}>}
 */
export async function generateReply (e, trigger) {
  const triggerText = String(trigger?.text || '')
  const preset = resolvePreset(triggerText)

  // 群上下文与图片互不依赖，并发取
  const [groupContext, currentImages, quotedImages] = await Promise.all([
    buildGroupContext(e),
    Promise.resolve(collectImageUrls(e)),
    collectQuotedImageUrls(e),
  ])
  const hasContext = Boolean(groupContext.text)
  const mode = resolveMode(hasContext)

  // 记忆检索用“最近在聊什么”当查询词，比用触发词更贴合群聊语境
  const memoryQuery = hasContext
    ? groupContext.items.slice(-6).map(item => item.text).join(' ')
    : triggerText
  const memoryPrompt = buildMemoryPrompt(e.group_id, memoryQuery)

  // 动态段：时间 + 记忆。时间放这里而不是 system，是为了让 system 保持静态
  const dynamicParts = [`当前时间：${formatTime(Date.now())}`]
  if (!hasContext && config.context.enable) {
    dynamicParts.push('（没有取到群聊记录，只根据下面这条消息自然地接一句即可）')
  }
  if (memoryPrompt) dynamicParts.push(memoryPrompt)

  const content = []
  if (hasContext) {
    content.push({ type: 'text', text: groupContext.text })
  }
  content.push({ type: 'text', text: dynamicParts.join('\n') })

  if (mode === 'contextual') {
    content.push({
      type: 'text',
      text: String(config.speaking.contextualPrompt || '').trim() || '请结合上面的群聊内容，自然地接一句话。',
    })
  } else {
    const images = [...currentImages, ...quotedImages]
    content.push({ type: 'text', text: `下面这条消息来自「${displayName(e)}」，请自然地接话：` })
    const userContent = await buildUserContent(triggerText, images)
    if (typeof userContent === 'string') {
      content.push({ type: 'text', text: userContent })
    } else {
      // 多模态时 userContent 是数组，拆开后并入同一条消息
      content.push(...userContent)
    }
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(preset) },
    { role: 'user', content },
  ]

  const llm = {
    ...config.llm,
    // 预设可以覆盖采样参数：不同人设的语气需要不同的温度
    temperature: Number.isFinite(preset.temperature) ? preset.temperature : config.llm.temperature,
    maxTokens: Number.isFinite(preset.maxTokens) ? preset.maxTokens : config.llm.maxTokens,
  }

  const result = await chatCompletion({ messages, llm })
  const text = postProcess(result.text)

  return {
    text,
    reasoning: result.reasoning,
    mode,
    preset,
    model: result.model,
    contextItems: groupContext.items,
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
  return await generateReply(e, { text, forced: true })
}
