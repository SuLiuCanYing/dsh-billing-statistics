/**
 * 轻量 Schemastery 兼容加载。
 *
 * 只做一件事：用动态 import 探测宿主是否提供了可用的 schemastery。
 * - 正常时返回 Schema，Config 照常生成完整 schema；
 * - 缺失、导出形态变化或缺少本插件用到的方法时返回 null，调用方省略 Config，
 *   插件仍按 config 字段的默认值运行，只是不再有配置校验/配置页 schema。
 *
 * 不复制、不内置 schemastery 本体，避免维护一份会漂移的 schema 实现。
 */

const REQUIRED_METHODS = ['object', 'string', 'number', 'boolean', 'array', 'dict']

export async function loadSchema() {
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    const Schema = loaded?.default ?? loaded
    if (typeof Schema !== 'function') throw new Error('导出不是构造函数')
    for (const method of REQUIRED_METHODS) {
      if (typeof Schema[method] !== 'function') throw new Error(`缺少 Schema.${method}`)
    }
    return { Schema, error: null }
  } catch (error) {
    return { Schema: null, error }
  }
}
