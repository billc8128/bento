import { createContext, useContext } from "react"

import { DEFAULT_STYLE, getStyle, type StyleTraits } from "@/data/styles"

/** 当前主题的结构特征。组件读它来决定布局形态,而不是各自写死。 */
const TraitsContext = createContext<StyleTraits>(getStyle(DEFAULT_STYLE).traits)

export const TraitsProvider = TraitsContext.Provider

export function useTraits(): StyleTraits {
  return useContext(TraitsContext)
}
