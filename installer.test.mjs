#!/usr/bin/env node
/**
 * 安装/更新器回归测试。
 *
 * 只使用临时 DSH_HOME 和假 dsh，不读写真实 profile，不调用百炼接口。
 * 运行：node installer.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(PLUGIN_DIR, 'install.mjs')

function runInstaller(args, env = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
}

function runWindowsLauncher(name, args) {
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', join(PLUGIN_DIR, name), ...args], {
    cwd: PLUGIN_DIR,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function jsonOf(result, label = 'installer') {
  if (result.status !== 0) {
    throw new Error(`${label} 退出码 ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(`${label} 不是 JSON：\n${result.stdout}\n${result.stderr}`)
  }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function makeFakeDsh(home) {
  const log = join(home, 'dsh-calls.log')
  const file = join(home, 'fake-dsh.cmd')
  await writeFile(
    file,
    `@echo off\r\necho %*>>"${log}"\r\nexit /b 0\r\n`,
    'utf8',
  )
  return { file, log }
}

async function makeProfile(home, name = 'desktop', bundles = ['@deepseek-ai/dsh-base']) {
  const profileDir = join(home, 'profiles', name)
  await writeJson(join(profileDir, 'package.json'), {
    name: `dsh-profile-${name}`,
    private: true,
    dsh: { profile: { bundles } },
    dependencies: {},
  })
  return profileDir
}

async function makeHome(root, name) {
  const home = join(root, name)
  await mkdir(join(home, 'profiles'), { recursive: true })
  const fake = await makeFakeDsh(home)
  const profileDir = await makeProfile(home)
  return { home, fake, profileDir }
}

function bundleNames(manifest) {
  return Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'qwen-installer-test-'))
  const cases = []
  try {
    const first = await makeHome(root, 'home with space')
    const installed = join(first.home, 'plugins', 'dsh-qwen-image')

    // 1. 首次安装：复制、假 pnpm、bundle、JSON。
    let result = runInstaller([
      '--dsh-home', first.home,
      '--profile', 'desktop',
      '--dsh-path', first.fake.file,
      '--skip-key',
      '--json',
    ])
    let report = jsonOf(result, '首次安装')
    assert.equal(report.ok, true)
    assert.equal(report.version, '0.5.2')
    assert.equal(report.profiles.length, 1)
    assert.equal(existsSync(join(installed, 'install.mjs')), true)
    assert.equal(existsSync(join(installed, 'index.mjs')), true)
    let profile = await readJson(join(first.profileDir, 'package.json'))
    assert.deepEqual(bundleNames(profile), ['@deepseek-ai/dsh-base', 'dsh-qwen-image'])
    assert.match(await readFile(first.fake.log, 'utf8'), /plugin --profile/)
    assert.match(await readFile(first.fake.log, 'utf8'), /add/)
    cases.push('首次安装')

    // 2. 用户数据在更新时保留；旧包里移除的文件要被清掉。
    await mkdir(join(installed, 'generated'), { recursive: true })
    await writeFile(join(installed, 'generated', 'keep.png'), 'keep', 'utf8')
    await writeFile(join(installed, 'user-note.txt'), 'keep me', 'utf8')
    await writeFile(join(installed, 'old-module.mjs'), 'old', 'utf8')
    const installedManifest = await readJson(join(installed, 'package.json'))
    installedManifest.files = [...installedManifest.files, 'old-module.mjs']
    await writeJson(join(installed, 'package.json'), installedManifest)

    // 3. 更新：同版本重装，生成 .bak，不重复 bundle，不碰 Key。
    const envPath = join(first.home, '.env')
    await writeFile(envPath, 'DASHSCOPE_API_KEY=sk-test-do-not-print\n', 'utf8')
    profile.dependencies = {
      ...(profile.dependencies || {}),
      'dsh-qwen-image': `link:${installed.replace(/\\/g, '/')}`,
    }
    await writeJson(join(first.profileDir, 'package.json'), profile)
    const callsBeforeUpgrade = (await readFile(first.fake.log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length
    result = runInstaller([
      '--dsh-home', first.home,
      '--profile', 'desktop',
      '--dsh-path', first.fake.file,
      '--upgrade',
      '--json',
    ])
    report = jsonOf(result, '更新')
    assert.equal(report.ok, true)
    assert.equal(report.action, 'upgrade')
    assert.equal(report.profiles[0].dependencyChanged, false)
    const callsAfterUpgrade = (await readFile(first.fake.log, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length
    assert.equal(callsAfterUpgrade, callsBeforeUpgrade)
    assert.equal(existsSync(join(installed, 'generated', 'keep.png')), true)
    assert.equal(existsSync(join(installed, 'user-note.txt')), true)
    assert.equal(existsSync(join(installed, 'old-module.mjs')), false)
    assert.equal(existsSync(`${installed}.bak`), true)
    assert.equal(await readFile(envPath, 'utf8'), 'DASHSCOPE_API_KEY=sk-test-do-not-print\n')
    profile = await readJson(join(first.profileDir, 'package.json'))
    assert.equal(bundleNames(profile).filter((name) => name === 'dsh-qwen-image').length, 1)
    cases.push('更新保留用户数据')

    // 4. 状态检查：不写文件、不调用 dsh，能看到备份和 profile 状态。
    result = runInstaller([
      '--dsh-home', first.home,
      '--profile', 'desktop',
      '--check',
      '--json',
    ])
    report = jsonOf(result, 'check')
    assert.equal(report.action, 'check')
    assert.equal(report.installedVersion, '0.5.2')
    assert.equal(report.upToDate, true)
    assert.equal(report.backups.plugin, true)
    assert.equal(report.profiles[0].bundleEnabled, true)
    assert.equal(report.profiles[0].dependencyPointsToPlugin, true)
    assert.equal(report.keyConfigured, true)
    assert.equal(existsSync(join(first.home, '.qwen-image-install.lock')), false)
    cases.push('--check 状态')

    // 5. 同目录更新必须拒绝，避免“提示成功但没有替换”。
    result = runInstaller([
      '--dsh-home', first.home,
      '--profile', 'desktop',
      '--source', installed,
      '--upgrade',
      '--skip-key',
      '--json',
    ])
    assert.notEqual(result.status, 0)
    const sameDirFailure = JSON.parse(result.stdout)
    assert.equal(sameDirFailure.code, 'QWEN_INSTALL_SAME_DIR')
    assert.equal(existsSync(`${installed}.bak`), true)
    assert.equal(existsSync(join(first.home, '.qwen-image-install.lock')), false)
    cases.push('拒绝同目录更新')

    // 6. 回滚：恢复备份，删掉更新后的目录。
    result = runInstaller([
      '--dsh-home', first.home,
      '--profile', 'desktop',
      '--rollback',
      '--json',
    ])
    report = jsonOf(result, '回滚')
    assert.equal(report.ok, true)
    assert.equal(existsSync(installed), true)
    assert.equal(existsSync(`${installed}.bak`), false)
    assert.equal(existsSync(join(installed, 'old-module.mjs')), true)
    cases.push('回滚')

    // 5. dry-run：不改文件，不执行 dsh。
    const second = await makeHome(root, 'dry-run-home')
    const beforeLog = existsSync(second.fake.log) ? await readFile(second.fake.log, 'utf8') : ''
    result = runInstaller([
      '--dsh-home', second.home,
      '--profile', 'desktop',
      '--dsh-path', second.fake.file,
      '--skip-key',
      '--dry-run',
      '--json',
    ])
    report = jsonOf(result, 'dry-run')
    assert.equal(report.dryRun, true)
    assert.equal(existsSync(join(second.home, 'plugins', 'dsh-qwen-image')), false)
    const afterLog = existsSync(second.fake.log) ? await readFile(second.fake.log, 'utf8') : ''
    assert.equal(afterLog, beforeLog)
    cases.push('dry-run 不改文件')

    // 6. 无 dsh 的 --skip-install：只复制并写 bundle。
    result = runInstaller([
      '--dsh-home', second.home,
      '--profile', 'desktop',
      '--skip-install',
      '--skip-key',
      '--json',
    ])
    report = jsonOf(result, 'skip-install')
    assert.equal(report.ok, true)
    assert.equal(existsSync(join(second.home, 'plugins', 'dsh-qwen-image', 'package.json')), true)
    profile = await readJson(join(second.profileDir, 'package.json'))
    assert.equal(bundleNames(profile).includes('dsh-qwen-image'), true)
    cases.push('skip-install')

    // 7. 拒绝降级。
    const third = await makeHome(root, 'version-home')
    result = runInstaller([
      '--dsh-home', third.home,
      '--profile', 'desktop',
      '--dsh-path', third.fake.file,
      '--skip-key',
      '--json',
    ])
    assert.equal(result.status, 0)
    const thirdInstalled = join(third.home, 'plugins', 'dsh-qwen-image')
    const thirdManifest = await readJson(join(thirdInstalled, 'package.json'))
    thirdManifest.version = '9.9.9'
    await writeJson(join(thirdInstalled, 'package.json'), thirdManifest)
    result = runInstaller([
      '--dsh-home', third.home,
      '--profile', 'desktop',
      '--dsh-path', third.fake.file,
      '--upgrade',
      '--skip-key',
      '--json',
    ])
    assert.notEqual(result.status, 0)
    const failure = JSON.parse(result.stdout)
    assert.equal(failure.ok, false)
    assert.equal(failure.code, 'QWEN_INSTALL_VERSION')
    cases.push('拒绝降级')

    // 8. 卸载：移除 bundle，默认保留插件目录。
    result = runInstaller([
      '--dsh-home', third.home,
      '--profile', 'desktop',
      '--dsh-path', third.fake.file,
      '--uninstall',
      '--json',
    ])
    report = jsonOf(result, '卸载')
    assert.equal(report.ok, true)
    profile = await readJson(join(third.profileDir, 'package.json'))
    assert.equal(bundleNames(profile).includes('dsh-qwen-image'), false)
    assert.equal(existsSync(thirdInstalled), true)
    cases.push('卸载')

    // 9. Windows 双击入口：install.cmd / update.cmd 转发参数和退出码。
    const fourth = await makeHome(root, 'launcher-home')
    const launcherArgs = [
      '--dsh-home', fourth.home,
      '--profile', 'desktop',
      '--dsh-path', fourth.fake.file,
      '--skip-key',
      '--json',
    ]
    result = runWindowsLauncher('install.cmd', launcherArgs)
    report = jsonOf(result, 'install.cmd')
    assert.equal(report.action, 'install')
    assert.equal(existsSync(join(fourth.home, 'plugins', 'dsh-qwen-image', 'install.mjs')), true)

    result = runWindowsLauncher('update.cmd', launcherArgs)
    report = jsonOf(result, 'update.cmd')
    assert.equal(report.action, 'upgrade')
    assert.equal(existsSync(join(fourth.home, 'plugins', 'dsh-qwen-image.bak')), true)
    cases.push('Windows 双击入口')

    // 10. 更新检查与下载（子进程 HTTP 模拟 GitHub Releases；spawnSync 会阻塞父进程事件循环）。
    const serverCode = [
      'const http = require("node:http")',
      'const crypto = require("node:crypto")',
      'const zip = Buffer.from("fake-update-package")',
      'const hash = crypto.createHash("sha256").update(zip).digest("hex")',
      'const server = http.createServer((req, res) => {',
      '  if (req.url === "/latest.json") {',
      '    const body = JSON.stringify({ version: "0.5.3", url: "http://127.0.0.1:" + server.address().port + "/pkg.zip", sha256: hash, notes: "测试更新", publishedAt: "2026-11-20" })',
      '    res.writeHead(200, { "content-type": "application/json" })',
      '    res.end(body)',
      '    return',
      '  }',
      '  if (req.url === "/pkg.zip") {',
      '    res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length })',
      '    res.end(zip)',
      '    return',
      '  }',
      '  res.writeHead(404)',
      '  res.end()',
      '})',
      'server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port, sha256: hash }) + "\\n"))',
    ].join('\n')
    const serverProcess = spawn(process.execPath, ['-e', serverCode], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
    const serverInfo = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('测试更新服务器启动超时')), 8000)
      serverProcess.stdout.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        clearTimeout(timer)
        resolve(JSON.parse(buffer.slice(0, newline)))
      })
      serverProcess.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`测试更新服务器退出：${code}`))
      })
    })
    const updateHome = join(root, 'update-home')
    const updateTemp = join(root, 'update-temp')
    await mkdir(updateHome, { recursive: true })
    await mkdir(updateTemp, { recursive: true })
    try {
      const updateUrl = `http://127.0.0.1:${serverInfo.port}/latest.json`
      result = runInstaller([
        '--check-update',
        '--update-url', updateUrl,
        '--dsh-home', updateHome,
        '--json',
      ])
      report = jsonOf(result, '--check-update')
      assert.equal(report.action, 'check-update')
      assert.equal(report.currentVersion, '0.5.2')
      assert.equal(report.latestVersion, '0.5.3')
      assert.equal(report.updateAvailable, true)
      assert.equal(report.sha256, serverInfo.sha256)
      cases.push('检查更新')

      result = runWindowsLauncher('check-update.cmd', [
        '--update-url', updateUrl,
        '--dsh-home', updateHome,
        '--json',
      ])
      assert.equal(result.status, 0)
      assert.match(result.stdout, /"updateAvailable": true/)
      cases.push('检查更新双击入口')

      result = runInstaller([
        '--download-update',
        '--update-url', updateUrl,
        '--dsh-home', updateHome,
        '--json',
      ], { TEMP: updateTemp })
      report = jsonOf(result, '--download-update')
      assert.equal(report.updateAvailable, true)
      assert.equal(report.downloaded.sha256, serverInfo.sha256)
      assert.equal(existsSync(report.downloaded.path), true)
      assert.equal(createHash('sha256').update(await readFile(report.downloaded.path)).digest('hex'), serverInfo.sha256)
      cases.push('下载更新')
    } finally {
      serverProcess.kill()
    }

    // 11. 帮助和版本。
    result = runInstaller(['--help'])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--upgrade/)
    assert.match(result.stdout, /--check/)
    assert.match(result.stdout, /--check-update/)
    result = runInstaller(['--version'])
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), '0.5.2')
    cases.push('help/version')

    console.log(`ok  ${cases.length} 项安装器检查：${cases.join('、')}`)
    console.log('INSTALLER REGRESSION OK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`INSTALLER REGRESSION FAILED: ${error.stack || error.message}`)
  process.exitCode = 1
})