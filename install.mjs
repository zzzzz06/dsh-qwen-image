#!/usr/bin/env node
/**
 * dsh-qwen-image Windows 安装/更新器。
 *
 * 设计目标：
 * - 只支持 Windows，启动器只负责找 Node 并转发参数；
 * - 安装和更新幂等：重复运行不会重复加 bundle，也不会清空用户 Key；
 * - 更新前备份插件目录和 profile 清单，失败可 --rollback；
 * - 默认不触碰 generated、.env、usage ledger；
 * - 不调用任何生图接口，安装过程零费用。
 */

import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin, stderr } from 'node:process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const KEY_ENV = 'DASHSCOPE_API_KEY'
const EXPECTED_NAME = 'dsh-qwen-image'
const DEFAULT_UPDATE_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
]

class InstallerError extends Error {
  constructor(message, code = 'QWEN_INSTALL') {
    super(message)
    this.name = 'InstallerError'
    this.code = code
  }
}

function fail(message, code) {
  throw new InstallerError(message, code)
}

function randomSuffix() {
  return `${process.pid}-${randomBytes(3).toString('hex')}`
}

function pathKey(value) {
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return normalized.toLowerCase()
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

function printHelp() {
  const lines = [
    'dsh-qwen-image Windows 安装 / 更新器',
    '',
    '用法：',
    '  node install.mjs [选项]',
    '',
    '常用：',
    '  --check                只检查当前安装，不写文件、不调用 dsh',
    '  --check-update         检查 GitHub Releases 是否有新版本（只读网络）',
    '  --download-update      有新版时下载 zip 并校验 SHA256，不自动安装',
    '  --update-url <url>     覆盖 update-source.json 里的清单地址',
    '  --upgrade              更新已有安装（备份旧版本，不询问 Key）',
    '  --rollback             恢复最近一次更新前的插件目录和 profile',
    '  --uninstall            从 profile 移除插件（默认保留插件目录）',
    '  --dry-run              只打印计划，不写文件、不执行 pnpm',
    '  --profile <name>       指定 profile，可重复或逗号分隔；默认自动发现',
    '  --dsh-home <dir>       指定 DSH home；默认 %DSH_HOME% 或 %USERPROFILE%\\.dsh',
    '  --profile-root <dir>   指定 profiles 目录；默认 <DSH home>/profiles',
    '  --dsh-path <file>      指定 dsh CLI；否则从 PATH 和常见安装位置查找',
    '  --source <dir>         指定插件源目录；默认本脚本所在目录',
    '',
    'Key 与自动化：',
    '  --api-key <key>        写入 <DSH home>/.env；不建议在共享终端使用',
    '  --prompt-key           在终端里询问并写入 Key',
    '  --skip-key             不配置 Key',
    '  --skip-install         只复制文件和更新 bundle，不执行 dsh plugin add',
    '  --json                 输出机器可读 JSON（日志会减少）',
    '  --force                允许同版本重装或降级',
    '',
    '卸载：',
    '  --purge                与 --uninstall 一起使用，删除插件目录和 usage ledger',
    '  --remove-key           与 --uninstall 一起使用，从 .env 删除 DASHSCOPE_API_KEY',
    '',
    '更新前请完全退出 DeepSeek Harness；更新后需要重新启动宿主。',
  ]
  console.log(lines.join('\n'))
}

function takeValue(argv, index, inlineValue, name) {
  if (inlineValue !== undefined) {
    if (inlineValue === '') fail(`参数 ${name} 需要一个值`, 'QWEN_INSTALL_ARGS')
    return { value: inlineValue, next: index }
  }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) {
    fail(`参数 ${name} 需要一个值`, 'QWEN_INSTALL_ARGS')
  }
  return { value: next, next: index + 1 }
}

function parseArgs(argv) {
  const options = {
    profiles: [],
    dshHome: '',
    profileRoot: '',
    dshPath: '',
    source: '',
    apiKey: '',
    skipKey: false,
    skipInstall: false,
    upgrade: false,
    rollback: false,
    uninstall: false,
    purge: false,
    removeKey: false,
    dryRun: false,
    json: false,
    promptKey: false,
    force: false,
    help: false,
    version: false,
    check: false,
    checkUpdate: false,
    downloadUpdate: false,
    updateUrl: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h') {
      options.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      fail(`未知参数：${arg}`, 'QWEN_INSTALL_ARGS')
    }
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined

    switch (name) {
      case '--help':
      case '-h':
        options.help = true
        break
      case '--version':
        options.version = true
        break
      case '--check':
        options.check = true
        break
      case '--check-update':
        options.checkUpdate = true
        break
      case '--download-update':
        options.downloadUpdate = true
        break
      case '--update-url': {
        const { value, next } = takeValue(argv, index, inline, name)
        options.updateUrl = value
        index = next
        break
      }
      case '--profile': {
        const { value, next } = takeValue(argv, index, inline, name)
        for (const item of value.split(',')) {
          const profile = item.trim()
          if (profile) options.profiles.push(profile)
        }
        index = next
        break
      }
      case '--dsh-home': {
        const { value, next } = takeValue(argv, index, inline, name)
        options.dshHome = value
        index = next
        break
      }
      case '--profile-root': {
        const { value, next } = takeValue(argv, index, inline, name)
        options.profileRoot = value
        index = next
        break
      }
      case '--dsh-path': {
        const { value, next } = takeValue(argv, index, inline, name)
        options.dshPath = value
        index = next
        break
      }
      case '--source': {
        const { value, next } = takeValue(argv, index, inline, name)
        options.source = value
        index = next
        break
      }
      case '--api-key': {
        const { value, next } = takeValue(argv, index, inline, name)
        options.apiKey = value
        index = next
        break
      }
      case '--skip-key':
        options.skipKey = true
        break
      case '--prompt-key':
        options.promptKey = true
        break
      case '--skip-install':
        options.skipInstall = true
        break
      case '--upgrade':
        options.upgrade = true
        break
      case '--rollback':
        options.rollback = true
        break
      case '--uninstall':
        options.uninstall = true
        break
      case '--purge':
        options.purge = true
        break
      case '--remove-key':
        options.removeKey = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--json':
        options.json = true
        break
      case '--force':
        options.force = true
        break
      default:
        fail(`未知参数：${arg}`, 'QWEN_INSTALL_ARGS')
    }
  }

  return options
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    fail(`无法读取 JSON：${file}（${error.message}）`, code)
  }
}

async function readManifest(directory, code = 'QWEN_INSTALL_MANIFEST') {
  const file = join(directory, 'package.json')
  const data = await readJson(file, code)
  if (!data || data.name !== EXPECTED_NAME) {
    fail(`插件清单名称不是 ${EXPECTED_NAME}：${file}`, code)
  }
  return { file, data }
}

function payloadEntries(manifest) {
  const files = Array.isArray(manifest.files) ? manifest.files : []
  const entries = ['package.json', ...files]
  const unique = []
  const seen = new Set()
  for (const raw of entries) {
    if (typeof raw !== 'string' || !raw.trim()) {
      fail('package.json 的 files 里有非法条目', 'QWEN_INSTALL_MANIFEST')
    }
    const entry = raw.trim()
    if (isAbsolute(entry) || entry.includes('..') || entry.startsWith('/') || entry.startsWith('\\')) {
      fail(`package.json 的 files 不允许越界路径：${entry}`, 'QWEN_INSTALL_MANIFEST')
    }
    if (!seen.has(entry)) {
      seen.add(entry)
      unique.push(entry)
    }
  }
  return unique
}

async function validatePayload(sourceDir) {
  const manifest = await readManifest(sourceDir)
  const entries = payloadEntries(manifest.data)
  for (const entry of entries) {
    const file = join(sourceDir, entry)
    if (!existsSync(file)) {
      fail(`插件包缺少文件：${entry}`, 'QWEN_INSTALL_MISSING')
    }
  }
  for (const required of ['index.mjs', 'core.mjs', 'config.mjs']) {
    if (!existsSync(join(sourceDir, required))) {
      fail(`插件包缺少运行文件：${required}`, 'QWEN_INSTALL_MISSING')
    }
  }
  return { manifest, entries }
}

function compareVersions(left, right) {
  const parse = (value) => String(value).split('-')[0].split('.').map((part) => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function validateUpdateUrl(value, allowedHosts, label) {
  let parsed
  try {
    parsed = new URL(String(value))
  } catch {
    fail(`${label}不是合法 URL：${value}`, 'QWEN_UPDATE_URL')
  }
  if (parsed.username || parsed.password) {
    fail(`${label}不能包含用户名或密码`, 'QWEN_UPDATE_URL')
  }
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol === 'https:' && allowedHosts.includes(host)) return parsed
  // 仅允许本机 HTTP，方便离线测试；公网更新源必须走 HTTPS 且在白名单内。
  if (parsed.protocol === 'http:' && isLoopbackHost(host)) return parsed
  fail(
    `${label}不受信任：${parsed.href}\n`
      + `只允许 HTTPS 且域名在 update-source.json 的 allowedHosts 中（当前：${allowedHosts.join(', ')}）。`,
    'QWEN_UPDATE_URL',
  )
}

async function loadUpdateSource(options) {
  const configPath = join(SCRIPT_DIR, 'update-source.json')
  let config = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (error) {
      fail(`无法读取更新源配置 ${configPath}：${error.message}`, 'QWEN_UPDATE_SOURCE')
    }
  }
  const manifestUrl = String(
    options.updateUrl || process.env.QWEN_UPDATE_URL || config.manifestUrl || '',
  ).trim()
  if (!manifestUrl) {
    fail(
      '未配置更新源。请编辑 update-source.json，把 manifestUrl 改成你的 GitHub Releases 地址，'
        + '例如 https://github.com/OWNER/REPO/releases/latest/download/latest.json。',
      'QWEN_UPDATE_SOURCE',
    )
  }
  if (manifestUrl.includes('/OWNER/') || manifestUrl.includes('/REPO/')) {
    fail(
      'update-source.json 仍是模板地址。请把 OWNER/REPO 替换成你的 GitHub 仓库，再运行 check-update.cmd。',
      'QWEN_UPDATE_SOURCE',
    )
  }
  const allowedHosts = Array.isArray(config.allowedHosts)
    ? config.allowedHosts.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : []
  return {
    manifestUrl,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : DEFAULT_UPDATE_HOSTS,
  }
}

async function fetchWithTimeout(url, timeoutMs, label) {
  if (typeof fetch !== 'function') {
    fail('当前 Node 不支持 fetch，无法检查更新；请升级 Node 或改用 DSH 自带运行时。', 'QWEN_UPDATE_FETCH')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-qwen-image-installer' },
    })
    return response
  } catch (error) {
    if (error && error.name === 'AbortError') {
      fail(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`, 'QWEN_UPDATE_TIMEOUT')
    }
    fail(`${label}失败：${url}\n${error.message || error}`, 'QWEN_UPDATE_FETCH')
  } finally {
    clearTimeout(timer)
  }
}

async function readUpdateManifest(source) {
  const manifestUrl = validateUpdateUrl(source.manifestUrl, source.allowedHosts, '更新清单地址')
  const response = await fetchWithTimeout(manifestUrl.href, 8000, '请求更新清单')
  if (!response.ok) {
    fail(`更新清单返回 HTTP ${response.status}：${manifestUrl.href}`, 'QWEN_UPDATE_HTTP')
  }
  if (response.url) {
    validateUpdateUrl(response.url, source.allowedHosts, '更新清单重定向地址')
  }
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > 64 * 1024) {
    fail('更新清单超过 64KB，拒绝读取', 'QWEN_UPDATE_MANIFEST')
  }
  const text = await response.text()
  if (text.length > 64 * 1024) {
    fail('更新清单超过 64KB，拒绝读取', 'QWEN_UPDATE_MANIFEST')
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    fail('更新清单不是合法 JSON', 'QWEN_UPDATE_MANIFEST')
  }
  const version = String(manifest?.version || '').trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`更新清单版本号不合法：${manifest?.version}`, 'QWEN_UPDATE_MANIFEST')
  }
  if (!manifest?.url) {
    fail('更新清单缺少 url', 'QWEN_UPDATE_MANIFEST')
  }
  const downloadUrl = validateUpdateUrl(manifest.url, source.allowedHosts, '新版本下载地址')
  const sha256 = String(manifest?.sha256 || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    fail('更新清单缺少合法的 sha256（64 位十六进制）', 'QWEN_UPDATE_MANIFEST')
  }
  return {
    version,
    url: downloadUrl.href,
    sha256,
    notes: typeof manifest?.notes === 'string' ? manifest.notes : '',
    publishedAt: typeof manifest?.publishedAt === 'string' ? manifest.publishedAt : '',
    source: manifestUrl.href,
  }
}

async function checkForUpdate(currentVersion, source) {
  const latest = await readUpdateManifest(source)
  const comparison = compareVersions(latest.version, currentVersion)
  return {
    ok: true,
    action: 'check-update',
    currentVersion,
    latestVersion: latest.version,
    upToDate: comparison <= 0,
    updateAvailable: comparison > 0,
    downloadUrl: latest.url,
    sha256: latest.sha256,
    notes: latest.notes,
    publishedAt: latest.publishedAt,
    manifestUrl: latest.source,
  }
}

async function downloadUpdate(latest, source) {
  const parsed = validateUpdateUrl(latest.downloadUrl, source.allowedHosts, '新版本下载地址')
  const response = await fetchWithTimeout(parsed.href, 120000, '下载新版本')
  if (!response.ok) {
    fail(`下载新版本返回 HTTP ${response.status}：${parsed.href}`, 'QWEN_UPDATE_HTTP')
  }
  if (response.url) {
    validateUpdateUrl(response.url, source.allowedHosts, '新版本下载重定向地址')
  }
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > 64 * 1024 * 1024) {
    fail('新版本 zip 超过 64MB，拒绝下载', 'QWEN_UPDATE_DOWNLOAD')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 64 * 1024 * 1024) {
    fail('新版本 zip 超过 64MB，拒绝写入', 'QWEN_UPDATE_DOWNLOAD')
  }
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== latest.sha256) {
    fail(`新版本 SHA256 不匹配：期望 ${latest.sha256}，实际 ${actual}`, 'QWEN_UPDATE_HASH')
  }
  let filename = basename(parsed.pathname)
  if (!filename.toLowerCase().endsWith('.zip')) filename = `${EXPECTED_NAME}-${latest.latestVersion}.zip`
  const directory = join(process.env.TEMP || homedir(), 'dsh-qwen-image-updates', latest.latestVersion)
  await mkdir(directory, { recursive: true })
  const target = join(directory, filename)
  await writeFile(target, bytes)
  return { path: target, bytes: bytes.length, sha256: actual }
}

function printUpdateStatus(report) {
  console.log('dsh-qwen-image 更新检查')
  console.log(`当前版本  : ${report.currentVersion}`)
  console.log(`最新版本  : ${report.latestVersion}`)
  console.log(`状态      : ${report.updateAvailable ? '有新版本' : '已是最新'}`)
  if (report.publishedAt) console.log(`发布日期  : ${report.publishedAt}`)
  if (report.notes) console.log(`更新说明  : ${report.notes}`)
  if (report.updateAvailable) {
    console.log(`下载地址  : ${report.downloadUrl}`)
    console.log(`SHA256    : ${report.sha256}`)
    if (report.downloaded) {
      console.log(`已下载    : ${report.downloaded.path}`)
      console.log('下一步    : 退出 DSH，解压后运行 update.cmd；或运行 install.mjs --upgrade --source <解压目录>。')
    } else {
      console.log('下载      : 运行 check-update.cmd --download-update，或手动打开上面的地址。')
    }
  }
  console.log('')
  console.log('检查只访问更新清单，不调用百炼接口。')
}

function assertProfileName(value) {
  const name = String(value || '').trim()
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) {
    fail(`非法 profile 名称：${value}`, 'QWEN_INSTALL_PROFILE')
  }
  return name
}

async function resolveProfiles(options, profileRoot) {
  if (options.profiles.length > 0) {
    return [...new Set(options.profiles.map(assertProfileName))]
  }
  if (!options.dshHome && process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim()) {
    return [assertProfileName(process.env.DSH_PROFILE)]
  }
  if (!options.dshHome && process.env.DSH_PROFILE_DIR && process.env.DSH_PROFILE_DIR.trim()) {
    return [assertProfileName(basename(resolve(process.env.DSH_PROFILE_DIR.trim())))]
  }

  const found = []
  try {
    const entries = await readdir(profileRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(profileRoot, entry.name, 'package.json'))) {
        found.push(entry.name)
      }
    }
  } catch {
    // profile 还没初始化时，交给后面的错误提示。
  }
  return found.length > 0 ? found.map(assertProfileName) : ['desktop']
}

function findOnPath() {
  const result = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || !result.stdout) return ''
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  return first && existsSync(first) ? first : ''
}

function dshCandidates() {
  const candidates = []
  const local = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  for (const root of [local && join(local, 'Programs', 'DeepSeek Harness'), programFiles && join(programFiles, 'DeepSeek Harness'), programFilesX86 && join(programFilesX86, 'DeepSeek Harness'), 'C:\\ai\\dsh']) {
    if (root) candidates.push(join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
  }
  return candidates
}

function findDsh(options) {
  if (options.dshPath) {
    if (!existsSync(options.dshPath)) {
      fail(`指定的 dsh 不存在：${options.dshPath}`, 'QWEN_INSTALL_DSH')
    }
    return resolve(options.dshPath)
  }
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) {
    return resolve(process.env.DSH_BIN)
  }
  const fromPath = findOnPath()
  if (fromPath) return fromPath
  for (const candidate of dshCandidates()) {
    if (candidate && existsSync(candidate)) return resolve(candidate)
  }
  fail(
    '找不到 dsh 命令行。请先启动一次 DSH，或用 --dsh-path 指定；'
      + '也可以加 --skip-install 只复制文件。',
    'QWEN_INSTALL_DSH',
  )
}

function shellQuoteForCmd(value) {
  return `"${String(value).replace(/%/g, '%%').replace(/"/g, '""')}"`
}

function runDshPlugin(dshPath, profile, spec, action, options) {
  const args = ['plugin', '--profile', profile, action, spec]
  if (options.dryRun) {
    return { skipped: true, command: `${dshPath} ${args.join(' ')}` }
  }

  const command = [
    shellQuoteForCmd(dshPath),
    'plugin',
    '--profile',
    shellQuoteForCmd(profile),
    action,
    shellQuoteForCmd(spec),
  ].join(' ')
  const result = spawnSync(command, {
    shell: true,
    windowsHide: true,
    encoding: options.json ? 'utf8' : undefined,
    stdio: options.json ? 'pipe' : 'inherit',
  })

  if (result.error) {
    fail(`执行 dsh plugin ${action} 失败：${result.error.message}`, 'QWEN_INSTALL_DSH')
  }
  const output = options.json
    ? `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-4000)
    : ''
  if (result.status !== 0) {
    fail(
      `dsh plugin ${action} 退出码 ${result.status ?? 'unknown'}${output ? `：\n${output}` : ''}`,
      'QWEN_INSTALL_DSH',
    )
  }
  return { skipped: false, output }
}

function dependencyPointsTo(spec, pluginHome) {
  if (typeof spec !== 'string') return false
  const value = spec.startsWith('link:') ? `file:${spec.slice('link:'.length)}` : spec
  if (!value.startsWith('file:')) return false
  let target = value.slice('file:'.length)
  if (target.startsWith('//')) {
    try {
      target = fileURLToPath(value)
    } catch {
      return false
    }
  }
  try {
    return samePath(decodeURIComponent(target), pluginHome)
  } catch {
    return false
  }
}

async function ensureDependency(profile, profileDir, pluginHome, dshPath, options) {
  const manifestPath = join(profileDir, 'package.json')
  const before = await readJson(manifestPath, 'QWEN_INSTALL_PROFILE')
  const current = before && before.dependencies ? before.dependencies[EXPECTED_NAME] : undefined
  const spec = `file:${pluginHome.replace(/\\/g, '/')}`

  if (current && dependencyPointsTo(current, pluginHome)) {
    return { changed: false, spec: current, output: '' }
  }
  if (options.skipInstall) {
    return { changed: false, spec: current || '', skipped: true, reason: '--skip-install' }
  }
  if (!dshPath) {
    fail('需要安装依赖但找不到 dsh；请用 --dsh-path 指定或加 --skip-install', 'QWEN_INSTALL_DSH')
  }
  if (options.dryRun) {
    return { changed: true, spec, skipped: true, reason: 'dry-run' }
  }

  await backupFile(manifestPath)
  const result = runDshPlugin(dshPath, profile, spec, 'add', options)
  return { changed: !options.dryRun, spec, output: result.output || '', skipped: Boolean(result.skipped) }
}

async function backupFile(file) {
  if (!existsSync(file)) return ''
  const backup = `${file}.bak`
  await rm(backup, { force: true })
  await cp(file, backup, { force: true })
  return backup
}

async function writeJsonAtomic(file, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`
  const temporary = `${file}.${randomSuffix()}.tmp`
  await writeFile(temporary, text, 'utf8')
  try {
    await rename(temporary, file)
  } catch {
    // Windows 在目标正被占用时 rename 可能失败；退化为直接写，前面已有 .bak。
    await rm(temporary, { force: true })
    await writeFile(file, text, 'utf8')
  }
}

async function ensureBundleEntry(profile, profileDir, options) {
  const manifestPath = join(profileDir, 'package.json')
  const data = await readJson(manifestPath, 'QWEN_INSTALL_PROFILE')
  if (!data.dsh || typeof data.dsh !== 'object' || Array.isArray(data.dsh)) data.dsh = {}
  if (!data.dsh.profile || typeof data.dsh.profile !== 'object' || Array.isArray(data.dsh.profile)) {
    data.dsh.profile = {}
  }
  const before = Array.isArray(data.dsh.profile.bundles) ? data.dsh.profile.bundles : []
  if (data.dsh.profile.bundles !== undefined && !Array.isArray(data.dsh.profile.bundles)) {
    fail(`${manifestPath} 的 dsh.profile.bundles 不是数组`, 'QWEN_INSTALL_PROFILE')
  }
  if (before.includes(EXPECTED_NAME)) {
    return { changed: false, bundles: before }
  }
  if (options.dryRun) {
    return { changed: true, bundles: [...before, EXPECTED_NAME], skipped: true }
  }
  await backupFile(manifestPath)
  data.dsh.profile.bundles = [...before, EXPECTED_NAME]
  await writeJsonAtomic(manifestPath, data)
  return { changed: true, bundles: data.dsh.profile.bundles }
}

async function removeBundleEntry(profile, profileDir, options) {
  const manifestPath = join(profileDir, 'package.json')
  const data = await readJson(manifestPath, 'QWEN_INSTALL_PROFILE')
  const bundles = data?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(EXPECTED_NAME)) {
    return { changed: false }
  }
  if (options.dryRun) return { changed: true, skipped: true }
  await backupFile(manifestPath)
  data.dsh.profile.bundles = bundles.filter((name) => name !== EXPECTED_NAME)
  await writeJsonAtomic(manifestPath, data)
  return { changed: true }
}

async function stagePlugin(sourceDir, sourceManifest, entries, pluginHome, options) {
  if (samePath(sourceDir, pluginHome)) {
    if (options.upgrade) {
      fail(
        '更新包不能放在已安装的插件目录里运行。\n'
          + '请把新 zip 解压到其他目录（例如 Downloads），再双击那里的 update.cmd。',
        'QWEN_INSTALL_SAME_DIR',
      )
    }
    return { skipped: true, reason: 'source-is-installed', backup: '' }
  }

  if (options.dryRun) {
    return { skipped: true, reason: 'dry-run', backup: '' }
  }

  const parent = dirname(pluginHome)
  await mkdir(parent, { recursive: true })
  const temporary = join(parent, `.${basename(pluginHome)}.new-${randomSuffix()}`)
  let backup = ''
  let movedOld = false

  try {
    await mkdir(temporary, { recursive: true })
    if (existsSync(pluginHome)) {
      await cp(pluginHome, temporary, { recursive: true, force: true })
    }

    let oldManifest
    if (existsSync(join(pluginHome, 'package.json'))) {
      try {
        oldManifest = await readManifest(pluginHome)
      } catch {
        oldManifest = undefined
      }
    }

    for (const entry of entries) {
      const target = join(temporary, entry)
      await rm(target, { recursive: true, force: true })
      await cp(join(sourceDir, entry), target, { recursive: true, force: true })
    }

    if (oldManifest) {
      const newEntries = new Set(entries)
      for (const entry of payloadEntries(oldManifest.data)) {
        if (!newEntries.has(entry)) {
          await rm(join(temporary, entry), { recursive: true, force: true })
        }
      }
    }

    // 在替换正式目录前，先确认新清单和关键运行文件都在。
    await validatePayload(temporary)

    if (existsSync(pluginHome)) {
      backup = `${pluginHome}.bak`
      await rm(backup, { recursive: true, force: true })
      await rename(pluginHome, backup)
      movedOld = true
    }
    await rename(temporary, pluginHome)
    return {
      skipped: false,
      backup,
      oldVersion: oldManifest?.data?.version || '',
      newVersion: sourceManifest.data.version,
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {})
    if (movedOld && backup && !existsSync(pluginHome) && existsSync(backup)) {
      await rename(backup, pluginHome).catch(() => {})
    }
    if (error instanceof InstallerError) throw error
    fail(`替换插件目录失败：${error.message}`, 'QWEN_INSTALL_COPY')
  }
}

async function hasUsableKey(home) {
  if (process.env[KEY_ENV] && process.env[KEY_ENV].trim()) return true
  const envPath = join(home, '.env')
  if (!existsSync(envPath)) return false
  try {
    const text = await readFile(envPath, 'utf8')
    return new RegExp(`^\\s*(?:export\\s+)?${KEY_ENV}\\s*=\\s*\\S`, 'm').test(text)
  } catch {
    return false
  }
}

function lockFileFor(home) {
  return join(home, '.qwen-image-install.lock')
}

async function acquireInstallLock(home, options) {
  if (options.dryRun || options.check || options.help || options.version) return
  await mkdir(home, { recursive: true })
  const file = lockFileFor(home)
  let fd
  try {
    fd = openSync(file, 'wx')
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
    closeSync(fd)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
      try { unlinkSync(file) } catch {}
    }
    if (error && error.code === 'EEXIST') {
      fail(`检测到另一个安装/更新正在进行：${file}\n确认没有其他窗口在运行后，删除这个锁文件再重试。`, 'QWEN_INSTALL_LOCKED')
    }
    fail(`无法创建安装锁：${file}（${error.message}）`, 'QWEN_INSTALL_LOCKED')
  }
  process.once('exit', () => {
    try { unlinkSync(file) } catch {}
  })
}

async function collectCheckStatus({ home, pluginHome, profileRoot, profiles, sourceManifest }) {
  let installedVersion = ''
  try {
    installedVersion = (await readManifest(pluginHome)).data.version || ''
  } catch {
    installedVersion = ''
  }

  const profileStatus = []
  for (const profile of profiles) {
    const manifestPath = join(profileRoot, profile, 'package.json')
    let data
    let error = ''
    try {
      data = await readJson(manifestPath)
    } catch (caught) {
      data = undefined
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const dependency = data?.dependencies?.[EXPECTED_NAME]
    const bundles = Array.isArray(data?.dsh?.profile?.bundles) ? data.dsh.profile.bundles : []
    profileStatus.push({
      name: profile,
      manifestPath,
      manifestExists: Boolean(data),
      dependency: dependency || '',
      dependencyPointsToPlugin: dependencyPointsTo(dependency, pluginHome),
      bundleEnabled: bundles.includes(EXPECTED_NAME),
      ...(error ? { error } : {}),
    })
  }

  return {
    ok: true,
    action: 'check',
    version: sourceManifest.data.version,
    installedVersion,
    upToDate: Boolean(installedVersion) && installedVersion === sourceManifest.data.version,
    home,
    pluginHome,
    profiles: profileStatus,
    backups: {
      plugin: existsSync(`${pluginHome}.bak`),
      profile: profileStatus.some((item) => existsSync(`${item.manifestPath}.bak`)),
    },
    keyConfigured: await hasUsableKey(home),
    keyCheck: '只检查环境变量和 .env；DSH 设置页/credentials 里的 Key 不会在这里显示',
    ledgerFile: join(home, 'qwen-image-usage.json'),
    ledgerExists: existsSync(join(home, 'qwen-image-usage.json')),
    lock: existsSync(lockFileFor(home)),
  }
}

function printCheckStatus(status) {
  console.log('dsh-qwen-image 安装检查')
  console.log(`包版本    : ${status.version}`)
  console.log(`已安装    : ${status.installedVersion || '未安装'}${status.upToDate ? '（与包版本一致）' : ''}`)
  console.log(`home      : ${status.home}`)
  console.log(`插件目录  : ${status.pluginHome}`)
  console.log(`旧版备份  : ${status.backups.plugin ? `${status.pluginHome}.bak` : '无'}`)
  console.log(`API Key   : ${status.keyConfigured ? '已在环境变量/.env 中配置' : '未在环境变量/.env 中发现'}`)
  if (!status.keyConfigured) console.log(`            ${status.keyCheck}`)
  console.log(`额度文件  : ${status.ledgerExists ? status.ledgerFile : '无'}`)
  console.log(`安装锁    : ${status.lock ? `存在（${lockFileFor(status.home)}）` : '无'}`)
  if (status.lock) console.log('            确认没有其他安装窗口后，删除上面的锁文件再重试。')
  for (const profile of status.profiles) {
    const pieces = [
      profile.manifestExists ? '清单存在' : '清单缺失',
      profile.dependencyPointsToPlugin ? '依赖已指向插件' : '依赖未指向插件',
      profile.bundleEnabled ? 'bundle 已启用' : 'bundle 未启用',
    ]
    console.log(`profile   : ${profile.name}（${pieces.join('，')}）`)
    if (profile.error) console.log(`            ! ${profile.error}`)
  }
  console.log('')
  console.log('检查不会写文件，也不会调用百炼接口。')
}

async function writeApiKey(home, key) {
  const value = String(key || '').trim()
  if (!value) fail('API Key 为空', 'QWEN_INSTALL_KEY')
  if (/[\r\n]/.test(value)) fail('API Key 不能包含换行', 'QWEN_INSTALL_KEY')
  const envPath = join(home, '.env')
  const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : ''
  const newline = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing ? existing.replace(/\r\n/g, '\n').split('\n') : []
  const output = []
  let replaced = false
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${KEY_ENV}\\s*=`)
  for (const line of lines) {
    if (pattern.test(line)) {
      if (!replaced) output.push(`${KEY_ENV}=${value}`)
      replaced = true
    } else {
      output.push(line)
    }
  }
  if (!replaced) {
    if (output.length > 0 && output[output.length - 1].trim() !== '') output.push('')
    output.push('# 百炼（DashScope）API Key，qwen-image 插件会读这一行')
    output.push(`${KEY_ENV}=${value}`)
  }
  while (output.length > 0 && output[output.length - 1] === '') output.pop()
  await mkdir(home, { recursive: true })
  await writeFile(envPath, `${output.join(newline)}${newline}`, 'utf8')
  return envPath
}

async function promptForApiKey() {
  if (!stdin.isTTY) fail('当前终端不可交互，请用 --api-key 或 --skip-key', 'QWEN_INSTALL_KEY')
  const rl = createInterface({ input: stdin, output: stderr })
  try {
    return (await rl.question('粘贴百炼 API Key（直接回车跳过）：')).trim()
  } finally {
    rl.close()
  }
}

async function maybeConfigureKey(home, options, warnings) {
  if (options.skipKey || options.uninstall) return { configured: false }
  if (options.upgrade && !options.apiKey && !options.promptKey) return { configured: false, preserved: true }
  let key = options.apiKey
  if (!key && options.promptKey) key = await promptForApiKey()
  if (!key) {
    const existing = await hasUsableKey(home)
    if (!existing) warnings.push(`未配置 ${KEY_ENV}；可重跑安装器、设置页填写，或手动写 ${join(home, '.env')}`)
    return { configured: existing, preserved: existing }
  }
  if (options.dryRun) return { configured: false, dryRun: true }
  const envPath = await writeApiKey(home, key)
  return { configured: true, envPath }
}

async function rollback(pluginHome, profiles, profileRoot, options, report) {
  const backup = `${pluginHome}.bak`
  if (!existsSync(backup)) {
    fail(`没有可回滚的备份：${backup}`, 'QWEN_INSTALL_ROLLBACK')
  }
  if (options.dryRun) {
    report.plugin = { action: 'rollback', pluginHome, backup, dryRun: true }
    return
  }
  const temporary = `${pluginHome}.failed-${randomSuffix()}`
  if (existsSync(pluginHome)) await rename(pluginHome, temporary)
  try {
    await rename(backup, pluginHome)
    await rm(temporary, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(temporary) && !existsSync(pluginHome)) await rename(temporary, pluginHome).catch(() => {})
    fail(`回滚插件目录失败：${error.message}`, 'QWEN_INSTALL_ROLLBACK')
  }

  for (const profile of profiles) {
    const file = join(profileRoot, profile, 'package.json')
    const profileBackup = `${file}.bak`
    if (existsSync(profileBackup)) {
      await cp(profileBackup, file, { force: true })
      report.profiles.push({ name: profile, profileRestored: true })
    }
  }
  report.plugin = { action: 'rollback', pluginHome, restoredFrom: backup }
}

async function uninstallPlugins(pluginHome, profiles, profileRoot, dshPath, options, report) {
  for (const profile of profiles) {
    const profileDir = join(profileRoot, profile)
    if (!existsSync(join(profileDir, 'package.json'))) {
      fail(`找不到 profile 清单：${join(profileDir, 'package.json')}`, 'QWEN_INSTALL_PROFILE')
    }
    const removed = await removeBundleEntry(profile, profileDir, options)
    if (dshPath && !options.skipInstall) {
      const result = runDshPlugin(dshPath, profile, EXPECTED_NAME, 'remove', options)
      report.profiles.push({ name: profile, bundleRemoved: removed.changed, output: result.output || '' })
    } else {
      report.profiles.push({ name: profile, bundleRemoved: removed.changed, skippedDsh: true })
    }
  }

  if (options.purge) {
    if (options.dryRun) {
      report.plugin = { action: 'uninstall', pluginHome, purge: true, dryRun: true }
    } else {
      await rm(pluginHome, { recursive: true, force: true })
      await rm(`${pluginHome}.bak`, { recursive: true, force: true })
      await rm(join(report.home, 'qwen-image-usage.json'), { force: true })
      report.plugin = { action: 'uninstall', pluginHome, purge: true }
    }
  } else {
    report.plugin = { action: 'uninstall', pluginHome, purge: false }
  }

  if (options.removeKey) {
    const envPath = join(report.home, '.env')
    if (options.dryRun) {
      report.keyRemoved = false
      report.keyDryRun = true
    } else if (existsSync(envPath)) {
      const before = await readFile(envPath, 'utf8')
      const after = before.split(/\r?\n/).filter((line) => !new RegExp(`^\\s*(?:export\\s+)?${KEY_ENV}\\s*=`).test(line)).join('\n')
      await writeFile(envPath, after.replace(/\n*$/, '\n'), 'utf8')
      report.keyRemoved = true
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const sourceDir = resolve(options.source || SCRIPT_DIR)
  const { manifest: sourceManifest } = await validatePayload(sourceDir)
  if (options.version) {
    console.log(sourceManifest.data.version)
    return
  }

  const home = resolve(options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profileRoot = resolve(
    options.profileRoot
      || (options.dshHome
        ? join(home, 'profiles')
        : process.env.DSH_PROFILE_DIR
          ? dirname(resolve(process.env.DSH_PROFILE_DIR))
          : join(home, 'profiles')),
  )
  const pluginHome = join(home, 'plugins', EXPECTED_NAME)
  const profiles = await resolveProfiles(options, profileRoot)
  const report = {
    ok: true,
    action: options.checkUpdate || options.downloadUpdate ? 'check-update' : options.check ? 'check' : options.rollback ? 'rollback' : options.uninstall ? 'uninstall' : options.upgrade ? 'upgrade' : 'install',
    version: sourceManifest.data.version,
    home,
    pluginHome,
    profiles: [],
    warnings: [],
    dryRun: options.dryRun,
  }

  const log = (...args) => {
    if (!options.json) console.log(...args)
  }
  const warn = (message) => {
    report.warnings.push(message)
    if (!options.json) console.warn(`! ${message}`)
  }

  if (options.checkUpdate || options.downloadUpdate) {
    const updateSource = await loadUpdateSource(options)
    const update = await checkForUpdate(sourceManifest.data.version, updateSource)
    if (update.updateAvailable && options.downloadUpdate) {
      update.downloaded = await downloadUpdate(update, updateSource)
    }
    if (!options.json) printUpdateStatus(update)
    return update
  }

  if (options.check) {
    const status = await collectCheckStatus({ home, pluginHome, profileRoot, profiles, sourceManifest })
    if (!options.json) printCheckStatus(status)
    return status
  }

  await acquireInstallLock(home, options)

  if (options.rollback) {
    await rollback(pluginHome, profiles, profileRoot, options, report)
    return report
  }

  if (options.uninstall) {
    const dshPath = options.skipInstall ? '' : findDsh(options)
    await uninstallPlugins(pluginHome, profiles, profileRoot, dshPath, options, report)
    return report
  }

  // 先确认所有目标 profile 都存在，避免只改了一半才发现另一个 profile 路径错误。
  for (const profile of profiles) {
    const file = join(profileRoot, profile, 'package.json')
    if (!existsSync(file)) {
      fail(`找不到 profile 清单：${file}\n（先启动一次该 profile，或用 --profile 指定）`, 'QWEN_INSTALL_PROFILE')
    }
  }

  const dshPath = options.skipInstall ? '' : findDsh(options)
  if (dshPath) log(`dsh     : ${dshPath}`)
  log(`home    : ${home}`)
  log(`profile : ${profiles.join(', ')}`)
  log(`版本    : ${sourceManifest.data.version}${options.upgrade ? '（更新）' : '（安装）'}`)

  if (options.upgrade && existsSync(join(pluginHome, 'package.json'))) {
    try {
      const current = await readManifest(pluginHome)
      const comparison = compareVersions(sourceManifest.data.version, current.data.version)
      if (comparison < 0 && !options.force) {
        fail(
          `拒绝降级：当前 ${current.data.version}，zip 是 ${sourceManifest.data.version}；`
            + '确认要降级请加 --force',
          'QWEN_INSTALL_VERSION',
        )
      }
      if (comparison === 0) {
        warn(`当前已是 ${current.data.version}，将同版本重装（加 --force 可消除版本检查）`)
      }
    } catch (error) {
      if (error instanceof InstallerError && error.code === 'QWEN_INSTALL_VERSION') throw error
      warn(`无法读取已安装版本，按普通更新继续：${error.message}`)
    }
  }

  const staged = await stagePlugin(sourceDir, sourceManifest, payloadEntries(sourceManifest.data), pluginHome, options)
  if (staged.backup) report.backup = staged.backup
  if (staged.skipped && staged.reason === 'source-is-installed') {
    warn('安装器就在目标插件目录中运行，跳过文件替换；更新请解压新 zip 后再运行。')
  }

  for (const profile of profiles) {
    const profileDir = join(profileRoot, profile)
    const dependency = await ensureDependency(profile, profileDir, pluginHome, dshPath, options)
    const bundle = await ensureBundleEntry(profile, profileDir, options)
    report.profiles.push({
      name: profile,
      dependencyChanged: dependency.changed,
      dependencySkipped: dependency.skipped || false,
      bundleAdded: bundle.changed,
      bundleSkipped: bundle.skipped || false,
      output: dependency.output || '',
    })
  }

  const key = await maybeConfigureKey(home, options, report.warnings)
  report.keyConfigured = key.configured
  if (key.preserved) report.keyPreserved = true

  log('')
  if (options.dryRun) log('dry-run：未写文件，未执行 pnpm。')
  else log(`完成：${pluginHome}`)
  for (const warning of report.warnings) log(`! ${warning}`)
  log('请完全退出并重新启动 DeepSeek Harness（刷新页面不够）。')
  return report
}

try {
  const report = await main()
  if (report && process.argv.some((arg) => arg === '--json' || arg.startsWith('--json='))) {
    console.log(JSON.stringify(report, null, 2))
  }
} catch (error) {
  const isJson = process.argv.some((arg) => arg === '--json' || arg.startsWith('--json='))
  const message = error instanceof Error ? error.message : String(error)
  if (isJson) {
    console.log(JSON.stringify({ ok: false, code: error?.code || 'QWEN_INSTALL', error: message }, null, 2))
  } else {
    console.error(`安装/更新失败：${message}`)
  }
  process.exitCode = 1
}