/** 基线内置 view 注册。插件贡献的 view 未来走完全相同的路径(dogfooding)。 */

import { AppSidebar } from "@/components/AppSidebar"
import { loadPreference, resolveLocale, translate } from "@/lib/i18n"
import { AppsPane } from "@/views/AppsPane"
import { ChatPane } from "@/views/ChatPane"
import { registerView } from "@/views/registry"

// 模块级注册、无 React 上下文:按启动时的语言偏好取一次翻译
const t = (key: string) => translate(resolveLocale(loadPreference()), key)

registerView({ id: "core.sessions", title: t("workspace.sessionsView"), component: AppSidebar })
registerView({ id: "core.chat", title: t("workspace.chatView"), component: ChatPane })
registerView({ id: "core.apps", title: t("workspace.apps"), component: AppsPane })
