/**
 * i18n 核心:词典合并 + 查表,不依赖 React,可单测、可在非组件代码里用。
 * 词典来自 locales/*.ts 的自动聚合(import.meta.glob),新增命名空间只需
 * 往里丢一个文件,无需在任何 index 里登记。规则见 CONVENTIONS.md。
 */

export type Locale = "zh-CN" | "en-US"
/** system = 跟随系统(navigator.language 判定) */
export type LocalePreference = "system" | Locale

export const LOCALES: Locale[] = ["zh-CN", "en-US"]
export const DEFAULT_LOCALE: Locale = "zh-CN"
export const LOCALE_STORAGE_KEY = "bento.locale"

type Dict = Record<string, string>
export type LocaleBundle = { [L in Locale]?: Dict }

const tables: Record<Locale, Dict> = { "zh-CN": {}, "en-US": {} }

const modules = import.meta.glob<{ default: LocaleBundle }>("./locales/*.ts", { eager: true })
for (const mod of Object.values(modules)) {
  const bundle = mod.default
  for (const locale of LOCALES) {
    const dict = bundle[locale]
    if (!dict) continue
    for (const [key, value] of Object.entries(dict)) {
      if (import.meta.env.DEV && key in tables[locale]) {
        console.warn(`[i18n] duplicate key "${key}" (${locale}), later module wins`)
      }
      tables[locale][key] = value
    }
  }
}

/** 查表:当前 locale → zh-CN 兜底 → 返回 key 本身(dev 下警告)。支持 {name} 插值。 */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let value = tables[locale][key] ?? tables[DEFAULT_LOCALE][key]
  if (value === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key "${key}" (${locale})`)
    return key
  }
  if (vars) {
    value = value.replace(/\{(\w+)\}/g, (raw, name: string) =>
      vars[name] === undefined ? raw : String(vars[name]),
    )
  }
  return value
}

/** 跟随系统:中文环境 zh-CN,其余 en-US */
export function resolveSystemLocale(): Locale {
  const lang = typeof navigator === "undefined" ? "" : navigator.language
  return lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
}

export function resolveLocale(preference: LocalePreference): Locale {
  return preference === "system" ? resolveSystemLocale() : preference
}

/** 未存过偏好时保守回 zh-CN(现有用户都是中文,英文由用户手动切) */
export function loadPreference(): LocalePreference {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (v === "system" || v === "zh-CN" || v === "en-US") return v
  } catch {
    /* localStorage 可能被禁用,静默降级 */
  }
  return DEFAULT_LOCALE
}

export function savePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, preference)
  } catch {
    /* ignore */
  }
}
