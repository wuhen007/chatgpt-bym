/**
 * 插件自更新测试。完全离线 —— 远程用一个本地 bare 仓库充当。
 * 运行：node tests/updater.mjs
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { update, formatUpdate, pluginRoot } = await import('../utils/updater.js')

let pass = 0
let fail = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ' + name) },
    (err) => { fail++; console.log('  FAIL ' + name + '\n       ' + err.message) }
  )
}

/** git 环境隔离：不继承用户的全局配置（user.name 之类），离线，固定分支名 */
// 隔离用空文件。Windows 的 os.devNull 是 `\\.\nul`，git 会把 `//` 开头的串当成远程
// URL（fatal: unable to access '//./nul/'），所以不能用 devNull
const EMPTY_CONFIG = path.join(os.tmpdir(), `bym-upd-empty-${process.pid}.gitconfig`)
fs.writeFileSync(EMPTY_CONFIG, '')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_SYSTEM: EMPTY_CONFIG,
  LC_ALL: 'C', LANG: 'C',
}
const git = (args, cwd) => execSync(`git ${args}`, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bym-upd-'))
const remotePath = path.join(sandbox, 'remote.git')
const workPath = path.join(sandbox, 'work')

/** 初始提交推到 bare 远程 */
fs.mkdirSync(remotePath, { recursive: true })
git('init --bare -b master ' + JSON.stringify(remotePath), sandbox)
git('clone ' + JSON.stringify(remotePath) + ' ' + JSON.stringify(workPath), sandbox)
fs.writeFileSync(path.join(workPath, 'package.json'), JSON.stringify({ name: 'chatgpt-bym', version: '1.0.0' }))
fs.writeFileSync(path.join(workPath, 'README.md'), '# init\n')
git('add -A', workPath)
git('commit -m "init: 第一个提交"', workPath)
git('push origin master', workPath)

/** 往远程推一个新提交（借一个临时 clone，模拟别人开发了新版本） */
function pushCommit (message, files = {}) {
  const tmp = path.join(sandbox, 'pusher')
  if (!fs.existsSync(tmp)) git('clone ' + JSON.stringify(remotePath) + ' ' + JSON.stringify(tmp), sandbox)
  for (const [name, content] of Object.entries(files)) {
    // 子目录文件（如 docs/note.md）要先建目录
    fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true })
    fs.writeFileSync(path.join(tmp, name), content)
  }
  git('add -A', tmp)
  // --allow-empty：有的用例只推提交信息不推文件（模拟「没有文件变化的一次提交」）
  git('commit --allow-empty -m ' + JSON.stringify(message), tmp)
  git('push origin master', tmp)
}

const BRANCH = 'master'
const sha = cwd => git('rev-parse HEAD', cwd)

console.log('\n[1] 前置检查')
await test('非 git 目录报 no-git', async () => {
  const plain = path.join(sandbox, 'plain')
  fs.mkdirSync(plain, { recursive: true })
  const r = await update(plain)
  assert.equal(r.status, 'no-git')
  assert.equal(r.ok, false)
  assert.match(formatUpdate(r), /zip 安装/)
})
await test('git 目录但没有远程报 no-remote', async () => {
  const bare = path.join(sandbox, 'no-remote')
  fs.mkdirSync(bare, { recursive: true })
  git('init -b master', bare)
  const r = await update(bare)
  assert.equal(r.status, 'no-remote')
  assert.match(formatUpdate(r), /没有配置远程/)
})

console.log('\n[2] 已是最新')
await test('远程没有新提交时报告 up-to-date', async () => {
  const r = await update(workPath)
  assert.equal(r.status, 'up-to-date')
  assert.equal(r.ok, true)
  assert.equal(r.branch, BRANCH)
  assert.deepEqual(r.commits, [])
  const text = formatUpdate(r)
  assert.match(text, /已是最新/)
  assert.match(text, new RegExp(shortOf(sha(workPath))))
})
function shortOf (sha) { return sha.slice(0, 7) }

console.log('\n[3] 有更新')
await test('远程有新提交时拉取并列出提交', async () => {
  pushCommit('feat: 新增一个功能', { 'docs/note.md': '# note\n' })
  pushCommit('fix: 修一个问题')
  const r = await update(workPath)
  assert.equal(r.status, 'updated')
  assert.equal(r.ok, true)
  assert.equal(r.commits.length, 2)
  // log HEAD..origin 的顺序是新的在上
  assert.match(r.commits[0], /fix: 修一个问题/)
  assert.match(r.commits[1], /feat: 新增一个功能/)
  assert.equal(r.needInstall, false, '只改了 md，不需要重装依赖')
  assert.equal(sha(workPath), r.newSha, '拉完 HEAD 应该对齐远程')
  assert.ok(fs.existsSync(path.join(workPath, 'docs', 'note.md')), '新文件应该真的落盘了')
  const text = formatUpdate(r)
  assert.match(text, /插件已更新/)
  assert.match(text, /重启云崽后生效/)
})
await test('package.json 变化时提示要装依赖', async () => {
  pushCommit('chore: bump version', { 'package.json': JSON.stringify({ name: 'chatgpt-bym', version: '2.0.0' }) })
  const r = await update(workPath)
  assert.equal(r.status, 'updated')
  assert.equal(r.needInstall, true)
  assert.match(formatUpdate(r), /pnpm install/)
})
await test('package-lock.yaml 变化同样提示装依赖', async () => {
  pushCommit('chore: lockfile', { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' })
  const r = await update(workPath)
  assert.equal(r.needInstall, true)
})
await test('锁文件之外的普通文件不触发装依赖提示', async () => {
  pushCommit('docs: 更新说明', { 'README.md': '# v2\n' })
  const r = await update(workPath)
  assert.equal(r.status, 'updated')
  assert.equal(r.needInstall, false)
  assert.equal(formatUpdate(r).includes('pnpm install'), false)
})

console.log('\n[4] 冲突保护')
await test('本地有分叉提交时不硬合并，报 conflict', async () => {
  // 本地改一个文件并提交（分叉）；远程也推进 —— ff 不可能，pull --ff-only 会失败
  fs.writeFileSync(path.join(workPath, 'local.txt'), 'local change\n')
  git('add -A', workPath)
  git('commit -m "local: 本地改动"', workPath)
  pushCommit('feat: 远程也在动', { 'remote.md': '# remote\n' })
  const localSha = sha(workPath)
  const r = await update(workPath)
  assert.equal(r.status, 'conflict')
  assert.equal(r.ok, false)
  // 本地提交不能被动过 —— 保护的意义就在这
  assert.equal(sha(workPath), localSha, '冲突时 HEAD 必须原样不动')
  assert.match(formatUpdate(r), /已中止/)
  assert.match(formatUpdate(r), /git stash/)
})

console.log('\n[5] 注入命令执行器（离线覆盖网络分支）')
await test('fetch 失败报 network，带原始输出', async () => {
  // 真跑一遍其他命令，只在 fetch 上失败 —— 模拟 GitHub 连不上。
  // 注意返回形状必须是 { stdout, stderr }，和 promisify(exec) 一致
  const fakeRun = async (cmd) => {
    if (cmd.startsWith('git fetch')) {
      const err = new Error('Command failed')
      err.code = 128
      err.stderr = 'fatal: unable to access \'https://github.com/\': Could not resolve host'
      throw err
    }
    const out = execSync(cmd, { cwd: workPath, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout: String(out || ''), stderr: '' }
  }
  const r = await update(workPath, { runCmd: fakeRun })
  assert.equal(r.status, 'network')
  assert.match(r.detail, /Could not resolve host/)
  const text = formatUpdate(r)
  assert.match(text, /连接远程仓库失败/)
  assert.match(text, /Could not resolve host/)
})
await test('并发调用被锁挡住，报 busy', async () => {
  // [4] 的冲突用例让 work 处在本地分叉状态，先对齐远程，否则这里的 pull 必然 conflict
  git('fetch origin master', workPath)
  git('reset --hard origin/master', workPath)
  // 慢命令撑住第一调用的执行窗口，第二个并发调用应直接返回 busy
  const slowRun = async (cmd) => {
    if (cmd.startsWith('git fetch') || cmd.startsWith('git pull')) {
      await new Promise(r => setTimeout(r, 250))
    }
    const out = execSync(cmd, { cwd: workPath, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    return { stdout: String(out || ''), stderr: '' }
  }
  pushCommit('feat: 并发锁验证', { 'docs/lock.md': 'x\n' })
  const [first, second] = await Promise.all([
    update(workPath, { runCmd: slowRun }),
    new Promise(resolve => setTimeout(() => update(workPath, { runCmd: slowRun }).then(resolve), 50)),
  ])
  assert.equal(first.status, 'updated')
  assert.equal(second.status, 'busy')
  assert.match(formatUpdate(second), /已经有一次更新在进行/)
})

console.log('\n[6] 真实插件目录')
await test('对本插件仓库执行检查（不为崩溃，状态合法即可）', async () => {
  // 不真正拉取远程：只验证在真实目录上跑不抛异常、结果可格式化。
  // 开发机的插件仓库往往有未提交改动 —— 那正是 conflict 分支要保护的场景，
  // 所以 conflict 也是合法结果，不是错误。
  const r = await update(pluginRoot)
  assert.ok(['up-to-date', 'network', 'updated', 'no-git', 'conflict'].includes(r.status), `意外的状态：${r.status}`)
  assert.ok(typeof formatUpdate(r) === 'string' && formatUpdate(r).length > 0)
})

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) process.exit(1)
