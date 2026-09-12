import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const endpoint = process.env.BENTO_MCP_ENDPOINT
const token = process.env.BENTO_MCP_TOKEN
if (!endpoint || !token) throw new Error("Bento MCP relay 配置缺失")

const client = new Client({ name: "bento-mcp-relay", version: "0.1.0" })
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
}))

const server = new Server(
  { name: "bento-apps", version: "0.1.0" },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, (request) => client.listTools(request.params))
server.setRequestHandler(CallToolRequestSchema, (request) => client.callTool(request.params))

const close = async () => {
  await client.close().catch(() => {})
}
process.once("SIGTERM", close)
process.once("SIGINT", close)
await server.connect(new StdioServerTransport())
