/**
 * 本地个人资料:显示名 + 头像(dataURL)。纯本地装饰,没有账户系统;
 * localStorage 持久化,侧栏头像菜单与设置页共用。
 */

import { useSyncExternalStore } from "react"

export type Profile = {
  name: string
  /** 头像图片(128px dataURL);空 = 名字首字占位 */
  avatar: string | null
}

const KEY = "bento.profile"
const DEFAULT_PROFILE: Profile = { name: "我", avatar: null }

function load(): Profile {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "")
    if (raw && typeof raw === "object") {
      const p = raw as Partial<Profile>
      return {
        name: typeof p.name === "string" && p.name.trim() ? p.name : DEFAULT_PROFILE.name,
        avatar: typeof p.avatar === "string" ? p.avatar : null,
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PROFILE
}

let profile = load()
const listeners = new Set<() => void>()

export function setProfile(next: Partial<Profile>) {
  profile = {
    name: next.name !== undefined && next.name.trim() ? next.name : profile.name,
    avatar: next.avatar !== undefined ? next.avatar : profile.avatar,
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(profile))
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener()
}

/** 名字首字符做头像占位(CJK 取第一个字,拉丁取首字母大写) */
export function profileInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase()
}

/** 首次启动(用户从未设置过资料)时用系统用户名做默认显示名。
 * 不写 localStorage——显式改名前的每次启动都跟随系统账户 */
export function initProfileDefault(): void {
  if (typeof window === "undefined" || localStorage.getItem(KEY)) return
  void window.bento?.systemUsername?.().then((username) => {
    if (!username || localStorage.getItem(KEY)) return
    profile = { ...profile, name: username }
    for (const listener of listeners) listener()
  })
}

export function useProfile(): Profile {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => profile,
  )
}
