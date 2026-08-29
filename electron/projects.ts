import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** 在用户选定的源目录下创建一个新的项目文件夹。 */
export function createProject(sourceDir: string, name: string) {
  const projectName = name.trim()
  if (!projectName || projectName === "." || projectName === ".." || /[\\/]/.test(projectName)) {
    throw new Error("项目名称不能为空，也不能包含路径分隔符")
  }

  const root = sourceDir.trim().replace(/^~(?=$|\/)/, os.homedir())
  const stat = fs.statSync(root)
  if (!stat.isDirectory()) throw new Error("源文件夹不是目录")

  const target = path.join(root, projectName)
  fs.mkdirSync(target)
  return target
}
