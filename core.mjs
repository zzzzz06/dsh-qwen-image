/**
 * qwen-image 的核心调用逻辑。
 *
 * 这里刻意不 import 任何 @deepseek-ai/* 包：
 * 插件被 dsh 以 link: / file: 方式安装时，这些包未必解析得到，
 * 而 core.mjs 只用 node 内置模块，所以既能被插件引用，也能用
 * `node smoke.mjs "提示词"` 单独跑通。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export const MODELS = [
  'qwen-image-3.0',
  'qwen-image-3.0-pro',
  'qwen-image-2.1-pro',
  'qwen-image-2.1-turbo',
]

export const DEFAULTS = {
  baseURL: 'https://dashscope.aliyuncs.com',
  model: 'qwen-image-3.0',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  dir: 'generated',
  prefix: 'qwen',
  timeoutMs: 300000,
  downloadTimeoutMs: 120000,
  maxRetries: 2,
  downloadRetries: 2,
  maxImagesPerCall: 6,
  maxImagesPerDay: 0,
  maxReferenceImages: 3,
  maxReferenceBytes: 10 * 1024 * 1024,
  maxReferenceDimension: 4096,
  maxDownloadBytes: 32 * 1024 * 1024,
  maxPromptChars: 12000,
  writeMetadata: true,
  attachToChat: true,
}

const MIN_SIDE = 512
const MAX_SIDE = 2048
const MAX_ASPECT = 8
const MIN_PIXELS = MIN_SIDE * MIN_SIDE
const MAX_PIXELS = MAX_SIDE * MAX_SIDE
const MAX_SEED = 2147483647

/** 带稳定 code / status / requestId 的错误，便于工具层区分可操作原因。 */
export class QwenError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'QwenError'
    this.code = options.code || 'QWEN_ERROR'
    this.status = options.status
    this.requestId = options.requestId
    this.retryable = options.retryable === true
    this.retryAfterMs = options.retryAfterMs
  }
}

function toErrorText(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return err.message ? String(err.message) : String(err)
}

function causeText(err) {
  const cause = err && err.cause
  if (!cause) return ''
  if (cause.code && cause.message) return `（${cause.code}: ${cause.message}）`
  if (cause.code) return `（${cause.code}）`
  if (cause.message) return `（${cause.message}）`
  return ''
}

/**
 * 依次从 配置 / 环境变量 / ~/.dsh/.env / ~/.dsh/.credentials.yaml 找 API Key。
 * 自定义 apiKeyEnv 在四个来源里保持一致，不会只改环境变量、却仍从默认键回退。
 * @param {object} config 插件配置
 * @returns {string | undefined}
 */
export function resolveKey(config = {}) {
  const direct = config.apiKey === undefined || config.apiKey === null
    ? ''
    : String(config.apiKey).trim()
  if (direct) return direct
  const envName = String(config.apiKeyEnv || DEFAULTS.apiKeyEnv).trim() || DEFAULTS.apiKeyEnv
  const fromProcess = process.env[envName]
  if (fromProcess && fromProcess.trim()) return fromProcess.trim()
  return readHomeEnv(envName) || readCredentialsFile(envName)
}

/**
 * DSH 的 home 目录：优先 DSH_HOME，否则 ~/.dsh。
 * 这样用户把 DSH_HOME 指到别处时，Key 也能跟着走。
 */
function dshHomeDir() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim()) return override
  return join(homedir(), '.dsh')
}

/** 本地日期 YYYY-MM-DD，用于每日额度；按用户时区而不是 UTC 切换。 */
export function localDateStamp(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function usageFilePath() {
  return join(dshHomeDir(), 'qwen-image-usage.json')
}

async function readUsageLedger(file, date) {
  let entry
  try {
    entry = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    entry = undefined
  }
  const storedDate = entry && typeof entry === 'object' && typeof entry.date === 'string'
    ? entry.date
    : undefined
  if (!entry || typeof entry !== 'object' || storedDate !== date) {
    return { date, images: 0, storedDate }
  }
  return {
    date,
    images: Number.isInteger(entry.images) && entry.images > 0 ? entry.images : 0,
    storedDate,
  }
}

async function writeUsageLedger(file, entry) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (err) {
    await unlink(temporary).catch(() => {})
    throw new QwenError(`写入每日图片额度失败：${toErrorText(err)}`, {
      code: 'QWEN_BUDGET_IO',
      cause: err,
    })
  }
}

/**
 * 为一次生成预占每日图片额度。limit <= 0 表示关闭（不写 ledger）。
 * 预占而不是事后计数，降低两次并发调用同时通过检查的概率。
 * @param {number} limit 每日上限
 * @param {number} count 本次请求张数
 * @param {{file?: string, date?: string}} [options] 测试可注入
 * @returns {Promise<{date: string, file: string, count: number, previous: number, limit: number} | undefined>}
 */
export async function reserveDailyBudget(limit, count, options = {}) {
  const max = Number(limit)
  if (!Number.isInteger(max) || max <= 0) return undefined
  if (!Number.isInteger(count) || count < 1) {
    throw new QwenError('每日额度预占张数必须是正整数', { code: 'QWEN_BUDGET_INVALID' })
  }
  const date = options.date || localDateStamp()
  const file = options.file || usageFilePath()
  const entry = await readUsageLedger(file, date)
  if (entry.images + count > max) {
    throw new QwenError(
      `今日图片额度不足：已提交 ${entry.images} 张，本次 ${count} 张，上限 ${max} 张（${date}）。`
      + '可调大 maxImagesPerDay、等到明天，或把上限设为 0 关闭。',
      { code: 'QWEN_DAILY_BUDGET' },
    )
  }
  const next = {
    date,
    images: entry.images + count,
    updatedAt: new Date().toISOString(),
  }
  await writeUsageLedger(file, next)
  return { date, file, count, previous: entry.images, limit: max }
}

/**
 * 按实际返回张数结算预占额度。多退少补；跨天或 ledger 损坏时安全跳过。
 * @param {{date: string, file: string, count: number} | undefined} reservation
 * @param {number} actual 实际返回/计费张数
 */
export async function settleDailyBudget(reservation, actual) {
  if (!reservation) return
  const actualCount = Number.isInteger(actual) && actual > 0 ? actual : 0
  const entry = await readUsageLedger(reservation.file, reservation.date)
  if (entry.storedDate !== reservation.date) return
  const images = Math.max(0, entry.images - reservation.count + actualCount)
  if (images === entry.images) return
  await writeUsageLedger(reservation.file, {
    date: reservation.date,
    images,
    updatedAt: new Date().toISOString(),
  })
}

/** 请求失败时释放预占额度。 */
export async function releaseDailyBudget(reservation) {
  await settleDailyBudget(reservation, 0)
}

/**
 * 解析 .env 文本。支持 export、单双引号、双引号转义、行内注释和重复变量。
 * 重复变量采用最后一次出现的值（dotenv 的常见行为）。
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  const result = Object.create(null)
  if (typeof text !== 'string') return result
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    line = line.replace(/^export\s+/i, '')
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const raw = match[2]
    let value
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0]
      let end = -1
      let escaped = false
      for (let i = 1; i < raw.length; i += 1) {
        const ch = raw[i]
        if (quote === '"' && ch === '\\' && !escaped) {
          escaped = true
          continue
        }
        if (ch === quote && !escaped) {
          end = i
          break
        }
        escaped = false
      }
      if (end < 0) continue
      value = raw.slice(1, end)
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    } else {
      const comment = raw.search(/\s#/)
      value = (comment >= 0 ? raw.slice(0, comment) : raw).trim()
    }
    result[key] = value
  }
  return result
}

/**
 * 从 ~/.dsh/.env 读一个变量。
 * @param {string} envName
 * @returns {string | undefined}
 */
export function readHomeEnv(envName) {
  try {
    const text = readFileSync(join(dshHomeDir(), '.env'), 'utf8')
    const value = parseDotenv(text)[envName]
    return value && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取 dsh 凭据文件里的同名键（默认 DASHSCOPE_API_KEY）。
 * @param {string} [envName]
 * @returns {string | undefined}
 */
export function readCredentialsFile(envName = DEFAULTS.apiKeyEnv) {
  const name = String(envName || DEFAULTS.apiKeyEnv)
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`, 'm')
  try {
    const text = readFileSync(join(dshHomeDir(), '.credentials.yaml'), 'utf8')
    const match = text.match(pattern)
    if (!match) return undefined
    let value = match[1].trim()
    if (!value) return undefined
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]
      let end = -1
      let escaped = false
      for (let i = 1; i < value.length; i += 1) {
        const ch = value[i]
        if (quote === '"' && ch === '\\' && !escaped) {
          escaped = true
          continue
        }
        if (ch === quote && !escaped) {
          end = i
          break
        }
        escaped = false
      }
      if (end < 0) return undefined
      value = value.slice(1, end)
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    return value || undefined
  } catch {
    return undefined
  }
}

/** 判断路径是否位于 base 内（词法检查，realpath 检查在 prepareOutputDir 里做）。 */
export function isWithin(base, target) {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 把用户给的输出目录解析到工作区内。空目录、.. 逃逸和外部绝对路径都拒绝。
 * @param {string} root 工作区根
 * @param {string} dir 输出目录
 * @returns {string}
 */
export function resolveOutputDir(root, dir) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('缺少会话工作区，无法确定输出目录')
  }
  const value = dir === undefined || dir === null || String(dir).trim() === ''
    ? DEFAULTS.dir
    : String(dir).trim()
  if (value.includes('\0')) throw new Error('输出目录包含非法字符')
  const base = resolve(root)
  const target = isAbsolute(value) ? resolve(value) : resolve(base, value)
  if (!isWithin(base, target)) {
    throw new Error('输出目录必须位于当前工作区内；请使用相对路径，或工作区内的绝对路径')
  }
  return target
}

/**
 * 在 mkdir 之前检查“最近已存在的祖先目录”的真实路径，避免先在工作区外建目录再发现越界。
 * @param {string} root
 * @param {string} target
 * @returns {Promise<string>} 最近祖先的真实路径
 */
async function assertRealAncestorWithin(root, target) {
  const realRoot = await realpath(resolve(root)).catch(() => resolve(root))
  let current = target
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(current)
      if (!isWithin(realRoot, real)) {
        throw new Error('输出目录解析后位于工作区外（可能是符号链接）；请换一个目录')
      }
      return real
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`无法确认输出目录的边界：${target}`)
}

/**
 * 生成前检查目录：创建、解析真实路径（防 symlink/junction 逃逸）、做一次写测试。
 * `checkOnly` 只做边界检查，不创建目录、不写探针，供 dry-run 使用。
 * @param {string} root
 * @param {string} dir
 * @param {{ checkOnly?: boolean }} [options]
 * @returns {Promise<string>} 真实输出目录
 */
export async function prepareOutputDir(root, dir, options = {}) {
  const target = resolveOutputDir(root, dir)
  await assertRealAncestorWithin(root, target)
  if (options.checkOnly) {
    const info = await stat(target).catch(() => undefined)
    if (info && !info.isDirectory()) {
      throw new Error(`输出目录已存在但不是目录：${target}`)
    }
    return target
  }
  try {
    await mkdir(target, { recursive: true })
  } catch (err) {
    throw new Error(`无法创建输出目录 ${target}：${toErrorText(err)}`)
  }
  let realRoot = resolve(root)
  try {
    realRoot = await realpath(realRoot)
  } catch {
    // 工作区根不存在时，后面的写入测试会给出更具体的错误。
  }
  let realTarget
  try {
    realTarget = await realpath(target)
  } catch (err) {
    throw new Error(`无法解析输出目录 ${target}：${toErrorText(err)}`)
  }
  if (!isWithin(realRoot, realTarget)) {
    throw new Error('输出目录解析后位于工作区外（可能是符号链接）；请换一个目录')
  }
  const probe = join(realTarget, `.qwen-write-test-${randomBytes(4).toString('hex')}`)
  try {
    const handle = await open(probe, 'wx')
    await handle.close()
  } catch (err) {
    throw new Error(`输出目录不可写 ${realTarget}：${toErrorText(err)}`)
  } finally {
    await unlink(probe).catch(() => {})
  }
  return realTarget
}

/**
 * 统一尺寸写法并校验文档声明的范围。
 * 支持 1024x1024 / 1024*1024 / 1024×1024；省略或 auto 返回 undefined。
 * @param {string | undefined} size
 * @returns {{width: number, height: number, text: string} | undefined}
 */
export function parseSize(size) {
  if (size === undefined || size === null || String(size).trim() === '') return undefined
  if (typeof size !== 'string' && typeof size !== 'number') {
    throw new Error('size 必须是字符串，形如 1024*1024')
  }
  const raw = String(size).trim().toLowerCase()
  if (raw === 'auto') return undefined
  const normalized = raw.replace(/\s*[x×*]\s*/g, '*')
  const match = normalized.match(/^(\d+)\*(\d+)$/)
  if (!match) throw new Error('size 格式不对：请用 1024*1024（也接受 1024x1024）')
  if (match[1].length > 1 && match[1].startsWith('0')) throw new Error('size 不能有前导零')
  if (match[2].length > 1 && match[2].startsWith('0')) throw new Error('size 不能有前导零')
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('size 必须是两个正整数')
  }
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`size 单边必须在 ${MIN_SIDE}~${MAX_SIDE} 之间；收到 ${width}*${height}`)
  }
  if (width * height < MIN_PIXELS || width * height > MAX_PIXELS) {
    throw new Error(`size 总像素必须在 ${MIN_PIXELS}~${MAX_PIXELS} 之间；收到 ${width}*${height}`)
  }
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (ratio > MAX_ASPECT) {
    throw new Error(`size 宽高比必须在 1:${MAX_ASPECT} ~ ${MAX_ASPECT}:1 之间；收到 ${width}*${height}`)
  }
  return { width, height, text: `${width}*${height}` }
}

/**
 * 旧 API：只返回规范化的 size 文本；非法值现在会抛错，不再静默变成 auto。
 * @param {string | undefined} size
 * @returns {string | undefined}
 */
export function normalizeSize(size) {
  return parseSize(size)?.text
}

/** 校验模型是否在支持列表里。 */
export function assertModel(model) {
  const value = String(model || DEFAULTS.model).trim()
  if (!MODELS.includes(value)) {
    throw new Error(`不支持的模型：${value}；可用：${MODELS.join(' / ')}`)
  }
  return value
}

/** 3.0 系列才支持 negative_prompt；2.1 系列明确拒绝，避免静默发无效字段。 */
export function supportsNegativePrompt(model) {
  return model === 'qwen-image-3.0' || model === 'qwen-image-3.0-pro'
}

/** 生成前校验提示词长度；超长直接报错，不做静默截断。 */
export function validatePrompt(prompt, maxChars = DEFAULTS.maxPromptChars) {
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text) throw new Error('prompt 不能为空')
  if (text.length > maxChars) {
    throw new Error(`prompt 太长：${text.length} 字符，上限 ${maxChars}；请缩短提示词，避免 API 静默截断`)
  }
  return text
}

/**
 * 校验 baseURL。默认只允许 HTTPS；本机 http 调试放行，外部 http 必须显式开启。
 * @param {string} raw
 * @param {{allowInsecure?: boolean}} [options]
 * @returns {string}
 */
export function normalizeBaseURL(raw, options = {}) {
  const text = String(raw || DEFAULTS.baseURL).trim().replace(/\/+$/, '')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`baseURL 不是合法 URL：${text}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('baseURL 只支持 https:// 或 http://')
  }
  if (url.protocol === 'http:' && !options.allowInsecure && !isLocalHost(url.hostname)) {
    throw new Error('baseURL 外部端点必须使用 HTTPS；如确需 http 请开启 allowInsecureBaseURL')
  }
  if (url.search || url.hash) throw new Error('baseURL 不能带查询参数或锚点')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/** 从扩展名猜 MIME（只用于兼容旧调用；新链路以文件内容为准）。 */
function mimeFromName(file) {
  return MIME[extname(file).toLowerCase()] || 'image/png'
}

/**
 * 判断图片字节的真实格式和尺寸。支持 PNG / JPEG / GIF / WebP。
 * @param {Buffer|Uint8Array} input
 * @returns {{mediaType: string, ext: string, width: number, height: number} | undefined}
 */
export function sniffImage(input) {
  if (!input || typeof input.length !== 'number') return undefined
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf.length >= 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width > 0 && height > 0) return { mediaType: 'image/png', ext: '.png', width, height }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 3 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1
        continue
      }
      while (offset < buf.length && buf[offset] === 0xff) offset += 1
      if (offset >= buf.length) break
      const marker = buf[offset]
      offset += 1
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 1 >= buf.length) break
      const length = buf.readUInt16BE(offset)
      if (length < 2 || offset + length > buf.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (offset + 7 > buf.length) break
        const height = buf.readUInt16BE(offset + 3)
        const width = buf.readUInt16BE(offset + 5)
        if (width > 0 && height > 0) return { mediaType: 'image/jpeg', ext: '.jpg', width, height }
      }
      offset += length
    }
  }
  if (buf.length >= 10) {
    const header = buf.subarray(0, 6).toString('ascii')
    if (header === 'GIF87a' || header === 'GIF89a') {
      const width = buf.readUInt16LE(6)
      const height = buf.readUInt16LE(8)
      if (width > 0 && height > 0) return { mediaType: 'image/gif', ext: '.gif', width, height }
    }
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3)
      const height = 1 + buf.readUIntLE(27, 3)
      if (width > 0 && height > 0) return { mediaType: 'image/webp', ext: '.webp', width, height }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff
      const height = buf.readUInt16LE(28) & 0x3fff
      if (width > 0 && height > 0) return { mediaType: 'image/webp', ext: '.webp', width, height }
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b0 = buf[21]
      const b1 = buf[22]
      const b2 = buf[23]
      const b3 = buf[24]
      const width = 1 + (((b1 & 0x3f) << 8) | b0)
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      if (width > 0 && height > 0) return { mediaType: 'image/webp', ext: '.webp', width, height }
    }
  }
  return undefined
}

function parseDataUrl(value) {
  const match = String(value).match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s)
  if (!match) throw new Error('data URL 格式不对，只支持 data:image/...;base64,...')
  const declared = (match[1] || '').toLowerCase()
  if (!declared.startsWith('image/')) throw new Error(`data URL 不是图片：${declared || '未声明类型'}`)
  if (!/;base64,/i.test(value)) throw new Error('data URL 必须是 base64 编码')
  let buffer
  try {
    buffer = Buffer.from(match[2], 'base64')
  } catch {
    throw new Error('data URL 的 base64 无法解码')
  }
  if (!buffer.length) throw new Error('data URL 内容为空')
  const image = sniffImage(buffer)
  if (!image) throw new Error('data URL 的内容不是 PNG/JPEG/WebP/GIF 图片')
  return { buffer, image }
}

function resolveInputPath(root, value, allowOutside) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('缺少会话工作区，无法解析相对路径')
  }
  const base = resolve(root)
  const target = isAbsolute(value) ? resolve(value) : resolve(base, value)
  if (!allowOutside && !isWithin(base, target)) {
    throw new Error(`参考图必须位于当前工作区内：${target}；如确需读取外部文件请开启 allowOutsideWorkspace`)
  }
  return target
}

/** 词法检查之后再按真实路径检查一次，防止工作区内 symlink 指向外部。 */
async function assertRealImageWithin(root, file, allowOutside) {
  if (allowOutside) return file
  const realRoot = await realpath(resolve(root)).catch(() => resolve(root))
  const realFile = await realpath(file).catch(() => resolve(file))
  if (!isWithin(realRoot, realFile)) {
    throw new Error(`参考图解析后位于工作区外（可能是符号链接）：${file}；如确需读取外部文件请开启 allowOutsideWorkspace`)
  }
  return realFile
}

function assertImageLimits(image, meta, options) {
  const maxDimension = options.maxDimension || DEFAULTS.maxReferenceDimension
  if (image.width > maxDimension || image.height > maxDimension) {
    throw new Error(`${meta} 尺寸 ${image.width}x${image.height} 超过单边上限 ${maxDimension}px`)
  }
}

function dataUrlFor(buffer, image) {
  return `data:${image.mediaType};base64,${buffer.toString('base64')}`
}

async function readFileLimited(file, maxBytes, label) {
  let info
  try {
    info = await stat(file)
  } catch {
    throw new Error(`${label}读不到：${file}`)
  }
  if (!info.isFile()) throw new Error(`${label}不是普通文件：${file}`)
  if (info.size > maxBytes) {
    throw new Error(`${label}太大：${info.size} 字节，上限 ${maxBytes} 字节`)
  }
  let buffer
  try {
    buffer = await readFile(file)
  } catch (err) {
    throw new Error(`${label}读取失败：${file}：${toErrorText(err)}`)
  }
  if (buffer.length > maxBytes) {
    throw new Error(`${label}太大：${buffer.length} 字节，上限 ${maxBytes} 字节`)
  }
  return buffer
}

/**
 * 校验并物化参考图：本地/工作区相对路径转 data URL，data URL 重新按内容归一化，
 * 公网 URL 保留（由 DashScope 拉取）。
 * @param {string[]} sources
 * @param {object} [options]
 * @returns {Promise<string[]>}
 */
export async function prepareImageSources(sources, options = {}) {
  if (sources === undefined || sources === null) return []
  if (!Array.isArray(sources)) throw new Error('image 必须是字符串数组')
  const maxImages = options.maxImages || DEFAULTS.maxReferenceImages
  if (sources.length > maxImages) {
    throw new Error(`参考图最多 ${maxImages} 张；收到 ${sources.length} 张`)
  }
  const maxBytes = options.maxBytes || DEFAULTS.maxReferenceBytes
  const result = []
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error(`第 ${i + 1} 张参考图必须是非空字符串`)
    }
    const value = source.trim()
    if (/^data:/i.test(value)) {
      const { buffer, image } = parseDataUrl(value)
      if (buffer.length > maxBytes) throw new Error(`第 ${i + 1} 张参考图太大：${buffer.length} 字节，上限 ${maxBytes}`)
      assertImageLimits(image, `第 ${i + 1} 张参考图`, options)
      result.push(dataUrlFor(buffer, image))
      continue
    }
    if (/^https?:\/\//i.test(value)) {
      let url
      try {
        url = new URL(value)
      } catch {
        throw new Error(`第 ${i + 1} 张参考图 URL 不合法：${value}`)
      }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (options.allowInsecure || isLocalHost(url.hostname)))) {
        throw new Error(`第 ${i + 1} 张参考图必须使用 HTTPS：${value}`)
      }
      result.push(value)
      continue
    }
    const file = await assertRealImageWithin(
      options.root,
      resolveInputPath(options.root, value, options.allowOutsideWorkspace === true),
      options.allowOutsideWorkspace === true,
    )
    const buffer = await readFileLimited(file, maxBytes, `第 ${i + 1} 张参考图`)
    const image = sniffImage(buffer)
    if (!image) throw new Error(`第 ${i + 1} 张参考图不是 PNG/JPEG/WebP/GIF：${file}`)
    assertImageLimits(image, `第 ${i + 1} 张参考图`, options)
    result.push(dataUrlFor(buffer, image))
  }
  return result
}

/**
 * 旧同步 API：只处理单张，保留给外部脚本；插件主链路用 prepareImageSources。
 * @param {string} src
 * @param {object} [options]
 * @returns {string}
 */
export function toImageSource(src, options = {}) {
  if (typeof src !== 'string' || !src.trim()) {
    throw new Error('image 必须是公网 URL、data:base64 或本地路径')
  }
  const value = src.trim()
  if (/^https?:\/\//i.test(value)) return value
  if (/^data:/i.test(value)) {
    const { buffer, image } = parseDataUrl(value)
    return dataUrlFor(buffer, image)
  }
  const lexical = resolveInputPath(options.root, value, options.allowOutsideWorkspace === true)
  let file = lexical
  if (options.allowOutsideWorkspace !== true) {
    const realRoot = realpathOrResolve(options.root)
    file = realpathOrResolve(lexical)
    if (!isWithin(realRoot, file)) {
      throw new Error(`参考图解析后位于工作区外（可能是符号链接）：${lexical}；如确需读取外部文件请开启 allowOutsideWorkspace`)
    }
  }
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    throw new Error(`读不到参考图：${file}`)
  }
  const maxBytes = options.maxBytes || DEFAULTS.maxReferenceBytes
  if (buffer.length > maxBytes) throw new Error(`参考图太大：${buffer.length} 字节，上限 ${maxBytes}`)
  const image = sniffImage(buffer)
  if (!image) throw new Error(`参考图不是 PNG/JPEG/WebP/GIF：${file}`)
  assertImageLimits(image, '参考图', options)
  return dataUrlFor(buffer, image)
}

/** 本地时区 + 毫秒的文件时间戳，避免 UTC 跨午夜和同秒冲突。 */
export function timestampForFile(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`
}

function safePrefix(prefix) {
  const value = String(prefix || DEFAULTS.prefix).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (value || DEFAULTS.prefix).slice(0, 40)
}

function combineSignals(signals) {
  const list = signals.filter(Boolean)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  const abort = (event) => controller.abort(event && event.target && event.target.reason)
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

function timeoutController(timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  return {
    controller,
    clear: () => clearTimeout(timer),
    get timedOut() {
      return timedOut
    },
  }
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new QwenError('操作已取消', { code: 'QWEN_ABORTED' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new QwenError('操作已取消', { code: 'QWEN_ABORTED' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function trustedDownloadHost(host, options) {
  const value = String(host || '').toLowerCase()
  if (options.allowAnyHost) return true
  if (value === 'aliyuncs.com' || value.endsWith('.aliyuncs.com')) return true
  if (value === 'alibabacloud.com' || value.endsWith('.alibabacloud.com')) return true
  const allowed = new Set()
  if (options.baseURL) {
    try {
      allowed.add(new URL(options.baseURL).hostname.toLowerCase())
    } catch {
      // ignore malformed baseURL
    }
  }
  for (const item of options.allowedHosts || []) allowed.add(String(item).toLowerCase())
  return allowed.has(value)
}

function assertDownloadUrl(raw, options) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new QwenError(`下载地址不合法：${raw}`, { code: 'QWEN_BAD_DOWNLOAD_URL' })
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new QwenError(`下载地址协议不支持：${url.protocol}`, { code: 'QWEN_BAD_DOWNLOAD_URL' })
  }
  if (url.protocol === 'http:' && !options.allowInsecure && !isLocalHost(url.hostname)) {
    throw new QwenError('结果图下载地址不是 HTTPS，已拒绝', { code: 'QWEN_INSECURE_DOWNLOAD' })
  }
  if (!trustedDownloadHost(url.hostname, options)) {
    throw new QwenError(`结果图域名不在信任列表：${url.hostname}`, { code: 'QWEN_UNTRUSTED_DOWNLOAD_HOST' })
  }
  return url
}

async function readBodyLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) {
    if (response.body && typeof response.body.cancel === 'function') {
      Promise.resolve(response.body.cancel()).catch(() => {})
    }
    throw new QwenError(`图片太大：${declared} 字节，上限 ${maxBytes}`, { code: 'QWEN_IMAGE_TOO_LARGE' })
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new QwenError(`图片太大：${buffer.length} 字节，上限 ${maxBytes}`, { code: 'QWEN_IMAGE_TOO_LARGE' })
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new QwenError(`图片太大：超过 ${maxBytes} 字节`, { code: 'QWEN_IMAGE_TOO_LARGE' })
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks)
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30000, Math.round(seconds * 1000))
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.min(30000, Math.max(0, date - Date.now()))
  return undefined
}

/**
 * 下载一张结果图：限时、限体积、校验域名/格式/尺寸、429/5xx 重试。
 * @param {string} rawUrl
 * @param {object} [options]
 * @returns {Promise<{buffer: Buffer, mediaType: string, ext: string, width: number, height: number, contentType: string}>}
 */
async function fetchFollowingTrustedRedirects(rawUrl, options, signal) {
  let current = assertDownloadUrl(rawUrl, options)
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await fetch(current, { signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    if (response.body && typeof response.body.cancel === 'function') {
      Promise.resolve(response.body.cancel()).catch(() => {})
    }
    // 先校验下一跳，再发请求：避免把请求带到内网或未信任域名。
    let next
    try {
      next = new URL(location, current).toString()
    } catch {
      throw new QwenError(`下载重定向地址不合法：${location}`, { code: 'QWEN_BAD_DOWNLOAD_URL' })
    }
    current = assertDownloadUrl(next, options)
  }
  throw new QwenError('下载重定向次数过多', { code: 'QWEN_REDIRECT_LOOP' })
}

export async function fetchImage(rawUrl, options = {}) {
  const url = assertDownloadUrl(rawUrl, options)
  const retries = Math.max(0, Math.min(5, Number(options.downloadRetries ?? DEFAULTS.downloadRetries) || 0))
  const timeoutMs = Math.max(5000, Math.min(600000, Number(options.downloadTimeoutMs) || DEFAULTS.downloadTimeoutMs))
  const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULTS.maxDownloadBytes)
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) throw new QwenError('下载已取消', { code: 'QWEN_ABORTED' })
    const timeout = timeoutController(timeoutMs)
    const signal = combineSignals([options.signal, timeout.controller.signal])
    let response
    try {
      response = await fetchFollowingTrustedRedirects(url, options, signal)
      if (!response.ok) {
        const retry = response.status === 429 || response.status === 503 || response.status >= 500
        const error = new QwenError(`下载图片失败 HTTP ${response.status}`, {
          code: 'QWEN_DOWNLOAD_HTTP',
          status: response.status,
          retryable: retry,
          retryAfterMs: retryAfterMs(response),
        })
        if (response.body && typeof response.body.cancel === 'function') {
          Promise.resolve(response.body.cancel()).catch(() => {})
        }
        throw error
      }
      const finalUrl = response.url || String(url)
      if (finalUrl !== String(url)) assertDownloadUrl(finalUrl, options)
      const buffer = await readBodyLimited(response, maxBytes)
      if (!buffer.length) throw new QwenError('下载内容为空', { code: 'QWEN_EMPTY_IMAGE' })
      const image = sniffImage(buffer)
      if (!image) throw new QwenError('下载内容不是 PNG/JPEG/WebP/GIF 图片', { code: 'QWEN_NOT_IMAGE' })
      return {
        buffer,
        ...image,
        contentType: response.headers.get('content-type') || '',
      }
    } catch (err) {
      lastError = err
      if (err instanceof QwenError) {
        if (err.code === 'QWEN_ABORTED') throw err
        if (!err.retryable || attempt >= retries) throw err
      } else if (timeout.timedOut) {
        throw new QwenError(`下载超时（${timeoutMs}ms）`, { code: 'QWEN_DOWNLOAD_TIMEOUT', cause: err })
      } else if (options.signal?.aborted) {
        throw new QwenError('下载已取消', { code: 'QWEN_ABORTED' })
      } else if (attempt >= retries) {
        throw new QwenError(`下载失败：${toErrorText(err)}${causeText(err)}`, { code: 'QWEN_DOWNLOAD_NETWORK', cause: err })
      }
      const delayMs = lastError?.retryAfterMs ?? Math.min(5000, 300 * 2 ** attempt + Math.floor(Math.random() * 200))
      await sleep(delayMs, options.signal)
    } finally {
      timeout.clear()
    }
  }
  throw lastError || new QwenError('下载失败', { code: 'QWEN_DOWNLOAD_FAILED' })
}

async function writeNewFile(dir, basenameValue, buffer) {
  const ext = extname(basenameValue)
  const stem = ext ? basenameValue.slice(0, -ext.length) : basenameValue
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = attempt === 0 ? basenameValue : `${stem}-${attempt}${ext}`
    const file = join(dir, name)
    let handle
    try {
      handle = await open(file, 'wx')
      await handle.writeFile(buffer)
      await handle.close()
      return file
    } catch (err) {
      if (handle) {
        await handle.close().catch(() => {})
        await unlink(file).catch(() => {})
      }
      if (err && err.code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error(`无法生成唯一文件名：${basenameValue}`)
}

/**
 * 下载并保存结果图。每张独立处理，允许部分成功；同时写旁车 JSON。
 * @param {string[]} urls
 * @param {string} dir
 * @param {string} [prefix]
 * @param {object} [options]
 * @returns {Promise<{files: string[], failed: {index: number, error: string}[], items: object[], warnings: string[]}>}
 */
export async function saveImages(urls, dir, prefix = 'qwen', options = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('没有可下载的图片 URL')
  }
  let targetDir
  if (options.root) {
    const rootInput = resolve(options.root)
    const realRoot = await realpath(rootInput).catch(() => rootInput)
    const candidate = resolveOutputDir(realRoot, dir)
    await assertRealAncestorWithin(realRoot, candidate)
    await mkdir(candidate, { recursive: true })
    targetDir = await realpath(candidate)
    if (!isWithin(realRoot, targetDir)) {
      throw new Error('输出目录解析后位于工作区外（可能是符号链接）；请换一个目录')
    }
  } else {
    targetDir = resolve(dir)
    await mkdir(targetDir, { recursive: true })
  }
  const safe = safePrefix(prefix)
  const stamp = timestampForFile()
  const nonce = randomBytes(3).toString('hex')
  const files = []
  const failed = []
  const items = []
  const warnings = []
  const savedAt = new Date().toISOString()

  for (let i = 0; i < urls.length; i += 1) {
    try {
      const image = await fetchImage(urls[i], options)
      const sha256 = createHash('sha256').update(image.buffer).digest('hex')
      const base = `${safe}-${stamp}-${nonce}-${i + 1}${image.ext}`
      const file = await writeNewFile(targetDir, base, image.buffer)
      let metadataFile
      if (options.writeMetadata !== false) {
        try {
          const ext = extname(file)
          const stem = ext ? file.slice(0, -ext.length) : file
          const metadata = {
            file: basename(file),
            path: file,
            url: urls[i],
            mediaType: image.mediaType,
            width: image.width,
            height: image.height,
            bytes: image.buffer.length,
            sha256,
            savedAt,
            ...(options.metadata || {}),
          }
          metadataFile = await writeNewFile(targetDir, `${basename(stem)}.json`, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'))
        } catch (err) {
          warnings.push(`第 ${i + 1} 张的旁车 JSON 写入失败：${toErrorText(err)}`)
        }
      }
      items.push({
        index: i + 1,
        file,
        metadataFile,
        url: urls[i],
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        bytes: image.buffer.length,
        sha256,
        buffer: image.buffer,
      })
      files.push(file)
    } catch (err) {
      if (options.signal?.aborted) {
        failed.push({ index: i + 1, error: '下载已取消' })
        break
      }
      failed.push({ index: i + 1, error: toErrorText(err) })
    }
  }

  if (!files.length) {
    const detail = failed.map((item) => `第 ${item.index} 张：${item.error.slice(0, 200)}`).join('；')
    throw new QwenError(`所有图片下载失败：${detail || '未知错误'}`, {
      code: 'QWEN_ALL_DOWNLOADS_FAILED',
    })
  }

  return { files, failed, items, warnings }
}

/**
 * 读取输出目录里的旁车 JSON，列出历史图片（只读，不访问网络）。
 * 只信任 JSON 旁边的真实图片文件；sidecar 里的 path 字段不会被用来读取任意路径。
 * @param {string} root 工作区
 * @param {string} [dir] 输出目录
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{dir: string, total: number, items: object[], truncated: boolean}>}
 */
export async function listGeneratedImages(root, dir = DEFAULTS.dir, options = {}) {
  const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(100, options.limit)) : 10
  const target = resolveOutputDir(root, dir)
  const realRoot = await realpath(resolve(root)).catch(() => resolve(root))
  await assertRealAncestorWithin(root, target)
  let targetStat
  try {
    targetStat = await stat(target)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { dir: target, total: 0, items: [], truncated: false }
    }
    throw err
  }
  if (!targetStat.isDirectory()) throw new Error(`输出目录不是目录：${target}`)
  const realTarget = await realpath(target)
  if (!isWithin(realRoot, realTarget)) {
    throw new Error('输出目录解析后位于工作区外（可能是符号链接）；请换一个目录')
  }
  const entries = await readdir(realTarget, { withFileTypes: true })
  const items = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const sidecar = join(realTarget, entry.name)
    try {
      const info = await stat(sidecar)
      if (!info.isFile() || info.size > 256 * 1024) continue
      const metadata = JSON.parse(await readFile(sidecar, 'utf8'))
      if (!metadata || typeof metadata !== 'object') continue
      const name = basename(String(metadata.file || ''))
      if (!name || name === '.' || name === '..' || !/\.(png|jpe?g|webp|gif)$/i.test(name)) continue
      const imagePath = join(realTarget, name)
      const imageStat = await stat(imagePath).catch(() => undefined)
      if (!imageStat || !imageStat.isFile()) continue
      const realImage = await realpath(imagePath).catch(() => imagePath)
      if (!isWithin(realTarget, realImage)) continue
      const item = {
        file: imagePath,
        name,
        savedAt: typeof metadata.savedAt === 'string'
          ? metadata.savedAt
          : imageStat.mtime.toISOString(),
        bytes: Number.isInteger(metadata.bytes) ? metadata.bytes : imageStat.size,
        ...(typeof metadata.model === 'string' && metadata.model ? { model: metadata.model } : {}),
        ...(typeof metadata.size === 'string' && metadata.size ? { size: metadata.size } : {}),
        ...(Number.isInteger(metadata.width) ? { width: metadata.width } : {}),
        ...(Number.isInteger(metadata.height) ? { height: metadata.height } : {}),
        ...(typeof metadata.sha256 === 'string' && metadata.sha256 ? { sha256: metadata.sha256 } : {}),
        ...(typeof metadata.requestId === 'string' && metadata.requestId ? { requestId: metadata.requestId } : {}),
        ...(typeof metadata.prompt === 'string' && metadata.prompt ? { prompt: metadata.prompt } : {}),
        ...(Number.isInteger(metadata.seed) ? { seed: metadata.seed } : {}),
      }
      items.push(item)
    } catch {
      // 损坏的旁车 JSON 不应让整个历史列表失败。
    }
  }
  items.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
  return {
    dir: realTarget,
    total: items.length,
    items: items.slice(0, limit),
    truncated: items.length > limit,
  }
}

function extractImageUrls(body) {
  const output = body && typeof body.output === 'object' && body.output ? body.output : {}
  const urls = []
  const add = (value) => {
    if (!value) return
    if (typeof value === 'string') {
      if (/^(https?:\/\/|data:image\/)/i.test(value)) urls.push(value)
      return
    }
    if (typeof value !== 'object') return
    for (const key of ['url', 'image', 'image_url', 'imageUrl']) add(value[key])
    if (Array.isArray(value.content)) for (const item of value.content) add(item)
  }
  if (Array.isArray(output.choices)) {
    for (const choice of output.choices) {
      add(choice?.message?.content)
      add(choice?.message)
      add(choice)
    }
  }
  if (Array.isArray(output.results)) for (const item of output.results) add(item)
  add(output)
  add(body)
  return [...new Set(urls)]
}

function parseApiError(body, status, headerRequestId) {
  const code = body?.code || body?.error?.code
  const message = body?.message || body?.msg || body?.error?.message || `HTTP ${status}`
  const requestId = body?.request_id || body?.requestId || headerRequestId
  const hint = status === 401 || status === 403
    ? '；请检查 API Key 是否有效、是否与 baseURL 区域一致'
    : status === 429
      ? '；请求被限流，稍后重试'
      : ''
  return new QwenError(
    `百炼接口 ${status}${code ? ` (${code})` : ''}：${message}${requestId ? `；request_id=${requestId}` : ''}${hint}`,
    {
      code: code ? String(code) : 'QWEN_HTTP_ERROR',
      status,
      requestId,
      retryable: status === 429 || status >= 500,
      retryAfterMs: undefined,
    },
  )
}

async function requestOnce(options) {
  const timeout = timeoutController(options.timeoutMs)
  const signal = combineSignals([options.signal, timeout.controller.signal])
  const url = `${options.baseURL}/api/v1/services/aigc/multimodal-generation/generation`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.body),
      signal,
    })
  } catch (err) {
    timeout.clear()
    if (options.signal?.aborted) throw new QwenError('生图请求已取消', { code: 'QWEN_ABORTED' })
    if (timeout.timedOut) {
      throw new QwenError(`生图请求超时（${options.timeoutMs}ms）；服务端可能已经生成，请先检查账单/控制台，避免重复扣费`, {
        code: 'QWEN_TIMEOUT',
        cause: err,
      })
    }
    throw new QwenError(`无法连接百炼：${toErrorText(err)}${causeText(err)}；请检查网络、代理、DNS 与 baseURL 区域`, {
      code: 'QWEN_NETWORK',
      cause: err,
    })
  }
  const headerRequestId = response.headers.get('x-request-id') || response.headers.get('x-dashscope-request-id') || undefined
  let text
  try {
    text = await response.text()
  } catch (err) {
    timeout.clear()
    throw new QwenError(`读取百炼响应失败：${toErrorText(err)}`, { code: 'QWEN_BAD_RESPONSE', cause: err })
  } finally {
    timeout.clear()
  }
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new QwenError(`百炼返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`, {
      code: 'QWEN_BAD_RESPONSE',
      status: response.status,
      requestId: headerRequestId,
    })
  }
  if (!response.ok) {
    const error = parseApiError(body, response.status, headerRequestId)
    const retryAfter = retryAfterMs(response)
    if (retryAfter !== undefined) error.retryAfterMs = retryAfter
    throw error
  }
  if (body?.code && !body?.output) {
    throw new QwenError(`百炼返回错误 ${body.code}：${body.message || ''}`, {
      code: String(body.code),
      requestId: body.request_id || headerRequestId,
    })
  }
  const urls = extractImageUrls(body)
  if (!urls.length) {
    const taskId = body?.output?.task_id || body?.task_id
    const status = body?.output?.task_status || body?.task_status
    if (taskId) {
      throw new QwenError(`百炼返回了异步任务 ${taskId}（${status || 'PENDING'}），当前插件只支持同步接口`, {
        code: 'QWEN_ASYNC_TASK',
        requestId: body.request_id || headerRequestId,
      })
    }
    throw new QwenError('百炼接口没有返回图片；可能是提示词被安全策略拦截，或模型未开通', {
      code: 'QWEN_NO_IMAGE',
      requestId: body.request_id || headerRequestId,
    })
  }
  return {
    urls,
    model: options.model,
    size: body?.output?.size || body?.output?.actual_size || 'auto',
    usage: body?.usage || body?.output?.usage,
    requestId: body?.request_id || body?.requestId || headerRequestId,
    taskId: body?.output?.task_id || body?.task_id,
    raw: body,
  }
}

/**
 * 调用 DashScope 同步生图接口。
 * 只对 429/503 做重试；超时/网络错误不自动重试，避免重复扣费。
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function generateImage(options = {}) {
  const prompt = validatePrompt(options.prompt, options.maxPromptChars || DEFAULTS.maxPromptChars)
  const model = assertModel(options.model || DEFAULTS.model)
  const size = options.size === undefined || options.size === null
    ? undefined
    : (typeof options.size === 'object' ? options.size.text : normalizeSize(options.size))
  const n = options.n === undefined ? 1 : options.n
  if (!Number.isInteger(n) || n < 1 || n > (options.maxImagesPerCall || DEFAULTS.maxImagesPerCall)) {
    throw new Error(`n 必须是 1~${options.maxImagesPerCall || DEFAULTS.maxImagesPerCall} 的整数；收到 ${String(options.n)}`)
  }
  const images = Array.isArray(options.images) ? options.images : []
  if (images.length > 3) throw new Error(`参考图最多 3 张；收到 ${images.length} 张`)
  const negativePrompt = options.negativePrompt ? String(options.negativePrompt).trim() : ''
  if (negativePrompt && !supportsNegativePrompt(model)) {
    throw new Error(`模型 ${model} 不支持 negative_prompt；仅 qwen-image-3.0 系列支持`)
  }
  let seed
  if (options.seed !== undefined && options.seed !== null) {
    seed = options.seed
    if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
      throw new Error(`seed 必须是 0~${MAX_SEED} 的整数`)
    }
  }
  const watermark = options.watermark === true ? true : options.watermark === false ? false : undefined
  const promptExtend = options.promptExtend === undefined ? undefined : options.promptExtend === true
  const baseURL = normalizeBaseURL(options.baseURL || DEFAULTS.baseURL, { allowInsecure: options.allowInsecureBaseURL === true })
  const timeoutMs = Math.max(5000, Math.min(1800000, Number(options.timeoutMs) || DEFAULTS.timeoutMs))
  const retries = Math.max(0, Math.min(5, Number(options.maxRetries ?? DEFAULTS.maxRetries) || 0))
  const startedAt = Date.now()

  const parameters = { n }
  if (watermark !== undefined) parameters.watermark = watermark
  if (size) parameters.size = size
  if (negativePrompt) parameters.negative_prompt = negativePrompt
  if (promptExtend !== undefined) parameters.prompt_extend = promptExtend
  if (seed !== undefined) parameters.seed = seed

  const content = [{ text: prompt }]
  for (const image of images) content.push({ image })
  const body = {
    model,
    input: { messages: [{ role: 'user', content }] },
    parameters,
  }

  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await requestOnce({
        baseURL,
        apiKey: options.apiKey,
        body,
        model,
        timeoutMs,
        signal: options.signal,
      })
      return { ...result, durationMs: Date.now() - startedAt, requestedN: n }
    } catch (err) {
      lastError = err
      if (options.signal?.aborted) throw new QwenError('生图请求已取消', { code: 'QWEN_ABORTED', cause: err })
      if (!(err instanceof QwenError) || !err.retryable || attempt >= retries) throw err
      const delayMs = err.retryAfterMs ?? Math.min(10000, 800 * 2 ** attempt + Math.floor(Math.random() * 300))
      await sleep(delayMs, options.signal)
    }
  }
  throw lastError || new QwenError('生图失败', { code: 'QWEN_GENERATION_FAILED' })
}

/** 供测试/诊断使用：同步解析真实路径，不创建目录。 */
export function realpathOrResolve(value) {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}