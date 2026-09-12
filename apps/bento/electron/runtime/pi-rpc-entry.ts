import { fileURLToPath } from "node:url"

/** pi-coding-agent 只为 rpc-entry 声明 ESM import 导出，不能用 require.resolve。 */
export function resolvePiRpcEntry(): string {
  return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))
}
