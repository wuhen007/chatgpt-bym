/**
 * OpenAI 兼容的对话接口客户端。
 *
 * 只做一件事：把 messages 发出去，把文本收回来。
 * 不依赖任何 SDK，因此用户可以自由接官方、中转站或本地模型。
 */

export class LLMError extends Error {
  constructor (message, { status = 0, body = '', channel = '' } = {}) {
    super(message)
    this.name = 'LLMError'
    this.status = status
    this.body = body
    this.channel = channel
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeBase (baseURL) {
  return String(baseURL || '').trim().replace(/\/+$/, '')
}

/** 允许用户把 baseURL 写成完整端点 */
function endpointOf (baseURL) {
  const base = normalizeBase(baseURL)
  if (/\/(chat\/completions|completions)$/.test(base)) return base
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/**
 * 组装渠道列表：主渠道 + 备用渠道。任何一项缺字段就跳过，避免发出半成品请求。
 * @param {object} llm config.llm
 */
export function buildChannels (llm) {
  const channels = [{ baseURL: llm.baseURL, apiKey: llm.apiKey, model: llm.model }]
    .concat(Array.isArray(llm.fallback) ? llm.fallback : [])
    .map(item => ({
      baseURL: normalizeBase(item?.baseURL),
      apiKey: item?.apiKey ?? '',
      // 备用渠道可以不写 model，默认复用主渠道的
      model: item?.model || llm.model,
      headers: item?.headers || {},
    }))
    .filter(item => item.baseURL && item.model)
  return channels
}

function buildHeaders (llm, channel) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    ...(llm.extraHeaders || {}),
    ...(channel.headers || {}),
  }
  if (channel.apiKey) {
    headers.Authorization = `Bearer ${channel.apiKey}`
  }
  return headers
}

function buildBody ({ messages, llm, channel, stream }) {
  const body = {
    model: channel.model,
    messages,
    stream: !!stream,
    ...(llm.extraBody || {}),
  }
  if (Number.isFinite(llm.temperature) && llm.temperature >= 0) body.temperature = llm.temperature
  if (Number.isFinite(llm.topP) && llm.topP > 0) body.top_p = llm.topP
  if (Number.isFinite(llm.maxTokens) && llm.maxTokens > 0) body.max_tokens = llm.maxTokens
  return body
}

/** 从响应里尽量抠出文本：兼容 content 为字符串、数组、以及 reasoning 字段的不同叫法 */
function pickText (message) {
  if (!message) return { text: '', reasoning: '' }
  const text = Array.isArray(message.content)
    ? message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('')
    : (message.content || '')
  const reasoning = message.reasoning_content || message.reasoning || message.reasoning_details?.map?.(item => item.text || '').join('') || ''
  return { text: String(text || ''), reasoning: String(reasoning || '') }
}

/**
 * 流式解析：逐行读 SSE，边收边回调，最后返回聚合结果。
 * 有的中转站不发 [DONE]，靠 reader 结束兜底。
 */
async function readStream (response, onDelta) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let text = ''
  let reasoning = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          // 不完整的行会在下一轮补齐，这里跳过即可
          continue
        }
        const delta = json.choices?.[0]?.delta || {}
        if (delta.content) {
          text += delta.content
          onDelta?.(delta.content)
        }
        const reasoningDelta = delta.reasoning_content || delta.reasoning
        if (reasoningDelta) reasoning += reasoningDelta
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  return { text, reasoning }
}

/**
 * 发起一次对话补全。
 *
 * @param {object} options
 * @param {Array<object>} options.messages OpenAI 格式消息
 * @param {object} options.llm config.llm 段
 * @param {boolean} [options.stream] 覆盖配置里的 stream
 * @param {(delta: string) => void} [options.onDelta] 流式增量回调
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{text: string, reasoning: string, model: string, channel: string, usage: object|null}>}
 */
export async function chatCompletion ({ messages, llm, stream = llm.stream === true, onDelta, signal }) {
  const channels = buildChannels(llm)
  if (channels.length === 0) {
    throw new LLMError('未配置可用渠道，请填写 llm.baseURL 与 llm.model')
  }

  let lastError = null
  const retries = Math.max(0, Number(llm.retries) || 0)

  for (const channel of channels) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(llm.timeoutMs) || 60000))

      try {
        const response = await fetch(endpointOf(channel.baseURL), {
          method: 'POST',
          headers: buildHeaders(llm, channel),
          body: JSON.stringify(buildBody({ messages, llm, channel, stream })),
          signal: controller.signal,
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new LLMError(
            `接口返回 ${response.status}${body ? '：' + body.slice(0, 300) : ''}`,
            { status: response.status, body, channel: channel.baseURL }
          )
        }

        if (stream) {
          const result = await readStream(response, onDelta)
          if (result.text.trim()) {
            return { ...result, model: channel.model, channel: channel.baseURL, usage: null }
          }
          // 流式没收到内容（有的中转站会直接返回 JSON），退回非流式解析
          throw new LLMError('流式响应为空', { status: 0, channel: channel.baseURL })
        }

        const json = await response.json()
        const choice = json.choices?.[0]
        const { text, reasoning } = pickText(choice?.message)
        if (!text.trim() && !reasoning.trim()) {
          throw new LLMError('响应中没有可用内容', { status: 0, body: JSON.stringify(json).slice(0, 300), channel: channel.baseURL })
        }
        return { text, reasoning, model: json.model || channel.model, channel: channel.baseURL, usage: json.usage || null }
      } catch (error) {
        lastError = error
        const status = error?.status ?? 0
        const aborted = error?.name === 'AbortError'
        const retryable = aborted || status === 0 || RETRYABLE_STATUS.has(status)
        const hasNextAttempt = attempt < retries

        globalThis.logger?.debug?.(`[bym][llm] 请求失败 channel=${channel.baseURL} status=${status} attempt=${attempt + 1}/${retries + 1}：${error.message}`)

        // 同一个渠道的重试只针对可恢复错误；认证错误直接换渠道
        if (retryable && hasNextAttempt) {
          await sleep(500 * 2 ** attempt + Math.floor(Math.random() * 200))
          continue
        }
        break
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }

  const message = lastError?.message || '未知错误'
  throw new LLMError(`所有渠道均不可用：${message}`, { status: lastError?.status ?? 0 })
}
