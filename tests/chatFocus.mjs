import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-focus-'))
process.env.BYM_CONFIG_DIR = path.join(sandbox, 'config')
process.env.BYM_DATA_DIR = path.join(sandbox, 'data')
global.logger = { info () {}, warn () {}, debug () {}, error () {} }
global.Bot = { bots: {} }
const { config } = await import('../config/config.js')
const { addFact, disposeMemory } = await import('../models/memory.js')
const { generateReply } = await import('../models/chatService.js')
config.load()
config.llm.baseURL = 'https://mock.invalid'
config.llm.model = 'mock'
config.llm.stream = false
config.guard.enable = false
config.gate.enable = false
config.memory.enable = true
config.memory.write = false
config.memory.profileEnabled = false
addFact('123', { fact: '630抽了，准备抽尼可池，旧话题记忆', importance: 0.9 })
config.context.enable = true
config.context.cacheTTL = 0
const history = [
  { message_id: '1', raw_message: '630抽了', sender: { user_id: 1 }, time: 1700000000 },
  { message_id: '2', raw_message: '宝你这攒得比肥鱼扒饭还快', sender: { user_id: 9 }, time: 1700000001 },
  { message_id: '3', raw_message: '人机会聊天了', sender: { user_id: 1 }, time: 1700000002 },
]
let payload
const originalFetch = global.fetch
global.fetch = async (_url, options) => {
  payload = JSON.parse(options.body)
  return new Response(JSON.stringify({ choices: [{ message: { content: '那可不' } }] }), { headers: { 'Content-Type': 'application/json' } })
}
try {
  for (const mode of ['contextual', 'reply']) {
    config.speaking.mode = mode
    const e = { group_id: '123', self_id: '9', user_id: '2', sender: { nickname: '无痕' }, group: { getChatHistory: async () => [...history].reverse() } }
    await generateReply(e, { text: '肯定的', forced: true })
    const text = payload.messages[1].content.filter(p => p.type === 'text').map(p => p.text).join('\n')
    assert.ok(text.includes('630抽了'), '保留历史供理解短句')
    assert.ok(text.includes('人机会聊天了'), '保留近邻语境')
    assert.ok(!text.includes('旧话题记忆'), '旧历史不得召回无关记忆')
    assert.ok(text.includes('肯定的'), `${mode}: 请求必须包含当前消息`)
    assert.ok(text.lastIndexOf('肯定的') > text.lastIndexOf('人机会聊天了'), '当前消息应在历史之后')
    assert.match(payload.messages[0].content, /最新消息/, '明确最新消息优先级')
    console.log(`ok ${mode}: 最新消息独立置后，历史只作背景`)
  }
} finally {
  global.fetch = originalFetch
  await disposeMemory()
  config.unwatch()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
