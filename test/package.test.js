import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { PLUGIN_VERSION } from '../deepseek-official.js'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('发布清单包含 Host bundle、Client 页面与版本声明', async () => {
  const manifest = JSON.parse(await read('package.json'))

  assert.equal(manifest.name, 'dsh-billing-statistics')
  assert.equal(manifest.version, PLUGIN_VERSION)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.client?.immediately, true)
  assert.equal(manifest.engines?.dsh, '>=0.2.1-rc.5 <0.3.0')
  assert.equal(manifest.engines?.node, '>=20')
  assert.ok(manifest.files.includes('PLUGIN-DECLARATION.md'))
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(!manifest.files.some((entry) => /(^|\/)(test|release|node_modules|\.git)(\/|$)/.test(entry)))
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
})

test('发布声明覆盖兼容范围、权限边界与已知局限', async () => {
  const declaration = await read('PLUGIN-DECLARATION.md')

  assert.match(declaration, /1\.13\.0/)
  assert.match(declaration, /dsh-billing-statistics/)
  assert.match(declaration, /命名迁移/)
  assert.match(declaration, />=0\.2\.1-rc\.5 <0\.3\.0/)
  assert.match(declaration, /不保存账号/)
  assert.match(declaration, /官方账单/)
  assert.match(declaration, /已知局限/)
  assert.match(declaration, /只统计经过 DSH `llm\/stream` 的调用/)
  assert.match(declaration, /PDF.*中文字体/s)
  assert.match(declaration, /SHA-256/)
})

test('发布声明的版本与包版本保持一致', async () => {
  const manifest = JSON.parse(await read('package.json'))
  const declaration = await read('PLUGIN-DECLARATION.md')

  assert.match(declaration, new RegExp(`版本 \\| \`${manifest.version.replaceAll('.', '\\.')}\``))
  assert.equal(manifest.private, false)
  assert.equal(manifest.license, 'MIT')
})
