import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../config/config.js'
import { loadPresets } from '../models/preset.js'
import { clearMemory, memoryStats } from '../models/memory.js'
import { rateStats, resetRate } from '../utils/rateLimit.js'
import { clearContextCache } from '../utils/groupContext.js'
import { dryRun } from '../models/chatService.js'

function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function maskKey (key) {
  if (!key) return '未配置'
  const text = String(key)
  if (text.length <= 8) return '已配置'
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

/**
 * 管理指令。全部要求主人权限：伪人会以机器人身份在群里说话，
 * 误操作的影响面比普通功能大。
 */
export class BymAdmin extends plugin {
  constructor () {
    const prefix = escapeRegExp(config.data.commandPrefix || '#bym')
    super({
      name: '伪人模式管理',
      dsc: '伪人模式开关、状态与调试',
      event: 'message',
      priority: 10,
      rule: [
        { reg: `^${prefix}\\s*(状态|status)$`, fnc: 'status', permission: 'master' },
        { reg: `^${prefix}\\s*(开|开启|on)$`, fnc: 'enable', permission: 'master' },
        { reg: `^${prefix}\\s*(关|关闭|off)$`, fnc: 'disable', permission: 'master' },
        { reg: `^${prefix}\\s*(重载|reload)$`, fnc: 'reload', permission: 'master' },
        { reg: `^${prefix}\\s*(测试|test)\\s*([\\s\\S]+)$`, fnc: 'test', permission: 'master' },
        { reg: `^${prefix}\\s*记忆$`, fnc: 'memory', permission: 'master' },
        { reg: `^${prefix}\\s*(清空|清除)记忆$`, fnc: 'clearMemoryCmd', permission: 'master' },
      ],
    })
  }

  async status (e) {
    const presets = loadPresets(true)
    const rate = e.isGroup ? rateStats(e.group_id) : null
    const memory = e.isGroup ? memoryStats(e.group_id) : null
    const lines = [
      `伪人模式：${config.enabled ? '已开启' : '已关闭'}`,
      `接口：${config.llm.baseURL}`,
      `模型：${config.llm.model}（key ${maskKey(config.llm.apiKey)}）`,
      `触发：关键词 ${JSON.stringify(config.trigger.hitKeywords)}，概率 ${config.trigger.probability}`,
      `群范围：${config.trigger.groupMode}（${(config.trigger.groups || []).length} 个）`,
      `冷却：${config.trigger.cooldownSeconds} 秒 / 每小时上限 ${config.trigger.maxPerHour} 次`,
      `发言方式：${config.speaking.mode}，分段 ${config.speaking.splitReplies ? '开' : '关'}，撤回 ${config.speaking.recallSeconds || 0} 秒`,
      `群上下文：${config.context.enable ? `${config.context.length} 条` : '关闭'}，记忆：${config.memory.enable ? '开' : '关'}`,
      `预设（${presets.size}）：${[...presets.keys()].join('、') || '无，将使用内置人设'}`,
    ]
    if (rate) {
      lines.push(`本群：近一小时已发言 ${rate.inLastHour} 次，上次 ${rate.lastAt ? new Date(rate.lastAt).toLocaleTimeString('zh-CN') : '从未'}`)
    }
    if (memory) {
      lines.push(`本群记忆：${memory.count} 条`)
    }
    await e.reply(lines.join('\n'))
    return true
  }

  async enable (e) {
    config.set('enable', true)
    await e.reply('伪人模式已开启')
    return true
  }

  async disable (e) {
    config.set('enable', false)
    await e.reply('伪人模式已关闭')
    return true
  }

  async reload (e) {
    config.load()
    loadPresets(true)
    clearContextCache()
    const notes = ['已重载配置与预设', `当前${config.enabled ? '开启' : '关闭'}`]
    // 指令正则是插件加载时按 commandPrefix 编译好的快照，改前缀必须重载插件
    notes.push('注意：如果改过 commandPrefix，需要重启或重载插件才会生效')
    await e.reply(notes.join('，').replace('，注意', '。注意'))
    return true
  }

  async test (e) {
    const match = e.msg.match(new RegExp(`^${escapeRegExp(config.data.commandPrefix)}\\s*(测试|test)\\s*([\\s\\S]+)$`))
    const content = (match?.[2] || '').trim()
    if (!content) {
      await e.reply(`用法：${config.data.commandPrefix}测试 你好呀`)
      return true
    }
    if (!e.isGroup) {
      await e.reply('请在群里测试：群上下文与发言方式都依赖群聊环境')
      return true
    }
    await e.reply('正在生成，可能需要几秒……')
    try {
      const result = await dryRun(e, content)
      const preview = [
        `模式：${result.mode}　人设：${result.preset?.name || result.preset?.id}`,
        `模型：${result.model}`,
        '',
        result.text || '（空响应）',
      ]
      if (result.reasoning) {
        preview.push('', '思考摘要：', result.reasoning.slice(0, 300))
      }
      await e.reply(preview.join('\n'))
    } catch (err) {
      await e.reply(`生成失败：${err.message}`)
    }
    return true
  }

  async memory (e) {
    if (!e.isGroup) {
      await e.reply('群记忆按群隔离，请在群里查看')
      return true
    }
    const { facts } = memoryStats(e.group_id)
    if (facts.length === 0) {
      await e.reply(`本群还没有记忆（memory.enable=${config.memory.enable}，extract=${config.memory.extract}）`)
      return true
    }
    const lines = facts
      .slice()
      .sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.at - a.at)
      .slice(0, 20)
      .map((fact, index) => `${index + 1}. [${(fact.importance || 0).toFixed(2)}] ${fact.fact}`)
    await e.reply([`本群记忆（共 ${facts.length} 条，显示前 ${lines.length} 条）：`, ...lines].join('\n'))
    return true
  }

  async clearMemoryCmd (e) {
    if (!e.isGroup) {
      await clearMemory()
      resetRate()
      await e.reply('已清空所有群的记忆与频率记录')
      return true
    }
    await clearMemory(e.group_id)
    resetRate(e.group_id)
    await e.reply('已清空本群记忆与频率记录')
    return true
  }
}
