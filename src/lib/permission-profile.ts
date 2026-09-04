/** 默认权限档位偏好:新建会话时继承,localStorage 持久化(设置 → 运行环境 可改)。 */

import { useSyncExternalStore } from "react"

import { DEFAULT_PERMISSION_PROFILE, PERMISSION_PROFILES, type PermissionProfile } from "@/core/permission"

const STORAGE_KEY = "bento.default-permission-profile"
let cache: PermissionProfile | null = null
const listeners = new Set<() => void>()

function load(): PermissionProfile {
  if (cache) return cache
  const saved = localStorage.getItem(STORAGE_KEY)
  cache = PERMISSION_PROFILES.some((p) => p.id === saved)
    ? (saved as PermissionProfile)
    : DEFAULT_PERMISSION_PROFILE
  return cache
}

export function setDefaultPermissionProfile(next: PermissionProfile) {
  cache = next
  localStorage.setItem(STORAGE_KEY, next)
  for (const listener of listeners) listener()
}

export function useDefaultPermissionProfile(): PermissionProfile {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
  )
}
