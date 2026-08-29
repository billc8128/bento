/** 基线内置 view 注册。插件贡献的 view 未来走完全相同的路径(dogfooding)。 */

import { AppSidebar } from "@/components/AppSidebar"
import { ChatPane } from "@/views/ChatPane"
import { registerView } from "@/views/registry"

registerView({ id: "core.sessions", title: "会话", component: AppSidebar })
registerView({ id: "core.chat", title: "对话", component: ChatPane })
