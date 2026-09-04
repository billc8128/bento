/**
 * realpath 归一(main 侧 IO 薄壳):src/core/permission 的 isPathInside 是纯字符串
 * 判定,看不见 symlink——cwd 内一个指向 /etc 的软链就能绕过"工作区内"承诺。
 * 写类工具裁决前必须先过这里(M2 审批上线前的既定承诺)。
 */

import fs from "node:fs"
import path from "node:path"

/**
 * 归一到真实路径:存在即 realpath;不存在(新建文件)归一最近的已存在祖先,
 * 再拼回剩余段——symlink 在路径任意一层都会被解开。全部失败退回原路径
 * (此时 isPathInside 的字符串判定兜底,偏保守方向)。
 */
export function resolveRealPath(target: string): string {
  // 相对路径不以进程 cwd 为基解析(会变松):原样返回,isPathInside 按旧行为判越界
  if (!path.isAbsolute(target)) return target
  const absolute = path.resolve(target)
  try {
    return fs.realpathSync(absolute)
  } catch {
    // 目标尚不存在(新建文件/目录):逐级向上找已存在祖先
  }
  const missing: string[] = []
  let cursor = absolute
  for (;;) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return absolute
    missing.unshift(path.basename(cursor))
    cursor = parent
    try {
      const realAncestor = fs.realpathSync(cursor)
      return path.join(realAncestor, ...missing)
    } catch {
      // 继续向上
    }
  }
}
