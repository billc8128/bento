/**
 * React 集成:I18nProvider 挂 app 根部,组件用 useT() 取 t / locale。
 * 非 React 代码(lib、store)直接用 core 里的 translate(locale, key)。
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

import {
  loadPreference,
  resolveLocale,
  savePreference,
  translate,
  type Locale,
  type LocalePreference,
} from "./core"

export {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_STORAGE_KEY,
  loadPreference,
  resolveLocale,
  resolveSystemLocale,
  savePreference,
  translate,
} from "./core"
export type { Locale, LocaleBundle, LocalePreference } from "./core"

export type TFn = (key: string, vars?: Record<string, string | number>) => string

type I18nContextValue = {
  /** 当前生效语言(已按 preference 解析) */
  locale: Locale
  /** 用户偏好:system | zh-CN | en-US */
  preference: LocalePreference
  setPreference: (preference: LocalePreference) => void
  t: TFn
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(loadPreference)
  const locale = resolveLocale(preference)

  const setPreference = useCallback((next: LocalePreference) => {
    savePreference(next)
    setPreferenceState(next)
  }, [])

  const t = useCallback<TFn>((key, vars) => translate(locale, key, vars), [locale])

  const value = useMemo<I18nContextValue>(
    () => ({ locale, preference, setPreference, t }),
    [locale, preference, setPreference, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useT(): { t: TFn; locale: Locale } {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useT must be used within <I18nProvider>")
  return { t: ctx.t, locale: ctx.locale }
}

/** 设置页语言选项用:需要 preference 与 setter 时使用 */
export function useLocalePreference(): {
  preference: LocalePreference
  setPreference: (p: LocalePreference) => void
} {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useLocalePreference must be used within <I18nProvider>")
  return { preference: ctx.preference, setPreference: ctx.setPreference }
}
