import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

import type { ITheme } from "@xterm/xterm"

import { useT, type TFn } from "@/lib/i18n"

function cssToken(element: HTMLElement, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim()
}

function terminalTheme(element: HTMLElement): ITheme {
  const background = cssToken(element, "--background")
  const foreground = cssToken(element, "--foreground")
  const muted = cssToken(element, "--muted-foreground")
  const accent = cssToken(element, "--accent")
  const ok = cssToken(element, "--app-ok")
  const warn = cssToken(element, "--app-warn")
  const err = cssToken(element, "--app-err")
  const primary = cssToken(element, "--primary")
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: accent,
    black: background,
    brightBlack: muted,
    red: err,
    brightRed: err,
    green: ok,
    brightGreen: ok,
    yellow: warn,
    brightYellow: warn,
    blue: primary,
    brightBlue: primary,
    magenta: primary,
    brightMagenta: primary,
    cyan: ok,
    brightCyan: ok,
    white: foreground,
    brightWhite: foreground,
  }
}

function DemoTerminal() {
  return (
    <div className="h-full overflow-auto p-4 font-mono text-xs leading-6 text-foreground">
      <p className="text-muted-foreground">Last login: Fri Aug 29 09:42:16 on ttys004</p>
      <p><span className="font-medium">bento</span> <span className="text-muted-foreground">git:(feature/workspace-panel)</span> ❯ pnpm test --run</p>
      <p className="text-ok">✓ 43 test files · 296 tests passed</p>
      <p><span className="font-medium">bento</span> <span className="text-muted-foreground">git:(feature/workspace-panel)</span> ❯</p>
    </div>
  )
}

export function TerminalWorkspacePane({
  cwd,
  onTitleChange,
}: {
  cwd: string
  onTitleChange: (title: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalIdRef = useRef<string | null>(null)
  const titleChangeRef = useRef(onTitleChange)
  const { t } = useT()
  const tRef = useRef<TFn>(t)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    titleChangeRef.current = onTitleChange
    tRef.current = t
  }, [onTitleChange, t])

  useEffect(() => {
    const api = window.bento?.workspace.terminal
    const host = hostRef.current
    if (!api || !host) return

    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      fontFamily: cssToken(host, "--app-font-mono"),
      fontSize: Number.parseFloat(cssToken(host, "--app-type-caption-size")) || 12,
      lineHeight: 1.35,
      theme: terminalTheme(host),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(new WebLinksAddon())
    terminal.open(host)

    let disposed = false
    const resize = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      const id = terminalIdRef.current
      if (id) api.resize(id, terminal.cols, terminal.rows)
    }
    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(resize))
    resizeObserver.observe(host)

    const root = document.documentElement
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = terminalTheme(host)
      terminal.options.fontFamily = cssToken(host, "--app-font-mono")
      terminal.options.fontSize = Number.parseFloat(cssToken(host, "--app-type-caption-size")) || 12
      window.requestAnimationFrame(resize)
    })
    themeObserver.observe(root, { attributes: true, attributeFilter: ["class", "data-style"] })

    const stopData = api.onData(({ id, data }) => {
      if (id === terminalIdRef.current) terminal.write(data)
    })
    const stopExit = api.onExit(({ id, exitCode }) => {
      if (id !== terminalIdRef.current) return
      terminalIdRef.current = null
      terminal.writeln(`\r\n\x1b[90m${tRef.current("workspace.processExited", { code: exitCode })}\x1b[0m`)
    })
    const input = terminal.onData((data) => {
      const id = terminalIdRef.current
      if (id) api.write(id, data)
    })

    window.requestAnimationFrame(async () => {
      resize()
      const result = await api.create({ cwd, cols: terminal.cols, rows: terminal.rows })
      if (disposed) {
        if (result.terminal) await api.kill(result.terminal.id)
        return
      }
      if (!result.terminal) {
        setError(result.error)
        return
      }
      terminalIdRef.current = result.terminal.id
      const folder = result.terminal.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || result.terminal.cwd
      titleChangeRef.current(`${result.terminal.shell} · ${folder}`)
      api.resize(result.terminal.id, terminal.cols, terminal.rows)
      terminal.focus()
    })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      themeObserver.disconnect()
      stopData()
      stopExit()
      input.dispose()
      terminal.dispose()
      const id = terminalIdRef.current
      terminalIdRef.current = null
      if (id) void api.kill(id)
    }
  }, [cwd])

  if (!window.bento) return <DemoTerminal />

  return (
    <section aria-label={t("workspace.terminal")} className="relative min-h-0 flex-1 bg-background">
      <div ref={hostRef} className="workspace-terminal absolute inset-0 p-3" />
      {error && (
        <div role="alert" className="absolute inset-0 grid place-items-center bg-background p-6 text-center text-xs text-muted-foreground">
          <div><p className="font-medium text-foreground">{t("workspace.terminalStartFailed")}</p><p className="mt-1">{error}</p></div>
        </div>
      )}
    </section>
  )
}
