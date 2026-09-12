/**
 * app 级通用词典(stores 与提示)。命名空间:app
 * 非组件 store(live-store / apps-store / layout-store 等)产出的
 * 用户可见错误文案与面板标题在这里。
 */
import type { LocaleBundle } from "../core"

const bundle: LocaleBundle = {
  "zh-CN": {
    "app.desktopUnavailable": "桌面模式不可用",
    "app.desktopRequired": "需要桌面版",
    "app.loadAppsFailed": "读取 Apps 失败",
    "app.requestFailed": "请求失败:{error}",
    "app.appsPanelTitle": "应用",
    "app.defaultProfileName": "我",
  },
  "en-US": {
    "app.desktopUnavailable": "Desktop mode unavailable",
    "app.desktopRequired": "Requires the desktop app",
    "app.loadAppsFailed": "Failed to load apps",
    "app.requestFailed": "Request failed: {error}",
    "app.appsPanelTitle": "Apps",
    "app.defaultProfileName": "Me",
  },
}

export default bundle
