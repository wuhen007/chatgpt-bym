/**
 * chatgpt-bym —— 云崽（Yunzai）伪人模式插件入口。
 *
 * 来源：本项目衍生自 ikechan8370 的 chatgpt-plugin（GPL-3.0）中的「伪人模式（BYM）」，
 * 原项目 https://github.com/ikechan8370/chatgpt-plugin ，版权归原作者所有。
 * 本仓库为剥离重写版本，同样以 GPL-3.0 发布，详见根目录 LICENSE 与 README。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config/config.js'
import { disposeMemory } from './models/memory.js'
import { createShutdown, installShutdownHooks } from './utils/lifecycle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname)

// 云崽各分支（Miao / TRSS）对 segment 的暴露方式不一致，这里兜底一次
if (!global.segment) {
  for (const pkg of ['icqq', 'oekq', 'oicq']) {
    try {
      global.segment = (await import(pkg)).segment
      break
    } catch {
      // 换下一个
    }
  }
}

config.load().watch()

const appsDir = path.join(pluginRoot, 'apps')
const files = fs.existsSync(appsDir)
  ? fs.readdirSync(appsDir).filter(file => file.endsWith('.js'))
  : []

const loaded = await Promise.allSettled(files.map(file => import(`./apps/${file}`)))

/** @type {Record<string, Function>} */
const apps = {}
files.forEach((file, index) => {
  const result = loaded[index]
  const name = file.replace(/\.js$/, '')
  if (result.status !== 'fulfilled') {
    globalThis.logger?.error?.(`[bym] 插件模块 ${name} 加载失败`)
    globalThis.logger?.error?.(result.reason)
    return
  }
  // 一个文件可以导出多个插件类，全部注册
  for (const [exportName, exported] of Object.entries(result.value)) {
    if (typeof exported === 'function') apps[exportName] = exported
  }
})

globalThis.logger?.info?.('**************************************')
globalThis.logger?.info?.('[bym] 伪人模式插件加载完成')
globalThis.logger?.info?.(`[bym] 当前状态：${config.enabled ? '已开启' : '已关闭'}，触发概率 ${config.trigger.probability}`)
globalThis.logger?.info?.('**************************************')

/**
 * 进程退出收尾。
 *
 * pm2 的 `kill_timeout: 10000` 给了 10 秒做清理再 SIGKILL —— 不注册信号处理的话，
 * 这 10 秒是白扔的，最后几条记忆会跟着进程一起没。
 *
 * 只做两件事：把记忆刷盘、停掉配置文件监听。**不调 `process.exit()`** ——
 * 宿主和其他插件可能还有自己的收尾，抢先退出会打断它们。
 *
 * 记忆侧用 `disposeMemory()` 而不是 `flushMemory()`：前者会把攒批的
 * 访问计数一并刷出去，并停掉那个 3 秒定时器（定时器不清的话，
 * 进程退出瞬间还可能触发一次多余的写盘）。
 *
 * logger 用包装对象而不是直接传 `globalThis.logger`：加载时它可能还没挂上，
 * 包一层才能在真正调用时取到最新的。
 */
const shutdown = createShutdown({
  logger: {
    info: (...args) => globalThis.logger?.info?.(...args),
    warn: (...args) => globalThis.logger?.warn?.(...args),
    error: (...args) => globalThis.logger?.error?.(...args),
  },
  tasks: [
    { name: 'memory', run: () => disposeMemory() },
    { name: 'config-watcher', run: () => config.unwatch() },
  ],
})
installShutdownHooks(shutdown)

export { apps, shutdown }
