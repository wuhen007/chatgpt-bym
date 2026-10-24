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

export { apps }
