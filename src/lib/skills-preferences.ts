/**
 * 全局 Skills 开关(localStorage 持久化,与 harness-preferences 同构)。
 * 主开关 allowGlobal(默认 true)+ 禁用列表(缺省空 = 新扫描到的 skill 默认启用)。
 * 每次变更即推送 main(skills:set,主进程内存缓存,会话 prepare 时消费)——
 * 快照语义:已在进行的会话不受影响,新会话按最新集合物化。
 */

import { useSyncExternalStore } from "react"

const KEY = "bento.skillsPreferences"

export type SkillsPreferences = {
  allowGlobal: boolean
  disabledSkills: string[]
}

const DEFAULTS: SkillsPreferences = { allowGlobal: true, disabledSkills: [] }

function load(): SkillsPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null")
    if (raw === null || typeof raw !== "object") return { ...DEFAULTS }
    const parsed = raw as Partial<SkillsPreferences>
    return {
      allowGlobal: parsed.allowGlobal !== false,
      disabledSkills: Array.isArray(parsed.disabledSkills)
        ? parsed.disabledSkills.filter((item): item is string => typeof item === "string")
        : [],
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let preferences = load()
let version = 0
const listeners = new Set<() => void>()

/** 推送 main:fire-and-forget,失败静默(下次变更会重推;会话 prepare 前有扫描兜底)。 */
function push() {
  try {
    void window.bento?.setSkillsPreferences(preferences)
  } catch {
    /* 纯 web 模式无 window.bento */
  }
}

function commit(next: SkillsPreferences) {
  preferences = next
  version += 1
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  push()
  for (const listener of listeners) listener()
}

/** 应用启动后主动同步一次(main 侧内存缓存跨窗口/重启即空)。 */
export function syncSkillsPreferences() {
  push()
}

export function getSkillsPreferences(): SkillsPreferences {
  return preferences
}

export function setSkillsAllowGlobal(allowGlobal: boolean) {
  commit({ ...preferences, allowGlobal })
}

export function setSkillEnabled(name: string, enabled: boolean) {
  const disabled = new Set(preferences.disabledSkills)
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  commit({ ...preferences, disabledSkills: [...disabled] })
}

export function useSkillsPreferences(): SkillsPreferences & {
  isSkillEnabled: (name: string) => boolean
} {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version,
  )
  return {
    ...preferences,
    isSkillEnabled: (name) => !preferences.disabledSkills.includes(name),
  }
}
