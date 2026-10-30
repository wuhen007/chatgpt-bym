/**
 * 语义把关测试：分数解析、阈值判定、失败降级。
 * 不联网 —— chatCompletion 是注入的。
 * 运行：node tests/gate.mjs
 */
import assert from 'node:assert/strict'

global.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const { judgeRelevance, parseScore } = await import('../models/gate.js')

let pass = 0
let fail = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ' + name) },
    (err) => { fail++; console.log('  FAIL ' + name + '\n       ' + err.message) }
  )
}

const LLM = { baseURL: 'http://x/v1', apiKey: 'k', model: 'main-model' }
const GATE = { enable: true, model: '', threshold: 6 }

/** 造一个返回固定文本的假 chatCompletion，顺便记录调用参数 */
function fakeLLM (text) {
  const calls = []
  const fn = async (args) => { calls.push(args); return { text, model: 'judge' } }
  fn.calls = calls
  return fn
}
const throwingLLM = async () => { throw new Error('judge timeout') }

console.log('\n[1] 分数解析')
await test('标准 JSON', () => {
  assert.equal(parseScore('{"score": 8, "why": "有人在提问"}'), 8)
})
await test('代码块包裹', () => {
  assert.equal(parseScore('```json\n{"score": 3, "why": "自言自语"}\n```'), 3)
})
await test('前后有废话', () => {
  assert.equal(parseScore('好的，我的判断是 {"score": 7, "why": "闲聊"} 就这样'), 7)
})
await test('只有数字没有 JSON', () => {
  assert.equal(parseScore('7'), 7)
})
await test('数字后面跟解释', () => {
  assert.equal(parseScore('7，这是日常闲聊'), 7)
})
await test('标签和分数分行（原来会解析失败 → gate 静默失效）', () => {
  assert.equal(parseScore('评分：\n7'), 7)
  assert.equal(parseScore('分数\n3'), 3)
  assert.equal(parseScore('score = 8'), 8)
})
await test('带解释文字时优先取「评分」后面的数字', () => {
  // 全文第一个数字是 2，但真正的分数在「评分」后面
  assert.equal(parseScore('这句话有 2 个问题，整体评分 7'), 7)
})
await test('从 "15" 里不会抠出 "1"', () => {
  assert.equal(parseScore('{"score": 15}'), null)
  assert.equal(parseScore('给了 15 分'), null)
})
await test('边界值 0 和 10', () => {
  assert.equal(parseScore('{"score": 0}'), 0)
  assert.equal(parseScore('{"score": 10}'), 10)
})
await test('超出 0-10 的分不算数，退回文本解析', () => {
  // JSON 里 15 非法，但第一个独立数字是 15 也不在 0-10 —— 应返回 null 或退到下一个
  const r = parseScore('{"score": 15}')
  assert.ok(r === null || (r >= 0 && r <= 10), `不该返回 ${r}`)
})
await test('完全解析不出来返回 null', () => {
  assert.equal(parseScore('我觉得还行'), null)
  assert.equal(parseScore(''), null)
  assert.equal(parseScore(null), null)
})

console.log('\n[2] 阈值判定')
await test('高于阈值 → 接话', async () => {
  const llm = fakeLLM('{"score": 8, "why": "在问所有人"}')
  const r = await judgeRelevance({ text: '谁来帮我看下', llm: LLM, chatCompletion: llm, gate: GATE })
  assert.equal(r.should, true)
  assert.equal(r.score, 8)
})
await test('等于阈值 → 接话（6 分是日常闲聊的正常水平）', async () => {
  const r = await judgeRelevance({ text: '今天好热', llm: LLM, chatCompletion: fakeLLM('{"score": 6}'), gate: GATE })
  assert.equal(r.should, true)
})
await test('低于阈值 → 不接话', async () => {
  const r = await judgeRelevance({ text: '嗯', llm: LLM, chatCompletion: fakeLLM('{"score": 2}'), gate: GATE })
  assert.equal(r.should, false)
})
await test('阈值可配', async () => {
  const r = await judgeRelevance({ text: '今天好热', llm: LLM, chatCompletion: fakeLLM('{"score": 6}'), gate: { ...GATE, threshold: 8 } })
  assert.equal(r.should, false)
})

console.log('\n[3] 降级：判不出来就放行')
await test('调用抛错 → 放行', async () => {
  const r = await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: throwingLLM, gate: GATE })
  assert.equal(r.should, true)
  assert.equal(r.degraded, true)
})
await test('返回看不懂 → 放行', async () => {
  const r = await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: fakeLLM('我不知道'), gate: GATE })
  assert.equal(r.should, true)
  assert.equal(r.degraded, true)
  assert.equal(r.score, null)
})
await test('放行时 degraded 标记为真（供上层记日志）', async () => {
  const r = await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: throwingLLM, gate: GATE })
  assert.match(r.why, /放行/)
})

console.log('\n[4] 请求参数')
await test('gate.model 覆盖主模型', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: llm, gate: { ...GATE, model: 'cheap' } })
  assert.equal(llm.calls[0].llm.model, 'cheap')
})
await test('gate.model 留空时复用主模型', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: llm, gate: GATE })
  assert.equal(llm.calls[0].llm.model, 'main-model')
})
await test('maxTokens 不能太小（推理模型会把正文吃空）', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: llm, gate: GATE })
  assert.ok(llm.calls[0].llm.maxTokens >= 64, `maxTokens=${llm.calls[0].llm.maxTokens} 太小`)
})
await test('temperature 固定 0（判定要稳定）', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: llm, gate: GATE })
  assert.equal(llm.calls[0].llm.temperature, 0)
})
await test('上下文和发言人会带上', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: '这题怎么做', context: '张三：明天考试\n李四：我也没复习', speaker: '王五', llm: LLM, chatCompletion: llm, gate: GATE })
  const userMsg = llm.calls[0].messages[1].content
  assert.match(userMsg, /明天考试/)
  assert.match(userMsg, /这题怎么做/)
  assert.match(userMsg, /王五/)
})
await test('非流式（判定要一次拿全）', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: 'x', llm: LLM, chatCompletion: llm, gate: GATE })
  assert.equal(llm.calls[0].stream, false)
})
await test('不继承主渠道的重试（最多等 8 秒，且不重试）', async () => {
  const llm = fakeLLM('{"score": 7}')
  // 主渠道配了重试 2 次、超时 60 秒
  await judgeRelevance({ text: 'x', llm: { ...LLM, retries: 2, timeoutMs: 60000 }, chatCompletion: llm, gate: GATE })
  assert.equal(llm.calls[0].llm.retries, 0, '判定层不该重试')
  assert.ok(llm.calls[0].llm.timeoutMs <= 8000, `超时应在 8 秒内，实际 ${llm.calls[0].llm.timeoutMs}`)
})
await test('主渠道超时较短时不会被拉长', async () => {
  const llm = fakeLLM('{"score": 7}')
  await judgeRelevance({ text: 'x', llm: { ...LLM, timeoutMs: 3000 }, chatCompletion: llm, gate: GATE })
  assert.equal(llm.calls[0].llm.timeoutMs, 3000)
})

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
