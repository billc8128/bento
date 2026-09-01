/**
 * Agent 协作使用的只读 Harness/模型目录。
 *
 * 复用 ProviderRegistry 与新会话模型选择器的同一套过滤/默认规则，不建立第二份目录；
 * 输出只含可执行的结构化 ID 与公开元数据，不含凭证或 Harness 配置文件。
 */

import type {
  CollaborationHarnessOption,
  CollaborationModelOption,
  CollaborationSelection,
} from "../src/core/collaboration"
import { getHarness, HARNESSES, type HarnessId, type HarnessRuntimeStatus } from "../src/core/harness"
import {
  defaultModelSelection,
  modelsForProvider,
  providersForModelPicker,
  type ProviderView,
} from "../src/core/provider"
import type { CollaborationCatalog } from "./collaboration-service"

type ProviderCatalog = {
  list(options: {
    harnessId: HarnessId
    cwd?: string
    discover?: boolean
  }): Promise<ProviderView[]>
}

export class AgentSelectionCatalog implements CollaborationCatalog {
  constructor(
    private readonly providers: ProviderCatalog,
    private readonly runtimeStatuses: () => Promise<HarnessRuntimeStatus[]>,
    private readonly sessionCwd: (sessionId: string) => string | null,
  ) {}

  async listHarnesses(): Promise<CollaborationHarnessOption[]> {
    const statuses = new Map((await this.runtimeStatuses()).map((status) => [status.harnessId, status]))
    return HARNESSES.map((harness) => {
      const status = statuses.get(harness.id)
      return {
        id: harness.id,
        name: harness.name,
        usable: status?.usable ?? false,
        source: status?.source ?? "missing",
        ...(status?.version ? { version: status.version } : {}),
        effortSelection: harness.effortSelection,
        efforts: [...harness.efforts],
        defaultEffort: harness.defaultEffort,
      }
    })
  }

  async listModels(input: {
    callerSessionId: string
    harnessId: HarnessId
    cwd?: string
  }): Promise<CollaborationModelOption[]> {
    const cwd = input.cwd ?? this.sessionCwd(input.callerSessionId)
    if (!cwd) return []
    const providers = providersForModelPicker(
      await this.providers.list({ harnessId: input.harnessId, cwd, discover: true }),
      input.harnessId,
    ).filter((provider) => provider.connected)
    const defaultSelection = defaultModelSelection(providers, input.harnessId)
    const harness = getHarness(input.harnessId)

    return providers.flatMap((provider) => {
      const models = modelsForProvider(provider, input.harnessId)
      const providerDefaultId = provider.defaultModelIds?.[input.harnessId] ?? models[0]?.id
      return models.map((model): CollaborationModelOption => {
        const efforts = harness.effortSelection && model.reasoning !== false
          ? model.efforts?.filter((effort) => harness.efforts.includes(effort)) ?? [...harness.efforts]
          : []
        const defaultEffort = model.defaultEffort && harness.efforts.includes(model.defaultEffort)
          ? model.defaultEffort
          : harness.defaultEffort
        return {
          harnessId: input.harnessId,
          providerId: provider.id,
          providerName: provider.name,
          providerSource: provider.source as CollaborationModelOption["providerSource"],
          modelId: model.id,
          modelName: model.name,
          reasoning: model.reasoning,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          efforts,
          defaultEffort,
          providerDefault: model.id === providerDefaultId,
          default: provider.id === defaultSelection?.providerId && model.id === defaultSelection.modelId,
        }
      })
    })
  }

  async resolveSelection(input: {
    callerSessionId: string
    harnessId: HarnessId
    cwd?: string
    providerId?: string
    modelId?: string
  }): Promise<CollaborationSelection | null> {
    const models = await this.listModels(input)
    const candidates = models.filter((model) =>
      (!input.providerId || model.providerId === input.providerId) &&
      (!input.modelId || model.modelId === input.modelId))

    let selected: CollaborationModelOption | undefined
    if (!input.providerId && !input.modelId) {
      selected = candidates.find((model) => model.default)
    } else if (input.providerId && !input.modelId) {
      selected = candidates.find((model) => model.providerDefault) ?? candidates[0]
    } else if (!input.providerId && input.modelId) {
      selected = candidates.length === 1 ? candidates[0] : undefined
    } else {
      selected = candidates[0]
    }
    return selected
      ? {
          providerId: selected.providerId,
          modelId: selected.modelId,
          defaultEffort: selected.defaultEffort,
        }
      : null
  }
}
