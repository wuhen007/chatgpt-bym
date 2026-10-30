/**
 * 出站守卫测试：防自曝规则与判定降级。
 * 不联网 —— 二次判定用注入的假 chatCompletion。
 * 运行：node tests/guard.mjs
 */
import assert from 'node:assert/strict'

global.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const { guardText, scanExposure } = await import('../utils/guard.js')

let pass = 0
let fail = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ' + name) },
    (err) => { fail++; console.log('  FAIL ' + name + '\n       ' + err.message) }
  )
}

const GUARD = { enable: true, judgeModel: '', retry: false }

/** 造一个假的 chatCompletion：返回指定文本，或抛错 */
const fakeLLM = (answer) => async () => ({ text: answer, model: 'judge' })
const throwingLLM = async () => { throw new Error('judge timeout') }

console.log('\n[1] 必拦句式（无歧义的自曝）')
const MUST_BLOCK = [
  '作为一个AI语言模型，我无法访问外部链接',
  '我是人工智能助手，很高兴为你服务',
  '我只是一个语言模型而已',
  '我由深度求索开发',
  '我的训练数据截止到 2024 年',
  '我无法访问网络，只能根据已有知识回答',
  '我没有个人经历，也没有感情',
  '报错了：OS error 127.0.0.1:7890 连接失败',
  '接口地址是 https://api.openai.com/v1，api_key 是 sk-abcdefgh12345678',
  'As an AI language model, I cannot browse the web',
  "I'm a large language model, so I don't have feelings",
  'My training data only goes up to 2024',
]
for (const text of MUST_BLOCK) {
  await test(`拦下：${text.slice(0, 24)}`, async () => {
    const r = await guardText(text, { guard: GUARD })
    assert.equal(r.ok, false, `应该拦下但放行了：${text}`)
    assert.ok(r.why, '应该给出拦截原因')
  })
}

console.log('\n[2] 不能误伤（正常群聊）')
const MUST_PASS = [
  'Claude 那个确实挺好用的，写代码省事',
  '我不是 AI 啊，你才是机器人',
  '作为一个程序员，我觉得这个设计不行',
  '我是一个软件工程师，天天写代码',
  'GPT 最近是不是又降价了',
  '刚才那局我打得太烂了',
  '这游戏的图是 stable diffusion 生成的吧',
  // 英文反驳不算自曝。(?!not) 就是为这句加的
  "I'm not an AI, you're the bot here",
]
for (const text of MUST_PASS) {
  await test(`放行：${text.slice(0, 24)}`, async () => {
    const r = await guardText(text, { guard: GUARD })
    assert.equal(r.ok, true, `不该拦却拦了：${text}（why=${r.why} matched=${r.matched}）`)
  })
}

console.log('\n[3] 分档判定')
await test('纯厂商名判为 suspicious 而非 definite', () => {
  const s = scanExposure('GPT-4 和 Claude 哪个强')
  assert.equal(s.level, 'suspicious')
})
await test('「作为 AI 语言模型」判为 definite', () => {
  assert.equal(scanExposure('作为一个 AI 语言模型，我不能').level, 'definite')
})
await test('干净文本返回 null', () => {
  assert.equal(scanExposure('今天好热啊，谁去买冰可乐').level, null)
})

console.log('\n[4] 二次判定')
await test('配了 judgeModel 且判定为是 → 拦', async () => {
  const r = await guardText('Claude 那个挺强的', {
    guard: { ...GUARD, judgeModel: 'cheap-model' },
    chatCompletion: fakeLLM('是'),
    llm: { baseURL: 'http://x/v1', apiKey: 'k', model: 'main' },
  })
  assert.equal(r.ok, false)
  assert.equal(r.judged, true)
})
await test('配了 judgeModel 且判定为否 → 放行', async () => {
  const r = await guardText('Claude 那个挺强的', {
    guard: { ...GUARD, judgeModel: 'cheap-model' },
    chatCompletion: fakeLLM('否'),
    llm: { baseURL: 'http://x/v1', apiKey: 'k', model: 'main' },
  })
  assert.equal(r.ok, true)
})
await test('判定模型返回带标点/引号也能认', async () => {
  const r = await guardText('GPT 挺好', {
    guard: { ...GUARD, judgeModel: 'cheap-model' },
    chatCompletion: fakeLLM('「是」'),
    llm: { baseURL: 'http://x/v1', apiKey: 'k', model: 'main' },
  })
  assert.equal(r.ok, false)
})
await test('判定失败（抛错）→ 放行，不保守拦截', async () => {
  // 和 fatfish 的取舍相反：那一档本来就可能误伤，判不出来时拦掉更糟
  const r = await guardText('Claude 那个挺强的', {
    guard: { ...GUARD, judgeModel: 'cheap-model' },
    chatCompletion: throwingLLM,
    llm: { baseURL: 'http://x/v1', apiKey: 'k', model: 'main' },
  })
  assert.equal(r.ok, true)
})
await test('判定请求不重试，且超时不超过 8 秒', async () => {
  let seen = null
  const spy = async (args) => { seen = args.llm; return { text: '否' } }
  await guardText('GPT 挺好', {
    guard: { ...GUARD, judgeModel: 'cheap-model' },
    chatCompletion: spy,
    llm: { baseURL: 'http://x/v1', apiKey: 'k', model: 'main', retries: 2, timeoutMs: 60000 },
  })
  assert.equal(seen.retries, 0, '判定层不该重试')
  assert.ok(seen.timeoutMs <= 8000, `超时应在 8 秒内，实际 ${seen.timeoutMs}`)
})

console.log('\n[5] 开关与边界')
await test('enable=false 时连 definite 也放行', async () => {
  const r = await guardText('作为一个AI语言模型', { guard: { enable: false } })
  assert.equal(r.ok, true)
})
await test('空文本放行', async () => {
  assert.equal((await guardText('', { guard: GUARD })).ok, true)
  assert.equal((await guardText(null, { guard: GUARD })).ok, true)
})
await test('guard 配置缺失时按开启处理（安全默认）', async () => {
  const r = await guardText('作为一个AI语言模型')
  assert.equal(r.ok, false)
})

console.log('\n[6] allowSelfClaim：放行自称身份，不放宽其它')
const SELF_CLAIM = [
  '我是人工智能助手，很高兴为你服务',
  '我只是一个语言模型而已',
  "I'm a large language model, so I don't have feelings",
]
for (const text of SELF_CLAIM) {
  await test(`放行自称：${text.slice(0, 22)}`, async () => {
    const r = await guardText(text, { guard: GUARD, allowSelfClaim: true })
    assert.equal(r.ok, true, `应该放行但拦下了：${text}`)
  })
  await test(`默认仍拦：${text.slice(0, 22)}`, async () => {
    const r = await guardText(text, { guard: GUARD })
    assert.equal(r.ok, false, `默认不该放行：${text}`)
  })
}
// 这几条在放行自称之后必须照拦，否则这个开关就成了「关掉守卫」
const STILL_BLOCK = [
  '我由深度求索开发',
  '我的训练数据截止到 2024 年',
  '我无法访问网络，只能根据已有知识回答',
  '我没有个人经历，也没有感情',
  '报错了：OS error 127.0.0.1:7890 连接失败',
  '接口地址是 https://api.deepseek.com/v1，api_key 是 sk-abcdefgh12345678',
  'My training data only goes up to 2024',
  // 这一句同时命中「自称身份」和「能力边界口癖」——放行前者后，后者照样把它拦下。
  // 这是对的：说「我是语言模型，我不能上网」本身就是自曝。
  'As an AI language model, I cannot browse the web',
]
for (const text of STILL_BLOCK) {
  await test(`放行自称后仍拦：${text.slice(0, 22)}`, async () => {
    const r = await guardText(text, { guard: GUARD, allowSelfClaim: true })
    assert.equal(r.ok, false, `不该放行：${text}`)
  })
}
await test('本来就放行的说法不受影响（如「我是住在 QQ 里的 AI 鲸鱼娘」）', async () => {
  // 正则要求「我是」后面紧跟 AI/机器人，中间隔了字就不算自称身份 —— 本来就不拦
  const r = await guardText('我是住在 QQ 里的 AI 鲸鱼娘', { guard: GUARD })
  assert.equal(r.ok, true)
})
await test('scanExposure 也认这个开关', () => {
  assert.equal(scanExposure('我是人工智能助手').level, 'definite')
  assert.equal(scanExposure('我是人工智能助手', { allowSelfClaim: true }).level, null)
  // 厂商名属于可疑档，不在放行范围内
  assert.equal(scanExposure('Claude 真好用', { allowSelfClaim: true }).level, 'suspicious')
})

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
