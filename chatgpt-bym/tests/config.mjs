/**
 * 配置接入测试：防「新增配置段但忘记注册访问器」。
 *
 * 背景：config 的段访问器曾经是手写 getter 列表，新增 guard/dedup 段时漏了注册，
 * 结果 config.guard 是 undefined —— 所有 config.guard?.xxx 静默走默认分支，
 * 表现为「面板里改了开关但完全没反应」，不报错、日志也看不出来。
 *
 * 这个测试用「扫源码」而不是「手写清单」，所以以后再加配置段一旦漏注册就会失败。
 * 运行：node tests/config.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

global.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-cfg-'))
process.env.BYM_CONFIG_DIR = path.join(sandbox, 'config')
process.env.BYM_DATA_DIR = path.join(sandbox, 'data')
fs.mkdirSync(process.env.BYM_CONFIG_DIR, { recursive: true })
fs.mkdirSync(process.env.BYM_DATA_DIR, { recursive: true })
fs.cpSync(path.resolve(import.meta.dirname, '..', 'presets'), path.join(process.env.BYM_DATA_DIR, 'presets'), { recursive: true })

const { config } = await import('../config/config.js')
config.load()
const triggerMod = await import('../utils/trigger.js')

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

/** BymConfig 类自己的成员，不是配置段 */
const CLASS_MEMBERS = new Set([
  'data', 'file', 'mtimeMs', 'load', 'save', 'set', 'get', 'watch', 'apply', 'enabled',
  '_timer', '_watcher',
])

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'data') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

console.log('\n[1] DEFAULTS 的每个配置段都能访问')
// 只查对象类型的段：标量键（enable / commandPrefix）直接用 config.data.xxx，
// 没有也不需要有同名访问器。
for (const section of Object.keys(config.data)) {
  if (config.data[section] === null || typeof config.data[section] !== 'object') continue
  test(`config.${section} 不是 undefined`, () => {
    assert.notEqual(config[section], undefined, `缺访问器：config.${section}`)
    assert.deepEqual(config[section], config.data[section])
  })
}

console.log('\n[2] 源码里用到的每个 config.xxx 都真实存在')
const root = path.resolve(import.meta.dirname, '..')
// 文件名里的 config.yaml / config.json 也会被正则抓到，按扩展名排除
const FILE_EXTS = new Set(['yaml', 'yml', 'json', 'js', 'mjs', 'md', 'example', 'tmp', 'bak', 'log', 'db', 'lock', 'ts'])
const used = new Set()
for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf8')
  // 跳过注释行里的用法，避免误报
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const m of line.matchAll(/\bconfig\.([A-Za-z_$][\w$]*)/g)) {
      if (FILE_EXTS.has(m[1])) continue
      used.add(m[1])
    }
  }
}
test(`扫到 ${used.size} 个 config.xxx 用法`, () => {
  assert.ok(used.size > 5, '扫描结果太少，正则可能失效了')
})
for (const name of [...used].sort()) {
  if (CLASS_MEMBERS.has(name)) continue
  test(`config.${name} 可访问`, () => {
    assert.notEqual(config[name], undefined, `源码里用了 config.${name}，但没有对应访问器或配置段`)
  })
}

console.log('\n[3] 关键开关取值正确')
test('guard.enable 默认 true', () => {
  assert.equal(config.guard.enable, true)
})
test('guard.retry 默认 false（不额外多一次请求）', () => {
  assert.equal(config.guard.retry, false)
})
test('dedup.enable 默认 true', () => {
  assert.equal(config.dedup.enable, true)
})
test('set 能一路写到新段里', () => {
  config.set('guard.enable', false)
  assert.equal(config.guard.enable, false)
  config.set('guard.enable', true)
  assert.equal(config.guard.enable, true)
})
test('落盘后重新解析，新段还在', async () => {
  const raw = fs.readFileSync(path.join(process.env.BYM_CONFIG_DIR, 'config.yaml'), 'utf8')
  assert.match(raw, /^guard:/m)
  assert.match(raw, /^dedup:/m)
})

console.log('\n[4] 数组写成标量会被自动修正（而不是运行时崩）')
/** 写一个坏值再重载，看 load() 有没有修回来 */
function loadWith (keyPath, badValue) {
  config.set(keyPath, badValue)
  config.load()
  return keyPath.split('.').reduce((obj, k) => obj?.[k], config.data)
}

test('groups 写成数字 → 包成 [123456]', () => {
  const v = loadWith('trigger.groups', 123456)
  assert.deepEqual(v, [123456], `实际 ${JSON.stringify(v)}`)
})
test('hitKeywords 写成字符串 → 包成单元素数组', () => {
  const v = loadWith('trigger.hitKeywords', 'bym')
  assert.deepEqual(v, ['bym'])
})
test('muteKeywords 写成字符串 → 包成单元素数组', () => {
  assert.deepEqual(loadWith('trigger.muteKeywords', '砍一刀'), ['砍一刀'])
})
test('ignoreCommandPrefixes 写成字符串 → 包成单元素数组', () => {
  assert.deepEqual(loadWith('trigger.ignoreCommandPrefixes', '#'), ['#'])
})
test('空串 / null 视为没填，用默认值', () => {
  assert.deepEqual(loadWith('trigger.groups', ''), [])
  assert.deepEqual(loadWith('trigger.groups', null), [])
})
test('本来就是数组时原样保留', () => {
  assert.deepEqual(loadWith('trigger.groups', ['111', '222']), ['111', '222'])
})
test('修正后 trigger.js 不再抛错（这条是真正的回归点）', () => {
  const { isGroupAllowed, evaluate } = triggerMod
  config.set('trigger.groups', 123456)
  config.load()
  assert.deepEqual(config.data.trigger.groups, [123456], '前置：数组应已修正')
  config.set('trigger.groupMode', 'whitelist')
  config.set('enable', true)
  assert.equal(
    isGroupAllowed('123456'),
    true,
    `groupMode=${config.data.trigger.groupMode} groups=${JSON.stringify(config.data.trigger.groups)}`
  )

  config.set('trigger.hitKeywords', 'bym')
  config.load()
  config.set('trigger.probability', 0)
  const r = evaluate({ isGroup: true, group_id: '123456', self_id: '9', user_id: '8', message: [], raw_message: 'x' }, 'bym 你好')
  assert.equal(r.forced, true)
})

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
