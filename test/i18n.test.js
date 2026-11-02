import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'client.js'), 'utf8')

/** 取出某一语言的字典块（client.js 里 `      zh: {` … `      },`）。 */
function block(language) {
  const marker = `\n      ${language}: {`
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `找不到 ${language} 字典`)
  const end = source.indexOf('\n      },', start)
  assert.ok(end > start, `${language} 字典没有结束标记`)
  return source.slice(start, end)
}

function keysOf(text) {
  return new Set([...text.matchAll(/^\s{8}([A-Za-z][\w]*):/gm)].map((match) => match[1]))
}

const zhKeys = keysOf(block('zh'))
const enKeys = keysOf(block('en'))

test('中英文案键一一对应', () => {
  assert.ok(zhKeys.size > 100, `中文文案只有 ${zhKeys.size} 条，疑似解析失败`)
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key))
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key))
  assert.deepEqual(missingInEn, [], '英文缺少这些键: ' + missingInEn.join(', '))
  assert.deepEqual(missingInZh, [], '中文缺少这些键: ' + missingInZh.join(', '))
})

test('数字格式化跟随界面语言，不再写死 zh-CN', () => {
  assert.equal(/toLocaleString\('zh-CN'/.test(source), false)
  assert.match(source, /suffix: 'B'/, '英文紧凑单位应为 K/M/B')
  assert.match(source, /NUMBER_LOCALES\s*=/, '缺少随语言切换的数字区域设置')
  assert.match(source, /formatInteger\(value, localeTag/, 'formatInteger 应接受语言参数')
})
