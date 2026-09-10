/**
 * TurnActivity 视觉 demo:?demo=turn-activity
 * 阶段摘要栈的场景:
 * - S1 live:单工具完成、agent 思考中(已完成阶段收进顶部聚合行,末行是流光的「正在思考…」);
 * - S2 live:思考→说话→8 个工具一组在跑(聚合行只含已闭合 thinking,工具组含 running 留在流里);
 * - S3 settled:回合结束,一行总折叠「已工作 1m12s」,final message 露在外面。
 */
import { TurnActivity } from "@/components/TurnActivity"
import type { ActivityItem, ToolCall } from "@/core/types"

const tool = (over: Partial<ToolCall> & Pick<ToolCall, "kind" | "target" | "status">): ToolCall => ({
  detail: "",
  ...over,
})

const curl = tool({ kind: "bash", target: "Running: curl -s -o /dev/null -w '%{http_code}'", status: "done", durationMs: 300 })

const tools8: ToolCall[] = [
  tool({ kind: "search", target: "ark api key 配置", status: "done", durationMs: 1200 }),
  tool({ kind: "read", target: "src/core/config.ts", status: "done", durationMs: 210 }),
  tool({ kind: "read", target: "src/core/provider.ts", status: "done", durationMs: 180 }),
  tool({ kind: "bash", target: "pnpm test", status: "done", durationMs: 8400 }),
  tool({ kind: "edit", target: "src/core/config.ts", status: "done", durationMs: 95, diffs: [{ path: "src/core/config.ts", added: 12, deleted: 4 }] }),
  tool({ kind: "read", target: "src/lib/llm.ts", status: "done", durationMs: 160 }),
  tool({ kind: "edit", target: "src/lib/llm.ts", status: "done", durationMs: 110, diffs: [{ path: "src/lib/llm.ts", added: 40, deleted: 22 }] }),
  tool({ kind: "bash", target: "Running: pnpm exec tsc -b --noEmit", status: "running" }),
]

/** S1:思考 → 说话 → 1 个工具 → 思考中 */
const s1Activity: ActivityItem[] = [
  { id: "th1", kind: "thinking", text: "用户想知道连通性,最快的方式是 curl 打一个请求看状态码…", durationMs: 2100 },
  { id: "p1", kind: "progress", text: "我先测一下 genlab 的连通性。" },
  { id: "t1", kind: "tool", tool: curl },
  { id: "th2", kind: "thinking", text: "返回 200,延迟 38ms,连通性正常。接下来看一下配置文件里 LLM 层是怎么写的…", startedAtMs: 1 },
]

/** S2:思考 → 说话 → 7 个工具落定,第 8 步在跑 */
const s2Activity: ActivityItem[] = [
  { id: "th1", kind: "thinking", text: "config.ts 里 LLM 层是手写 fetch,没有重试和流式处理。重写前先跑一遍现有测试确认基线…", durationMs: 6100 },
  { id: "p1", kind: "progress", text: "配置找到了,接下来重写 LLM 层。" },
  ...tools8.map((t, i) => ({ id: `t${i}`, kind: "tool" as const, tool: t })),
]

/** S3:同 S2,但全部落定 + 收尾思考 + 整回合耗时 */
const s3Activity: ActivityItem[] = [
  ...s2Activity.slice(0, 2),
  ...tools8.map((t, i) => ({
    id: `t${i}`,
    kind: "tool" as const,
    tool: { ...t, status: "done" as const, durationMs: t.durationMs ?? 1100 },
  })),
  { id: "th2", kind: "thinking", text: "改完了,tsc 通过,最后跑一遍全量测试确认没有回归…", durationMs: 5000 },
]

export function TurnActivityDemo() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-10 p-10">
      <section>
        <h2 className="mb-3 type-micro text-muted-foreground">S1 · live:单工具完成,agent 思考中</h2>
        <div className="rounded-xl border border-border bg-background p-4">
          <TurnActivity turn={{ activity: s1Activity, tools: [curl] }} live shape="flat" />
          <div className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Composer 占位 —— 进行中的阶段行应紧贴它上方
          </div>
        </div>
      </section>
      <section>
        <h2 className="mb-3 type-micro text-muted-foreground">S2 · live:多步骤进行中(第 8 步在跑)</h2>
        <div className="rounded-xl border border-border bg-background p-4">
          <TurnActivity turn={{ activity: s2Activity, tools: tools8 }} live shape="flat" />
        </div>
      </section>
      <section>
        <h2 className="mb-3 type-micro text-muted-foreground">S4 · live:思考已被说话闭合,正文流式中(回归:不再把「正在思考…」钉在流式正文上面)</h2>
        <div className="rounded-xl border border-border bg-background p-4">
          <TurnActivity
            turn={{
              activity: [
                { id: "t1", kind: "tool", tool: curl },
                { id: "th1", kind: "thinking", text: "用户想知道连通性,最快的方式是 curl 打一个请求看状态码…", startedAtMs: 1, durationMs: 2100 },
              ],
              tools: [curl],
            }}
            live
            shape="flat"
          />
          <p className="mt-1 text-sm">返回 200,延迟 38ms,连通性正常。接下来看一下配置文件里 LLM 层是怎么写的,然后重写 LLM 层…</p>
          <div className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Composer 占位
          </div>
        </div>
      </section>
      <section>
        <h2 className="mb-3 type-micro text-muted-foreground">S3 · settled:总折叠 + final message</h2>
        <div className="rounded-xl border border-border bg-background p-4">
          <TurnActivity
            turn={{
              activity: s3Activity,
              tools: tools8.map((t) => ({ ...t, status: "done" as const, durationMs: t.durationMs ?? 1100 })),
              thinking: "先确认配置文件,再动手改 LLM 层。",
              durationMs: 72000,
            }}
            live={false}
            shape="flat"
          />
          <p className="mt-1 text-sm">LLM 层重写完成:改成统一封装的流式 client,带重试和超时;tsc 与 442 个测试全部通过。</p>
        </div>
      </section>
    </div>
  )
}
