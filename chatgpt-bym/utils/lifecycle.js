/**
 * 进程退出时的收尾。
 *
 * 为什么需要：TRSS-Yunzai 的 pm2 配置里写着 `kill_timeout: 10000`，
 * 注释是「pm2 停止/重启进程的等待时间，需大于插件退出清理的耗时，
 * 否则进程会被 SIGKILL 强杀」。也就是说 pm2 会给我们 10 秒做收尾 ——
 * 但如果不注册信号处理，这 10 秒就是白扔的，最后几条记忆跟着进程一起没了。
 *
 * 两条纪律：
 *
 * 1. **只 flush，不调 `process.exit()`。** 宿主和其他插件可能还有自己的收尾动作，
 *    抢先退出会把它们打断。我们做完自己的事就安静返回，让 pm2 继续走流程。
 * 2. **幂等。** pm2 停止时可能连发 SIGTERM，第二次进来直接返回，不重复刷盘。
 *
 * 任务并行执行而不是串行：两个任务互不依赖，串行只会白白消耗那 10 秒预算。
 * 每个任务各自有超时 —— 磁盘满、网络盘挂起时，卡住的那一个不该拖垮另一个。
 */

/** 默认监听的信号。SIGHUP 是部分终端关闭时发的，一并处理 */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP']

/** 整体预算。pm2 给 10 秒，留一半余量防止被 SIGKILL */
const DEFAULT_TIMEOUT_MS = 5000

function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 造一个收尾函数。
 *
 * @param {object} options
 * @param {Array<{name: string, run: () => (void|Promise<void>)}>} options.tasks
 * @param {object} [options.logger] 有 info/warn/error 即可
 * @param {number} [options.timeoutMs] 单个任务的超时
 * @returns {(signal?: string) => Promise<{ran: boolean, results?: Array}>}
 */
export function createShutdown ({ tasks = [], logger, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let running = false
  let finished = null

  return async function shutdown (signal = 'shutdown') {
    // 已经跑过：把同一个结果给回第二个调用方，避免重复落盘
    if (finished) return finished
    if (running) return { ran: false, reason: 'in-progress' }
    running = true

    const start = Date.now()
    logger?.info?.(`[bym] 收到 ${signal}，开始收尾（${tasks.length} 项）`)

    // 并行跑，各自超时；一个失败不影响另一个
    const results = await Promise.all(tasks.map(async ({ name, run }) => {
      try {
        await withTimeout(Promise.resolve().then(run), timeoutMs, name)
        return { name, ok: true }
      } catch (err) {
        logger?.warn?.(`[bym] 收尾项 ${name} 失败：${err.message}`)
        return { name, ok: false, error: err.message }
      }
    }))

    const failed = results.filter(item => !item.ok)
    const elapsed = Date.now() - start
    if (failed.length === 0) {
      logger?.info?.(`[bym] 收尾完成（${elapsed}ms）`)
    } else {
      logger?.warn?.(`[bym] 收尾完成，${failed.length} 项失败（${elapsed}ms）`)
    }

    finished = { ran: true, results, elapsedMs: elapsed }
    running = false
    return finished
  }
}

/**
 * 把收尾函数挂到进程信号上。
 *
 * `proc` 可以注入，测试时传假对象，避免污染真实进程。
 *
 * @param {Function} shutdown createShutdown 的返回值
 * @param {object} [options]
 * @param {NodeJS.Process} [options.proc] 默认 process
 * @param {string[]} [options.signals]
 * @returns {Function} 反注册函数
 */
export function installShutdownHooks (shutdown, { proc = process, signals = SHUTDOWN_SIGNALS } = {}) {
  const handlers = new Map()

  for (const signal of signals) {
    // 用 once 会在第一次触发后自动摘掉，但我们需要幂等而不是"只响一次"
    // （pm2 可能连发两次，第二次进了 createShutdown 会自己短路）
    const handler = () => { shutdown(signal) }
    handlers.set(signal, handler)
    proc.on(signal, handler)
  }

  return function uninstall () {
    for (const [signal, handler] of handlers) {
      proc.off?.(signal, handler)
    }
    handlers.clear()
  }
}
