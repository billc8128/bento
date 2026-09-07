# i18n 范式说明(给抽取文案的 agent 看)

基础设施在 `src/lib/i18n/`,无外部依赖。看完这份再动手;照 `sidebar.ts` / `composer.ts` 抄即可。

## 加一个新命名空间

1. 新建 `src/lib/i18n/locales/<namespace>.ts`。**不需要在任何 index 里登记**——
   `core.ts` 用 `import.meta.glob('./locales/*.ts', { eager: true })` 自动合并所有文件。
2. 文件默认导出一个 `LocaleBundle`(两个语言各一张扁平 key-value 表):

```ts
import type { LocaleBundle } from "../core"

const bundle: LocaleBundle = {
  "zh-CN": {
    "settings.language": "语言",
  },
  "en-US": {
    "settings.language": "Language",
  },
}

export default bundle
```

- 命名空间 = 文件名,通常对应一个组件/视图(`sidebar` / `composer` / `settings`)。
- key 一律以命名空间为前缀 + camelCase:`composer.dropToUpload`、`sidebar.moreCount`。
- 两个语言的 key 集合必须一致;缺 key 时运行时会回退 zh-CN(dev 下 console.warn)。
- 多个并行 agent 各建各的文件,key 前缀不撞就不会冲突;同名 key 后加载者覆盖前者(dev 下会警告)。

## 在组件里用

```tsx
import { useT } from "@/lib/i18n"

function MyPanel() {
  const { t, locale } = useT()
  return <Button title={t("sidebar.pin")}>{t("sidebar.newChat")}</Button>
}
```

- 插值:`t("sidebar.moreCount", { count: 3 })`,词典里写 `"更多 {count} 条"` / `"{count} more"`。
  变量名 camelCase;值可以是 string 或 number。
- 非 React 代码(lib/store):`import { translate } from "@/lib/i18n"`,但需要自己拿到 locale——
  优先把 `t` 从组件传下去(参考 `AppSidebar.tsx` 里的 `relativeTime(iso, t)`)。
- `<I18nProvider>` 已挂在 `src/main.tsx` 根部,不要再套一层。

## 常见模式

- **toast**:`toast.success(t("sessions.deleted"))` —— toast 文案也是 UI 文案,照样抽。
- **confirm / alert-dialog**:标题、描述、按钮各一个 key(`sidebar.deleteSession` /
  `sidebar.deleteSessionDesc` / `sidebar.cancel` / `sidebar.delete`)。
  描述里嵌用户数据用插值:`"「{title}」的历史记录将一并删除…"`。
- **aria-label / title / sr-only**:都是文案,都要抽(`title={t("sidebar.searchChats")}`)。
  同一短语的 title + sr-only 共用一个 key,不要造两个。
- **placeholder**:`placeholder={t("composer.placeholder", { name: harness.name })}`。
- **带动态片段的文案**:拆成「静态模板 + 插值」,不要字符串拼接
  (语序在中英文里不同)。反例:`"在 " + label + " 中新建对话"`;正例:`t("sidebar.newChatIn", { label })`。

## 什么不翻

- 用户数据:会话标题、文件夹名、路径、模型名、harness 名、错误消息原文。
- 品牌名(Bento)、快捷键符号(⌘N)、纯格式化的相对时间单位(`5m` / `3h` / `2d` 两语通用)。
- 代码注释不抽,保持原样。

## 英文文案风格

- Sentence case,不要 Title Case:`New chat`,不是 `New Chat`。
- 短,动词开头:`Pin` / `Rename` / `Delete` / `Drop to upload`。
- 自然产品英语,不逐字机翻:「发送为下一条」→ `Queue message`;
  「还没有对话」→ `No chats yet`;「从侧栏移除」→ `Remove from sidebar`。
- 引号用弯引号 `“”` / `’`(见 `sidebar.deleteSessionDesc`),省略号用 `…`。

## 验证

改完跑:`pnpm vitest run`、`npx tsc -b`、`pnpm lint`。
已有测试若断言了中文文案,把断言更新成新文案或 key 对应的英文。
