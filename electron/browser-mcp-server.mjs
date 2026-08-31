import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const bridgeUrl = process.env.BENTO_BROWSER_BRIDGE_URL
const bridgeToken = process.env.BENTO_BROWSER_BRIDGE_TOKEN
if (!bridgeUrl || !bridgeToken) throw new Error("Bento Browser bridge 配置缺失")

async function invoke(tool, args = {}) {
  const response = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tool, args }),
  })
  const payload = await response.json()
  if (!response.ok || payload.error) throw new Error(payload.error || `Browser bridge ${response.status}`)
  return payload.result
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

const server = new McpServer({ name: "bento-browser", version: "0.1.0" })

server.registerTool("browser_tabs", {
  description: "列出 Bento 右侧工作区中当前可见的浏览器标签页。",
}, async () => textResult(await invoke("tabs")))

server.registerTool("browser_open", {
  description: "在指定或第一个 Bento 浏览器标签页中打开 URL。",
  inputSchema: { tabId: z.string().optional(), url: z.string() },
}, async (args) => textResult(await invoke("open", args)))

server.registerTool("browser_snapshot", {
  description: "获取当前页面的精简无障碍树；后续 click/fill 使用这里返回的 nodeId。",
  inputSchema: { tabId: z.string().optional() },
}, async (args) => textResult(await invoke("snapshot", args)))

server.registerTool("browser_click", {
  description: "点击最近一次 browser_snapshot 中的节点。",
  inputSchema: { tabId: z.string().optional(), nodeId: z.number().int() },
}, async (args) => textResult(await invoke("click", args)))

server.registerTool("browser_fill", {
  description: "向最近一次 browser_snapshot 中的文本输入节点填写内容。",
  inputSchema: { tabId: z.string().optional(), nodeId: z.number().int(), text: z.string() },
}, async (args) => textResult(await invoke("fill", args)))

server.registerTool("browser_scroll", {
  description: "滚动当前页面；正数向下，负数向上。",
  inputSchema: { tabId: z.string().optional(), deltaY: z.number() },
}, async (args) => textResult(await invoke("scroll", args)))

server.registerTool("browser_screenshot", {
  description: "截取当前浏览器标签页可见区域。",
  inputSchema: { tabId: z.string().optional() },
}, async (args) => {
  const result = await invoke("screenshot", args)
  return { content: [{ type: "image", data: result.base64, mimeType: result.mimeType }] }
})

await server.connect(new StdioServerTransport())
