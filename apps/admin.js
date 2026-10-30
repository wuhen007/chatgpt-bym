import plugin from '../../../lib/plugins/plugin.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config/config.js'
import { loadPresets, setGroupPreset } from '../models/preset.js'
import { clearMemory, memoryStats, getProfile, setProfile } from '../models/memory.js'
import { rateStats, resetRate } from '../utils/rateLimit.js'
import { clearContextCache } from '../utils/groupContext.js'
import { dryRun } from '../models/chatService.js'
import { update as runUpdate, formatUpdate, pluginRoot } from '../utils/updater.js'

function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function maskKey (key) {
  if (!key) return '未配置'
  const text = String(key)
  if (text.length <= 8) return '已配置'
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

/** 把时间戳说成「3 小时前」这种人话。状态指令里比 ISO 时间好读 */
function ago (at) {
  const ms = Date.now() - (Number(at) || 0)
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
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
        { reg: `^${prefix}\\s*人设\\s*([\\s\\S]*)$`, fnc: 'preset', permission: 'master' },
        { reg: `^${prefix}\\s*画像\\s*([\\s\\S]*)$`, fnc: 'profile', permission: 'master' },
        // 云崽生态习惯把这类指令挂在插件名下（#xxx更新），所以不带 #bym 前缀也能用
        { reg: '^[#＃]?\\s*伪人更新\\s*$', fnc: 'update', permission: 'master' },
        { reg: `^${prefix}\\s*更新\\s*$`, fnc: 'update', permission: 'master' },
      ],
    })
  }

  async status (e) {
    const presets = loadPresets(true)
    const rate = e.isGroup ? rateStats(e.group_id) : null
    const memory = e.isGroup ? memoryStats(e.group_id) : null
    const boundMap = config.speaking.groupPresets || {}
    const boundId = e.isGroup ? String(boundMap[String(e.group_id)] || '') : ''
    const defaultId = String(config.speaking.defaultPresetId || '')
    const presetLine = boundId
      ? `本群人设：${presets.get(boundId)?.name || boundId}（${boundId}，群指定）`
      : `本群人设：${presets.get(defaultId)?.name || defaultId || '内置'}（${defaultId || '内置'}，全局默认）`
    const lines = [
      `伪人模式：${config.enabled ? '已开启' : '已关闭'}`,
      `接口：${config.llm.baseURL}`,
      `模型：${config.llm.model}（key ${maskKey(config.llm.apiKey)}）`,
      `触发：关键词 ${JSON.stringify(config.trigger.hitKeywords)}，概率 ${config.trigger.probability}`,
      `群范围：${config.trigger.groupMode}（${(config.trigger.groups || []).length} 个）`,
      `冷却：${config.trigger.cooldownSeconds} 秒 / 每小时上限 ${config.trigger.maxPerHour} 次`,
      `发言方式：${config.speaking.mode}，分段 ${config.speaking.splitReplies ? '开' : '关'}，撤回 ${config.speaking.recallSeconds || 0} 秒`,
      `群上下文：${config.context.enable ? `${config.context.length} 条` : '关闭'}，记忆：${config.memory.enable ? `开（读${config.memory.inject === false ? '关' : '开'}/写${config.memory.write === false ? '关' : '开'}）` : '关'}`,
      `守卫：自曝拦截${config.guard?.enable === false ? '关' : '开'}` +
        `，语义把关${config.gate?.enable ? `开（阈值 ${config.gate.threshold}）` : '关'}` +
        `，去重${config.dedup?.enable === false ? '关' : '开'}`,
      presetLine,
      `预设（${presets.size}）：${[...presets.keys()].join('、') || '无，将使用内置人设'}`,
    ]
    if (rate) {
      lines.push(`本群：近一小时已发言 ${rate.inLastHour} 次，上次 ${rate.lastAt ? new Date(rate.lastAt).toLocaleTimeString('zh-CN') : '从未'}`)
    }
    if (memory) {
      // 显示 active 而不是 count：库里有 200 条但全过期了，
      // 只看总数会让人以为记忆在正常工作
      const detail = memory.expired > 0 ? `${memory.active} 条有效 / 共 ${memory.count}` : `${memory.count} 条`
      const lastWrite = memory.facts.reduce((max, fact) => Math.max(max, Number(fact.at) || 0), 0)
      lines.push(`本群记忆：${detail}${lastWrite ? `，最近写入 ${ago(lastWrite)}` : ''}`)
      if (memory.profile?.about) lines.push(`本群画像：${memory.profile.about}`)
    }
    await e.reply(lines.join('\n'))
    return true
  }

  async enable (e) {
    const saved = config.set('enable', true)
    await e.reply(saved
      ? '伪人模式已开启'
      : '已切换到开启，但**没有写进配置文件**（配置文件处于只读保护模式，见日志）。重启后会变回原样')
    return true
  }

  async disable (e) {
    const saved = config.set('enable', false)
    await e.reply(saved
      ? '伪人模式已关闭'
      : '已切换到关闭，但**没有写进配置文件**（配置文件处于只读保护模式，见日志）。重启后会变回原样')
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
    const { facts, active, profile } = memoryStats(e.group_id)
    if (facts.length === 0) {
      await e.reply(`本群还没有记忆（memory.enable=${config.memory.enable}，write=${config.memory.write !== false}）`)
      return true
    }
    const now = Date.now()
    const lines = facts
      .slice()
      .sort((a, b) => (b.importance || 0) - (a.importance || 0) || b.at - a.at)
      .slice(0, 20)
      .map((fact, index) => {
        // 过期/被取代的不参与检索，但留在库里可追溯，这里标出来免得看着困惑
        const dead = fact.supersededBy ? '已取代'
          : (fact.expiresAt > 0 && fact.expiresAt < now ? '已过期' : '')
        const type = fact.type || 'unknown'
        return `${index + 1}. [${type} ${(fact.importance || 0).toFixed(2)}${dead ? ` ${dead}` : ''}] ${fact.fact}`
      })
    const header = `本群记忆（有效 ${active} 条 / 共 ${facts.length} 条，显示前 ${lines.length} 条）：`
    const footer = profile?.about ? `\n画像：${profile.about}` : ''
    await e.reply([header, ...lines].join('\n') + footer)
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

  /**
   * `#bym 人设` —— 列人设 / 给本群指定人设 / 取消本群指定。
   *
   * 写的是**群级**配置（`speaking.groupPresets[群号]`），不是 `defaultPresetId`。
   * 在 A 群调成沙雕人设不该毁掉 B 群的严肃场景。
   */
  async preset (e) {
    const prefix = escapeRegExp(config.data.commandPrefix || '#bym')
    const match = e.msg.match(new RegExp(`^${prefix}\\s*人设\\s*([\\s\\S]*)$`))
    const arg = (match?.[1] || '').trim()
    const presets = loadPresets(true)
    const defaultId = String(config.speaking.defaultPresetId || '')
    const boundMap = config.speaking.groupPresets || {}
    const boundId = e.isGroup ? String(boundMap[String(e.group_id)] || '') : ''

    // 列表（无参数，或显式写「列表」）
    if (!arg || arg === '列表' || arg.toLowerCase() === 'list') {
      if (presets.size === 0) {
        await e.reply(`没有找到任何人设文件（${config.data.commandPrefix || '#bym'} 的 presets 目录）。当前会用内置兜底人设。`)
        return true
      }
      const lines = [`人设（${presets.size}）：`]
      for (const [id, item] of presets) {
        const marks = []
        if (id === boundId) marks.push('本群指定')
        else if (!boundId && id === defaultId) marks.push('全局默认')
        if (id === defaultId) marks.push('默认值')
        lines.push(`· ${item.name} [${id}]${marks.length ? `　← ${marks.join('，')}` : ''}`)
      }
      lines.push('')
      lines.push(`用法：${config.data.commandPrefix} 人设 <id> 给本群指定`)
      lines.push(`　　　${config.data.commandPrefix} 人设 off 取消本群指定，回到全局默认（${defaultId || '内置'}）`)
      lines.push(`想看效果：${config.data.commandPrefix} 测试 随便说句话`)
      await e.reply(lines.join('\n'))
      return true
    }

    if (!e.isGroup) {
      await e.reply('人设按群绑定，请在群里操作')
      return true
    }

    const result = setGroupPreset(e.group_id, arg)
    if (!result.ok) {
      await e.reply(`切换失败：${result.reason}\n可用的人设：${[...presets.keys()].join('、') || '无'}`)
      return true
    }
    if (result.id) {
      const item = presets.get(result.id)
      await e.reply(`本群已切换到「${item?.name || result.id}」（${result.id}）。下一条触发就生效。`)
    } else {
      await e.reply(`已取消本群的人设指定，回到全局默认（${defaultId || '内置'}）。`)
    }
    return true
  }

  /**
   * `#bym 画像` —— 查看 / 设置本群画像。
   *
   * 画像和「记忆条目」是两回事：它是「这个群是个什么群」，每轮都注入，
   * 不参与相关度竞争。模型不擅长判断这件事，所以提供手动设置的口子。
   */
  async profile (e) {
    if (!e.isGroup) {
      await e.reply('画像按群隔离，请在群里查看')
      return true
    }
    const prefix = escapeRegExp(config.data.commandPrefix || '#bym')
    const match = e.msg.match(new RegExp(`^${prefix}\\s*画像\\s*([\\s\\S]*)$`))
    const arg = (match?.[1] || '').trim()

    if (!arg || arg === '查看') {
      const { about, updatedAt } = getProfile(e.group_id)
      if (!about) {
        await e.reply([
          '本群还没画像。',
          `设置：${config.data.commandPrefix} 画像 设置 游戏群，主要聊原神和日常，氛围轻松`,
          '画像会每轮带给模型，控制在 100 字以内最好。',
        ].join('\n'))
        return true
      }
      await e.reply(`本群画像（${updatedAt ? `更新于 ${ago(updatedAt)}` : '未记录时间'}）：\n${about}`)
      return true
    }

    if (/^(清空|清除|删除|off)$/i.test(arg)) {
      setProfile(e.group_id, '')
      await e.reply('已清空本群画像')
      return true
    }

    const setMatch = arg.match(/^(?:设置|set)\s*([\s\S]*)$/i)
    if (!setMatch) {
      await e.reply(`用法：${config.data.commandPrefix} 画像　|　${config.data.commandPrefix} 画像 设置 <一句话描述>　|　${config.data.commandPrefix} 画像 清空`)
      return true
    }

    const text = setMatch[1].trim()
    const result = setProfile(e.group_id, text)
    if (!result.ok) {
      await e.reply('画像写入失败，看日志')
      return true
    }
    await e.reply(text ? `已更新本群画像（${result.about.length} 字）：\n${result.about}` : '已清空本群画像')
    return true
  }

  /**
   * `#伪人更新` / `#bym 更新` —— 拉取远程代码。
   *
   * 更新代码不会热生效：Node 已经加载过的模块不会因为文件变了就重载，
   * 所以更新完必须重启云崽。这里只负责把「更新了什么、要不要装依赖」说清楚，
   * 不替用户重启 —— 整个机器人瞬间掉线几秒，不该由一条群消息静默触发。
   */
  async update (e) {
    await e.reply('正在检查插件更新…')
    const result = await runUpdate(pluginRoot)
    await e.reply(formatUpdate(result))
    return true
  }
}
