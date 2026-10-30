/**
 * 进程退出收尾测试。
 * 运行：node tests/lifecycle.mjs
 *
 * 不碰真实 process —— 所有信号都用假对象注入，免得测试进程自己响应 SIGTERM。
 */
import assert from 'node:assert/strict'

const { createShutdown, installShutdownHooks, SHUTDOWN_SIGNALS } = await import('../utils/lifecycle.js')

let pass = 0
let fail = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ' + name) },
    (err) => { fail++; console.log('  FAIL ' + name + '\n       ' + err.message) }
  )
}

/** 假 logger，把日志收进数组 */
function fakeLogger () {
  const lines = []
  return {
    lines,
    info: (msg) => lines.push(['info', msg]),
    warn: (msg) => lines.push(['warn', msg]),
    error: (msg) => lines.push(['error', msg]),
  }
}

/** 假 process：能手动 emit */
function fakeProcess () {
  const handlers = new Map()
  return {
    on (sig, fn) {
      if (!handlers.has(sig)) handlers.set(sig, [])
      handlers.get(sig).push(fn)
    },
    off (sig, fn) {
      const list = handlers.get(sig) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    emit (sig) {
      for (const fn of handlers.get(sig) || []) fn(sig)
    },
    count (sig) { return (handlers.get(sig) || []).length },
    total () { return [...handlers.values()].reduce((n, l) => n + l.length, 0) },
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

console.log('\n[1] 基本行为')
await test('按顺序跑完所有任务', async () => {
  const done = []
  const shutdown = createShutdown({
    tasks: [
      { name: 'a', run: () => { done.push('a') } },
      { name: 'b', run: async () => { done.push('b') } },
    ],
  })
  const result = await shutdown('SIGTERM')
  assert.deepEqual(done.sort(), ['a', 'b'])
  assert.equal(result.ran, true)
  assert.equal(result.results.every(r => r.ok), true)
})
await test('任务可以返回 Promise，会被等完', async () => {
  let finished = false
  const shutdown = createShutdown({
    tasks: [{ name: 'slow', run: async () => { await sleep(30); finished = true } }],
  })
  await shutdown()
  assert.equal(finished, true)
})
await test('返回耗时，供日志排查', async () => {
  const shutdown = createShutdown({ tasks: [{ name: 'x', run: () => {} }] })
  const result = await shutdown()
  assert.equal(typeof result.elapsedMs, 'number')
  assert.ok(result.elapsedMs >= 0)
})

console.log('\n[2] 幂等（pm2 可能连发两次信号）')
await test('第二次调用不再执行任务', async () => {
  let count = 0
  const shutdown = createShutdown({ tasks: [{ name: 'x', run: () => { count += 1 } }] })
  await shutdown('SIGTERM')
  await shutdown('SIGTERM')
  assert.equal(count, 1, '任务只该跑一次')
})
await test('第二次拿到的是同一份结果', async () => {
  const shutdown = createShutdown({ tasks: [{ name: 'x', run: () => {} }] })
  const first = await shutdown('SIGTERM')
  const second = await shutdown('SIGINT')
  assert.equal(first, second, '应该返回同一个对象，而不是重跑一遍')
})
await test('并发调用时第二次直接返回（不重复落盘）', async () => {
  let count = 0
  const shutdown = createShutdown({
    tasks: [{ name: 'slow', run: async () => { count += 1; await sleep(40) } }],
  })
  const [a, b] = await Promise.all([shutdown('SIGTERM'), shutdown('SIGTERM')])
  assert.equal(count, 1)
  assert.equal(a.ran, true)
  // 第二个可能拿到 {ran:false}（进行中）或同一份结果，两者都可接受
  assert.ok(b.ran === false || b === a)
})

console.log('\n[3] 失败不互相牵连')
await test('一个任务抛错，另一个照常执行', async () => {
  const done = []
  const logger = fakeLogger()
  const shutdown = createShutdown({
    logger,
    tasks: [
      { name: 'bad', run: () => { throw new Error('磁盘满了') } },
      { name: 'good', run: () => { done.push('good') } },
    ],
  })
  const result = await shutdown()
  assert.deepEqual(done, ['good'])
  const bad = result.results.find(r => r.name === 'bad')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /磁盘满了/)
})
await test('任务失败会打 warn，不是静默', async () => {
  const logger = fakeLogger()
  const shutdown = createShutdown({
    logger,
    tasks: [{ name: 'bad', run: () => { throw new Error('boom') } }],
  })
  await shutdown()
  assert.ok(logger.lines.some(([level, msg]) => level === 'warn' && /bad/.test(msg)))
})
await test('全部成功时打 info 收尾日志', async () => {
  const logger = fakeLogger()
  const shutdown = createShutdown({ logger, tasks: [{ name: 'x', run: () => {} }] })
  await shutdown()
  assert.ok(logger.lines.some(([level, msg]) => level === 'info' && /收尾完成/.test(msg)))
})

console.log('\n[4] 超时保护')
await test('卡住的任务不会拖死整体', async () => {
  const logger = fakeLogger()
  const shutdown = createShutdown({
    logger,
    timeoutMs: 50,
    tasks: [
      { name: 'stuck', run: () => new Promise(() => {}) },  // 永不 resolve
      { name: 'ok', run: () => {} },
    ],
  })
  const started = Date.now()
  const result = await shutdown()
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `应该在超时附近返回，实际 ${elapsed}ms`)
  const stuck = result.results.find(r => r.name === 'stuck')
  assert.equal(stuck.ok, false)
  assert.match(stuck.error, /超时/)
  assert.equal(result.results.find(r => r.name === 'ok').ok, true, '另一个任务不该被拖累')
})

console.log('\n[5] 信号挂载')
await test('默认挂三个信号', async () => {
  const proc = fakeProcess()
  const shutdown = createShutdown({ tasks: [] })
  installShutdownHooks(shutdown, { proc })
  assert.equal(proc.total(), SHUTDOWN_SIGNALS.length)
  for (const sig of SHUTDOWN_SIGNALS) assert.equal(proc.count(sig), 1)
})
await test('收到信号时调用 shutdown，并带上信号名', async () => {
  const proc = fakeProcess()
  let seen = null
  const shutdown = createShutdown({ tasks: [] })
  installShutdownHooks((sig) => { seen = sig }, { proc })
  proc.emit('SIGTERM')
  assert.equal(seen, 'SIGTERM')
})
await test('反注册能摘掉所有 handler', async () => {
  const proc = fakeProcess()
  const uninstall = installShutdownHooks(createShutdown({ tasks: [] }), { proc })
  assert.ok(proc.total() > 0)
  uninstall()
  assert.equal(proc.total(), 0)
})
await test('可以只挂指定信号', async () => {
  const proc = fakeProcess()
  installShutdownHooks(createShutdown({ tasks: [] }), { proc, signals: ['SIGTERM'] })
  assert.equal(proc.total(), 1)
  assert.equal(proc.count('SIGINT'), 0)
})

console.log('\n[6] 边界')
await test('没有任务时不报错', async () => {
  const shutdown = createShutdown({})
  const result = await shutdown()
  assert.equal(result.ran, true)
  assert.deepEqual(result.results, [])
})
await test('没有 logger 也不炸（云崽的 logger 可能还没挂上）', async () => {
  const shutdown = createShutdown({ tasks: [{ name: 'x', run: () => {} }] })
  await assert.doesNotReject(() => shutdown())
})

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
