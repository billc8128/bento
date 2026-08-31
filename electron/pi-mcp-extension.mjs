const ENDPOINT = process.env.BENTO_MCP_ENDPOINT
const TOKEN = process.env.BENTO_MCP_TOKEN

export default async function bentoMcpExtension(pi) {
  if (!ENDPOINT || !TOKEN) return
  let nextId = 1
  async function responseMessage(response, id) {
    const body = await response.text()
    if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(body)
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      const message = JSON.parse(data)
      if (message.id === id) return message
    }
    throw new Error("Bento MCP 返回了无效 SSE response")
  }
  async function request(method, params) {
    const id = nextId++
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    })
    const message = await responseMessage(response, id)
    if (!response.ok || message.error) throw new Error(message.error?.message || `Bento MCP ${response.status}`)
    return message.result
  }
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "bento-pi-extension", version: "0.1.0" },
  })
  let cursor
  do {
    const listed = await request("tools/list", cursor ? { cursor } : {})
    for (const tool of listed.tools ?? []) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description || `Bento App tool ${tool.name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        async execute(_id, args) {
          const result = await request("tools/call", { name: tool.name, arguments: args })
          if (result?.isError) throw new Error((result.content ?? []).map((item) => item.text ?? "").join("\n"))
          return { content: result?.content ?? [{ type: "text", text: "(empty result)" }], details: result?.structuredContent ?? {} }
        },
      })
    }
    cursor = listed.nextCursor
  } while (cursor)
}
