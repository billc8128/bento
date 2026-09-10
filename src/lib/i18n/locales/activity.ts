/**
 * 会话活动流(TurnActivity / core/activity / StatusGlyph / status-glyph)词典。
 * 命名空间:activity。工具目标、计划项内容、审批标题等用户数据不在这里。
 */
import type { LocaleBundle } from "../core"

const bundle: LocaleBundle = {
  "zh-CN": {
    // 阶段行标题(core/activity.ts phaseLabel)
    "activity.thinkingLive": "正在思考…",
    "activity.thoughtWithDuration": "已思考 {duration}",
    "activity.thought": "已思考",
    "activity.usingTools": "正在使用工具",
    "activity.usedTools": "已使用 {count} 个工具",
    // 兜底状态行(core/activity.ts liveStatus)
    "activity.waitingApproval": "等待你的审批",
    "activity.replying": "正在回复",
    "activity.working": "正在工作",
    "activity.thinking": "正在思考",
    // 落定摘要(core/activity.ts settledMasterLabel / settledSummary)
    "activity.worked": "已工作 {duration}",
    "activity.stopped": "已停止",
    "activity.runFailed": "执行失败",
    "activity.unfinished": "上轮未完成",
    "activity.outcomeWork": "{outcome} · {work}",
    "activity.outcomeTools": "{outcome} · {count} 个工具",
    "activity.thoughtAndUsedTools": "思考并使用了 {count} 个工具",
    "activity.usedToolsSummary": "使用了 {count} 个工具",
    "activity.thinkingDone": "思考完成",
    // 工具行动词(TurnActivity.tsx)
    "activity.toolRead": "读取",
    "activity.toolReading": "正在读取",
    "activity.toolEdit": "编辑",
    "activity.toolEditing": "正在编辑",
    "activity.toolBash": "执行",
    "activity.toolBashRunning": "正在执行",
    "activity.toolSearch": "搜索",
    "activity.toolSearching": "正在搜索",
    // 计划摘要(TurnActivity.tsx PlanSummary)
    "activity.plan": "计划",
    "activity.planCurrent": "正在:{content}",
    // 审批(TurnActivity.tsx ApprovalRow)
    "activity.approvalNeeded": "需要审批",
    "activity.approval": "审批",
    "activity.autoDenied": "协作自动拒绝",
    "activity.deniedWithCancel": "已随取消拒绝",
    "activity.deniedWithSessionClose": "已随会话关闭拒绝",
    "activity.denied": "已拒绝",
    "activity.allowedAlways": "已总是允许",
    "activity.allowed": "已允许",
    // 失败计数(TurnActivity.tsx)
    "activity.failedCount": "{count} 个失败",
    // 会话状态指示 aria-label(StatusGlyph.tsx)
    "activity.glyphRunning": "进行中",
    "activity.glyphAttention": "有待审批的请求",
    "activity.glyphUnread": "有来自其它会话的新消息",
  },
  "en-US": {
    "activity.thinkingLive": "Thinking…",
    "activity.thoughtWithDuration": "Thought for {duration}",
    "activity.thought": "Thought",
    "activity.usingTools": "Using tools",
    "activity.usedTools": "Used {count} tools",
    "activity.waitingApproval": "Waiting for your approval",
    "activity.replying": "Replying",
    "activity.working": "Working",
    "activity.thinking": "Thinking",
    "activity.worked": "Worked for {duration}",
    "activity.stopped": "Stopped",
    "activity.runFailed": "Failed",
    "activity.unfinished": "Previous turn didn’t finish",
    "activity.outcomeWork": "{outcome} · {work}",
    "activity.outcomeTools": "{outcome} · {count} tools",
    "activity.thoughtAndUsedTools": "Thought and used {count} tools",
    "activity.usedToolsSummary": "Used {count} tools",
    "activity.thinkingDone": "Done thinking",
    "activity.toolRead": "Read",
    "activity.toolReading": "Reading",
    "activity.toolEdit": "Edit",
    "activity.toolEditing": "Editing",
    "activity.toolBash": "Run",
    "activity.toolBashRunning": "Running",
    "activity.toolSearch": "Search",
    "activity.toolSearching": "Searching",
    "activity.plan": "Plan",
    "activity.planCurrent": "Now: {content}",
    "activity.approvalNeeded": "Approval needed",
    "activity.approval": "Approval",
    "activity.autoDenied": "Auto-denied (unattended)",
    "activity.deniedWithCancel": "Denied on cancel",
    "activity.deniedWithSessionClose": "Denied on session close",
    "activity.denied": "Denied",
    "activity.allowedAlways": "Always allowed",
    "activity.allowed": "Allowed",
    "activity.failedCount": "{count} failed",
    "activity.glyphRunning": "Running",
    "activity.glyphAttention": "Approval requested",
    "activity.glyphUnread": "New messages from another chat",
  },
}

export default bundle
