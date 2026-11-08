/**
 * DSH 插件入口：把 qwen-image 注册成一个工具。
 *
 * 约定：
 * - 只导出命名导出（name / inject / apply，可选 Config）。不要用 export default，
 *   loader 的 unwrapExports 会丢掉同模块上的命名导出。
 * - 不声明 dependencies：官方包由运行时注入，自己装反而解析不到。
 * - 手写 ToolDefinition，避免 link: 安装时 defineTool 解析不到。
 *
 * 分发说明：本文件不保存任何 API Key。Key 由每位使用者在自己机器上配置。
 */
import { basename } from 'node:path'
import {
  DEFAULTS,
  assertModel,
  generateImage,
  listGeneratedImages,
  normalizeBaseURL,
  parseSize,
  prepareImageSources,
  prepareOutputDir,
  releaseDailyBudget,
  reserveDailyBudget,
  resolveKey,
  saveImages,
  settleDailyBudget,
  supportsNegativePrompt,
  validatePrompt,
} from './core.mjs'
import { Config, resolveSettings } from './config.mjs'

export { Config }
export const name = 'qwen-image'
export const inject = ['tools']

const PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '画面描述或改图指令，中英文均可。建议写清主体、风格、构图、光线。',
    },
    size: {
      type: 'string',
      description: '输出尺寸，形如 1024*1024（也接受 1024x1024）。单边 512~2048，总像素 512×512 ~ 2048×2048，宽高比 1:8 ~ 8:1。省略则由模型决定。',
    },
    n: {
      type: 'integer',
      description: '生成张数，1~6，默认 1；受配置 maxImagesPerCall 限制。',
    },
    negative_prompt: {
      type: 'string',
      description: '不希望出现的元素；仅 qwen-image-3.0 / 3.0-pro 支持，其他模型会明确报错。',
    },
    negativePrompt: {
      type: 'string',
      description: 'negative_prompt 的别名，二者只能选一个。',
    },
    image: {
      type: 'array',
      description: '参考图，1~3 张。支持工作区内相对路径、工作区内绝对路径、公网 HTTPS URL、data:image/...;base64。',
      items: { type: 'string' },
    },
    imageUrl: {
      type: 'string',
      description: '单张参考图的别名，与 image 二选一。',
    },
    dir: {
      type: 'string',
      description: '保存目录，必须在当前工作区内，默认 generated；..、外部绝对路径和 symlink 逃逸会被拒绝。',
    },
    model: {
      type: 'string',
      description: '覆盖默认模型：qwen-image-3.0 / qwen-image-3.0-pro / qwen-image-2.1-pro / qwen-image-2.1-turbo。',
    },
    prompt_extend: {
      type: 'boolean',
      description: '是否让模型扩写提示词；3.0 默认 true，2.1 默认 false。要精确复现描述时传 false。',
    },
    promptExtend: {
      type: 'boolean',
      description: 'prompt_extend 的别名，二者只能选一个。',
    },
    seed: {
      type: 'integer',
      description: '可选随机种子（0~2147483647），用于尽量复现同一张图；服务端不保证完全一致。',
    },
    watermark: {
      type: 'boolean',
      description: '是否加“AI生成”水印；不传则用服务端默认。通义千问 API 目前通常不加可见水印。',
    },
    dry_run: {
      type: 'boolean',
      description: '只校验参数、参考图和目录边界，不调用付费接口、不下载、不写文件。',
    },
    timeout_ms: {
      type: 'integer',
      description: '本次生图请求超时（毫秒），覆盖配置 timeoutMs；范围 5000~1800000。',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    urls: { type: 'array', items: { type: 'string' } },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
        },
        required: ['attachmentId'],
        additionalProperties: false,
      },
    },
    model: { type: 'string' },
    size: { type: 'string' },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          mediaType: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
        },
        required: ['file', 'width', 'height'],
        additionalProperties: false,
      },
    },
    requestedN: { type: 'integer' },
    receivedN: { type: 'integer' },
    requestId: { type: 'string' },
    usage: { type: 'object', additionalProperties: true },
    failed: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    dryRun: { type: 'boolean' },
    durationMs: { type: 'integer' },
    seed: { type: 'integer' },
  },
  required: ['files', 'dryRun'],
  additionalProperties: false,
}

const ALLOWED_ARGS = new Set([
  'prompt',
  'size',
  'n',
  'negative_prompt',
  'negativePrompt',
  'image',
  'imageUrl',
  'dir',
  'model',
  'prompt_extend',
  'promptExtend',
  'seed',
  'watermark',
  'dry_run',
  'timeout_ms',
])

/**
 * 会话工作区：优先 workingDirectory 服务，其次 session.header.cwd 等字段。
 * 不回退到 process.cwd()，避免 cwd 与用户工作区不一致时把文件写错地方。
 */
async function workspaceRoot(ctx, exec) {
  const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  if (wd && typeof wd.ensure === 'function' && exec?.agent) {
    try {
      const cwd = await wd.ensure(exec.agent, exec.signal)
      if (typeof cwd === 'string' && cwd.trim()) return cwd
    } catch {
      // 服务不可用时继续走 session 字段兜底。
    }
  }
  const session = exec && exec.agent && exec.agent.session
  const header = session && session.header
  const meta = session && session.meta
  const candidates = [
    header && header.cwd,
    header && header.identity && header.identity.cwd,
    meta && meta.cwd,
    session && session.cwd,
    exec && exec.agent && exec.agent.cwd,
    process.env.DSH_WORKSPACE,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  throw new Error('无法确定会话工作区：缺少 workingDirectory 服务和 session.cwd')
}

function asArray(value) {
  if (value == null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

/**
 * 先走宿主 credentials 服务（支持设置页/凭据存储热更新），再回退到
 * .env / 环境变量 / .credentials.yaml。
 */
async function resolveApiKey(ctx, settings) {
  if (settings.apiKey && String(settings.apiKey).trim()) return String(settings.apiKey).trim()
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(settings.apiKeyEnv)
      if (resolved && resolved.value) return String(resolved.value).trim()
    } catch {
      // 凭据服务不可用/未配置时继续走环境变量兜底。
    }
  }
  return resolveKey(settings)
}

function pickAlias(args, primary, alias) {
  if (args[primary] !== undefined && args[alias] !== undefined && args[primary] !== args[alias]) {
    throw new Error(`${primary} 与 ${alias} 不能同时传且值不同；请只用一个`)
  }
  return args[primary] !== undefined ? args[primary] : args[alias]
}

function validateArgs(args) {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGS.has(key)) throw new Error(`未知参数：${key}`)
  }
}

function compactUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  try {
    const text = JSON.stringify(usage)
    return text.length > 400 ? { summary: `${text.slice(0, 400)}…` } : usage
  } catch {
    return undefined
  }
}

function renderOutput(args, value) {
  const files = Array.isArray(value.files) ? value.files : []
  const failed = Array.isArray(value.failed) ? value.failed : []
  const warnings = Array.isArray(value.warnings) ? value.warnings : []
  const requestedN = Number.isInteger(value.requestedN) ? value.requestedN : files.length
  if (value.dryRun) {
    const lines = [
      `dry-run：参数已通过校验，将请求 ${requestedN} 张 ${value.model || ''}${value.size ? `（${value.size}）` : ''}。`,
      '未调用付费接口、未下载、未写文件。去掉 dry_run 后才会真正生成。',
    ]
    if (warnings.length) {
      lines.push('', '注意：')
      for (const warning of warnings) lines.push(`- ${warning}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const lines = [
    `已生成 ${files.length} 张图片（${value.model || 'qwen-image'}${value.size ? `, ${value.size}` : ''}），请求 ${requestedN} 张。`,
  ]
  const dimensions = new Map(
    (Array.isArray(value.dimensions) ? value.dimensions : [])
      .filter((item) => item && item.file)
      .map((item) => [item.file, item]),
  )
  for (const file of files) {
    const actual = dimensions.get(file)
    lines.push(`- ${file}${actual ? `（实际 ${actual.width}×${actual.height}）` : ''}`)
  }
  if (value.requestId) lines.push('', `request_id: ${value.requestId}`)
  if (value.usage) {
    lines.push(`usage: ${JSON.stringify(value.usage)}`)
  }
  if (failed.length) {
    lines.push('', `⚠️ 有 ${failed.length} 张下载失败：`)
    for (const message of failed) lines.push(`- ${message}`)
  }
  if (warnings.length) {
    lines.push('', '提示：')
    for (const warning of warnings) lines.push(`- ${warning}`)
  }
  if (value.urls && value.urls.length) {
    lines.push('', '原图链接 24 小时内有效，长期保存请用上面的本地文件。')
  }

  const blocks = [{ type: 'text', text: lines.join('\n') }]
  for (const image of Array.isArray(value.images) ? value.images : []) {
    if (!image || !image.attachmentId) continue
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        name: image.name,
      },
    })
  }
  return blocks
}

const HISTORY_PARAMETERS = {
  type: 'object',
  properties: {
    dir: {
      type: 'string',
      description: '要查看的输出目录（相对工作区，默认取配置 dir，通常是 generated）。',
    },
    limit: {
      type: 'integer',
      description: '最多返回多少张，1~100，默认 10。',
    },
  },
  required: [],
  additionalProperties: false,
}

const HISTORY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    dir: { type: 'string' },
    total: { type: 'integer' },
    truncated: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          name: { type: 'string' },
          savedAt: { type: 'string' },
          bytes: { type: 'integer' },
          model: { type: 'string' },
          size: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          sha256: { type: 'string' },
          requestId: { type: 'string' },
          prompt: { type: 'string' },
          seed: { type: 'integer' },
        },
        required: ['file', 'name', 'savedAt', 'bytes'],
        additionalProperties: false,
      },
    },
  },
  required: ['dir', 'total', 'truncated', 'items'],
  additionalProperties: false,
}

function renderHistory(args, value) {
  if (!value.items.length) {
    return [{ type: 'text', text: `在 ${value.dir} 没有找到 qwen-image 历史图片。` }]
  }
  const lines = [`最近 ${value.items.length} 张图片（目录：${value.dir}，共 ${value.total} 张）：`]
  for (const item of value.items) {
    const bits = [item.size, item.model].filter(Boolean).join(' · ')
    lines.push(`- ${item.name}${bits ? `（${bits}）` : ''} · ${item.savedAt}`)
    if (item.prompt) lines.push(`  ${item.prompt.length > 160 ? `${item.prompt.slice(0, 160)}…` : item.prompt}`)
  }
  if (value.truncated) lines.push('', '还有更多结果；调大 limit 或缩小 dir 范围。')
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx, rawConfig = {}) {
  const settings = resolveSettings(rawConfig || {})

  const tool = {
    name: 'generate_image',
    description:
      '用通义千问 qwen-image 生成或编辑图片（阿里云百炼，付费接口）。文生图只给 prompt；改图再给 image（1~3 张参考图）。'
      + '图片会下载到工作区并返回绝对路径，同时尽量在聊天里预览；原图链接 24 小时后失效。'
      + '先可用 dry_run 免费校验参数。默认模型 qwen-image-3.0。',
    timeoutMs: Math.min(
      3600000,
      settings.timeoutMs + settings.downloadTimeoutMs * Math.max(1, settings.maxImagesPerCall) + 60000,
    ),
    // 付费接口 + 共享输出目录：让调度器不要并发跑同一个工具，降低限流和磁盘竞争。
    isConcurrencySafe: () => false,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderOutput,
    },
    execute: async (rawArgs = {}, exec) => {
      const startedAt = Date.now()
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      validateArgs(args)

      const prompt = validatePrompt(args.prompt, settings.maxPromptChars)
      const model = assertModel(args.model || settings.model)
      const sizeInfo = parseSize(args.size)
      const requestedN = args.n === undefined ? 1 : args.n
      if (!Number.isInteger(requestedN) || requestedN < 1 || requestedN > settings.maxImagesPerCall) {
        throw new Error(`n 必须是 1~${settings.maxImagesPerCall} 的整数；收到 ${String(args.n)}`)
      }

      const negativeRaw = pickAlias(args, 'negative_prompt', 'negativePrompt')
      const negativePrompt = negativeRaw === undefined ? '' : String(negativeRaw).trim()
      if (negativePrompt && !supportsNegativePrompt(model)) {
        throw new Error(`模型 ${model} 不支持 negative_prompt；仅 qwen-image-3.0 / 3.0-pro 支持`)
      }

      const promptExtend = pickAlias(args, 'prompt_extend', 'promptExtend')
      if (promptExtend !== undefined && typeof promptExtend !== 'boolean') {
        throw new Error('prompt_extend 必须是布尔值')
      }
      if (args.watermark !== undefined && typeof args.watermark !== 'boolean') {
        throw new Error('watermark 必须是布尔值')
      }
      const seed = args.seed
      if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)) {
        throw new Error('seed 必须是 0~2147483647 的整数')
      }
      const dryRun = args.dry_run === true

      let timeoutMs = args.timeout_ms === undefined ? settings.timeoutMs : args.timeout_ms
      if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 1800000) {
        throw new Error('timeout_ms 必须是 5000~1800000 的整数')
      }

      const imageArg = args.image
      const imageUrlArg = args.imageUrl
      if (imageArg !== undefined && imageUrlArg !== undefined) {
        throw new Error('image 与 imageUrl 只能二选一')
      }
      const sourceImages = imageUrlArg !== undefined ? [imageUrlArg] : asArray(imageArg)

      const root = await workspaceRoot(ctx, exec)
      const dir = dryRun
        ? await prepareOutputDir(root, args.dir || settings.dir, { checkOnly: true })
        : await prepareOutputDir(root, args.dir || settings.dir)
      const images = await prepareImageSources(sourceImages, {
        root,
        maxImages: settings.maxReferenceImages,
        maxBytes: settings.maxReferenceBytes,
        maxDimension: settings.maxReferenceDimension,
        allowOutsideWorkspace: settings.allowOutsideWorkspace,
        allowInsecure: settings.allowInsecureBaseURL,
      })

      const warnings = []
      if (prompt.length > 5000) {
        warnings.push(`提示词较长（${prompt.length} 字符），建议传 prompt_extend: false 或缩短，避免扩写后偏离原意`)
      }
      if (promptExtend === true || (promptExtend === undefined && model.startsWith('qwen-image-3.0'))) {
        warnings.push('已开启 prompt_extend：模型可能扩写/改写提示词，实际送去生成的文本可能与原文不同；要精确复现请传 prompt_extend: false')
      }
      if (images.some((item) => /^https?:\/\//i.test(item))) {
        warnings.push('公网参考图由 DashScope 服务端拉取，插件无法校验其体积和真实格式；本地路径/data URL 会在上传前校验')
      }
      if (!settings.attachToChat) {
        warnings.push('配置 attachToChat=false：只返回本地路径，不在聊天里显示图片')
      }

      if (dryRun) {
        const output = {
          files: [],
          urls: [],
          images: [],
          model,
          size: sizeInfo?.text || 'auto',
          dimensions: [],
          requestedN,
          receivedN: 0,
          requestId: '',
          failed: [],
          warnings,
          dryRun: true,
          durationMs: 0,
        }
        if (seed !== undefined) output.seed = seed
        return output
      }

      const apiKey = await resolveApiKey(ctx, settings)
      if (!apiKey) {
        throw new Error(
          '未找到 API Key：请把 DASHSCOPE_API_KEY 写进 ~/.dsh/.env（推荐），'
          + '或设为环境变量，或写进 ~/.dsh/.credentials.yaml，或在插件 config.apiKey / 设置页里配置',
        )
      }

      const baseURL = normalizeBaseURL(settings.baseURL || DEFAULTS.baseURL, {
        allowInsecure: settings.allowInsecureBaseURL,
      })
      const budgetReservation = await reserveDailyBudget(settings.maxImagesPerDay, requestedN)
      if (budgetReservation && budgetReservation.previous + requestedN >= budgetReservation.limit) {
        warnings.push(
          `今日图片额度：本次提交后为 ${budgetReservation.previous + requestedN}/${budgetReservation.limit} 张；`
          + '额度按本地日期计数，不含失败重试和 dry-run',
        )
      }

      let result
      try {
        result = await generateImage({
          prompt,
          model,
          baseURL,
          apiKey,
          size: sizeInfo?.text,
          n: requestedN,
          negativePrompt,
          images,
          promptExtend,
          watermark: args.watermark,
          seed,
          signal: exec && exec.signal,
          timeoutMs,
          maxRetries: settings.maxRetries,
          maxImagesPerCall: settings.maxImagesPerCall,
          maxPromptChars: settings.maxPromptChars,
          allowInsecureBaseURL: settings.allowInsecureBaseURL,
        })
      } catch (err) {
        await releaseDailyBudget(budgetReservation).catch(() => {})
        if (err && err.requestId && !String(err.message).includes('request_id=')) {
          err.message = `${err.message}（request_id=${err.requestId}）`
        }
        throw err
      }

      // 先按接口实际返回张数结算，再去下载；即使下载失败，API 已经产生的成本仍然计数。
      try {
        await settleDailyBudget(budgetReservation, result.urls.length)
      } catch (err) {
        warnings.push(`每日额度结算失败：${err instanceof Error ? err.message : String(err)}`)
      }

      const saved = await saveImages(result.urls, dir, settings.prefix, {
        root,
        signal: exec && exec.signal,
        downloadTimeoutMs: settings.downloadTimeoutMs,
        downloadRetries: settings.downloadRetries,
        maxBytes: settings.maxDownloadBytes,
        maxBytesPerImage: settings.maxDownloadBytes,
        allowAnyHost: settings.allowAnyDownloadHost,
        allowInsecure: settings.allowInsecureBaseURL,
        baseURL,
        writeMetadata: settings.writeMetadata,
        metadata: {
          prompt,
          negativePrompt: negativePrompt || undefined,
          model: result.model,
          size: result.size || sizeInfo?.text || 'auto',
          seed,
          promptExtend,
          watermark: args.watermark,
          requestedN,
          receivedN: result.urls.length,
          requestId: result.requestId,
          usage: result.usage,
        },
      })
      warnings.push(...saved.warnings)

      const imagesOut = []
      const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
      if (settings.attachToChat) {
        if (attachments && typeof attachments.saveImage === 'function') {
          for (const item of saved.items) {
            try {
              const ref = await attachments.saveImage({
                data: item.buffer,
                mediaType: item.mediaType,
                name: basename(item.file),
              })
              if (ref && ref.attachmentId) {
                imagesOut.push({
                  attachmentId: ref.attachmentId,
                  mediaType: ref.mediaType || item.mediaType,
                  bytes: ref.bytes ?? item.bytes,
                  width: ref.width ?? item.width,
                  height: ref.height ?? item.height,
                  name: ref.name || basename(item.file),
                })
              }
            } catch (err) {
              warnings.push(`第 ${item.index} 张无法在聊天中预览：${err && err.message ? err.message : String(err)}`)
            }
          }
        } else {
          warnings.push('未找到 attachments 服务，无法在聊天中内联预览；文件已保存到本地')
        }
      }

      const receivedN = result.urls.length
      if (receivedN < requestedN) {
        warnings.push(`请求 ${requestedN} 张，接口只返回 ${receivedN} 张`)
      } else if (receivedN > requestedN) {
        warnings.push(`请求 ${requestedN} 张，接口返回 ${receivedN} 张；以实际下载为准`)
      }

      const output = {
        files: saved.files,
        urls: result.urls,
        images: imagesOut,
        model: result.model,
        size: result.size || sizeInfo?.text || 'auto',
        dimensions: saved.items.map((item) => ({
          file: item.file,
          mediaType: item.mediaType,
          width: item.width,
          height: item.height,
          bytes: item.bytes,
        })),
        requestedN,
        receivedN,
        requestId: result.requestId || '',
        failed: saved.failed.map((item) => `第 ${item.index} 张：${item.error}`),
        warnings,
        dryRun: false,
        durationMs: Date.now() - startedAt,
      }
      const usage = compactUsage(result.usage)
      if (usage !== undefined) output.usage = usage
      if (seed !== undefined) output.seed = seed
      return output
    },
  }

  const historyTool = {
    name: 'list_generated_images',
    description:
      '列出当前工作区里由 qwen-image 保存过的历史图片。只读本地文件，不调用付费接口；'
      + '没有元数据的旧图片不会出现在列表里。',
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    parameters: HISTORY_PARAMETERS,
    output: {
      schema: HISTORY_OUTPUT_SCHEMA,
      render: renderHistory,
    },
    execute: async (rawArgs = {}, exec) => {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      for (const key of Object.keys(args)) {
        if (key !== 'dir' && key !== 'limit') throw new Error(`未知参数：${key}`)
      }
      if (args.dir !== undefined && typeof args.dir !== 'string') {
        throw new Error('dir 必须是字符串')
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
        throw new Error('limit 必须是 1~100 的整数')
      }
      const dir = args.dir === undefined || args.dir.trim() === '' ? settings.dir : args.dir.trim()
      const limit = args.limit === undefined ? 10 : args.limit
      const root = await workspaceRoot(ctx, exec)
      const result = await listGeneratedImages(root, dir, { limit })
      const items = result.items.map((item) => ({
        ...item,
        ...(item.prompt
          ? { prompt: item.prompt.length > 500 ? `${item.prompt.slice(0, 500)}…` : item.prompt }
          : {}),
      }))
      return { ...result, items }
    },
  }

  ctx.effect(() => {
    const disposers = []
    try {
      disposers.push(ctx.tools.register(tool))
      disposers.push(ctx.tools.register(historyTool))
    } catch (err) {
      for (const dispose of [...disposers].reverse()) {
        if (typeof dispose === 'function') dispose()
      }
      throw err
    }
    return () => {
      for (const dispose of [...disposers].reverse()) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }, 'qwen-image: generate_image + list_generated_images')
}