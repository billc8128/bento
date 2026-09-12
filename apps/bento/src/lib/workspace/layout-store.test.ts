import { describe, expect, it, vi } from "vitest"

// live-store 在模块加载时 init 并触碰 window;node 环境先放一个最小壳
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).window = {
    bento: {
      listSessions: async () => [],
      onSessionEvent: () => () => {},
      onSessionsChanged: () => () => {},
      onBinaryProgress: () => () => {},
      onCollaborationUiCommand: () => () => {},
      reportCollaborationUiState: () => {},
    },
  }
})

import { agentHideSession, agentShowSession, choosePlacement, currentUiAdjacency, panelIdOf } from "./layout-store"

/** 最小 DockviewApi 假件:面板字典 + activePanel + element 尺寸。 */
function fakeApi(options: {
  panels?: string[]
  active?: string | null
  width?: number
  height?: number
  rects?: Record<string, { left: number; top: number; width: number; height: number }>
  hidden?: string[]
}) {
  const makePanel = (id: string) => {
    const rect = options.rects?.[id] ?? { left: 0, top: 0, width: 100, height: 100 }
    return {
      id,
      api: { setActive: () => {}, isVisible: !options.hidden?.includes(id) },
      group: {
        element: {
          getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
        },
      },
    }
  }
  const panels = new Map<string, ReturnType<typeof makePanel>>()
  for (const id of options.panels ?? []) {
    panels.set(id, makePanel(id))
  }
  const record = {
    addedPanel: undefined as string | undefined,
    lastPosition: null as { direction?: string; referencePanel?: string } | null,
    lastInactive: undefined as boolean | undefined,
  }
  const api = {
    get panels() { return [...panels.values()] },
    groups: [],
    width: options.width ?? 1200,
    height: options.height ?? 800,
    activePanel: null as null | ReturnType<typeof makePanel>,
    getPanel: (id: string) => panels.get(id) ?? null,
    addPanel: (opts: { id: string; position?: { direction?: string; referencePanel?: string }; inactive?: boolean }) => {
      const panel = makePanel(opts.id)
      panels.set(opts.id, panel)
      record.lastPosition = opts.position ?? null
      record.addedPanel = opts.id
      record.lastInactive = Boolean(opts.inactive)
      return panel
    },
    removePanel: (panel: { id: string }) => panels.delete(panel.id),
  }
  api.activePanel = options.active ? panels.get(options.active) ?? null : null
  Object.defineProperties(api, {
    addedPanel: { get: () => record.addedPanel },
    lastPosition: { get: () => record.lastPosition },
    lastInactive: { get: () => record.lastInactive },
  })
  return api as typeof api & {
    addedPanel: string | undefined
    lastPosition: { direction?: string; referencePanel?: string } | null
    lastInactive: boolean | undefined
  }
}

// 把假件挂到模块内部:attachDockApi 是唯一入口,用结构兼容的对象 attach
// (cast 绕过完整 DockviewApi 面;被测代码只用到上述子集)
function attach(fake: ReturnType<typeof fakeApi>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachDockApi(fake as any)
  return fake
}

import { attachDockApi } from "./layout-store"

describe("choosePlacement(纯函数)", () => {
  it("宽且横向占优 → right;窄屏/纵向 → down", () => {
    expect(choosePlacement(1200, 800)).toBe("right")
    expect(choosePlacement(700, 900)).toBe("down")
    expect(choosePlacement(500, 800)).toBe("down") // 低于 680px 最小宽度
    expect(choosePlacement(680, 680)).toBe("right")
  })
})

describe("currentUiAdjacency(Dockview 投影)", () => {
  it("只读取真正可见的聊天 Session，并隐藏 Dockview panel id", () => {
    attach(fakeApi({
      panels: ["chat:left", "chat:right", "chat:tab-hidden", "apps"],
      active: "chat:left",
      hidden: ["chat:tab-hidden"],
      rects: {
        "chat:left": { left: 0, top: 0, width: 400, height: 600 },
        "chat:right": { left: 400, top: 0, width: 400, height: 600 },
      },
    }))
    expect(currentUiAdjacency()).toEqual([
      { sessionId: "left", neighbors: { right: "right" } },
      { sessionId: "right", neighbors: { left: "left" } },
    ])
  })
})

describe("agent 面向布局操作", () => {
  it("show:anchor 优先 caller 面板,auto 依容器尺寸选方向;focus=false 恢复旧焦点", () => {
    const onActive = vi.fn()
    const fake = attach(fakeApi({ panels: ["chat:caller"], active: "chat:caller", width: 1400, height: 700 }))
    // 给 activePanel 一个可断言的 setActive
    let activated = 0
    if (fake.activePanel) fake.activePanel.api.setActive = () => { activated += 1 }

    agentShowSession("peer-1", { anchorSessionId: "caller", placement: "auto", focus: false })
    expect(fake.addedPanel).toBe(panelIdOf("peer-1"))
    expect(fake.lastPosition).toMatchObject({ direction: "right", referencePanel: "chat:caller" })
    expect(activated).toBe(0) // inactive 添加:根本不触碰旧焦点
    void onActive

    // 窄容器 → down
    const narrow = fakeApi({ panels: ["chat:caller"], active: "chat:caller", width: 500, height: 800 })
    attach(narrow)
    agentShowSession("peer-2", { anchorSessionId: "caller", placement: "auto", focus: true })
    expect(narrow.lastPosition).toMatchObject({ direction: "below" })
  })

  it("show 幂等:面板已存在时只在 focus=true 才激活,不重复加面板", () => {
    const fake = attach(fakeApi({ panels: ["chat:s-1", "chat:s-2"], active: "chat:s-1" }))
    let activates = 0
    fake.getPanel("chat:s-2")!.api.setActive = () => { activates += 1 }

    agentShowSession("s-2", { focus: false })
    expect(fake.addedPanel).toBeUndefined()
    expect(activates).toBe(0)
    agentShowSession("s-2", { focus: true })
    expect(activates).toBe(1)
  })

  it("hide:只移除目标面板;最后一个聊天面板保留(不白屏)", () => {
    const fake = attach(fakeApi({ panels: ["chat:s-1", "chat:s-2"], active: "chat:s-2" }))
    agentHideSession("s-2")
    expect(fake.getPanel("chat:s-2")).toBeNull()

    agentHideSession("s-1") // 最后一个:兜底保留
    expect(fake.getPanel("chat:s-1")).not.toBeNull()
  })
})

describe("agentShowSession inactive", () => {
  it("focus=false 以 inactive:true 添加面板,不触碰 active;focus=true 保持 active 行为", () => {
    const fake = attach(fakeApi({ panels: ["chat:caller"], active: "chat:caller", width: 1400, height: 700 }))
    agentShowSession("peer", { anchorSessionId: "caller", focus: false })
    expect(fake.addedPanel).toBe(panelIdOf("peer"))
    expect(fake.lastInactive).toBe(true)

    const fake2 = attach(fakeApi({ panels: ["chat:caller"], active: "chat:caller", width: 1400, height: 700 }))
    agentShowSession("peer", { anchorSessionId: "caller", focus: true })
    expect(fake2.lastInactive).toBe(false) // focus=true:正常 active 添加
  })
})
