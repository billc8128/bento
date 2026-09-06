/**
 * 主题(L0)= 配色 token(themes.css)+ 结构特征(这里的 traits)。
 *
 * 只换颜色的话几套看起来还是同一个界面。真正拉开距离的是布局本身:
 * 侧边栏贴不贴边、消息有没有气泡、输入框是嵌在底边还是浮在内容上。
 * 只换 token 不配 traits 的主题没有资格进内置列表(ARCHITECTURE.md §3)。
 */

export type SidebarShape =
  /** 贴边全高,靠一条竖线和主区分开 */
  | "flush"
  /** 浮岛:四周留白 + 圆角 + 投影,像一块独立面板 */
  | "island"
  /** 裸露:没有底色也没有边框,只靠留白划分 */
  | "bare"

export type MessageShape =
  /** 双向气泡,对话感最强 */
  | "bubble-both"
  /** 只有用户有气泡,助手是正文流 */
  | "bubble-user"
  /** 都不用气泡,靠一个前缀标签区分说话人,像终端日志 */
  | "plain"

export type ComposerShape =
  /** 贴底通栏,和窗口底边焊死 */
  | "docked"
  /** 独立卡片,离底边有一点距离 */
  | "card"
  /** 悬浮在消息流之上,带毛玻璃和投影 */
  | "floating"
  /** 内嵌:没有边框和底色,只有一条分隔线 */
  | "inline"

export type StyleTraits = {
  sidebar: SidebarShape
  message: MessageShape
  composer: ComposerShape
  /** 对话头:完整工具条,还是只留一行标题 */
  header: "bar" | "minimal"
  /** 工具调用:带框的分组,还是散开的行 */
  tools: "boxed" | "flat"
  /** 正文栏宽:窄栏接近文档的可读行长,满宽则是 IDE 面板那种铺开的用法 */
  width: "wide" | "narrow" | "full"
  /** 新建对话的悬浮层:居中弹窗,还是从顶部落下的命令面板 */
  dialog: "centered" | "palette"
}

/** 每套主题的默认空间比例。字体规范在 themes.css 同名主题块内，
 *  这里保留必须以 number 传给布局组件的尺寸。 */
export type StyleLayout = {
  sidebar: {
    default: number
    min: number
    max: number
  }
}

export type Style = {
  id: string
  name: string
  desc: string
  /** 这套主题是照着哪个模式设计的,切过去时默认跟到对应明暗 */
  tone: "light" | "dark"
  traits: StyleTraits
  layout: StyleLayout
}

export const STYLES = [
  {
    id: "graphite",
    name: "默认",
    desc: "石墨灰阶 · 琥珀点睛 · 悬浮输入",
    tone: "light",
    layout: { sidebar: { default: 204, min: 196, max: 304 } },
    traits: {
      sidebar: "flush",
      message: "bubble-user",
      composer: "floating",
      header: "minimal",
      tools: "flat",
      width: "wide",
      dialog: "centered",
    },
  },
  {
    id: "glass",
    name: "液态玻璃",
    desc: "整窗 vibrancy · 玻璃层叠 · 明暗双色",
    tone: "light",
    layout: { sidebar: { default: 204, min: 196, max: 304 } },
    traits: {
      sidebar: "flush",
      message: "bubble-user",
      composer: "floating",
      header: "minimal",
      tools: "flat",
      width: "wide",
      dialog: "centered",
    },
  },
  {
    id: "indigo",
    name: "靛蓝暗夜",
    desc: "纯黑底 · 靛蓝强调 · 浮岛侧栏",
    tone: "dark",
    layout: { sidebar: { default: 216, min: 208, max: 320 } },
    traits: {
      sidebar: "island",
      message: "bubble-user",
      composer: "card",
      header: "bar",
      tools: "boxed",
      width: "wide",
      dialog: "palette",
    },
  },
  {
    id: "soft",
    name: "柔和浮岛",
    desc: "大圆角 · 双向气泡 · 悬浮输入",
    tone: "light",
    layout: { sidebar: { default: 224, min: 216, max: 336 } },
    traits: {
      sidebar: "island",
      message: "bubble-both",
      composer: "floating",
      header: "minimal",
      tools: "flat",
      width: "wide",
      dialog: "centered",
    },
  },
  {
    id: "warm",
    name: "温暖编辑",
    desc: "衬线标题 · 双向气泡 · 圆润",
    tone: "light",
    layout: { sidebar: { default: 220, min: 212, max: 328 } },
    traits: {
      sidebar: "flush",
      message: "bubble-both",
      composer: "card",
      header: "bar",
      tools: "flat",
      width: "wide",
      dialog: "centered",
    },
  },
  {
    id: "terminal",
    name: "终端极客",
    desc: "等宽字体 · 锐角 · 贴底输入区",
    tone: "dark",
    layout: { sidebar: { default: 240, min: 224, max: 360 } },
    traits: {
      sidebar: "flush",
      message: "plain",
      composer: "docked",
      header: "bar",
      tools: "boxed",
      width: "wide",
      dialog: "palette",
    },
  },
] as const satisfies readonly Style[]

export type StyleId = (typeof STYLES)[number]["id"]

export const DEFAULT_STYLE: StyleId = "graphite"

export function getStyle(id: StyleId): Style {
  return STYLES.find((s) => s.id === id)!
}

/** 正文和输入区共用的栏宽。full 不居中,直接铺满可用区域 */
export const COLUMN: Record<StyleTraits["width"], string> = {
  narrow: "mx-auto max-w-2xl",
  wide: "mx-auto max-w-[var(--app-content-max)]",
  full: "max-w-none",
}

/** 消息与标题对齐到 Composer 圆角进入直线后的内容轴。 */
export const CHAT_CONTENT_GUTTER: Record<ComposerShape, string> = {
  docked: "px-4",
  card: "px-6",
  floating: "px-10",
  inline: "px-4",
}
