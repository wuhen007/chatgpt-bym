/**
 * 插件自更新：`#伪人更新` 背后的逻辑。
 *
 * 为什么不直接 `git pull` 完事：群里触发这条指令的人只想知道「更新了什么、
 * 要不要重启、要不要装依赖」。所以要分步拿信息，把结果组织成人话。
 *
 * 全部命令都带超时 —— 网络不通时挂着不回话，比更新失败更糟。
 * exec 的回调风格在这里没优势，promisify 串行写更清楚。
 *
 * cwd 可注入（测试用临时 git 仓库），runCmd 也可注入（离线测试）。
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execAsync = promisify(exec)

/** 插件根目录（utils/ 的上一级）。更新就发生在这里。 */
export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 单条 git 命令的超时。fetch 网络慢，给足一点 */
const CMD_TIMEOUT = 90_000

/** 已有一次更新在进行中。两个主人同时发指令时，git 操作会互相踩 */
let inFlight = false

/**
 * 跑一条 git 命令。失败不抛 —— 上层要的是「带原因的结果」而不是中断。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code?: number}>}
 */
async function git (args, { cwd, runCmd } = {}) {
  const execFn = runCmd || execAsync
  try {
    const { stdout, stderr } = await execFn(`git ${args}`, {
      cwd,
      timeout: CMD_TIMEOUT,
      windowsHide: true,
      // git 在中文 Windows 上输出 GBK 会被 exec 按 utf8 解成乱码；
      // 强制英文输出，判断就只依赖 exit code，不猜语言
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    return { ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }
  } catch (err) {
    return { ok: false, stdout: String(err.stdout || '').trim(), stderr: String(err.stderr || err.message || '').trim(), code: err.code }
  }
}

/**
 * 执行更新，返回结构化结果。
 *
 * @param {string} [cwd] 插件根目录，默认自动推导
 * @param {object} [options]
 * @param {Function} [options.runCmd] 注入的命令执行器，测试用
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'updated'|'up-to-date'|'no-git'|'no-remote'|'conflict'|'network'|'error',
 *   branch?: string,
 *   commits?: string[],      // 这次更新的提交（oneline 格式，新的在上）
 *   needInstall?: boolean,   // package.json 变了，需要重新装依赖
 *   detail?: string,         // 给用户看的原始 git 输出片段
 *   oldSha?: string, newSha?: string,
 * }>}
 */
export async function update (cwd = pluginRoot, { runCmd } = {}) {
  // 并发保护：git 操作没有锁，两个同时跑 fetch/pull 会互相踩。
  // 真实场景很少见（两个主人同时发指令），但挡一下只要一行。
  if (inFlight) {
    return { ok: false, status: 'busy' }
  }
  inFlight = true
  try {
    return await doUpdate(cwd, { runCmd })
  } finally {
    inFlight = false
  }
}

async function doUpdate (cwd, { runCmd } = {}) {
  // zip 安装的用户没有 .git。这一步放在最前面，报错信息才对得上他们的场景
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    return { ok: false, status: 'no-git' }
  }

  // 有没有配远程：git init 了但没 remote 的目录，fetch 会报错得很难看
  const remote = await git('remote get-url origin', { cwd, runCmd })
  if (!remote.ok) {
    return { ok: false, status: 'no-remote', detail: remote.stderr }
  }

  const branch = await git('rev-parse --abbrev-ref HEAD', { cwd, runCmd })
  if (!branch.ok) {
    return { ok: false, status: 'error', detail: branch.stderr }
  }

  // 记下更新前的 HEAD：后面用它算「这次到底更新了哪些文件」
  const oldSha = await git('rev-parse HEAD', { cwd, runCmd })
  if (!oldSha.ok) {
    return { ok: false, status: 'error', detail: oldSha.stderr }
  }

  // 先 fetch 再比较，而不是直接 pull：
  // 「已是最新」和「有更新」要在拉之前就知道，才能给出对应的话
  const fetched = await git(`fetch origin ${branch.stdout}`, { cwd, runCmd })
  if (!fetched.ok) {
    // fetch 失败大概率是网络（GitHub 直连不通），把原始报错带给用户
    return { ok: false, status: 'network', branch: branch.stdout, detail: fetched.stderr }
  }

  const remoteSha = await git(`rev-parse origin/${branch.stdout}`, { cwd, runCmd })
  if (!remoteSha.ok) {
    return { ok: false, status: 'error', detail: remoteSha.stderr }
  }

  if (remoteSha.stdout === oldSha.stdout) {
    return { ok: true, status: 'up-to-date', branch: branch.stdout, oldSha: oldSha.stdout, newSha: oldSha.stdout, commits: [] }
  }

  // 要更新什么：提交列表给用户看，文件列表用来判断要不要重装依赖
  const log = await git(`log --oneline HEAD..origin/${branch.stdout}`, { cwd, runCmd })
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean) : []

  // --ff-only：本地没动过才快进。本地有改动时拒绝而不是硬合并 ——
  // 自动 merge 冲突会让插件处于「改了一半」的状态，比不更新糟
  const pulled = await git('pull --ff-only', { cwd, runCmd })
  if (!pulled.ok) {
    return {
      ok: false,
      status: 'conflict',
      branch: branch.stdout,
      commits,
      detail: pulled.stdout + (pulled.stderr ? `\n${pulled.stderr}` : ''),
    }
  }

  const newSha = await git('rev-parse HEAD', { cwd, runCmd })
  const changed = await git(`diff --name-only ${oldSha.stdout} ${newSha.stdout || 'HEAD'}`, { cwd, runCmd })
  const files = changed.ok ? changed.stdout.split('\n').map(f => f.trim()).filter(Boolean) : []
  // 依赖变了就必须重装，否则更新后可能因为缺新依赖起不来
  const needInstall = files.some(f => f === 'package.json' || f === 'pnpm-lock.yaml' || f === 'package-lock.json')

  return {
    ok: true,
    status: 'updated',
    branch: branch.stdout,
    commits,
    needInstall,
    detail: pulled.stdout,
    oldSha: oldSha.stdout,
    newSha: newSha.stdout || '',
  }
}

/**
 * 把 update() 的结果转成给用户看的文本。
 * 放在 updater 而不是 apps/admin.js：格式化的每种分支都要被测试覆盖到，
 * 而 apps/ 依赖云崽的 plugin 基类，单测环境里加载不了。
 */
export function formatUpdate (result) {
  const shortSha = sha => String(sha || '').slice(0, 7)
  switch (result.status) {
    case 'updated': {
      const lines = [`插件已更新（${result.branch} 分支，${result.commits.length} 个提交）：`]
      for (const commit of result.commits.slice(0, 8)) lines.push(`  ${commit}`)
      if (result.commits.length > 8) lines.push(`  …等共 ${result.commits.length} 个提交`)
      if (result.needInstall) {
        lines.push('')
        lines.push('⚠ 依赖有变化，请在插件目录执行 pnpm install 后再重启')
      }
      lines.push('')
      lines.push('重启云崽后生效')
      return lines.join('\n')
    }
    case 'up-to-date':
      return `已是最新（${result.branch} @ ${shortSha(result.newSha)}）`
    case 'no-git':
      return [
        '插件目录不是 git 仓库（zip 安装的），无法自动更新。',
        '用 zip 重新下载覆盖即可 —— 配置和记忆在 Yunzai/data/chatgpt-bym/，不受影响。',
      ].join('\n')
    case 'no-remote':
      return '这个插件目录没有配置远程仓库（git remote origin），无法自动更新'
    case 'busy':
      return '已经有一次更新在进行中，等它结束再试'
    case 'conflict':
      return [
        '本地文件有改动，直接更新会产生冲突，已中止（你的改动没有被覆盖）。',
        '如果本地改动不重要，可以在插件目录执行：',
        '  git stash && git pull --ff-only && git stash pop',
        'git 输出：',
        String(result.detail || '').split('\n').slice(0, 6).map(l => `  ${l}`).join('\n'),
      ].join('\n')
    case 'network':
      return [
        '连接远程仓库失败，检查网络后重试。',
        'git 输出：',
        String(result.detail || '').split('\n').slice(0, 4).map(l => `  ${l}`).join('\n'),
      ].join('\n')
    default:
      return [
        '更新失败，看日志排查。',
        String(result.detail || '').split('\n').slice(0, 4).map(l => `  ${l}`).join('\n'),
      ].join('\n')
  }
}
