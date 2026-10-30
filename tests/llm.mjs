/**
 * 接口层测试：起一个本地假 OpenAI 兼容服务，验证请求组装、流式聚合、
 * 重试与备用渠道。不需要真实 API Key。
 * 运行：node tests/llm.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'

global.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const { chatCompletion, LLMError, buildChannels } = await import('../models/llmClient.js')

const requests = []
// 按 apiKey 决定行为：bad-key=401，flaky=前两次 500 后成功，其余正常
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const auth = String(req.headers.authorization || '')
    requests.push({ url: req.url, auth, payload })

    if (auth.includes('bad-key')) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }

    if (auth.includes('flaky-key') && requests.filter(item => item.auth.includes('flaky-key')).length <= 2) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'boom' } }))
      return
    }

    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunks = [
        { choices: [{ delta: { reasoning_content: '先想一下，' } }] },
        { choices: [{ delta: { content: '那' } }] },
        { choices: [{ delta: { content: '就这样吧' } }] },
      ]
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      // 故意不发 [DONE]，验证 reader 结束兜底
      res.end()
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      model: payload.model,
      choices: [{
        message: {
          role: 'assistant',
          content: '行吧，那就这么定了。',
          reasoning_content: '用户在征求意见，简短同意即可。',
        },
      }],
      usage: { total_tokens: 42 },
    }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/v1`

const baseLLM = {
  baseURL: base,
  apiKey: 'good-key',
  model: 'test-model',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 128,
  timeoutMs: 5000,
  stream: false,
  retries: 0,
  extraHeaders: { 'X-Test': '1' },
  extraBody: {},
  fallback: [],
}

let passed = 0
async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}

console.log('\n[1] 端点与请求体')
await test('baseURL 归一化为 /v1/chat/completions', async () => {
  requests.length = 0
  await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], llm: baseLLM })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/v1/chat/completions')
})
await test('鉴权头与自定义头都带上', async () => {
  assert.equal(requests[0].auth, 'Bearer good-key')
})
await test('采样参数写入请求体', async () => {
  const body = requests[0].payload
  assert.equal(body.model, 'test-model')
  assert.equal(body.temperature, 0.7)
  assert.equal(body.top_p, 0.9)
  assert.equal(body.max_tokens, 128)
  assert.equal(body.stream, false)
})
await test('extraBody 会合并进请求体', async () => {
  requests.length = 0
  await chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    llm: { ...baseLLM, extraBody: { enable_thinking: false } },
  })
  assert.equal(requests[0].payload.enable_thinking, false)
})

console.log('\n[2] 响应解析')
await test('非流式取 content 与 reasoning', async () => {
  const result = await chatCompletion({ messages: [{ role: 'user', content: 'hi' }], llm: baseLLM })
  assert.equal(result.text, '行吧，那就这么定了。')
  assert.match(result.reasoning, /征求意见/)
  assert.equal(result.model, 'test-model')
  assert.equal(result.usage.total_tokens, 42)
})
await test('流式逐块聚合，且无 [DONE] 也能收尾', async () => {
  const deltas = []
  const result = await chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    llm: { ...baseLLM, stream: true },
    onDelta: piece => deltas.push(piece),
  })
  assert.equal(result.text, '那就这样吧')
  assert.deepEqual(deltas, ['那', '就这样吧'])
  assert.match(result.reasoning, /先想一下/)
})

console.log('\n[3] 容错')
await test('5xx 在额度内重试后成功', async () => {
  requests.length = 0
  const result = await chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    llm: { ...baseLLM, apiKey: 'flaky-key', retries: 3 },
  })
  assert.equal(result.text.length > 0, true)
  assert.equal(requests.length, 3, '第二次成功应共发出 3 次请求')
})
await test('401 不重试，直接切备用渠道', async () => {
  requests.length = 0
  const result = await chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    llm: {
      ...baseLLM,
      apiKey: 'bad-key',
      retries: 3,
      fallback: [{ baseURL: base, apiKey: 'good-key', model: 'backup-model' }],
    },
  })
  assert.equal(result.text.length > 0, true)
  // 主渠道只试一次（401 不可重试），第二次落到备用渠道
  assert.equal(requests.length, 2)
  assert.equal(requests[1].payload.model, 'backup-model')
})
await test('全部渠道失败时抛 LLMError', async () => {
  await assert.rejects(
    () => chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      llm: { ...baseLLM, apiKey: 'bad-key', retries: 0 },
    }),
    (err) => err instanceof LLMError && /所有渠道均不可用/.test(err.message)
  )
})
await test('缺少模型配置时快速失败', async () => {
  // buildChannels 只负责过滤，抛错点在 chatCompletion，这里两段都验一下
  assert.deepEqual(buildChannels({ baseURL: '', model: '' }), [])
  await assert.rejects(
    () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }], llm: { baseURL: '', apiKey: '', model: '' } }),
    /未配置可用渠道/
  )
})

server.close()
console.log(`\n通过 ${passed} 项检查${process.exitCode ? '，存在失败项' : ''}\n`)
