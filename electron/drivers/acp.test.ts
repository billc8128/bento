import { describe, expect, it, vi } from "vitest"

import { sendLegacySessionModel } from "./acp"

describe("Hermes ACP model switch", () => {
  it("透传 session/set_model 到 SDK 底层连接", async () => {
    const sendRequest = vi.fn(async () => ({}))
    const connection = { connection: { sendRequest } }

    await sendLegacySessionModel(connection as never, "session-1", "custom:bento-a:model-1")

    expect(sendRequest).toHaveBeenCalledWith("session/set_model", {
      sessionId: "session-1",
      modelId: "custom:bento-a:model-1",
    })
  })
})
