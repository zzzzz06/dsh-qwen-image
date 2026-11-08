/**
 * 不启动 DSH、不花钱，验证插件入口能加载、能注册、Config/参数/输出 schema 正常。
 *   node selftest.mjs
 * （真正出图用 smoke.mjs / smoke.ps1；完整本地回归用 regression.mjs。）
 */
const mod = await import('./index.mjs')
const core = await import('./core.mjs')

if (!mod.Config) throw new Error('缺少 Config（设置页/配置校验会失效）')
const validated = mod.Config['~standard'].validate({ model: 'qwen-image-3.0' })
if (validated.issues) throw new Error(`Config 默认值校验失败：${JSON.stringify(validated.issues)}`)
if (validated.value.dir !== 'generated') throw new Error('Config 没有填默认 dir')
const serialized = mod.Config.toJSON()
if (typeof serialized.uid !== 'number' || !serialized.refs) throw new Error('Config.toJSON 不是 schemastery 序列化')

const registered = []
const ctx = {
  tools: {
    register(def) {
      registered.push(def)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

mod.apply(ctx, { model: 'qwen-image-3.0' })
const tool = registered[0]
const history = registered[1]

if (!tool) throw new Error('插件没有注册任何工具')
if (tool.name !== 'generate_image') throw new Error(`工具名不对：${tool.name}`)
if (!history || history.name !== 'list_generated_images') throw new Error('缺少历史列表工具')
if (!history.output?.schema?.properties?.items) throw new Error('历史列表 output schema 缺少 items')
if (tool.parameters.additionalProperties !== false) throw new Error('参数应禁止未知字段')
if (!tool.parameters.properties.dry_run) throw new Error('缺少 dry_run 参数')
if (!tool.parameters.properties.seed) throw new Error('缺少 seed 参数')
if (!tool.output?.schema?.properties?.images) throw new Error('输出 schema 缺少 images')
if (typeof tool.output?.render !== 'function') throw new Error('缺少 output.render')
if (typeof tool.timeoutMs !== 'number' || tool.timeoutMs < 300000) throw new Error('缺少合理的 timeoutMs')

const preview = tool.output.render({}, {
  files: ['C:/work/generated/qwen-20260101-120000-ab12cd-1.png'],
  urls: ['https://example.com/a.png'],
  images: [],
  dimensions: [{ file: 'C:/work/generated/qwen-20260101-120000-ab12cd-1.png', width: 1024, height: 1024 }],
  model: 'qwen-image-3.0',
  size: '1024*1024',
  requestedN: 1,
  receivedN: 1,
  failed: [],
  warnings: [],
  dryRun: false,
})

const dry = tool.output.render({}, {
  files: [],
  urls: [],
  images: [],
  model: 'qwen-image-3.0',
  size: '1024*1024',
  requestedN: 2,
  failed: [],
  warnings: ['示例警告'],
  dryRun: true,
})

if (core.parseSize('1024x1536').text !== '1024*1536') throw new Error('size 规范化失败')
if (!core.sniffImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'))) {
  throw new Error('PNG 魔数识别失败')
}

console.log('plugin name   :', mod.name)
console.log('inject        :', mod.inject)
console.log('Config        :', 'schema ok, fields =', Object.keys(mod.Config.dict).length)
console.log('registered    :', registered.map((t) => t.name).join(','))
console.log('timeoutMs     :', tool.timeoutMs)
console.log('render        :', JSON.stringify(preview))
console.log('dry-run       :', JSON.stringify(dry))
console.log('SELFTEST OK')