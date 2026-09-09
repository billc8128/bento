/**
 * 选择器与工作区词典。命名空间:workspace
 * 覆盖 RuntimePicker / ProjectPicker / PromptRail / DockWorkspace / AppsPane /
 * 内置 view 标题 / workspace 面板(文件树、浏览器、终端、工具面板)。
 */
import type { LocaleBundle } from "../core"

const bundle: LocaleBundle = {
  "zh-CN": {
    // RuntimePicker
    "workspace.runtimeConfig": "运行配置",
    "workspace.selectModel": "选择模型",
    "workspace.model": "模型",
    "workspace.effort": "推理强度",
    "workspace.permission": "权限",
    "workspace.permissionManagedByTrae": "由 TRAE 管理",
    "workspace.permissionNoteTrae": "权限由 TRAE 自身的沙箱与审批策略管理，Bento 暂不支持设置或切换。",
    "workspace.permissionNotePi": "该 Harness 暂不支持权限档位(行为等同放行)",
    "workspace.permissionNoteCodex": "Codex 换档需新建会话生效",
    "workspace.permissionNoteApprox": "工具集近似,非硬边界;受限/标准档无 shell(Bash 类),需要请选放行",
    "workspace.searchModels": "搜索模型",
    "workspace.noMatchingModels": "没有匹配的模型",
    "workspace.noConnectedProviders": "没有已连接供应商提供可选模型。",
    "workspace.importLocalConfig": "从本机配置导入({sources})…",
    "workspace.addProvider": "添加供应商…",
    "workspace.goToProviderSettings": "前往供应商设置…",

    // ProjectPicker
    "workspace.createProjectFailed": "项目创建失败",
    "workspace.createProject": "创建项目",
    "workspace.createProjectDesc": "输入项目名称并选择新项目所在的源文件夹。",
    "workspace.projectName": "项目名称",
    "workspace.sourceFolder": "源文件夹",
    "workspace.dropToChooseFolder": "松手选择这个文件夹",
    "workspace.clickOrDropFolder": "点击选择,或把文件夹拖进来",
    "workspace.cancel": "取消",
    "workspace.creating": "正在创建…",
    "workspace.selectProject": "选择项目",
    "workspace.clearProject": "清除项目",
    "workspace.clearProjectNamed": "清除项目 {name}",
    "workspace.searchProjects": "搜索项目",
    "workspace.noMatchingProjects": "没有匹配的最近项目",
    "workspace.openFolder": "打开文件夹…",
    "workspace.newProject": "新建项目",

    // PromptRail
    "workspace.jumpToPrompt": "跳转到:{text}",
    "workspace.promptCount": "本会话 {count} 条指令",

    // DockWorkspace / 内置 view 标题
    "workspace.unknownView": "未知视图 {viewId}",
    "workspace.apps": "应用",
    "workspace.sessionsView": "会话",
    "workspace.chatView": "对话",

    // WorkspaceToolsPanel
    "workspace.terminal": "终端",
    "workspace.files": "文件",
    "workspace.browser": "浏览器",
    "workspace.newTab": "新标签页",
    "workspace.terminalN": "终端 {index}",
    "workspace.filesN": "文件 {index}",
    "workspace.newTabN": "新标签页 {index}",
    "workspace.workspaceTabs": "工作区标签",
    "workspace.closeTab": "关闭 {title}",
    "workspace.allWorkspaceTabs": "所有工作区标签",
    "workspace.newWorkspaceTab": "新建工作区标签",
    "workspace.closeToolsPanel": "关闭工具面板",
    "workspace.openWorkspaceTool": "打开工作区工具",
    "workspace.openingTool": "正在打开工具…",

    // FilesWorkspacePane
    "workspace.readingFile": "正在读取文件…",
    "workspace.previewFailed": "无法预览文件",
    "workspace.fileTruncated": "文件较长,仅显示前 2000 行。",
    "workspace.unsupportedFormat": "暂不支持此文件格式",
    "workspace.filePreview": "文件预览",
    "workspace.copyFileContents": "复制文件内容",
    "workspace.readOnlyPreview": "只读预览",
    "workspace.filesAndPreview": "文件与预览",
    "workspace.fileTree": "文件树",
    "workspace.allFileTabs": "所有文件标签",
    "workspace.filterExpandedFiles": "筛选已展开文件",
    "workspace.filterFiles": "筛选文件",
    "workspace.refreshFileTree": "刷新文件树",
    "workspace.readOnlyAutoRefresh": "只读 · 自动刷新",
    "workspace.readOnly": "只读",
    "workspace.loadingProject": "正在读取项目…",
    "workspace.openProjectFailed": "无法打开项目",
    "workspace.emptyDirectory": "目录为空",
    "workspace.loading": "读取中…",

    // BrowserWorkspacePane
    "workspace.invalidUrl": "请输入有效的 HTTP(S) URL",
    "workspace.back": "后退",
    "workspace.forward": "前进",
    "workspace.reload": "刷新",
    "workspace.urlLabel": "网址",
    "workspace.enterUrl": "输入 URL",
    "workspace.openInSystemBrowser": "在系统浏览器打开",
    "workspace.startBrowsing": "开始浏览",
    "workspace.enterUrlHint": "输入 URL 以打开页面",
    "workspace.pageFailed": "页面无法打开",
    "workspace.retry": "重试",
    "workspace.demoBrowserNote": "正式桌面版由隔离的 WebContentsView 渲染真实页面;纯 Web demo 只展示浏览器 chrome 和生命周期。",

    // TerminalWorkspacePane
    "workspace.processExited": "[进程已退出,状态码 {code}]",
    "workspace.terminalStartFailed": "终端启动失败",
  },
  "en-US": {
    // RuntimePicker
    "workspace.runtimeConfig": "Runtime",
    "workspace.selectModel": "Select model",
    "workspace.model": "Model",
    "workspace.effort": "Effort",
    "workspace.permission": "Permission",
    "workspace.permissionManagedByTrae": "Managed by TRAE",
    "workspace.permissionNoteTrae": "TRAE manages its own sandbox and approvals. Bento cannot set or switch its permission policy yet.",
    "workspace.permissionNotePi": "This harness doesn’t support permission profiles (behaves like Bypass)",
    "workspace.permissionNoteCodex": "Changing profiles for Codex takes effect in a new session",
    "workspace.permissionNoteApprox": "Approximated via the tool set, not a hard boundary; Restricted and Standard have no shell (Bash-like) tools — choose Bypass if needed",
    "workspace.searchModels": "Search models",
    "workspace.noMatchingModels": "No matching models",
    "workspace.noConnectedProviders": "No connected providers offer models.",
    "workspace.importLocalConfig": "Import from local config ({sources})…",
    "workspace.addProvider": "Add provider…",
    "workspace.goToProviderSettings": "Open provider settings…",

    // ProjectPicker
    "workspace.createProjectFailed": "Failed to create project",
    "workspace.createProject": "Create project",
    "workspace.createProjectDesc": "Name the project and choose the source folder for it.",
    "workspace.projectName": "Project name",
    "workspace.sourceFolder": "Source folder",
    "workspace.dropToChooseFolder": "Drop to choose this folder",
    "workspace.clickOrDropFolder": "Click to choose, or drop a folder here",
    "workspace.cancel": "Cancel",
    "workspace.creating": "Creating…",
    "workspace.selectProject": "Select project",
    "workspace.clearProject": "Clear project",
    "workspace.clearProjectNamed": "Clear project {name}",
    "workspace.searchProjects": "Search projects",
    "workspace.noMatchingProjects": "No matching recent projects",
    "workspace.openFolder": "Open folder…",
    "workspace.newProject": "New project",

    // PromptRail
    "workspace.jumpToPrompt": "Jump to: {text}",
    "workspace.promptCount": "{count} prompts in this session",

    // DockWorkspace / built-in view titles
    "workspace.unknownView": "Unknown view {viewId}",
    "workspace.apps": "Apps",
    "workspace.sessionsView": "Sessions",
    "workspace.chatView": "Chat",

    // WorkspaceToolsPanel
    "workspace.terminal": "Terminal",
    "workspace.files": "Files",
    "workspace.browser": "Browser",
    "workspace.newTab": "New tab",
    "workspace.terminalN": "Terminal {index}",
    "workspace.filesN": "Files {index}",
    "workspace.newTabN": "New tab {index}",
    "workspace.workspaceTabs": "Workspace tabs",
    "workspace.closeTab": "Close {title}",
    "workspace.allWorkspaceTabs": "All workspace tabs",
    "workspace.newWorkspaceTab": "New workspace tab",
    "workspace.closeToolsPanel": "Close tools panel",
    "workspace.openWorkspaceTool": "Open a workspace tool",
    "workspace.openingTool": "Opening tool…",

    // FilesWorkspacePane
    "workspace.readingFile": "Reading file…",
    "workspace.previewFailed": "Can’t preview file",
    "workspace.fileTruncated": "Large file — showing the first 2000 lines.",
    "workspace.unsupportedFormat": "This file format isn’t supported yet",
    "workspace.filePreview": "File preview",
    "workspace.copyFileContents": "Copy file contents",
    "workspace.readOnlyPreview": "Read-only preview",
    "workspace.filesAndPreview": "Files and previews",
    "workspace.fileTree": "File tree",
    "workspace.allFileTabs": "All file tabs",
    "workspace.filterExpandedFiles": "Filter expanded files",
    "workspace.filterFiles": "Filter files",
    "workspace.refreshFileTree": "Refresh file tree",
    "workspace.readOnlyAutoRefresh": "Read-only · auto-refresh",
    "workspace.readOnly": "Read-only",
    "workspace.loadingProject": "Reading project…",
    "workspace.openProjectFailed": "Can’t open project",
    "workspace.emptyDirectory": "Empty folder",
    "workspace.loading": "Loading…",

    // BrowserWorkspacePane
    "workspace.invalidUrl": "Enter a valid HTTP(S) URL",
    "workspace.back": "Back",
    "workspace.forward": "Forward",
    "workspace.reload": "Reload",
    "workspace.urlLabel": "Address",
    "workspace.enterUrl": "Enter URL",
    "workspace.openInSystemBrowser": "Open in system browser",
    "workspace.startBrowsing": "Start browsing",
    "workspace.enterUrlHint": "Enter a URL to open a page",
    "workspace.pageFailed": "This page can’t be opened",
    "workspace.retry": "Retry",
    "workspace.demoBrowserNote": "The desktop app renders real pages in an isolated WebContentsView; this web demo only shows the browser chrome and lifecycle.",

    // TerminalWorkspacePane
    "workspace.processExited": "[Process exited with code {code}]",
    "workspace.terminalStartFailed": "Terminal failed to start",
  },
}

export default bundle
