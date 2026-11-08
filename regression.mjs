/**
 * 本地回归测试：不访问 DashScope、不花钱。
 *   node regression.mjs
 *
 * 覆盖：配置校验、size/env 解析、目录边界、参考图校验、下载格式/扩展名/重试/
 * 旁车 JSON、生图请求体、usage/request_id、附件内容块、dry-run 和参数拒绝。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Config,
  resolveSettings,
} from './config.mjs'
import {
  fetchImage,
  generateImage,
  listGeneratedImages,
  parseDotenv,
  parseSize,
  prepareImageSources,
  prepareOutputDir,
  releaseDailyBudget,
  reserveDailyBudget,
  resolveOutputDir,
  saveImages,
  settleDailyBudget,
  sniffImage,
} from './core.mjs'
import { apply } from './index.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
)

const root = await mkdtemp(join(tmpdir(), 'qwen-regression-'))
const outside = await mkdtemp(join(tmpdir(), 'qwen-outside-'))
await mkdir(join(root, 'refs'), { recursive: true })
await writeFile(join(root, 'refs', 'ok.png'), PNG)
await writeFile(join(outside, 'secret.png'), PNG)
await writeFile(join(root, 'not-image.txt'), 'hello')

let generationRequests = 0
let throttledOnce = false
let flakyDownloads = 0
let lastGenerationBody
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'POST' && url.pathname.endsWith('/multimodal-generation/generation')) {
    generationRequests += 1
    let raw = ''
    for await (const chunk of req) raw += chunk
    lastGenerationBody = JSON.parse(raw)
    if (!throttledOnce) {
      throttledOnce = true
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
      res.end(JSON.stringify({ code: 'Throttling', message: 'slow down' }))
      return
    }
    const base = `http://127.0.0.1:${server.address().port}`
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'header-rid' })
    res.end(JSON.stringify({
      request_id: 'req-1',
      usage: { image_count: 3, total_tokens: 10 },
      output: {
        choices: [{
          message: {
            content: [
              { image: `${base}/img/a.png` },
              { image: `${base}/img/missing.png` },
              { image: `${base}/img/b.png` },
            ],
          },
        }],
      },
    }))
    return
  }
  if (url.pathname === '/img/redir.png') {
    res.writeHead(302, { location: '/img/a.png' })
    res.end()
    return
  }
  if (url.pathname === '/img/redir-bad.png') {
    res.writeHead(302, { location: 'http://example.com/a.png' })
    res.end()
    return
  }
  if (url.pathname === '/img/a.png' || url.pathname === '/img/b.png') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(PNG)
    return
  }
  if (url.pathname === '/img/flaky.png') {
    flakyDownloads += 1
    if (flakyDownloads === 1) {
      res.writeHead(503, { 'retry-after': '0' })
      res.end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const base = `http://127.0.0.1:${server.address().port}`

function check(name, fn) {
  try {
    fn()
    console.log(`ok  ${name}`)
  } catch (err) {
    console.error(`FAIL ${name}`)
    throw err
  }
}

/** DSH 对工具输出做 lossless JSON 校验；undefined 字段会让真实调用直接失败。 */
function assertLossless(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
}

try {
  // ---- 配置 ----
  const defaults = resolveSettings({})
  check('Config 填默认值', () => {
    assert.equal(defaults.model, 'qwen-image-3.0')
    assert.equal(defaults.dir, 'generated')
    assert.equal(defaults.maxImagesPerCall, 6)
  })
  check('Config 拒绝未知字段', () => {
    assert.throws(() => resolveSettings({ nope: 1 }), /未知配置项/)
  })
  check('Config 拒绝未知模型', () => {
    assert.throws(() => resolveSettings({ model: 'gpt-image-1' }), /不支持的模型/)
  })
  check('Config 拒绝外部 http baseURL', () => {
    assert.throws(() => resolveSettings({ baseURL: 'http://example.com' }), /HTTPS/)
  })
  check('Config 拒绝 baseURL 查询参数', () => {
    assert.throws(() => resolveSettings({ baseURL: 'https://dashscope.aliyuncs.com?x=1' }), /查询参数/)
  })
  check('Config 允许本机 http baseURL', () => {
    const value = resolveSettings({ baseURL: 'http://127.0.0.1:1234' })
    assert.equal(value.baseURL, 'http://127.0.0.1:1234')
  })
  check('Config.toJSON 是 schemastery 序列化', () => {
    const json = Config.toJSON()
    assert.equal(typeof json.uid, 'number')
    assert.equal(typeof json.refs, 'object')
    const root = json.refs[String(json.uid)]
    assert.equal(root.type, 'object')
    assert.ok(root.dict.apiKey)
    assert.equal(json.refs[String(root.dict.apiKey)].meta.role, 'secret')
    assert.equal(json.refs[String(root.dict.attachToChat)].type, 'boolean')
  })

  // ---- 解析 ----
  check('size 规范化', () => {
    assert.equal(parseSize('1024x1536').text, '1024*1536')
    assert.equal(parseSize('512 * 512').text, '512*512')
    assert.equal(parseSize('auto'), undefined)
  })
  check('size 边界', () => {
    assert.throws(() => parseSize('256*256'), /单边/)
    assert.throws(() => parseSize('256*4096'), /单边/)
    assert.throws(() => parseSize('4096*4096'), /单边/)
    assert.throws(() => parseSize('abc'), /格式/)
  })
  check('dotenv 引号/注释/重复键', () => {
    const parsed = parseDotenv([
      'export A=1',
      'B="x # y" # comment',
      'C=z#q',
      'D=1',
      'D=2',
    ].join('\n'))
    assert.equal(parsed.A, '1')
    assert.equal(parsed.B, 'x # y')
    assert.equal(parsed.C, 'z#q')
    assert.equal(parsed.D, '2')
  })

  // ---- 目录/参考图 ----
  check('目录拒绝 ..', () => {
    assert.throws(() => resolveOutputDir(root, '../escape'), /工作区内/)
  })
  check('目录拒绝外部绝对路径', () => {
    assert.throws(() => resolveOutputDir(root, outside), /工作区内/)
  })
  const prepared = await prepareOutputDir(root, 'out/sub')
  check('prepareOutputDir 创建可写目录', () => {
    assert.ok(existsSync(prepared))
  })
  const checkOnlyDir = await prepareOutputDir(root, 'out/check-only', { checkOnly: true })
  check('prepareOutputDir checkOnly 不建目录', () => {
    assert.ok(!existsSync(checkOnlyDir))
  })
  check('参考图相对路径物化为 data URL', async () => {
    const sources = await prepareImageSources(['refs/ok.png'], { root })
    assert.match(sources[0], /^data:image\/png;base64,/)
  })
  await assert.rejects(
    () => prepareImageSources([join(outside, 'secret.png')], { root }),
    /工作区内/,
  )
  await assert.rejects(
    () => prepareImageSources(['not-image.txt'], { root }),
    /不是 PNG\/JPEG/,
  )
  await assert.rejects(
    () => prepareImageSources(['refs/ok.png', 'refs/ok.png', 'refs/ok.png', 'refs/ok.png'], { root }),
    /最多 3 张/,
  )

  // ---- 下载 ----
  const download = await fetchImage(`${base}/img/a.png`, {
    allowAnyHost: true,
    allowInsecure: true,
    downloadRetries: 0,
  })
  check('下载按 magic 识别 PNG（忽略 text/plain）', () => {
    assert.equal(download.mediaType, 'image/png')
    assert.equal(download.ext, '.png')
    assert.equal(download.width, 1)
  })
  const flaky = await fetchImage(`${base}/img/flaky.png`, {
    allowAnyHost: true,
    allowInsecure: true,
    downloadRetries: 1,
  })
  check('下载 503 后重试成功', () => {
    assert.equal(flaky.mediaType, 'image/png')
    assert.equal(flakyDownloads, 2)
  })
  const redirected = await fetchImage(`${base}/img/redir.png`, {
    allowAnyHost: true,
    allowInsecure: true,
    downloadRetries: 0,
  })
  check('信任域内重定向可跟随', () => {
    assert.equal(redirected.mediaType, 'image/png')
  })
  await assert.rejects(
    () => fetchImage(`${base}/img/redir-bad.png`, {
      allowAnyHost: true,
      allowInsecure: false,
      downloadRetries: 0,
    }),
    /不是 HTTPS/,
  )
  await assert.rejects(
    () => fetchImage('http://example.com/a.png', { allowAnyHost: false }),
    /不是 HTTPS/,
  )

  const saved = await saveImages(
    [`${base}/img/a.png`, `${base}/img/missing.png`, `${base}/img/b.png`],
    join(root, 'saved'),
    'test',
    {
      allowAnyHost: true,
      allowInsecure: true,
      downloadRetries: 0,
      metadata: { prompt: 'a test image', model: 'qwen-image-3.0', seed: 42 },
    },
  )
  check('部分失败保留成功文件', () => {
    assert.equal(saved.files.length, 2)
    assert.equal(saved.failed.length, 1)
    assert.match(saved.files[0], /test-\d{8}-\d{6}-\d{3}-[0-9a-f]{6}-1\.png$/)
  })
  check('旁车 JSON 写入', async () => {
    const meta = JSON.parse(await readFile(saved.items[0].metadataFile, 'utf8'))
    assert.equal(meta.prompt, 'a test image')
    assert.equal(meta.sha256.length, 64)
    assert.equal(meta.width, 1)
  })
  const history = await listGeneratedImages(root, 'saved', { limit: 10 })
  check('历史列表读取旁车 JSON', () => {
    assert.equal(history.total, 2)
    assert.equal(history.items.length, 2)
    assert.equal(history.items[0].prompt, 'a test image')
    assert.match(history.items[0].name, /^test-.*\.png$/)
    assert.equal(history.truncated, false)
  })

  const budgetFile = join(root, 'budget', 'usage.json')
  const reservation = await reserveDailyBudget(5, 2, { file: budgetFile, date: '2026-01-01' })
  await assert.rejects(
    () => reserveDailyBudget(5, 4, { file: budgetFile, date: '2026-01-01' }),
    /额度不足/,
  )
  await settleDailyBudget(reservation, 3)
  const afterSettle = JSON.parse(await readFile(budgetFile, 'utf8'))
  const extra = await reserveDailyBudget(5, 1, { file: budgetFile, date: '2026-01-01' })
  await releaseDailyBudget(extra)
  const afterRelease = JSON.parse(await readFile(budgetFile, 'utf8'))
  check('每日图片额度预占/结算/释放', () => {
    assert.equal(afterSettle.images, 3)
    assert.equal(afterRelease.images, 3)
  })
  await assert.rejects(
    () => saveImages([`${base}/img/missing.png`], join(root, 'all-fail'), 'x', {
      allowAnyHost: true,
      allowInsecure: true,
    }),
    /所有图片下载失败/,
  )

  // ---- 生图 ----
  throttledOnce = false
  const generated = await generateImage({
    prompt: '一只猫',
    apiKey: 'sk-test',
    baseURL: base,
    size: '1024*1024',
    n: 3,
    seed: 7,
    negativePrompt: '低质量',
    timeoutMs: 5000,
    maxRetries: 1,
    allowInsecureBaseURL: true,
  })
  check('生图请求体/重试/usage/request_id', () => {
    assert.equal(generationRequests, 2)
    assert.equal(generated.urls.length, 3)
    assert.equal(generated.usage.image_count, 3)
    assert.equal(generated.requestId, 'req-1')
    assert.equal(lastGenerationBody.parameters.n, 3)
    assert.equal(lastGenerationBody.parameters.size, '1024*1024')
    assert.equal(lastGenerationBody.parameters.seed, 7)
    assert.equal(lastGenerationBody.parameters.negative_prompt, '低质量')
  })

  // ---- 工具端到端 ----
  const attachments = []
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool); return () => {} } },
    effect(fn) { return fn() },
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage({ data, mediaType, name: fileName }) {
            attachments.push({ data, mediaType, name: fileName })
            return { attachmentId: `att-${attachments.length}` }
          },
        }
      }
      return undefined
    },
  }
  const settings = {
    baseURL: base,
    allowInsecureBaseURL: true,
    allowAnyDownloadHost: true,
    maxRetries: 0,
    downloadRetries: 0,
    dir: 'tool-out',
    prefix: 'tool',
  }
  apply(ctx, settings)
  const tool = registered[0]
  const historyTool = registered[1]
  const exec = { agent: { session: { header: { cwd: root } } } }

  const dry = await tool.execute({ prompt: 'dry cat', dry_run: true }, exec)
  check('dry-run 不调用接口、不建目录', () => {
    assert.equal(dry.dryRun, true)
    assert.equal(dry.files.length, 0)
    assertLossless(dry)
    const before = generationRequests
    assert.equal(before, 2)
    assert.equal(existsSync(join(root, 'tool-out')), false)
  })

  const output = await tool.execute({
    prompt: 'cat',
    n: 3,
    image: 'refs/ok.png',
  }, exec)
  check('工具端到端：部分下载失败 + 附件内容块', () => {
    assert.equal(output.files.length, 2)
    assert.equal(output.failed.length, 1)
    assert.equal(output.images.length, 2)
    assert.equal(output.images[0].attachmentId, 'att-1')
    assert.equal(attachments.length, 2)
    assert.match(output.requestId, /req-1/)
    assert.equal(output.usage.image_count, 3)
    assertLossless(output)
  })
  const blocks = tool.output.render({}, output)
  check('render 返回 text + image 块', () => {
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks.filter((block) => block.type === 'image').length, 2)
  })

  const listed = await historyTool.execute({}, exec)
  check('历史工具列出刚生成的图', () => {
    assert.equal(listed.total, 2)
    assert.equal(listed.items.length, 2)
    assert.equal(listed.items[0].prompt, 'cat')
    assertLossless(listed)
  })

  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'budget-home')
  const budgetRegistered = []
  const budgetCtx = {
    ...ctx,
    tools: { register(budgetTool) { budgetRegistered.push(budgetTool); return () => {} } },
  }
  try {
    apply(budgetCtx, {
      ...settings,
      apiKey: 'sk-test',
      maxImagesPerDay: 1,
      dir: 'budget-out',
    })
    const beforeBudget = generationRequests
    await assert.rejects(
      () => budgetRegistered[0].execute({ prompt: 'budget cat', n: 2 }, exec),
      /额度不足/,
    )
    check('每日额度在调用接口前拦截', () => {
      assert.equal(generationRequests, beforeBudget)
    })
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }

  await assert.rejects(
    () => tool.execute({ prompt: 'x', bad: 1 }, exec),
    /未知参数/,
  )
  await assert.rejects(
    () => tool.execute({ prompt: 'x', n: 7 }, exec),
    /n 必须是/,
  )
  await assert.rejects(
    () => tool.execute({ prompt: 'x', size: '256*4096' }, exec),
    /单边/,
  )
  await assert.rejects(
    () => tool.execute({ prompt: 'x', model: 'qwen-image-2.1-pro', negative_prompt: 'bad' }, exec),
    /不支持 negative_prompt/,
  )
  await assert.rejects(
    () => tool.execute({ prompt: 'x', image: join(outside, 'secret.png') }, exec),
    /工作区内/,
  )
  await assert.rejects(
    () => tool.execute({ prompt: 'x', dir: '../escape' }, exec),
    /工作区内/,
  )

  console.log('REGRESSION OK')
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise))
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}