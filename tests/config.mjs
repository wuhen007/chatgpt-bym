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

const configMod = await import('../config/config.js')
const { config } = configMod
config.load()
const triggerMod = await import('../utils/trigger.js')

let pass = 0
let fail = 0
function test (name, fn) {
  try {
    const ret = fn()
    // 异步用例传进来会「假通过」：fn() 返回 Promise，try 块里的断言失败
    // 变成 unhandled rejection，而这里已经先记成通过了。当场拦下来。
    if (ret && typeof ret.then === 'function') {
      throw new Error('这是异步用例，请改用 await testAsync(...)')
    }
    pass++
    console.log('  ok  ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name + '\n       ' + err.message)
  }
}

/** 异步版本的 test。必须 await，否则统计不到。 */
async function testAsync (name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok  ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name + '\n       ' + err.message)
  }
}

/** BymConfig 类自己的成员，不是配置段 */
const CLASS_MEMBERS = new Set([
  'data', 'file', 'mtimeMs', 'load', 'save', 'set', 'get', 'watch', 'unwatch', 'apply', 'enabled',
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
// 只扫插件自己的源码。仓库根同时放着开发环境（sim-lab/、.ref/）和上游项目
// （chatgpt-plugin/），那些代码里的 config.xxx 属于别的配置体系，
// 扫进来会报出一堆「缺访问器」的假失败。
const SRC_ENTRIES = ['index.js', 'guoba.support.js', 'apps', 'models', 'utils', 'config']
const srcFiles = []
for (const name of SRC_ENTRIES) {
  const full = path.join(root, name)
  if (!fs.existsSync(full)) continue
  if (fs.statSync(full).isDirectory()) srcFiles.push(...walk(full))
  else srcFiles.push(full)
}
// 文件名里的 config.yaml / config.json 也会被正则抓到，按扩展名排除
const FILE_EXTS = new Set(['yaml', 'yml', 'json', 'js', 'mjs', 'md', 'example', 'tmp', 'bak', 'log', 'db', 'lock', 'ts'])
const used = new Set()
for (const file of srcFiles) {
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
test('guard.allowSelfClaim 默认 false（人设不该自称 AI）', () => {
  assert.equal(config.guard.allowSelfClaim, false)
})
test('默认人设是大肥鱼', () => {
  assert.equal(config.speaking.defaultPresetId, 'bym_dafeiyu')
})
test('dedup.enable 默认 true', () => {
  assert.equal(config.dedup.enable, true)
})
test('默认接口与模型指向 DeepSeek', () => {
  // 新装用户只有这两项是「猜对的」，写错就跑不起来。
  // 锁住是为了改默认值时能立刻发现，不是怕别人改。
  assert.equal(config.llm.baseURL, 'https://api.deepseek.com')
  assert.equal(config.llm.model, 'deepseek-flash')
})
await testAsync('默认端点在 llmClient 里补成 /v1/chat/completions', async () => {
  const { endpointOf } = await import('../models/llmClient.js')
  // 三种写法都要归一到同一个端点：这是用户填地址时最容易出错的地方
  assert.equal(endpointOf('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(endpointOf('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(endpointOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(
    endpointOf('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions'
  )
})
test('set 能一路写到新段里', () => {
  config.set('guard.enable', false)
  assert.equal(config.guard.enable, false)
  config.set('guard.enable', true)
  assert.equal(config.guard.enable, true)
})
await testAsync('落盘后重新解析，新段还在', async () => {
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

console.log('\n[5] 配置损坏保护（解析失败时绝不覆盖用户文件）')

const CONFIG_FILE = path.join(process.env.BYM_CONFIG_DIR, 'config.yaml')
const BROKEN_BACKUP = `${CONFIG_FILE}.broken`
const GOOD = 'enable: true\nllm:\n  apiKey: sk-real-key-123\n  model: my-model\n'

function writeRaw (text) {
  fs.writeFileSync(CONFIG_FILE, text)
  // 让 watch 的 mtime 比较不会误判
  config.mtimeMs = 0
}
function clearBroken () {
  config._readonly = false
  if (fs.existsSync(BROKEN_BACKUP)) fs.unlinkSync(BROKEN_BACKUP)
}

test('Tab 缩进 → 进入只读保护，不抛异常', () => {
  clearBroken()
  writeRaw('llm:\n\tapiKey: sk-real-key-123\n')
  config.load()
  assert.equal(config._readonly, true, '应该进入只读模式')
  assert.equal(config.data.llm.apiKey, '', '内存里是默认值（apiKey 空）')
})

test('坏文件被备份，且备份里 key 还在', () => {
  assert.ok(fs.existsSync(BROKEN_BACKUP), '应生成 .broken 备份')
  assert.match(fs.readFileSync(BROKEN_BACKUP, 'utf8'), /sk-real-key-123/)
})

test('只读期间 set 既不写盘也不改内存（避免状态漂移）', () => {
  const before = fs.readFileSync(CONFIG_FILE, 'utf8')
  const ok = config.set('speaking.recallSeconds', 12)
  assert.equal(ok, false, 'set 应返回 false 表示没写盘')
  // 关键：内存也不该变。只改内存不改磁盘的话，用户看到「已生效」，
  // 等配置文件修好触发重载，这个修改又会静默消失。
  assert.notEqual(config.data.speaking.recallSeconds, 12, '内存里也不该生效')
  assert.equal(fs.readFileSync(CONFIG_FILE, 'utf8'), before, '文件必须一字不改')
})

test('修好配置后自动解除只读并读回真实值', () => {
  writeRaw(GOOD)
  config.load()
  assert.equal(config._readonly, false)
  assert.equal(config.data.llm.apiKey, 'sk-real-key-123')
  assert.equal(config.data.llm.model, 'my-model')
})

test('全角冒号也能拦住（这条最阴：YAML 不报错，整份文件解析成一个字符串）', () => {
  clearBroken()
  writeRaw('llm：\n  apiKey：sk-real-key-123\n')
  config.load()
  assert.equal(config._readonly, true, '顶层不是映射时必须当成坏配置')
  assert.match(fs.readFileSync(BROKEN_BACKUP, 'utf8'), /sk-real-key-123/, '原文必须被备份下来')
})

test('顶层是数组也拦住', () => {
  clearBroken()
  writeRaw('- a\n- b\n')
  config.load()
  assert.equal(config._readonly, true)
})

test('引号不配对拦住', () => {
  clearBroken()
  writeRaw('llm:\n  apiKey: "sk-real-key-123\n')
  config.load()
  assert.equal(config._readonly, true)
})

test('空文件不算坏，用默认值且可以写盘', () => {
  clearBroken()
  writeRaw('')
  config.load()
  assert.equal(config._readonly, false, '空文件应视为新配置')
  assert.equal(config.data.enable, false, '默认 enable 是 false')
})

test('多次损坏时保留最早那份备份，不被新的坏文件覆盖', () => {
  clearBroken()
  writeRaw('bad1:\n\tx: 1\n')
  config.load()
  const first = fs.readFileSync(BROKEN_BACKUP, 'utf8')
  writeRaw('bad2:\n\ty: 2\n')
  config.load()
  assert.equal(fs.readFileSync(BROKEN_BACKUP, 'utf8'), first, '第一次的备份才最可能是有用的那份')
})

test('恢复后能正常写盘，且不留临时文件', () => {
  clearBroken()
  writeRaw(GOOD)
  config.load()
  config.set('speaking.recallSeconds', 7)
  assert.match(fs.readFileSync(CONFIG_FILE, 'utf8'), /recallSeconds: 7/)
  assert.equal(fs.existsSync(`${CONFIG_FILE}.tmp`), false, '原子写不该留下 .tmp')
})

test('缺新增项时只补内存，不改写文件（否则注释会被清空）', () => {
  clearBroken()
  // 只给一个键，其余全靠默认值补
  writeRaw('# 我手写的注释，升级后应该还在\nenable: true\n')
  config.load()
  const text = fs.readFileSync(CONFIG_FILE, 'utf8')
  assert.match(text, /我手写的注释/, '注释必须保留')
  assert.equal(text.trim(), '# 我手写的注释，升级后应该还在\nenable: true'.trim(), '文件不该被改写')
  assert.equal(config.data.trigger.probability, 0.02, '但内存里应该补上了默认值')
})

console.log('\n[6] 配置与数据的存放位置')

const { detectYunzaiRoot, migrateFromPluginDir } = configMod

/** 在临时目录搭一个假的云崽：<root>/package.json + plugins/chatgpt-bym/ */
function fakeYunzai (pkg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-yz-'))
  if (pkg !== null) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  const plugin = path.join(root, 'plugins', 'chatgpt-bym')
  fs.mkdirSync(plugin, { recursive: true })
  return { root, plugin }
}

test('标准布局 + 包名含 yunzai → 认出根目录', () => {
  const { root, plugin } = fakeYunzai({ name: 'trss-yunzai' })
  assert.equal(detectYunzaiRoot(plugin), root)
  fs.rmSync(root, { recursive: true, force: true })
})

test('包名不含 yunzai（自定义 fork）→ 认不出，退回原路径', () => {
  const { root, plugin } = fakeYunzai({ name: 'my-bot' })
  assert.equal(detectYunzaiRoot(plugin), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('不在 plugins/ 下一层 → 认不出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-yz-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trss-yunzai' }))
  const plugin = path.join(root, 'somewhere', 'chatgpt-bym')
  fs.mkdirSync(plugin, { recursive: true })
  assert.equal(detectYunzaiRoot(plugin), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('没有 package.json → 认不出，不报错', () => {
  const { root, plugin } = fakeYunzai(null)
  assert.equal(detectYunzaiRoot(plugin), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('迁移：旧位置有、新位置没有 → 复制过去', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  fs.writeFileSync(path.join(src, 'config.yaml'), 'llm:\n  apiKey: sk-abc\n')
  fs.mkdirSync(path.join(src, 'data'))
  fs.writeFileSync(path.join(src, 'data', 'memory.json'), '{"version":2,"groups":{}}')

  const moved = migrateFromPluginDir({
    dataHome: dst,
    legacyConfigDir: src,
    legacyDataDir: path.join(src, 'data'),
    configDir: dst,
    dataDir: dst,
  })
  assert.deepEqual(moved.sort(), ['config.yaml', 'memory.json'])
  assert.match(fs.readFileSync(path.join(dst, 'config.yaml'), 'utf8'), /sk-abc/)
  assert.ok(fs.existsSync(path.join(dst, 'memory.json')))
  // 原件必须保留
  assert.ok(fs.existsSync(path.join(src, 'config.yaml')), '旧文件不能被删')
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(dst, { recursive: true, force: true })
})

test('迁移：新位置已有配置 → 不覆盖', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  fs.writeFileSync(path.join(src, 'config.yaml'), 'enable: false\n')
  fs.writeFileSync(path.join(dst, 'config.yaml'), 'enable: true\n')

  const moved = migrateFromPluginDir({
    dataHome: dst,
    legacyConfigDir: src,
    legacyDataDir: path.join(src, 'data'),
    configDir: dst,
    dataDir: dst,
  })
  assert.deepEqual(moved, [])
  assert.match(fs.readFileSync(path.join(dst, 'config.yaml'), 'utf8'), /enable: true/, '新位置优先')
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(dst, { recursive: true, force: true })
})

test('没检测到云崽（dataHome 为 null）时完全不迁移', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  fs.writeFileSync(path.join(src, 'config.yaml'), 'enable: true\n')
  const moved = migrateFromPluginDir({
    dataHome: null,
    legacyConfigDir: src,
    legacyDataDir: src,
    configDir: src,
    dataDir: src,
  })
  assert.deepEqual(moved, [])
  fs.rmSync(src, { recursive: true, force: true })
})

test('旧位置什么都没有 → 返回空，不报错', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-mig-'))
  const moved = migrateFromPluginDir({
    dataHome: dst,
    legacyConfigDir: src,
    legacyDataDir: path.join(src, 'data'),
    configDir: dst,
    dataDir: dst,
  })
  assert.deepEqual(moved, [])
  fs.rmSync(src, { recursive: true, force: true })
  fs.rmSync(dst, { recursive: true, force: true })
})

console.log('\n[7] 危险输入')

test('__proto__ 路径被拒绝，且不污染原型', () => {
  config._readonly = false
  const before = {}.polluted
  const ok = config.set('__proto__.polluted', 'yes')
  assert.equal(ok, false, '应拒绝')
  assert.equal({}.polluted, before, 'Object.prototype 不该被改')
  delete Object.prototype.polluted
})

test('apply 里混入 __proto__ 只跳过那一条，其余照常写入', () => {
  const ok = config.apply({ '__proto__.polluted': 'yes', 'speaking.recallSeconds': 33 })
  assert.equal(ok, true, '合法项仍应写入')
  assert.equal(config.data.speaking.recallSeconds, 33)
  assert.equal({}.polluted, undefined, 'Object.prototype 不该被改')
  delete Object.prototype.polluted
})

test('constructor / prototype 段也拒绝', () => {
  config.set('constructor.x', 1)
  config.set('a.prototype.b', 1)
  assert.equal({}.x, undefined)
  assert.equal(typeof Object.prototype.b, 'undefined')
})

// ── 剩下这条要起新模块实例（configDir 是 import 时求值的常量），用 top-level await ──
console.log('\n[8] 目录建不出来时不能把插件带崩')
{
  const blocker = path.join(sandbox, 'blocker-file')
  fs.writeFileSync(blocker, 'x')
  const saved = process.env.BYM_CONFIG_DIR
  process.env.BYM_CONFIG_DIR = blocker
  const mod = await import(`../config/config.js?blocker=${Date.now()}`)
  let threw = null
  try { mod.config.load() } catch (e) { threw = e }
  process.env.BYM_CONFIG_DIR = saved

  if (threw) {
    fail++
    console.log('  FAIL load 不该把异常抛给 index.js\n       ' + threw.message)
  } else if (mod.config._readonly !== true) {
    fail++
    console.log('  FAIL 应该退到只读保护模式')
  } else {
    pass++
    console.log('  ok  load 不抛错，退到只读模式（插件能起来）')
  }
}

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n通过 ${pass} 项${fail ? `，失败 ${fail} 项` : ''}`)
if (fail) process.exit(1)
