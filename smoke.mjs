/**
 * 不装 DSH 也能先验证 API 是否通：
 *   node smoke.mjs "一只戴宇航头盔的橘猫，扁平插画风"
 * Key 从 DASHSCOPE_API_KEY 环境变量、~/.dsh/.env 或 ~/.dsh/.credentials.yaml 读。
 */
import { fileURLToPath } from 'node:url'
import { generateImage, resolveKey, saveImages } from './core.mjs'

const prompt =
  process.argv.slice(2).join(' ').trim() || '一只戴宇航头盔的橘猫，扁平插画风，暖色背景'

const apiKey = resolveKey({})
if (!apiKey) {
  console.error('缺少 API Key：设置 DASHSCOPE_API_KEY，或写进 ~/.dsh/.env')
  process.exit(1)
}

console.log('prompt =', prompt)
console.log('model  = qwen-image-3.0')

const result = await generateImage({ prompt, apiKey })
console.log('urls   =', result.urls)
if (result.usage) console.log('usage  =', JSON.stringify(result.usage))

const dir = fileURLToPath(new URL('./generated', import.meta.url))
const { files, failed } = await saveImages(result.urls, dir)
console.log('files  =', files)
if (failed.length) console.log('failed =', failed)
console.log('OK')