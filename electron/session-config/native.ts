/**
 * Native passthrough adapter(SESSION_CONFIG_ADAPTER_PLAN §5.1):所有 Harness 通用。
 *
 * native 模式:不生成 Provider 配置、不注入 Bento 凭证、不建临时目录;
 * CLI 直接读取用户原生 home 与登录态。selections 登记该 Harness 本机发现
 * 结果的全部 Provider/模型。capability spike 已证明 Kimi/OpenCode/OMP/Pi 的
 * 本机多 Provider 目录可经 CLI 原生切换(ACP setSessionConfigOption / Pi RPC
 * set_model)实时生效,因此租约目录内的任意选择(含跨 native Provider)都返回
 * live;只有未登记选择与 native↔bento 模式跨越返回 new-session。
 */

import type { HarnessId } from "../../src/core/harness"
import { NATIVE_MODEL_ID } from "../../src/core/provider"
import type {
  BentoModelSelection,
  PreparedModelRef,
  ReconfigureResult,
  SessionConfigAdapter,
  SessionConfigLease,
  SessionConfigRequest,
} from "./types"
import { modeOfSelection, selectionKey } from "./types"

export class NativeConfigAdapter implements SessionConfigAdapter {
  readonly mode = "native" as const

  constructor(readonly harnessId: HarnessId) {}

  async prepare(request: SessionConfigRequest): Promise<SessionConfigLease> {
    if (request.mode !== "native") {
      throw new Error("NativeConfigAdapter 只处理 native 模式")
    }
    // native 目录由调用方按 ProviderRegistry 的 native 发现结果填入 providers
    // (providerId = native-<harness> 或 native-<harness>/<canonical>,model id = CLI 原始 id)。
    // selected 必须在目录内;不在说明发现结果与会话选择不一致,启动期失败而不是静默降级。
    const selections = new Map<string, PreparedModelRef>()
    for (const provider of request.providers) {
      for (const model of provider.models) {
        const ref: PreparedModelRef = {
          providerId: provider.providerId,
          modelId: model.id,
          // 哨兵模型映射为空 wire id:Driver.start 据此省略 modelId,
          // 让 CLI 用自己的默认模型(哨兵绝不下发)。
          harnessModelId: model.id === NATIVE_MODEL_ID ? "" : model.id,
        }
        selections.set(selectionKey(ref.providerId, ref.modelId), ref)
      }
    }
    const selected = selections.get(selectionKey(request.selected.providerId, request.selected.modelId))
    if (!selected) {
      throw new Error(
        `native 模型 ${request.selected.providerId}/${request.selected.modelId} 不在本机目录中`,
      )
    }
    return {
      sessionKey: request.sessionKey,
      harnessId: request.harnessId,
      mode: "native",
      env: {},
      strip: [],
      selections,
      selected,
      revision: 1,
      dispose: async () => {},
    }
  }

  async reconfigure(lease: SessionConfigLease, next: BentoModelSelection): Promise<ReconfigureResult> {
    // 目录内任意选择(同 Provider 换模型、跨 native Provider)都走 CLI 原生
    // 实时切换,进程不重启。
    const ref = lease.selections.get(selectionKey(next.providerId, next.modelId))
    if (ref) {
      // 哨兵模型没有 wire id,无法 live 下发:CLI 默认模型只能在新会话生效。
      if (!ref.harnessModelId) {
        return { mode: "new-session", reason: "CLI 默认模型无法会话内切换,需要新会话" }
      }
      return { mode: "live", selection: ref }
    }
    // 未登记选择:要么属于另一配置模式(bento Provider),要么已不在本机目录。
    // 两种情况都无法在当前进程内如实生效,明示需要新会话,禁止假切换。
    const reason = modeOfSelection(next) !== lease.mode
      ? "native↔Bento 模式之间切换需要新会话"
      : "该模型不在当前 native 会话目录中,需要新会话"
    return { mode: "new-session", reason }
  }
}
