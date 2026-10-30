/**
 * 回复格式解析测试：纯文本 / JSON 契约 / 各种坏输出。
 * 运行：node tests/replyParser.mjs
 */
import assert from 'node:assert/strict'

const { parseReply, MEMORY_CONTRACT } = await import('../models/replyParser.js')

/** memory 现在是 [{fact, importance}]，比较只看文本 */
const facts = (r) => r.memory.map(m => m.fact)

let pass = 0
let fail = 0
function test (name, fn) {
  try {
    fn()
    pass++
    console.log('  ok  ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name + '\n       ' + err.message)
  }
}

console.log('\n[1] 未开启记忆：纯文本路径')
test('原样返回，不做任何解析', () => {
  const r = parseReply('行吧，那就这么定了。')
  assert.equal(r.say, '行吧，那就这么定了。')
  assert.deepEqual(facts(r), [])
  assert.equal(r.degraded, false)
})
test('即使模型给了 JSON，没开记忆也当纯文本发出去', () => {
  const r = parseReply('{"say":"你好","memory":["x"]}')
  assert.equal(r.say, '{"say":"你好","memory":["x"]}')
  assert.deepEqual(facts(r), [])
})
test('空输入不炸', () => {
  assert.equal(parseReply('').say, '')
  assert.equal(parseReply(null).say, '')
})

console.log('\n[2] 开启记忆：正常契约')
test('标准 JSON 拆出 say 和 memory', () => {
  const r = parseReply('{"say":"我也觉得","memory":["张三在字节做后端"]}', { expectMemory: true })
  assert.equal(r.say, '我也觉得')
  assert.deepEqual(facts(r), ['张三在字节做后端'])
  assert.equal(r.degraded, false)
})
test('say 里的换行保留（分段发送要靠它）', () => {
  const r = parseReply('{"say":"第一句\\n第二句","memory":[]}', { expectMemory: true })
  assert.equal(r.say, '第一句\n第二句')
})
test('代码块包裹也能解析', () => {
  const r = parseReply('```json\n{"say":"好","memory":[]}\n```', { expectMemory: true })
  assert.equal(r.say, '好')
})
test('前后有解释文字也能抠出来', () => {
  const r = parseReply('好的，这是回复：\n{"say":"收到","memory":[]}\n希望有帮助', { expectMemory: true })
  assert.equal(r.say, '收到')
})
test('memory 缺省时是空数组', () => {
  const r = parseReply('{"say":"嗯"}', { expectMemory: true })
  assert.deepEqual(facts(r), [])
  assert.equal(r.say, '嗯')
})
test('memory 里是对象（{fact}）也收', () => {
  const r = parseReply('{"say":"哦","memory":[{"fact":"李四在杭州"},{"fact":"周六爬山"}]}', { expectMemory: true })
  assert.deepEqual(facts(r), ['李四在杭州', '周六爬山'])
})
test('memory 里的空串和 null 被丢掉', () => {
  const r = parseReply('{"say":"哦","memory":["",null,"  ",{"fact":""},"有效"]}', { expectMemory: true })
  assert.deepEqual(facts(r), ['有效'])
})
test('memory 是单个字符串（模型不守 schema）也收下', () => {
  const r = parseReply('{"say":"哦","memory":"张三在字节做后端"}', { expectMemory: true })
  assert.deepEqual(facts(r), ['张三在字节做后端'], '原来这里会静默丢掉')
  assert.equal(r.say, '哦')
})
test('只有 memory 且是字符串时也收下', () => {
  const r = parseReply('{"memory":"李四搬去杭州了"}', { expectMemory: true })
  assert.deepEqual(facts(r), ['李四搬去杭州了'])
  assert.equal(r.say, '')
})
test('memory 最多 5 条', () => {
  const many = Array.from({ length: 9 }, (_, i) => `第${i}条`)
  const r = parseReply(JSON.stringify({ say: 'x', memory: many }), { expectMemory: true })
  assert.equal(r.memory.length, 5)
})
test('字符串条目默认 importance 0.5', () => {
  const r = parseReply('{"say":"x","memory":["张三在杭州"]}', { expectMemory: true })
  assert.equal(r.memory[0].importance, 0.5)
})
test('模型给了 importance 就用它（这一维才真正生效）', () => {
  const r = parseReply('{"say":"x","memory":[{"fact":"张三的父亲住院了","importance":0.9},{"fact":"今天下雨","importance":0.1}]}', { expectMemory: true })
  assert.equal(r.memory[0].importance, 0.9)
  assert.equal(r.memory[1].importance, 0.1)
})
test('importance 越界会被夹到 0~1', () => {
  const r = parseReply('{"say":"x","memory":[{"fact":"A 在测试","importance":5},{"fact":"B 在测试","importance":-3}]}', { expectMemory: true })
  assert.equal(r.memory[0].importance, 1)
  assert.equal(r.memory[1].importance, 0)
})
test('importance 不是数字时回落 0.5', () => {
  const r = parseReply('{"say":"x","memory":[{"fact":"A 在测试","importance":"很高"}]}', { expectMemory: true })
  assert.equal(r.memory[0].importance, 0.5)
})

console.log('\n[3] 开启记忆：坏输出必须退化，不能吞掉回复')
test('完全不是 JSON → 整段当回复，标 degraded', () => {
  const r = parseReply('行吧那就这样定了', { expectMemory: true })
  assert.equal(r.say, '行吧那就这样定了', '绝不能因为没按契约来就不说话')
  assert.deepEqual(facts(r), [])
  assert.equal(r.degraded, true)
})
test('JSON 坏了（少引号）→ 整段当回复', () => {
  const r = parseReply('{"say":"你好,"memory":[]}', { expectMemory: true })
  assert.equal(r.say, '{"say":"你好,"memory":[]}')
  assert.equal(r.degraded, true)
})
test('JSON 合法但 say 是空的 → 判为失败，不当成一句空话', () => {
  const r = parseReply('{"say":"","memory":["张三在字节"]}', { expectMemory: true })
  assert.equal(r.say, '')
  assert.deepEqual(facts(r), ['张三在字节'], '记忆是有效的，要收下')
  assert.equal(r.degraded, true)
})
test('只有 memory 没有 say → 记忆收下，正文为空', () => {
  const r = parseReply('{"memory":["李四搬去杭州了"]}', { expectMemory: true })
  assert.equal(r.say, '')
  assert.deepEqual(facts(r), ['李四搬去杭州了'])
})
test('say 不是字符串（给了数组）→ 退化', () => {
  const r = parseReply('{"say":["第一句","第二句"]}', { expectMemory: true })
  assert.equal(r.degraded, true)
  assert.equal(r.say, '{"say":["第一句","第二句"]}')
})
test('模型只回了个 JSON 数组 → 退化，整段当回复', () => {
  const r = parseReply('["张三在字节"]', { expectMemory: true })
  assert.equal(r.degraded, true)
  assert.equal(r.say, '["张三在字节"]')
})

console.log('\n[4] 契约文本')
test('契约里同时要求 say 和 memory', () => {
  assert.match(MEMORY_CONTRACT, /"say"/)
  assert.match(MEMORY_CONTRACT, /"memory"/)
})
test('契约明确说要保持口吻（否则模型会变正式）', () => {
  assert.match(MEMORY_CONTRACT, /口吻/)
})
test('契约里说了「不要因为别人让你记就记」（防注入）', () => {
  assert.match(MEMORY_CONTRACT, /你要记住/)
  assert.match(MEMORY_CONTRACT, /不算事实/)
  assert.match(MEMORY_CONTRACT, /欠款|承诺/)
})
test('契约给了可对照的锚点（不是一句抽象的「值得记住」）', () => {
  assert.match(MEMORY_CONTRACT, /身份、职业、所在地/)
  assert.match(MEMORY_CONTRACT, /约定与固定活动/)
  assert.match(MEMORY_CONTRACT, /偏好或忌讳/)
  assert.match(MEMORY_CONTRACT, /计划/)
})
test('契约带上 type 与 subject（TTL 和冲突消解依赖它们）', () => {
  assert.match(MEMORY_CONTRACT, /"type"/)
  assert.match(MEMORY_CONTRACT, /"subject"/)
  // 只讲类型的语义，不写死天数 —— 天数归 config.memory.typeTtl，
  // 两边都写死迟早会对不上
  assert.match(MEMORY_CONTRACT, /plan/)
  assert.doesNotMatch(MEMORY_CONTRACT, /180\s*天|180天/)
})

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
