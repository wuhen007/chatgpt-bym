/**
 * 锅巴适配测试：不装锅巴也能验证契约是否对得上。
 *
 * 模拟锅巴 server 的调用方式（PluginController）：
 *   - 扫描到 guoba.support.js → import → 调用 supportGuoba()
 *   - GET  配置：await configInfo.getConfigData()
 *   - POST 配置：await configInfo.setConfigData(扁平map, { Result })
 *
 * 运行：node tests/guoba.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-guoba-'))
process.env.BYM_CONFIG_DIR = path.join(sandbox, 'config')
process.env.BYM_DATA_DIR = path.join(sandbox, 'data')
fs.mkdirSync(process.env.BYM_CONFIG_DIR, { recursive: true })
fs.mkdirSync(process.env.BYM_DATA_DIR, { recursive: true })
fs.cpSync(path.join(pluginRoot, 'presets'), path.join(process.env.BYM_DATA_DIR, 'presets'), { recursive: true })

globalThis.logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  cyan: v => String(v), red: v => String(v), green: v => String(v),
  yellow: v => String(v), blue: v => String(v), magenta: v => String(v),
}
globalThis.Bot = { uin: [], bots: {}, gml: new Map() }

const { config } = await import('../config/config.js')
config.load()

const { supportGuoba } = await import('../guoba.support.js')

// 模拟锅巴的 Result 类（PluginController 里有 `flag instanceof Result` 判断）
class Result {
  constructor (type, data, msg) {
    this.type = type
    this.data = data
    this.msg = msg
  }

  static ok (data, msg = 'ok') { return new Result('ok', data, msg) }
  static error (msg) { return new Result('error', null, msg) }
}

let passed = 0
function test (name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`)
    process.exitCode = 1
  }
}

console.log('\n[1] supportGuoba 契约')
const support = supportGuoba()

test('返回 pluginInfo 与 configInfo', () => {
  assert.ok(support.pluginInfo && support.configInfo)
  assert.equal(typeof support.pluginInfo.name, 'string')
  assert.ok(Array.isArray(support.configInfo.schemas))
  assert.equal(typeof support.configInfo.getConfigData, 'function')
  assert.equal(typeof support.configInfo.setConfigData, 'function')
})

test('pluginInfo.name 与插件目录名一致（锅巴用它做路由 key）', () => {
  assert.equal(support.pluginInfo.name, path.basename(pluginRoot).toLowerCase())
})

test('图标与展示字段齐全', () => {
  assert.ok(support.pluginInfo.title)
  assert.ok(support.pluginInfo.icon)
  assert.equal(support.pluginInfo.isV3, true)
})

console.log('\n[2] schemas 合法性')
const schemas = support.configInfo.schemas

// 锅巴前端 componentMap 里注册过的组件（从 server/static 构建产物提取）
const KNOWN_COMPONENTS = new Set([
  'Input', 'InputPassword', 'InputSearch', 'InputTextArea', 'InputNumber',
  'Switch', 'Select', 'RadioGroup', 'RadioButtonGroup', 'Checkbox', 'CheckboxGroup',
  'Divider', 'SOFT_GROUP_BEGIN', 'Slider', 'Rate', 'AutoComplete', 'Cascader',
  'DatePicker', 'RangePicker', 'TimePicker', 'Upload', 'TreeSelect',
  'GTags', 'GSubForm', 'GButtons', 'GColorPicker', 'GSelectGroup', 'GSelectFriend',
])

test('组件名都在锅巴白名单内', () => {
  const bad = schemas.filter(s => s.component && !KNOWN_COMPONENTS.has(s.component))
  assert.deepEqual(bad.map(s => `${s.field || s.label}:${s.component}`), [])
})

test('每个分组标记都有 label', () => {
  const groups = schemas.filter(s => s.component === 'SOFT_GROUP_BEGIN')
  assert.ok(groups.length > 0)
  assert.ok(groups.every(s => s.label))
})

test('除分组外都有 field / label / component', () => {
  const items = schemas.filter(s => s.component !== 'SOFT_GROUP_BEGIN')
  for (const item of items) {
    assert.ok(item.field, `缺少 field：${item.label}`)
    assert.ok(item.label, `缺少 label：${item.field}`)
    assert.ok(item.component, `缺少 component：${item.field}`)
  }
})

test('每个 field 都能在真实配置里找到（防止拼错路径）', () => {
  const getPath = (obj, keyPath) => String(keyPath).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
  const missing = schemas
    .filter(s => s.field)
    .filter(s => getPath(config.data, s.field) === undefined)
    .map(s => s.field)
  assert.deepEqual(missing, [])
})

test('field 无重复（重复会让前端表单互相覆盖）', () => {
  const fields = schemas.filter(s => s.field).map(s => s.field)
  const dup = fields.filter((f, i) => fields.indexOf(f) !== i)
  assert.deepEqual([...new Set(dup)], [])
})

console.log('\n[3] getConfigData')
const form = support.configInfo.getConfigData()

test('返回嵌套对象，不是扁平 map', () => {
  assert.equal(typeof form.llm, 'object')
  assert.equal(typeof form.trigger, 'object')
})

test('数组字段转成一行一项的文本', () => {
  config.apply({ 'trigger.groups': ['111', '222'], 'trigger.hitKeywords': ['bym', '小助手'] })
  const view = support.configInfo.getConfigData()
  assert.equal(view.trigger.groups, '111\n222')
  assert.equal(view.trigger.hitKeywords, 'bym\n小助手')
})

test('结构化字段转成 JSON 文本，空值给空串', () => {
  config.apply({ 'speaking.presetMap': [{ keywords: ['原神'], presetId: 'bym_tsundere', priority: 10 }], 'llm.extraBody': {} })
  const view = support.configInfo.getConfigData()
  assert.match(view.speaking.presetMap, /"presetId": "bym_tsundere"/)
  assert.equal(view.llm.extraBody, '')
})

test('改 view 不影响真实配置（深拷贝）', () => {
  const view = support.configInfo.getConfigData()
  view.llm.model = '被篡改'
  assert.notEqual(config.data.llm.model, '被篡改')
})

console.log('\n[4] setConfigData')

test('扁平 map 写回嵌套配置', () => {
  const res = support.configInfo.setConfigData({
    'llm.baseURL': 'https://example.com/v1',
    'llm.model': 'test-model',
    'trigger.probability': 0.5,
    'speaking.mode': 'contextual',
  }, { Result })
  assert.equal(res.type, 'ok')
  assert.equal(config.data.llm.baseURL, 'https://example.com/v1')
  assert.equal(config.data.llm.model, 'test-model')
  assert.equal(config.data.trigger.probability, 0.5)
  assert.equal(config.data.speaking.mode, 'contextual')
})

test('写回后立即落盘（不需要重启）', () => {
  const onDisk = fs.readFileSync(config.file, 'utf8')
  assert.match(onDisk, /example\.com\/v1/)
  assert.match(onDisk, /test-model/)
})

test('文本框里的多行内容转回数组', () => {
  support.configInfo.setConfigData({
    'trigger.groups': '123456\n\n  789012  ',
    'trigger.hitKeywords': 'bym\n小助手\nbym',
    'trigger.ignoreCommandPrefixes': '#,/',
  }, { Result })
  assert.deepEqual(config.data.trigger.groups, ['123456', '789012'])
  // 不主动去重：用户可能故意重复，交给运行期判断
  assert.deepEqual(config.data.trigger.hitKeywords, ['bym', '小助手', 'bym'])
  assert.deepEqual(config.data.trigger.ignoreCommandPrefixes, ['#', '/'])
})

test('结构化字段从 JSON 文本解析回来', () => {
  const res = support.configInfo.setConfigData({
    'speaking.presetMap': '[{"keywords":["原神"],"presetId":"bym_tsundere","priority":20}]',
    'llm.fallback': '[{"baseURL":"https://backup/v1","model":"m"}]',
    'llm.extraBody': '{"enable_thinking":false}',
  }, { Result })
  assert.equal(res.type, 'ok')
  assert.deepEqual(config.data.speaking.presetMap, [{ keywords: ['原神'], presetId: 'bym_tsundere', priority: 20 }])
  assert.equal(config.data.llm.fallback[0].baseURL, 'https://backup/v1')
  assert.deepEqual(config.data.llm.extraBody, { enable_thinking: false })
})

test('清空结构化字段得到空数组/空对象', () => {
  support.configInfo.setConfigData({ 'speaking.presetMap': '', 'llm.extraHeaders': '' }, { Result })
  assert.deepEqual(config.data.speaking.presetMap, [])
  assert.deepEqual(config.data.llm.extraHeaders, {})
})

test('非法 JSON 被拒绝，且不写入任何字段', () => {
  const beforeModel = config.data.llm.model
  const beforeFallback = config.data.llm.fallback.length
  const res = support.configInfo.setConfigData({
    'llm.model': '不该被写进去的模型',
    'llm.fallback': '[{not valid json',
  }, { Result })
  assert.equal(res.type, 'error')
  assert.match(res.msg, /备用渠道/)
  // 一项非法则整张表单都不写，避免“改了一半”的更糟状态
  assert.equal(config.data.llm.model, beforeModel)
  assert.equal(config.data.llm.fallback.length, beforeFallback)
})

test('类型不符的 JSON 被拒绝（数组位置填了对象）', () => {
  const res = support.configInfo.setConfigData({ 'speaking.presetMap': '{"a":1}' }, { Result })
  assert.equal(res.type, 'error')
  assert.match(res.msg, /必须是 JSON 数组/)
})

test('对象位置填数组也被拒绝', () => {
  const res = support.configInfo.setConfigData({ 'llm.extraBody': '[1,2]' }, { Result })
  assert.equal(res.type, 'error')
  assert.match(res.msg, /必须是 JSON 对象/)
})

test('数值字段传空串时不写入脏值', () => {
  support.configInfo.setConfigData({ 'trigger.probability': 0.3 }, { Result })
  support.configInfo.setConfigData({ 'trigger.probability': '' }, { Result })
  assert.equal(config.data.trigger.probability, 0.3)
  assert.equal(typeof config.data.trigger.probability, 'number')
})

test('往返一致：改一遍再读回来，值不变', () => {
  support.configInfo.setConfigData({
    'enable': true,
    'trigger.groupMode': 'blacklist',
    'trigger.groups': '1\n2\n3',
    'llm.temperature': 1.2,
    'speaking.recallSeconds': 5,
  }, { Result })
  const view = support.configInfo.getConfigData()
  assert.equal(view.enable, true)
  assert.equal(view.trigger.groupMode, 'blacklist')
  assert.equal(view.trigger.groups, '1\n2\n3')
  assert.equal(view.llm.temperature, 1.2)
  assert.equal(view.speaking.recallSeconds, 5)
})

test('保存后记录了 mtime（供热加载跳过自身写入）', () => {
  // config.apply 会更新 mtimeMs，watch 回调据此跳过自身写入，
  // 否则锅巴保存一次就会触发一次重载。
  assert.ok(config.mtimeMs > 0)
})

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项检查${process.exitCode ? '，存在失败项' : ''}\n`)
process.exit(process.exitCode || 0)
