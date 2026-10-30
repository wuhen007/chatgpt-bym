/**
 * 入口去重与回声守卫测试。
 * 用假的 Date.now 控制时间，验证 TTL 与硬上限。
 * 运行：node tests/dedup.mjs
 */
import assert from 'node:assert/strict'

global.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const { checkIncoming, rememberSelf, resetDedup, dedupStats, ID_TTL, CONTENT_TTL, ECHO_TTL } = await import('../utils/dedup.js')

let pass = 0
let fail = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ' + name) },
    (err) => { fail++; console.log('  FAIL ' + name + '\n       ' + err.message) }
  )
}

const realNow = Date.now
let clock = 1_700_000_000_000
Date.now = () => clock
const tick = (ms) => { clock += ms }

/** 造一条群消息事件 */
const ev = ({ id = 1, gid = '100', uid = '7', text = '在吗' } = {}) => ({
  message_id: id, group_id: gid, user_id: uid, raw_message: text,
})

const reset = () => { resetDedup(); clock = 1_700_000_000_000 }

console.log('\n[1] message_id 去重')
await test('同一条消息第二次被丢弃', () => {
  reset()
  assert.equal(checkIncoming(ev({ id: 10 }), '在吗').dup, null)
  assert.equal(checkIncoming(ev({ id: 10 }), '在吗').dup, 'id')
})
await test('id 不同但内容相同也算重复（协议端重投会换 id）', () => {
  reset()
  checkIncoming(ev({ id: 1 }), '今晚打不打')
  assert.equal(checkIncoming(ev({ id: 2 }), '今晚打不打').dup, 'content')
})
await test('没有 message_id 时退回 seq', () => {
  reset()
  const a = { group_id: '100', user_id: '7', seq: 555 }
  const b = { group_id: '100', user_id: '7', seq: 555 }
  assert.equal(checkIncoming(a, '一').dup, null)
  assert.equal(checkIncoming(b, '二').dup, 'id')
})
await test('两个 id 字段都没有时只按内容去重', () => {
  reset()
  const a = { group_id: '100', user_id: '7' }
  assert.equal(checkIncoming(a, '无 id 的消息').dup, null)
  assert.equal(checkIncoming({ ...a }, '无 id 的消息').dup, 'content')
})

console.log('\n[2] 内容去重的作用域')
await test('同一句话不同人发，不算重复', () => {
  reset()
  checkIncoming(ev({ id: 1, uid: '7' }), '哈哈哈哈')
  assert.equal(checkIncoming(ev({ id: 2, uid: '8' }), '哈哈哈哈').dup, null)
})
await test('同一句话不同群，不算重复', () => {
  reset()
  checkIncoming(ev({ id: 1, gid: '100' }), '收到')
  assert.equal(checkIncoming(ev({ id: 2, gid: '200' }), '收到').dup, null)
})
await test('私聊（无 group_id）单独成域', () => {
  reset()
  checkIncoming({ message_id: 1, user_id: '7' }, '在吗')
  assert.equal(checkIncoming({ message_id: 2, user_id: '7' }, '在吗').dup, 'content')
})

console.log('\n[3] 回声守卫')
await test('自己刚发过的话被推回来时丢弃', () => {
  reset()
  rememberSelf(ev({ id: 50 }), '好耶，那就这么定了')
  assert.equal(checkIncoming(ev({ id: 99, uid: 'bot' }), '好耶，那就这么定了').dup, 'echo')
})
await test('回声不区分发送者（协议端会伪装成别人）', () => {
  reset()
  rememberSelf(ev({ id: 51 }), '我来了')
  assert.equal(checkIncoming(ev({ id: 1, uid: '随便谁' }), '我来了').dup, 'echo')
})
await test('回声按群隔离：A 群说过的话不挡 B 群', () => {
  reset()
  rememberSelf(ev({ id: 60, gid: '100' }), '哈哈哈这波可以')
  assert.equal(
    checkIncoming(ev({ id: 61, gid: '200', uid: '8' }), '哈哈哈这波可以').dup,
    null,
    'B 群群友发同样的文本不该被当回声'
  )
})
await test('空白内容不会被当成回声', () => {
  reset()
  rememberSelf(ev({ id: 52 }), '   ')
  assert.equal(dedupStats().echoes, 0)
})
await test('回声窗口过期后正常放行', () => {
  reset()
  rememberSelf(ev({ id: 53 }), '哈哈哈')
  tick(ECHO_TTL + 1000)
  assert.equal(checkIncoming(ev({ id: 2, uid: '9' }), '哈哈哈').dup, null)
})

console.log('\n[4] TTL 过期')
await test('id 记录过期后同 id 不再被丢弃', () => {
  reset()
  checkIncoming(ev({ id: 66 }), '第一条')
  tick(ID_TTL + 1000)
  assert.equal(checkIncoming(ev({ id: 66 }), '第二条').dup, null)
})
await test('内容记录过期后同人同话不再被丢弃', () => {
  reset()
  checkIncoming(ev({ id: 1 }), '在吗在吗')
  tick(CONTENT_TTL + 1000)
  assert.equal(checkIncoming(ev({ id: 2 }), '在吗在吗').dup, null)
})
await test('过期项会被真正清掉，不残留', () => {
  reset()
  for (let i = 0; i < 20; i++) checkIncoming(ev({ id: i }), `消息${i}`)
  assert.equal(dedupStats().ids, 20)
  tick(ID_TTL + 1000)
  checkIncoming(ev({ id: 999 }), '新消息')
  assert.equal(dedupStats().ids, 1, '旧 id 应被清空，只剩刚写入的这一条')
})

console.log('\n[5] 硬上限')
await test('短时间内大量消息不会让表无限增长', () => {
  reset()
  for (let i = 0; i < 1500; i++) checkIncoming(ev({ id: i, uid: String(i) }), `内容${i}`)
  const s = dedupStats()
  assert.ok(s.ids <= 600, `ids 表超限：${s.ids}`)
  assert.ok(s.contents <= 600, `contents 表超限：${s.contents}`)
})

console.log('\n[6] 组合场景')
await test('真实死循环：自己发的被推回来 → 不再触发', () => {
  reset()
  // 第一轮：群友说话，我们回复并记录
  assert.equal(checkIncoming(ev({ id: 1 }), '今天好热').dup, null)
  rememberSelf(ev({ id: 54 }), '热死了，空调开到 16 度')
  // 协议端把我们的消息推回来
  assert.equal(checkIncoming(ev({ id: 2, uid: 'bot' }), '热死了，空调开到 16 度').dup, 'echo')
  // 再来一次（多适配器场景）
  assert.equal(checkIncoming(ev({ id: 3, uid: 'bot' }), '热死了，空调开到 16 度').dup, 'echo')
})
await test('resetDedup 清干净', () => {
  reset()
  checkIncoming(ev({ id: 1 }), 'a')
  rememberSelf(ev({ id: 55 }), 'b')
  assert.deepEqual(dedupStats(), { ids: 1, contents: 1, echoes: 1 })
  resetDedup()
  assert.deepEqual(dedupStats(), { ids: 0, contents: 0, echoes: 0 })
})

Date.now = realNow
console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
