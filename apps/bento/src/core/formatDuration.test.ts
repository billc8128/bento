import { describe, expect, it } from "vitest"

import { formatDuration } from "./formatDuration"

describe("formatDuration(TRACE_DATA_PLAN §3.5/§8)", () => {
  it("下限:同 tick(at 差为 0)与 <100ms 一律 `<0.1s`,不得渲染成 0.0s", () => {
    expect(formatDuration(0)).toBe("<0.1s")
    expect(formatDuration(1)).toBe("<0.1s")
    expect(formatDuration(99)).toBe("<0.1s")
  })

  it("<10s 桶:一位小数 Math.floor 截断(9.95s 不得四舍五入成 10.0s)", () => {
    expect(formatDuration(100)).toBe("0.1s")
    expect(formatDuration(400)).toBe("0.4s")
    expect(formatDuration(4200)).toBe("4.2s")
    expect(formatDuration(9900)).toBe("9.9s")
    expect(formatDuration(9950)).toBe("9.9s")
    expect(formatDuration(9999)).toBe("9.9s")
  })

  it("<60s 桶:整数秒截断(59.9s 不得越桶显示 60s/1m00s)", () => {
    expect(formatDuration(10_000)).toBe("10s")
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(59_000)).toBe("59s")
    expect(formatDuration(59_900)).toBe("59s")
  })

  it("<1h 桶:m + 零填充秒", () => {
    expect(formatDuration(60_000)).toBe("1m00s")
    expect(formatDuration(61_000)).toBe("1m01s")
    expect(formatDuration(125_000)).toBe("2m05s")
    expect(formatDuration(3_599_900)).toBe("59m59s")
  })

  it("≥1h 桶:h + 零填充分", () => {
    expect(formatDuration(3_600_000)).toBe("1h00m")
    expect(formatDuration(3_780_000)).toBe("1h03m")
  })
})
