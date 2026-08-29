/**
 * 快捷键板块:只读清单,与代码里的真实绑定一一对应。
 * (⌘B 在 ui/sidebar.tsx,⏎/⇧⏎ 在 Composer.tsx;新增快捷键时同步这里。)
 */

const GROUPS: { title: string; items: { label: string; keys: string[] }[] }[] = [
  {
    title: "通用",
    items: [
      { label: "切换侧边栏", keys: ["⌘", "B"] },
      { label: "关闭弹层 / 设置页", keys: ["Esc"] },
    ],
  },
  {
    title: "输入",
    items: [
      { label: "发送消息", keys: ["⏎"] },
      { label: "换行", keys: ["⇧", "⏎"] },
    ],
  },
]

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  )
}

export function ShortcutsSection() {
  return (
    <div className="flex flex-col gap-6">
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h2 className="text-sm font-medium">{group.title}</h2>
          <div className="mt-2 flex flex-col divide-y divide-border rounded-xl border border-border">
            {group.items.map((item) => (
              <div key={item.label} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm">{item.label}</span>
                <span className="flex items-center gap-1">
                  {item.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">暂不支持自定义快捷键。</p>
    </div>
  )
}
