// 仅用于离线回归测试：模拟数据和模型响应不会进入实际群聊。
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
config.ocr.enable = true
config.ocr.apiKey = 'test-ocr-key'
config.vision.enable = false
config.memory.enable = true
config.memory.write = false
config.memory.profileEnabled = false
addFact('123', { fact: '周末准备去爬山，旧话题记忆', importance: 0.9 })
config.context.enable = true
config.context.cacheTTL = 0
const history = [
  { message_id: '1', raw_message: '周末去爬山吗', sender: { user_id: 1 }, time: 1700000000 },
  { message_id: '2', raw_message: '可以，周六见', sender: { user_id: 9 }, time: 1700000001 },
  { message_id: '3', raw_message: '换个话题，今天降温了', sender: { user_id: 1 }, time: 1700000002 },
]
let payload
let ocrCalls = 0
let failOcr = false
const imageUrl = 'https://image.invalid/ocr-test.png'

const originalFetch = global.fetch
global.fetch = async (url, options) => {
  if (url === imageUrl) {
    const buffer = Buffer.alloc(24)
    buffer.write('\x89PNG', 0, 'binary')
    buffer.writeUInt32BE(100, 16)
    buffer.writeUInt32BE(100, 20)
    return new Response(buffer, { headers: { 'Content-Type': 'image/png' } })
  }
  const body = JSON.parse(options.body)
  if (body.model === 'xoppaddleocrv16') {
    ocrCalls++
    assert.equal(options.headers.Authorization, 'Bearer test-ocr-key')
    assert.equal(body.stream, false)
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
    if (failOcr) return new Response('failed', { status: 400 })
    return new Response(JSON.stringify({ choices: [{ message: { content: '识别测试：签到成功 12 个' } }] }))
  }
  payload = body
  return new Response(JSON.stringify({ choices: [{ message: { content: '记得带外套' } }] }), { headers: { 'Content-Type': 'application/json' } })
}

try {
  for (const mode of ['contextual', 'reply']) {
    config.speaking.mode = mode
    const e = { message: [{ type: 'image', url: imageUrl }], group_id: '123', self_id: '9', user_id: '2', sender: { nickname: '测试群友' }, group: { getChatHistory: async () => [...history].reverse() } }
    await generateReply(e, { text: '是啊，多穿点', forced: true })
    const text = payload.messages[1].content.filter(p => p.type === 'text').map(p => p.text).join('\n')
    assert.ok(text.includes('识别测试：签到成功 12 个'), '聊天请求应收到 OCR 文字')
    assert.ok(!payload.messages[1].content.some(p => p.type === 'image_url'), '纯文本聊天模型不接收图片')
    assert.ok(text.includes('周末去爬山吗'), '保留历史供理解短句')
    assert.ok(text.includes('换个话题，今天降温了'), '保留近邻语境')
    assert.ok(!text.includes('旧话题记忆'), '旧历史不得召回无关记忆')
    assert.ok(text.includes('是啊，多穿点'), `${mode}: 请求必须包含当前消息`)
    assert.ok(text.lastIndexOf('是啊，多穿点') > text.lastIndexOf('换个话题，今天降温了'), '当前消息应在历史之后')
    assert.match(payload.messages[0].content, /最新消息/, '明确最新消息优先级')
    console.log(`ok ${mode}: 最新消息独立置后，历史只作背景`)
  }
  assert.equal(ocrCalls, 2)
  failOcr = true
  await generateReply({ group_id: '123', message: [{ type: 'image', url: imageUrl }] }, { text: '[图片]', forced: true })
  assert.ok(!JSON.stringify(payload).includes('识别测试'))
  const calls = ocrCalls
  config.ocr.enable = false
  await generateReply({ group_id: '123', message: [{ type: 'image', url: imageUrl }] }, { text: '[图片]', forced: true })
  assert.equal(ocrCalls, calls, '关闭 OCR 后不调用接口')
  console.log('ok OCR: text-only chat, failure fallback and disabled mode')
} finally {
  global.fetch = originalFetch
  await disposeMemory()
  config.unwatch()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
