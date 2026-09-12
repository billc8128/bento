/**
 * View 注册表(L2)。内置 view 与未来插件 view 走同一条注册路径。
 * 契约见 ARCHITECTURE.md §4:view 组件不接受任意 props,共享状态经 context。
 */

import type { ComponentType } from "react"

export type ViewDefinition = {
  /** 全局唯一;插件贡献的 view 必须带插件 id 前缀 `<pluginId>.<viewId>` */
  id: string
  title: string
  component: ComponentType
}

const registry = new Map<string, ViewDefinition>()

/** 重复注册按覆盖处理(HMR 会重跑注册模块),同 id 后注册者生效 */
export function registerView(def: ViewDefinition) {
  registry.set(def.id, def)
}

export function getView(id: string): ViewDefinition {
  const v = registry.get(id)
  if (!v) throw new Error(`view 未注册: ${id}`)
  return v
}

export function listViews(): ViewDefinition[] {
  return [...registry.values()]
}
