/**
 * 上下文预算裁剪测试。
 * 运行：node tests/budget.mjs
 */
import assert from 'node:assert/strict'

const { fitBudget, hasDropped, DEFAULT_MAX_CHARS } = await import('../utils/budget.js')

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

/** 造 n 条长度固定的群记录 */
const lines = (n, len = 20) => Array.from({ length: n }, (_, i) => `第${i + 1}条`.padEnd(len, '。'))

console.log('\n[1] 没超预算时不动任何人')
test('总量小于预算 → 原样返回', () => {
  const r = fitBudget({
    system: '人设'.repeat(10),
    groupHeader: '表头',
    groupLines: lines(3),
    memory: '记忆',
    userText: '你好',
    maxChars: 1000,
  })
  assert.equal(r.groupText.split('\n').length, 4, '表头 + 3 条')
  assert.equal(r.memory, '记忆')
  assert.equal(r.userText, '你好')
  assert.deepEqual(r.dropped, { memory: false, groupLines: 0, truncatedUser: false })
  assert.equal(hasDropped(r.dropped), false)
})
test('边界：刚好等于预算时不裁', () => {
  const parts = { system: 'x'.repeat(100), groupHeader: '', groupLines: [], memory: '', userText: 'y'.repeat(100) }
  const r = fitBudget({ ...parts, maxChars: 200 })
  assert.equal(r.userText.length, 100)
  assert.equal(hasDropped(r.dropped), false)
})

console.log('\n[2] 裁剪顺序：记忆 → 群记录 → 本轮')
test('超一点时先丢记忆', () => {
  // 200 + 1(表头) + 104(5×20 行) + 200(记忆) + 2(本轮) = 507，预算 500
  const r = fitBudget({
    system: 'x'.repeat(200),
    groupHeader: 'h',
    groupLines: lines(5, 20),
    memory: 'm'.repeat(200),
    userText: '你好',
    maxChars: 500,
  })
  assert.equal(r.dropped.memory, true, '记忆应该先被丢')
  assert.equal(r.dropped.groupLines, 0, '还没轮到群记录')
  assert.equal(r.groupText.split('\n').length, 6, '群记录应完整保留')
})
test('丢完记忆还超，才动群记录', () => {
  const r = fitBudget({
    system: 'x'.repeat(400),
    groupHeader: 'h',
    groupLines: lines(20, 40),
    memory: 'm'.repeat(100),
    userText: '你好',
    maxChars: 800,
  })
  assert.equal(r.dropped.memory, true)
  assert.ok(r.dropped.groupLines > 0, '应该开始丢群记录')
})
test('群记录从最早的开始丢，保留最近几条', () => {
  const all = lines(10, 40)
  // 300 + 1(表头) + 410(10×40 行) + 1(本轮) = 712，预算 500 → 大约只剩 4~5 条
  const r = fitBudget({
    system: 'x'.repeat(300),
    groupHeader: 'H',
    groupLines: all,
    memory: '',
    userText: 'u',
    maxChars: 500,
  })
  const kept = r.groupText.split('\n').slice(1)
  assert.ok(kept.length > 0 && kept.length < 10, `保留条数应介于 1 和 10 之间，实际 ${kept.length}`)
  assert.equal(kept.at(-1), all.at(-1), '最新的那条必须还在')
  assert.equal(kept[0], all.at(all.length - kept.length), '丢的是前面（最早）的')
})

console.log('\n[3] 极端情况')
test('至少保留最新一条（只要放得下）', () => {
  // 400 + 1 + 801 + 1 = 1203，预算 600 → 会从 20 条砍到只剩几条，但不会砍到 0
  const r = fitBudget({
    system: 'x'.repeat(400),
    groupHeader: 'H',
    groupLines: lines(20, 40),
    memory: 'm',
    userText: 'hi',
    maxChars: 600,
  })
  const kept = r.groupText.split('\n').slice(1)
  assert.ok(kept.length >= 1, '不能把群记录砍到一条都不剩')
  assert.equal(kept.at(-1), lines(20, 40).at(-1), '留下的是最新的那条')
})
test('连最后一条都放不下时才清空，且不留孤零零的表头', () => {
  const r = fitBudget({
    system: 'x'.repeat(560),
    groupHeader: 'H',
    groupLines: lines(1, 200),
    memory: '',
    userText: 'hi',
    maxChars: 600,
  })
  assert.equal(r.groupText, '', 'groupText 应为空串，而不是只剩表头')
})
test('前三步都丢完还超，才截断本轮消息并补省略号', () => {
  const r = fitBudget({
    system: 'x'.repeat(100),
    groupHeader: '',
    groupLines: [],
    memory: '',
    userText: 'y'.repeat(500),
    maxChars: 300,
  })
  assert.equal(r.dropped.truncatedUser, true)
  assert.ok(r.userText.endsWith('…'))
  assert.ok(r.userText.length < 500)
})
test('截断也保留最低可读长度（不会截成空串）', () => {
  const r = fitBudget({
    system: 'x'.repeat(1000),
    groupHeader: '',
    groupLines: [],
    memory: '',
    userText: 'y'.repeat(500),
    maxChars: 600,
  })
  assert.equal(r.dropped.truncatedUser, true)
  assert.ok(r.userText.length >= 21, `截断后长度 ${r.userText.length} 太短`)
})
test('人设永远不裁（哪怕预算被它吃光）', () => {
  const system = '人格'.repeat(500)
  const r = fitBudget({ system, groupHeader: 'H', groupLines: lines(5, 30), memory: 'mem', userText: 'hi', maxChars: 500 })
  assert.equal(r.system, undefined, 'fitBudget 不返回 system，调用方原样使用')
  assert.equal(r.groupText, '')
  assert.equal(r.memory, '')
})

console.log('\n[4] 参数容错')
test('maxChars 缺失时用默认值', () => {
  const r = fitBudget({ system: '', groupHeader: 'H', groupLines: lines(3, 20), memory: '', userText: 'hi' })
  assert.equal(r.dropped.groupLines, 0)
  assert.ok(DEFAULT_MAX_CHARS >= 4000)
})
test('maxChars 传 0 / 负数 / 非法值都退回默认（不会把预算算成 0 全裁光）', () => {
  for (const bad of [0, -1, 'abc', null, undefined]) {
    const r = fitBudget({ system: '', groupHeader: 'H', groupLines: lines(3, 20), memory: '', userText: 'hi', maxChars: bad })
    assert.equal(r.dropped.groupLines, 0, `maxChars=${bad} 不该触发裁剪`)
  }
})
test('maxChars 有 500 的下限：设太小会被抬到 500，而不是把自己裁成空', () => {
  // 400 字的内容 + 预算 200：如果真按 200 算会被砍光，实际按 500 算则原样保留
  const r = fitBudget({ system: '', groupHeader: '', groupLines: [], memory: '', userText: 'y'.repeat(400), maxChars: 200 })
  assert.equal(r.dropped.truncatedUser, false)
  assert.equal(r.userText.length, 400)
})
test('groupLines 不是数组时不炸', () => {
  const r = fitBudget({ system: 'x', groupHeader: 'H', groupLines: null, memory: '', userText: 'hi', maxChars: 500 })
  assert.equal(r.groupText, '')
})
test('空输入返回空结构', () => {
  const r = fitBudget({})
  assert.equal(r.groupText, '')
  assert.equal(r.memory, '')
  assert.equal(r.userText, '')
  assert.equal(hasDropped(r.dropped), false)
})

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
