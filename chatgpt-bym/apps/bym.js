import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../config/config.js'
import { evaluate, SKIP } from '../utils/trigger.js'
import { checkRate, markSpoken } from '../utils/rateLimit.js'
import { displayName, messageToText } from '../utils/message.js'
import { sendHumanized } from '../utils/humanize.js'
import { generateReply } from '../models/chatService.js'
import { extractFacts } from '../models/memory.js'

/**
 * 伪人模式主入口。
 *
 * 这个类只做“要不要说话、说完怎么发”两件事，
 * 具体内容生成全在 models/chatService.js 里，方便单独调试和替换。
 */
export class Bym extends plugin {
  constructor () {
    super({
      name: '伪人模式',
      dsc: '群聊拟人化自动聊天（OpenAI 兼容接口）',
      event: 'message',
      // 数字越小越先执行。比普通对话插件靠前，
      // 但比签到、抽卡这类功能性插件靠后（它们优先级通常 < 1000）
      priority: 6000,
      rule: [
        {
          // 只接非指令类消息；日志关掉，否则每条群消息都会刷一行
          reg: '^[^#][\\s\\S]*',
          fnc: 'onMessage',
          log: false,
        },
      ],
    })
  }

  /**
   * 注意：这里必须“立刻返回”。
   *
   * 伪人的发送带 1~6 秒打字延迟，如果 await 整条链路，
   * 云崽会把这条消息的后续插件全部卡住（表现为其他功能也变慢）。
   * 所以用 fire-and-forget，只把异常收在内部。
   */
  async onMessage (e) {
    this.trySpeak(e).catch(err => {
      globalThis.logger?.error?.(`[bym] 发言流程异常：${err?.stack || err?.message || err}`)
    })
    return false
  }

  async trySpeak (e) {
    if (!config.enabled) return

    const text = messageToText(e)
    const decision = evaluate(e, text)

    if (!decision.pass) {
      // 未命中的原因只在 debug 下打，避免刷日志
      globalThis.logger?.debug?.(`[bym] 跳过：${decision.reason || '未知'}${decision.reason === SKIP.NO_LUCK ? `（骰子 ${decision.dice.toFixed(3)} / 概率 ${config.trigger.probability}）` : ''}`)
      return
    }

    // 关键词命中默认仍然受冷却约束：否则一个热词就能让机器人刷屏
    const bypassCooldown = decision.forced && config.trigger.bypassCooldownOnKeyword === true
    const rate = checkRate(e.group_id, { bypassCooldown })
    if (!rate.ok) {
      globalThis.logger?.debug?.(`[bym] 跳过：${rate.reason}`)
      return
    }

    // 先记账再请求：模型响应可能耗时数秒，期间同群的新消息不应再触发一次
    markSpoken(e.group_id)
    globalThis.logger?.info?.(`[bym] 触发（${decision.forced ? '关键词' : '概率'}），群 ${e.group_id}，来自 ${displayName(e)}`)

    let reply
    try {
      reply = await generateReply(e, { text, forced: decision.forced })
    } catch (err) {
      globalThis.logger?.error?.(`[bym] 生成失败：${err.message}`)
      return
    }

    if (!reply?.text) {
      globalThis.logger?.debug?.('[bym] 模型返回空内容，放弃发送')
      return
    }

    await sendHumanized(e, reply.text, { recallSeconds: reply.preset?.recallSeconds })
    globalThis.logger?.debug?.(`[bym] 已发送（模式 ${reply.mode}，人设 ${reply.preset?.id}，模型 ${reply.model}）`)

    // 记忆抽取完全异步，失败不影响已经发出的消息
    if (config.memory.enable && config.memory.extract) {
      // 群上下文里已经有这轮之前的对话，补上当前这条再抽取，样本更完整
      const lines = (reply.contextItems || []).map(item => ({
        name: item.name,
        userId: item.userId,
        text: item.text,
      }))
      lines.push({ name: displayName(e), userId: String(e.user_id || ''), text })

      // 语料只来自群上下文。context.enable 关着时这里永远只有 1 条，
      // 抽取会被「至少 6 条」的门槛挡掉。把原因写清楚，否则用户会以为记忆坏了。
      if (lines.length < 6) {
        globalThis.logger?.debug?.(`[bym][memory] 跳过抽取：可用语料 ${lines.length} 条（开启 context.enable 才会积累群记忆）`)
      }
      extractFacts(e.group_id, lines).catch(err => {
        globalThis.logger?.warn?.(`[bym][memory] 抽取失败：${err.message}`)
      })
    }
  }
}
