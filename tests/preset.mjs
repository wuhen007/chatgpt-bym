/**
 * 人设测试：结构化字段、群级绑定、prompt 拼装。
 * 运行：node tests/preset.mjs
 *
 * 这一组对应 docs/人格与长期记忆方案.md 第二节。
 * 重点是**向后兼容**：只有 system 的老 yaml 必须继续工作，
 * 否则升级会静默改掉所有已有用户的语气。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

global.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-preset-'))
process.env.BYM_CONFIG_DIR = path.join(sandbox, 'config')
process.env.BYM_DATA_DIR = path.join(sandbox, 'data')
fs.mkdirSync(process.env.BYM_CONFIG_DIR, { recursive: true })
fs.mkdirSync(process.env.BYM_DATA_DIR, { recursive: true })
const presetDir = path.join(process.env.BYM_DATA_DIR, 'presets')
fs.mkdirSync(presetDir, { recursive: true })

fs.writeFileSync(path.join(presetDir, 'full.yaml'), `
name: 小张
identity:
  age: 24
  city: 杭州
  job: 后端开发
  signature: 常年加班。
speech:
  style: 口语、随意
  length: 一到两句
  catchphrases: ['确实', '也行']
  never: ['用列表']
system: |
  你刚进群不久。
temperature: 0.95
`)

fs.writeFileSync(path.join(presetDir, 'legacy.yaml'), `
name: 老派群友
system: |
  你是一个普通群友，说话简短。
`)

fs.writeFileSync(path.join(presetDir, 'partial.yaml'), `
name: 半个
identity:
  city: 成都
speech:
  catchphrases: ['好嘛']
`)

// 全空的结构化字段：相当于用户把子项都注释掉了
fs.writeFileSync(path.join(presetDir, 'emptyblocks.yaml'), `
name: 空块
identity: {}
speech: {}
system: 你是普通群友。
`)

fs.writeFileSync(path.join(presetDir, 'quiet.yaml'), `
name: 不爱提群
persona:
  groupAware: false
system: 你是普通群友。
`)

const { config } = await import('../config/config.js')
config.load()
config.set('speaking.defaultPresetId', 'full')
config.set('speaking.groupPresets', {})

const {
  loadPresets, getPreset, resolvePreset, setGroupPreset, getGroupPreset,
} = await import('../models/preset.js')
const { buildSystemPrompt } = await import('../models/chatService.js')

let pass = 0
let fail = 0
function test (name, fn) {
  try {
    fn()
    pass++
    console.log('  ok  ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name + '\n       ' + err.message)
  }
}

loadPresets(true)

console.log('\n[1] 结构化字段解析')

test('identity / speech 被解析出来', () => {
  const p = getPreset('full')
  assert.equal(p.identity.city, '杭州')
  assert.equal(p.identity.age, '24')       // 数字统一转成字符串，拼接时不用再判断类型
  assert.equal(p.speech.length, '一到两句')
  assert.deepEqual(p.speech.catchphrases, ['确实', '也行'])
})

test('只写了一个结构化字段也算有（partial）', () => {
  const p = getPreset('partial')
  assert.equal(p.identity.city, '成都')
  assert.equal(p.identity.job, '')          // 没写的补空串
  assert.deepEqual(p.speech.catchphrases, ['好嘛'])
  assert.equal(p.speech.style, '')
})

test('identity/speech 全空时当作没写（否则会拼出病句）', () => {
  const p = getPreset('emptyblocks')
  assert.equal(p.identity, null, '空对象应归一化为 null')
  assert.equal(p.speech, null)
})

test('只有 system 的老格式不受影响', () => {
  const p = getPreset('legacy')
  assert.equal(p.identity, null)
  assert.equal(p.speech, null)
  assert.match(p.system, /普通群友/)
})

test('speech 里的字符串会包成数组（用户只写一个口癖时很常见）', () => {
  fs.writeFileSync(path.join(presetDir, 'single.yaml'), `
name: 单个
speech:
  catchphrases: 确实
`)
  const p = loadPresets(true).get('single')
  assert.deepEqual(p.speech.catchphrases, ['确实'])
})

console.log('\n[2] prompt 拼装')

test('结构化字段按分节拼装', () => {
  const text = buildSystemPrompt(getPreset('full'), '原神群')
  assert.match(text, /# 你是谁/)
  assert.match(text, /你是小张，24 岁，在杭州做后端开发/)
  assert.match(text, /# 你怎么说话/)
  assert.match(text, /偶尔用这些口头禅：确实、也行/)
  assert.match(text, /绝对不要：用列表/)
  assert.match(text, /# 你在哪/)
  assert.match(text, /原神群/)
})

test('自由文本 system 也在（结构化不是替代品）', () => {
  const text = buildSystemPrompt(getPreset('full'), '原神群')
  assert.match(text, /你刚进群不久/)
})

test('城市和职业都在时合成一句，不要「，在做」', () => {
  const text = buildSystemPrompt(getPreset('partial'), '')
  assert.match(text, /你是半个，在成都。/)
  assert.doesNotMatch(text, /，，/)
})

test('只有 system 的人设不出现空的节标题', () => {
  const text = buildSystemPrompt(getPreset('legacy'), '某群')
  assert.doesNotMatch(text, /# 你是谁/)
  assert.doesNotMatch(text, /# 你怎么说话/)
  // 「你在哪」不依赖结构化字段，任何预设都该有
  assert.match(text, /# 你在哪/)
})

test('群名拿不到时不写「你在哪」', () => {
  const text = buildSystemPrompt(getPreset('full'), '')
  assert.doesNotMatch(text, /# 你在哪/)
  const unknown = buildSystemPrompt(getPreset('full'), 'unknown')
  assert.doesNotMatch(unknown, /# 你在哪/, 'unknown 是占位符，不该进 prompt')
})

test('groupAware: false 时不提群名', () => {
  const text = buildSystemPrompt(getPreset('quiet'), '某群')
  assert.doesNotMatch(text, /# 你在哪/)
})

test('末尾的「不要自称 AI」铁律任何预设都有', () => {
  for (const id of ['full', 'legacy', 'partial', 'emptyblocks']) {
    assert.match(buildSystemPrompt(getPreset(id), '群'), /不要自称 AI/, `${id} 缺铁律`)
  }
})

test('预设可以覆盖温度和 maxTokens', () => {
  assert.equal(getPreset('full').temperature, 0.95)
  assert.equal(getPreset('legacy').temperature, undefined, '没写就不覆盖全局')
})

console.log('\n[3] 优先级')

test('群绑定压过关键词规则', () => {
  config.set('speaking.presetMap', [{ keywords: ['原神'], presetId: 'legacy', priority: 10 }])
  setGroupPreset('111', 'full')
  assert.equal(resolvePreset('聊聊原神', '111').id, 'full', '同群时群绑定赢')
  assert.equal(resolvePreset('聊聊原神', '222').id, 'legacy', '别的群照常走关键词')
  setGroupPreset('111', 'off')
})

test('没绑定时走关键词，再没命中就走默认', () => {
  config.set('speaking.presetMap', [{ keywords: ['原神'], presetId: 'legacy', priority: 10 }])
  assert.equal(resolvePreset('聊聊原神', '333').id, 'legacy')
  assert.equal(resolvePreset('聊点别的', '333').id, 'full')
})

test('默认人设不存在时兜底到内置，不返回 null', () => {
  config.set('speaking.defaultPresetId', '不存在的')
  const p = resolvePreset('随便', '444')
  assert.equal(p.id, 'builtin')
  assert.ok(p.system.length > 0)

  config.set('speaking.defaultPresetId', 'full')
})

test('绑定的人设不存在时退回默认，而不是哑掉', () => {
  // 直接改配置绕过 setGroupPreset 的校验，模拟「人设文件被删了」
  config.set('speaking.groupPresets', { 555: '压根没有' })
  assert.equal(getGroupPreset('555'), null)
  assert.equal(resolvePreset('随便', '555').id, 'full')
  config.set('speaking.groupPresets', {})
})

console.log('\n[4] 群级绑定写入')

test('setGroupPreset 写进配置并落盘', () => {
  const r = setGroupPreset('666', 'legacy')
  assert.equal(r.ok, true)
  assert.equal(config.data.speaking.groupPresets['666'], 'legacy')
  const yaml = fs.readFileSync(path.join(process.env.BYM_CONFIG_DIR, 'config.yaml'), 'utf8')
  assert.match(yaml, /666/, '应回写到配置文件，重启后还在')
})

test('写入不存在的人设被拒绝，且不改配置', () => {
  const before = JSON.stringify(config.data.speaking.groupPresets)
  const r = setGroupPreset('666', '不存在的')
  assert.equal(r.ok, false)
  assert.match(r.reason, /不存在/)
  assert.equal(JSON.stringify(config.data.speaking.groupPresets), before)
})

test('off / 空串 / null 都是解绑', () => {
  for (const value of ['off', '', null, 'OFF']) {
    setGroupPreset('777', 'legacy')
    assert.ok(config.data.speaking.groupPresets['777'], `前置：应已绑定（${value}）`)
    const r = setGroupPreset('777', value)
    assert.equal(r.ok, true)
    assert.equal(config.data.speaking.groupPresets['777'], undefined, `「${value}」应解绑`)
  }
})

test('没有群号时拒绝写入', () => {
  assert.equal(setGroupPreset('', 'legacy').ok, false)
  assert.equal(setGroupPreset(undefined, 'legacy').ok, false)
})

test('解绑不影响其他群', () => {
  setGroupPreset('888', 'legacy')
  setGroupPreset('999', 'full')
  setGroupPreset('888', 'off')
  assert.equal(config.data.speaking.groupPresets['999'], 'full')
})

test('只读保护时拒绝并说明原因（不能假装成功）', () => {
  config._readonly = true
  try {
    const r = setGroupPreset('1111', 'legacy')
    assert.equal(r.ok, false, '写不进盘就不该返回成功')
    assert.match(r.reason, /只读保护/)
  } finally {
    config._readonly = false
  }
})

console.log('\n[5] 缓存与文件变更')

test('改了 yaml 后 loadPresets(true) 能看到', () => {
  fs.writeFileSync(path.join(presetDir, 'added.yaml'), 'name: 新加的\nsystem: 你是新加的\n')
  assert.ok(loadPresets(true).has('added'))
  fs.unlinkSync(path.join(presetDir, 'added.yaml'))
  assert.ok(!loadPresets(true).has('added'))
})

test('enabled: false 的人设不出现在列表里，也不能绑定', () => {
  fs.writeFileSync(path.join(presetDir, 'disabled.yaml'), 'name: 关掉的\nsystem: x\nenabled: false\n')
  loadPresets(true)
  assert.equal(getPreset('disabled'), null)
  assert.equal(setGroupPreset('1010', 'disabled').ok, false)
})

test('坏 yaml 不影响其他人设', () => {
  fs.writeFileSync(path.join(presetDir, 'broken.yaml'), 'name: [未闭合\n')
  const all = loadPresets(true)
  assert.ok(all.has('full'), '坏文件不该让整批加载失败')
  fs.unlinkSync(path.join(presetDir, 'broken.yaml'))
})

console.log('\n[6] 绑错人设的警告不会刷屏')

/** 临时接管 warn，数一下被打了几次 */
function countWarns (fn) {
  const saved = global.logger.warn
  let warns = 0
  global.logger.warn = () => { warns++ }
  try { fn() } finally { global.logger.warn = saved }
  return warns
}

test('同一个群反复取用只警告一次', () => {
  config.set('speaking.groupPresets', { 2020: '不存在的人设' })
  const warns = countWarns(() => {
    getGroupPreset('2020')
    getGroupPreset('2020')
    getGroupPreset('2020')
  })
  assert.equal(warns, 1, `每轮发言都警告会刷屏，实际警告 ${warns} 次`)
  config.set('speaking.groupPresets', {})
})

test('修好之后又绑错，会重新警告', () => {
  config.set('speaking.groupPresets', { 2020: 'legacy' })
  getGroupPreset('2020')                       // 成功一次，清掉「已警告」标记

  config.set('speaking.groupPresets', { 2020: '又不存在' })
  const warns = countWarns(() => getGroupPreset('2020'))
  assert.equal(warns, 1, '新的一轮错误应该重新提示')
  config.set('speaking.groupPresets', {})
})

fs.rmSync(sandbox, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
process.exit(fail === 0 ? 0 : 1)
