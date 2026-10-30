import plugin from '../../../lib/plugins/plugin.js'
import { config } from '../config/config.js'
import { evaluate, SKIP } from '../utils/trigger.js'
import { checkRate, markSpoken, refundSpoken } from '../utils/rateLimit.js'
import { displayName, messageToText } from '../utils/message.js'
import { checkIncoming } from '../utils/dedup.js'
import { sendHumanized } from '../utils/humanize.js'
import { generateReply } from '../models/chatService.js'
import { extractFacts, addFact, flushMemory, disposeMemory } from '../models/memory.js'

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
   * 宿主加载时的初始化钩子。
   *
   * TRSS 的加载器会先 `new` 一个实例、调 `init()`，**只有在这里用 `addCleanup`
   * 登记过的清理函数**才会在卸载或热更新时被调用（loader.js 的 `disposeInitializers`，
   * 而且会 await 返回的 Promise）。
   *
   * 不登记的话，`index.js` 里 `config.load().watch()` 注册的 `fs.watchFile`
   * 永远不会被解绑 —— 改一次插件文件就多一个回调，改十次挂十个，
   * 之后每次改配置都会触发多次 `load()`。
   *
   * 顺便在卸载时把记忆刷盘：热更新会重新 import 整个模块，内存里未落盘的
   * 那几条记忆会跟着清空。热更新比进程退出更频繁（改文件就触发）。
   *
   * 用 `disposeMemory()` 而不是 `flushMemory()`：访问强化的计数是攒批写的，
   * 而且背后挂着一个 3 秒定时器。定时器不清掉，旧模块实例会在热更新之后
   * 用它的旧 store 整份覆盖新模块刚写下去的数据 —— 那是数据回滚，不是丢几条。
   *
   * 第二个参数是 restore：热更新失败时把监听挂回去。
   * Miao 分支没有 addCleanup，判空跳过（那边靠进程重启清理）。
   */
  init () {
    this.addCleanup?.(
      async () => {
        config.unwatch()
        await disposeMemory()
      },
      () => config.watch(),
    )
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

    // 去重与回声守卫。必须放在任何有副作用的动作之前（冷却记账、调模型），
    // 否则重复消息会各自消耗一次配额，把本该留给真实消息的额度吃掉。
    if (config.dedup?.enable !== false) {
      const { dup } = checkIncoming(e, text)
      if (dup) {
        globalThis.logger?.debug?.(`[bym] 跳过：重复消息（${dup}）`)
        return
      }
    }

    const decision = evaluate(e, text)

    if (!decision.pass) {
      // 未命中的原因只在 debug 下打，避免刷日志
      globalThis.logger?.debug?.(`[bym] 跳过：${decision.reason || '未知'}${decision.reason === SKIP.NO_LUCK ? `（骰子 ${decision.dice.toFixed(3)} / 概率 ${config.trigger.probability}）` : ''}`)
      return
    }

    // 冷却豁免有三档，优先级从高到低：
    // 被点名（默认豁免）/ 关键词（默认不豁免）/ 概率（从不豁免）。
    // 三档都绕不过 maxPerHour —— 那是防刷屏的底线，被 @ 十次也不该回十条。
    const bypassCooldown = (decision.addressed && config.trigger.addressedBypassCooldown !== false) ||
      (decision.forced && !decision.addressed && config.trigger.bypassCooldownOnKeyword === true)
    const rate = checkRate(e.group_id, { bypassCooldown })
    if (!rate.ok) {
      globalThis.logger?.debug?.(`[bym] 跳过：${rate.reason}`)
      return
    }

    // 先记账再请求：模型响应可能耗时数秒，期间同群的新消息不应再触发一次。
    // token 要留着 —— 如果最终没说话（比如被语义把关拒掉），得按它精确退还。
    const spendToken = markSpoken(e.group_id)
    const how = decision.addressed ? '被点名' : (decision.forced ? '关键词' : '概率')
    globalThis.logger?.info?.(`[bym] 触发（${how}），群 ${e.group_id}，来自 ${displayName(e)}`)

    let reply
    try {
      reply = await generateReply(e, { text, forced: decision.forced, addressed: decision.addressed })
    } catch (err) {
      globalThis.logger?.error?.(`[bym] 生成失败：${err.message}`)
      return
    }

    if (reply?.skipped) {
      // 语义把关判了「这时候不该插话」。配额要退回去 ——
      // 那次调用是决策成本，不该算作用掉一次发言机会。
      // 带 token 退，否则并发时会退掉别人刚记的那次。
      refundSpoken(e.group_id, spendToken)
      globalThis.logger?.debug?.(`[bym][gate] 本轮不接话（${reply.skipReason || '评分不足'}），配额已退还`)
      return
    }

    if (reply?.blocked) {
      // 这里只记日志。群里不解释、不道歉、不发错误提示 ——
      // 伪人不说话是常态，但一旦开口解释"我刚才不该说那句话"就彻底破功了。
      globalThis.logger?.warn?.(`[bym][guard] 本轮已拦截（${reply.blockedReason}），群 ${e.group_id}`)
      return
    }

    // 记忆先落库，再管发不发得出去。
    // 记忆和「这一轮要不要说话」是两件事：模型只给了 memory 没给 say 时，
    // 正文确实不能发，但那条记忆是真的。
    saveMemory(e, reply, text)

    if (!reply?.text) {
      globalThis.logger?.debug?.('[bym] 模型返回空内容，放弃发送')
      return
    }

    await sendHumanized(e, reply.text, { recallSeconds: reply.preset?.recallSeconds })
    globalThis.logger?.debug?.(`[bym] 已发送（模式 ${reply.mode}，人设 ${reply.preset?.id}，模型 ${reply.model}）`)
  }
}

/**
 * 落库这一轮的记忆。
 *
 * 抽出来是为了能**在正文判空之前调用** —— 模型偶尔只返回 memory 不给 say
 * （契约要求两样，它只给了一样），那种情况下正文发不出去，但记忆是有效的。
 * 之前这段代码在 `if (!reply.text) return` 后面，导致 replyParser 特意收下的
 * 记忆被上游悄悄丢掉：测试绿了，功能却没生效。
 */
function saveMemory (e, reply, text) {
  // write 是主开关，extract 是兼容老配置的（extract:false 的升级用户不该突然开始写）
  if (!config.memory.enable || config.memory.write === false || config.memory.extract === false) return

  // 优先用回复里顺带产出的条目（零额外调用）
  if (reply.memory?.length) {
    // deferred + 最后统一 flush：一次回复最多 5 条，逐条 flush 就是 5 次
    // 全量序列化 + 5 次写文件，完全没必要。
    let saved = 0
    for (const item of reply.memory) {
      if (addFact(e.group_id, {
        fact: item.fact,
        topic: '对话',
        // importance 来自模型（契约里可选），没给就是 0.5。
        // 这一维直接影响 queryFacts 的排序，全填同一个值等于没填。
        importance: item.importance,
        // type 决定这条多久后失效，subject 决定它归到谁名下、和谁冲突。
        // 两者都是可选的：模型没给就按 unknown（30 天）和「不归属任何人」处理。
        type: item.type,
        subject: item.subject,
        predicate: item.predicate,
        confidence: item.confidence,
        deferred: true,
      })) saved += 1
    }
    if (saved > 0) flushMemory()
    globalThis.logger?.debug?.(`[bym][memory] 从回复中记录 ${saved} 条（去重后）`)
    return
  }

  // 模型没按契约来（小模型常见）时退回独立抽取。那条路要多一次调用，只作兜底。
  if (!reply.memoryDegraded) return

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
