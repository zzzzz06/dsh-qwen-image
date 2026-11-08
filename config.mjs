/**
 * 插件配置 schema。
 *
 * 这里不依赖 @deepseek-ai/schemastery：插件以 link: / file: 方式安装时，
 * 该包不一定能从插件目录解析到。Cordis 只要求 Config["~standard"].validate，
 * 设置页则要求 Config.toJSON()，所以这里实现一个最小的 Standard Schema +
 * schemastery 兼容外观：
 *   - type / dict / meta 供设置页做字段遍历；
 *   - toJSON() 供设置页构造表单；
 *   - "~standard" 供 Cordis 校验和填默认值。
 *
 * 字段标成 volatile，设置页改完可以直接热更新，不必重启宿主。
 */
import { DEFAULTS, MODELS } from './core.mjs'

const MODEL_SET = new Set(MODELS)

const FIELDS = {
  apiKey: {
    type: 'string',
    default: '',
    description: '百炼 API Key；留空则读环境变量、~/.dsh/.env 或 ~/.dsh/.credentials.yaml',
    role: 'secret',
  },
  apiKeyEnv: {
    type: 'string',
    default: DEFAULTS.apiKeyEnv,
    description: 'API Key 所在的环境变量名（也会用同名键查 .env 和 .credentials.yaml）',
  },
  model: {
    type: 'string',
    default: DEFAULTS.model,
    enum: [...MODELS],
    description: '默认模型：qwen-image-3.0 / qwen-image-3.0-pro / qwen-image-2.1-pro / qwen-image-2.1-turbo',
  },
  baseURL: {
    type: 'string',
    default: DEFAULTS.baseURL,
    description: '百炼端点（北京 dashscope.aliyuncs.com，新加坡 dashscope-intl.aliyuncs.com）',
  },
  dir: {
    type: 'string',
    default: DEFAULTS.dir,
    description: '图片保存目录，相对工作区；绝对路径也必须在工作区内',
  },
  timeoutMs: {
    type: 'integer',
    default: DEFAULTS.timeoutMs,
    minimum: 5000,
    maximum: 1800000,
    description: '单次生图请求超时（毫秒），默认 300000',
  },
  downloadTimeoutMs: {
    type: 'integer',
    default: DEFAULTS.downloadTimeoutMs,
    minimum: 5000,
    maximum: 600000,
    description: '单张图片下载超时（毫秒），默认 120000',
  },
  maxRetries: {
    type: 'integer',
    default: DEFAULTS.maxRetries,
    minimum: 0,
    maximum: 5,
    description: '生图接口 429/5xx 的重试次数，默认 2；重试可能重复计费',
  },
  downloadRetries: {
    type: 'integer',
    default: DEFAULTS.downloadRetries,
    minimum: 0,
    maximum: 5,
    description: '图片下载重试次数，默认 2',
  },
  maxImagesPerCall: {
    type: 'integer',
    default: DEFAULTS.maxImagesPerCall,
    minimum: 1,
    maximum: 6,
    description: '单次最多生成张数，默认 6；API 上限也是 6',
  },
  maxImagesPerDay: {
    type: 'integer',
    default: DEFAULTS.maxImagesPerDay,
    minimum: 0,
    maximum: 1000,
    description: '每日最多提交张数，按本地日期计数，默认 0（不限）；只做本地计数，不含 dry-run，多会话下为尽力而为',
  },
  maxReferenceImages: {
    type: 'integer',
    default: DEFAULTS.maxReferenceImages,
    minimum: 1,
    maximum: 3,
    description: '参考图张数上限，默认 3（qwen-image-3.0 系列上限）',
  },
  maxReferenceBytes: {
    type: 'integer',
    default: DEFAULTS.maxReferenceBytes,
    minimum: 1024 * 1024,
    maximum: 64 * 1024 * 1024,
    description: '单张参考图体积上限，默认 10 MiB',
  },
  maxReferenceDimension: {
    type: 'integer',
    default: DEFAULTS.maxReferenceDimension,
    minimum: 512,
    maximum: 8192,
    description: '参考图单边像素上限，默认 4096',
  },
  maxDownloadBytes: {
    type: 'integer',
    default: DEFAULTS.maxDownloadBytes,
    minimum: 1024 * 1024,
    maximum: 256 * 1024 * 1024,
    description: '单张生成图下载体积上限，默认 32 MiB',
  },
  maxPromptChars: {
    type: 'integer',
    default: DEFAULTS.maxPromptChars,
    minimum: 1000,
    maximum: 40000,
    description: '提示词字符数上限，默认 12000；超过会直接拒绝，避免静默截断',
  },
  prefix: {
    type: 'string',
    default: DEFAULTS.prefix,
    description: '文件名前缀，只保留字母、数字、下划线和连字符',
  },
  writeMetadata: {
    type: 'boolean',
    default: DEFAULTS.writeMetadata,
    description: '是否给每张图写同名 .json 旁车（prompt / seed / request id / usage / sha256）',
  },
  attachToChat: {
    type: 'boolean',
    default: DEFAULTS.attachToChat,
    description: '是否把生成图作为图片内容块返回，在聊天里直接预览；关闭则只返回路径',
  },
  allowOutsideWorkspace: {
    type: 'boolean',
    default: false,
    description: '允许参考图读取工作区外的本地路径；默认关闭，避免把任意文件发给 API',
  },
  allowInsecureBaseURL: {
    type: 'boolean',
    default: false,
    description: '允许 http:// 的 baseURL（本机/内网代理才需要）；默认只允许 HTTPS',
  },
  allowAnyDownloadHost: {
    type: 'boolean',
    default: false,
    description: '允许从任意 HTTPS 域名下载结果图；默认只信任百炼/阿里云域名和 baseURL 主机',
  },
}

const DEFAULTS_OBJECT = Object.fromEntries(
  Object.entries(FIELDS).map(([key, field]) => [key, field.default]),
)

function jsonFor(name, field) {
  const meta = {
    default: field.default,
    description: field.description,
    volatile: true,
    ...(field.role ? { role: field.role } : {}),
  }
  if (field.type === 'integer') meta.step = 1
  if (field.minimum !== undefined) meta.min = field.minimum
  if (field.maximum !== undefined) meta.max = field.maximum
  return {
    type: field.type === 'integer' ? 'number' : field.type,
    meta,
    ...(field.enum ? { enum: [...field.enum] } : {}),
  }
}

function nodeFor(name, field) {
  const json = jsonFor(name, field)
  return {
    type: json.type,
    meta: json.meta,
    [Symbol.for('schemastery')]: true,
    toJSON() {
      return jsonFor(name, field)
    },
  }
}

const NODES = Object.fromEntries(
  Object.entries(FIELDS).map(([key, field]) => [key, nodeFor(key, field)]),
)

function issue(path, message) {
  return { path: [path], message }
}

function validateField(name, field, value) {
  if (value === undefined || value === null) return { value: field.default }
  if (field.type === 'string') {
    if (typeof value !== 'string') return { issue: issue(name, '必须是字符串') }
    const text = value.trim()
    if (name === 'apiKeyEnv' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
      return { issue: issue(name, '必须是合法的环境变量名') }
    }
    if (name === 'model' && !MODEL_SET.has(text)) {
      return { issue: issue(name, `不支持的模型：${text}`) }
    }
    if (name === 'dir' && (!text || text.includes('\0'))) {
      return { issue: issue(name, '不能为空，也不能包含 NUL 字符') }
    }
    if (name === 'prefix' && !text) return { issue: issue(name, '不能为空') }
    if (name === 'baseURL') {
      let url
      try {
        url = new URL(text)
      } catch {
        return { issue: issue(name, '不是合法的 URL') }
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { issue: issue(name, '只支持 https:// 或 http://') }
      }
      if (url.search || url.hash) {
        return { issue: issue(name, '不能带查询参数或锚点') }
      }
    }
    return { value: text }
  }
  if (field.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { issue: issue(name, '必须是整数') }
    }
  } else if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { issue: issue(name, '必须是有限数字') }
    }
  } else if (field.type === 'boolean') {
    if (typeof value !== 'boolean') return { issue: issue(name, '必须是布尔值') }
  } else {
    return { issue: issue(name, `内部错误：未知字段类型 ${field.type}`) }
  }
  if (field.minimum !== undefined && value < field.minimum) {
    return { issue: issue(name, `不能小于 ${field.minimum}`) }
  }
  if (field.maximum !== undefined && value > field.maximum) {
    return { issue: issue(name, `不能大于 ${field.maximum}`) }
  }
  return { value }
}

function validate(raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ path: [], message: '配置必须是对象' }] }
  }
  const issues = []
  const value = {}
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(FIELDS, key)) issues.push(issue(key, '未知配置项'))
  }
  for (const [key, field] of Object.entries(FIELDS)) {
    const result = validateField(key, field, input[key])
    if (result.issue) issues.push(result.issue)
    else value[key] = result.value
  }
  if (!issues.length && value.baseURL) {
    try {
      const url = new URL(value.baseURL)
      const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
      if (url.protocol === 'http:' && !value.allowInsecureBaseURL && !local) {
        issues.push(issue('baseURL', '外部端点必须使用 HTTPS；如确需 http 请同时开启 allowInsecureBaseURL'))
      }
    } catch {
      issues.push(issue('baseURL', '不是合法的 URL'))
    }
  }
  if (issues.length) return { issues }
  return { value }
}

export const Config = {
  type: 'object',
  meta: {
    default: DEFAULTS_OBJECT,
    description: '通义千问 qwen-image 生图',
  },
  dict: NODES,
  // dsh-app-boot 的 isNativeConfigSchema 用这个知名 Symbol 识别原生 Schemastery 图，
  // 没有它设置页/Config 检查会显示 unsupported。
  [Symbol.for('schemastery')]: true,
  merge(...configs) {
    return Object.assign({}, ...configs)
  },
  toJSON() {
    // 必须是 schemastery 的序列化格式（uid + refs），不是 JSON Schema：
    // dsh-settings 会执行 `new z(schema.toJSON())` 来重建表单。
    const refs = {}
    const dict = {}
    let uid = 1
    for (const [key, field] of Object.entries(FIELDS)) {
      refs[String(uid)] = jsonFor(key, field)
      dict[key] = uid
      uid += 1
    }
    refs[String(uid)] = {
      type: 'object',
      meta: {
        default: DEFAULTS_OBJECT,
        description: '通义千问 qwen-image 生图',
      },
      dict,
    }
    return { uid, refs }
  },
  '~standard': {
    version: 1,
    vendor: 'schemastery',
    validate,
  },
}

/**
 * 供 selftest / smoke 这类不经过 Loader 的调用方使用。
 * @param {object} raw
 * @returns {object}
 */
export function resolveSettings(raw = {}) {
  const result = Config['~standard'].validate(raw)
  if (result.issues) {
    throw new Error(
      `插件配置无效：${result.issues.map((item) => `${item.path.join('.')} ${item.message}`).join('；')}`,
    )
  }
  return result.value
}