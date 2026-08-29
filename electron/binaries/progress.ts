/** 受管二进制的安装进度事件。main → renderer 单向推送,
 *  通道:BinaryManager.onProgress → IPC binary:progress → onBinaryProgress。
 *  单源定义:renderer 的 bento.d.ts 与 manager 都从这里 import。 */

import type { ManagedBinaryName } from "./manifest"

export type BinaryProgress = {
  name: ManagedBinaryName
  version: string
  phase: "downloading" | "verifying" | "done" | "error"
  /** 0-1;未知总大小时 undefined */
  fraction?: number
  /** 可读阶段文案,renderer 直接展示 */
  text: string
}
