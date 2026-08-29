/** 主题状态(L0):当前主题 id 与明暗。持久化在 App 层做,这里只传递。 */

import { createContext, useContext } from "react"

import type { StyleId } from "@/data/styles"

export type Theme = {
  style: StyleId
  dark: boolean
  setStyle: (id: StyleId) => void
  setDark: (v: boolean) => void
}

const ThemeContext = createContext<Theme | null>(null)

export const ThemeProvider = ThemeContext.Provider

export function useTheme(): Theme {
  const v = useContext(ThemeContext)
  if (!v) throw new Error("useTheme 必须在 ThemeProvider 内使用")
  return v
}
