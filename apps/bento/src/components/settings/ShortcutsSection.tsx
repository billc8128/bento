/**
 * 快捷键板块:只读清单,与代码里的真实绑定一一对应。
 * (⌘B 在 ui/sidebar.tsx 与 App.tsx,⌘N 在 App.tsx,⏎/⇧⏎ 在 Composer.tsx;新增快捷键时同步这里。)
 */

import { useT } from "@/lib/i18n"

const GROUPS: { titleKey: string; items: { labelKey: string; keys: string[] }[] }[] = [
  {
    titleKey: "settings.shortcutGroupGeneral",
    items: [
      { labelKey: "settings.shortcutNewChat", keys: ["⌘", "N"] },
      { labelKey: "settings.shortcutToggleSidebar", keys: ["⌘", "B"] },
      { labelKey: "settings.shortcutCloseOverlay", keys: ["Esc"] },
    ],
  },
  {
    titleKey: "settings.shortcutGroupInput",
    items: [
      { labelKey: "settings.shortcutSend", keys: ["⏎"] },
      { labelKey: "settings.shortcutNewline", keys: ["⇧", "⏎"] },
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
  const { t } = useT()

  return (
    <div className="flex flex-col gap-6">
      {GROUPS.map((group) => (
        <section key={group.titleKey}>
          <h2 className="text-sm font-medium">{t(group.titleKey)}</h2>
          <div className="mt-2 flex flex-col divide-y divide-border rounded-xl border border-border">
            {group.items.map((item) => (
              <div key={item.labelKey} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm">{t(item.labelKey)}</span>
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
      <p className="text-xs text-muted-foreground">{t("settings.shortcutsCustomUnsupported")}</p>
    </div>
  )
}
