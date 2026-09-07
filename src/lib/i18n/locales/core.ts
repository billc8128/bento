/**
 * 核心流程词典(src/core/* 非组件模块)。命名空间:core
 * 只含用户可见 UI 文案;协作协议错误文案、事件日志匹配串等不进这里。
 */
import type { LocaleBundle } from "../core"

const bundle: LocaleBundle = {
  "zh-CN": {
    "core.profileRestrictedName": "受限",
    "core.profileRestrictedDesc": "工作区内读写,禁网络,越界直接拒",
    "core.profileStandardName": "标准",
    "core.profileStandardDesc": "工作区读写 + 网络放行,越界暂自动拒",
    "core.profileFullName": "放行",
    "core.profileFullDesc": "不设限,可写任意路径、可执行任意命令",
    "core.effortOffName": "不推理",
    "core.effortOffHint": "直接回答,不进行额外思考",
    "core.effortAutoName": "自动",
    "core.effortAutoHint": "由 Harness 按任务判断",
    "core.effortLowName": "低",
    "core.effortLowHint": "抢速度,适合改一行、查文件",
    "core.effortMediumName": "中",
    "core.effortMediumHint": "日常默认",
    "core.effortHighName": "高",
    "core.effortHighHint": "跨文件重构、疑难排查",
    "core.effortMaxName": "极限",
    "core.effortMaxHint": "最慢,留给真正卡住的问题",
  },
  "en-US": {
    "core.profileRestrictedName": "Restricted",
    "core.profileRestrictedDesc": "Read and write inside the workspace, no network, out-of-bounds denied",
    "core.profileStandardName": "Standard",
    "core.profileStandardDesc": "Workspace read/write plus network, out-of-bounds auto-denied for now",
    "core.profileFullName": "Unrestricted",
    "core.profileFullDesc": "No limits — can write any path and run any command",
    "core.effortOffName": "Off",
    "core.effortOffHint": "Answers directly, no extra thinking",
    "core.effortAutoName": "Auto",
    "core.effortAutoHint": "The harness decides per task",
    "core.effortLowName": "Low",
    "core.effortLowHint": "Fastest — good for one-line edits and file lookups",
    "core.effortMediumName": "Medium",
    "core.effortMediumHint": "Everyday default",
    "core.effortHighName": "High",
    "core.effortHighHint": "Cross-file refactors and tricky debugging",
    "core.effortMaxName": "Max",
    "core.effortMaxHint": "Slowest — save it for truly blocking problems",
  },
}

export default bundle
