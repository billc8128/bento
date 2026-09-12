/**
 * 全局 Skills 的 renderer 可见类型(纯类型模块,无 node 依赖——沿用
 * binaries/progress.ts 的单源模式:skills.ts 运行时实现从这里 re-export,
 * src/types/bento.d.ts 只 import 本文件,避免把 main 实现拉进 renderer 编译)。
 */

/** 扫描结果条目;sources 为来源 label 列表(如 ["~/.claude","~/.agents"])。 */
export type GlobalSkill = {
  name: string
  description: string
  sources: string[]
}

/** 开关集合(renderer localStorage 持久化,推送 main 内存缓存)。 */
export type SkillsPreferences = {
  /** 主开关;缺省 true。 */
  allowGlobal: boolean
  /** 禁用的 skill name 列表;缺省空(新扫描到的 skill 默认启用)。 */
  disabledSkills: string[]
}
