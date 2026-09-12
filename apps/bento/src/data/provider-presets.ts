import type {
  ProviderCategory,
  ProviderHeaderRule,
  ProviderModelDiscovery,
  ProviderPreset,
  ProviderPresetAuth,
  ProviderPresetRuntime,
  ProviderRegion,
} from "@/core/provider-preset"
import { PROVIDER_SOURCES } from "@/data/provider-sources"

const bearer: ProviderHeaderRule = { header: "Authorization", prefix: "Bearer " }
const anthropicKey: ProviderHeaderRule = {
  header: "x-api-key",
  fixedHeaders: { "anthropic-version": "2023-06-01" },
}

type PresetInput = Omit<ProviderPreset, "sourceIds" | "directConnect"> & { directConnect?: boolean }

function define(input: PresetInput): ProviderPreset {
  return {
    ...input,
    directConnect: input.directConnect !== false,
    sourceIds: PROVIDER_SOURCES
      .filter((entry) => entry.canonicalId === input.id)
      .map((entry) => entry.sourceId),
  }
}

function httpModels(url: string, parser: Extract<ProviderModelDiscovery, { method: "http" }>["parser"] = "openai-list"): ProviderModelDiscovery {
  return { method: "http", url, parser }
}

function openAI(input: {
  id: string
  name: string
  baseUrl: string
  docsUrl: string
  credentialUrl?: string
  category?: ProviderCategory
  region?: ProviderRegion
  modelsUrl?: string | false
  modelsParser?: Extract<ProviderModelDiscovery, { method: "http" }>["parser"]
  auth?: ProviderPresetAuth
  requestPath?: string
}): ProviderPreset {
  const runtime: ProviderPresetRuntime = {
    baseUrl: input.baseUrl,
    wireProtocol: "openai-chat",
    ...(input.requestPath ? { requestPath: input.requestPath } : {}),
  }
  return define({
    id: input.id,
    name: input.name,
    category: input.category ?? "api",
    region: input.region ?? "global",
    docsUrl: input.docsUrl,
    ...(input.credentialUrl ? { credentialUrl: input.credentialUrl } : {}),
    auth: input.auth ?? { method: "apiKey", inference: bearer },
    runtimes: {
      "claude-code": runtime,
      codex: runtime,
      pi: runtime,
      kimi: runtime,
      opencode: runtime,
      omp: runtime,
      hermes: runtime,
      trae: runtime,
    },
    modelDiscovery: input.modelsUrl === false
      ? { method: "manual" }
      : httpModels(
          input.modelsUrl ?? `${input.baseUrl.replace(/\/$/, "")}/models`,
          input.modelsParser,
        ),
  })
}

function dual(input: {
  id: string
  name: string
  docsUrl: string
  claudeBaseUrl: string
  codexBaseUrl: string
  modelsUrl?: string | false
  region?: ProviderRegion
  category?: ProviderCategory
  codexProtocol?: "openai-chat" | "openai-responses"
  codexRequestPath?: string
  auth?: ProviderPresetAuth
}): ProviderPreset {
  return define({
    id: input.id,
    name: input.name,
    category: input.category ?? "api",
    region: input.region ?? "global",
    docsUrl: input.docsUrl,
    auth: input.auth ?? { method: "apiKey", inference: bearer },
    runtimes: {
      "claude-code": { baseUrl: input.claudeBaseUrl, wireProtocol: "anthropic-messages" },
      codex: {
        baseUrl: input.codexBaseUrl,
        wireProtocol: input.codexProtocol ?? "openai-chat",
        ...(input.codexRequestPath ? { requestPath: input.codexRequestPath } : {}),
      },
      pi: {
        baseUrl: input.codexBaseUrl,
        wireProtocol: input.codexProtocol ?? "openai-chat",
      },
      kimi: {
        baseUrl: input.codexBaseUrl,
        wireProtocol: input.codexProtocol ?? "openai-chat",
      },
      opencode: {
        baseUrl: input.codexBaseUrl,
        wireProtocol: input.codexProtocol ?? "openai-chat",
      },
      omp: {
        baseUrl: input.codexBaseUrl,
        wireProtocol: input.codexProtocol ?? "openai-chat",
      },
      hermes: {
        baseUrl: input.codexBaseUrl,
        wireProtocol: input.codexProtocol ?? "openai-chat",
      },
      // trae 不支持 responses wire:统一走 anthropic 端(与 claude-code 同一 base)
      trae: { baseUrl: input.claudeBaseUrl, wireProtocol: "anthropic-messages" },
    },
    modelDiscovery: input.modelsUrl === false
      ? { method: "manual" }
      : httpModels(input.modelsUrl ?? `${input.codexBaseUrl.replace(/\/$/, "")}/models`),
  })
}

function integration(input: {
  id: string
  name: string
  category: Extract<ProviderCategory, "cloud" | "account" | "runtime">
  docsUrl: string
  adapter: string
  region?: ProviderRegion
}): ProviderPreset {
  return define({
    ...input,
    region: input.region ?? "global",
    auth: { method: "adapter", adapter: input.adapter },
    runtimes: {},
    modelDiscovery: { method: "adapter", adapter: input.adapter },
    directConnect: false,
  })
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  define({
    id: "actual",
    name: "Actual Computer",
    category: "api",
    region: "global",
    docsUrl: "https://actual.inc",
    auth: { method: "apiKey", inference: bearer },
    runtimes: {
      codex: { baseUrl: "https://api.actual.inc/v1", wireProtocol: "openai-responses", requestPath: "/responses" },
      pi: { baseUrl: "https://api.actual.inc/v1", wireProtocol: "openai-responses" },
    },
    modelDiscovery: httpModels("https://api.actual.inc/v1/models"),
  }),
  openAI({ id: "aiand", name: "AI/AND", baseUrl: "https://api.aiand.com/v1", docsUrl: "https://aiand.com/" }),
  openAI({ id: "aimlapi", name: "AI/ML API", baseUrl: "https://api.aimlapi.com/v1", docsUrl: "https://docs.aimlapi.com/" }),
  openAI({ id: "alibaba-model-studio", name: "Alibaba Model Studio Global", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", docsUrl: "https://www.alibabacloud.com/help/en/model-studio/getting-started/first-api-call-to-qwen" }),
  openAI({ id: "aliyun-bailian-coding", name: "阿里云百炼 Coding Plan", baseUrl: "https://coding.dashscope.aliyuncs.com/v1", docsUrl: "https://help.aliyun.com/zh/model-studio/coding-plan", category: "plan", region: "cn" }),
  openAI({ id: "aliyun-bailian-token-plan-global", name: "Alibaba Token Plan Global", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", docsUrl: "https://www.alibabacloud.com/help/en/model-studio/", category: "plan" }),
  openAI({ id: "aliyun-bailian-token-plan-cn", name: "阿里云百炼 Token Plan（个人版）", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", docsUrl: "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview", category: "plan", region: "cn" }),
  openAI({ id: "aliyun-bailian-token-plan-team-cn", name: "阿里云百炼 Token Plan（团队版）", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", docsUrl: "https://help.aliyun.com/zh/model-studio/token-plan-team-overview", category: "plan", region: "cn" }),
  openAI({ id: "ant-ling", name: "蚂蚁 Ling", baseUrl: "https://api.ant-ling.com/v1", docsUrl: "https://www.modelscope.cn/models/inclusionAI/Ling-1T" }),
  define({
    id: "anthropic-api",
    name: "Anthropic API",
    category: "api",
    region: "global",
    docsUrl: "https://docs.anthropic.com/en/api/getting-started",
    credentialUrl: "https://console.anthropic.com/settings/keys",
    auth: { method: "apiKey", inference: anthropicKey, discovery: anthropicKey },
    runtimes: {
      "claude-code": { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
      pi: { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
      kimi: { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
      opencode: { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
      omp: { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
      hermes: { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
      trae: { baseUrl: "https://api.anthropic.com", wireProtocol: "anthropic-messages" },
    },
    modelDiscovery: httpModels("https://api.anthropic.com/v1/models", "anthropic-list"),
  }),
  openAI({ id: "arcee", name: "Arcee AI", baseUrl: "https://api.arcee.ai/api/v1", docsUrl: "https://docs.arcee.ai/" }),
  openAI({ id: "baseten", name: "Baseten", baseUrl: "https://inference.baseten.co/v1", docsUrl: "https://docs.baseten.co/development/model-apis/openai", modelsUrl: false }),
  openAI({ id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", docsUrl: "https://inference-docs.cerebras.ai/" }),
  openAI({ id: "commandcode", name: "CommandCode", baseUrl: "https://api.commandcode.ai/provider/v1", docsUrl: "https://commandcode.ai/", modelsUrl: "https://api.commandcode.ai/provider/v1/models" }),
  openAI({ id: "coreweave", name: "CoreWeave Inference", baseUrl: "https://api.inference.wandb.ai/v1", docsUrl: "https://docs.coreweave.com/docs/products/ai-inference" }),
  openAI({ id: "deepinfra", name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", docsUrl: "https://deepinfra.com/docs/openai_api", modelsUrl: "https://api.deepinfra.com/v1/openai/models?filter=true" }),
  dual({ id: "deepseek", name: "DeepSeek", docsUrl: "https://api-docs.deepseek.com/guides/anthropic_api", claudeBaseUrl: "https://api.deepseek.com/anthropic", codexBaseUrl: "https://api.deepseek.com", modelsUrl: "https://api.deepseek.com/models", region: "any" }),
  openAI({ id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", docsUrl: "https://docs.fireworks.ai/", modelsUrl: "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue", modelsParser: "fireworks-list" }),
  openAI({ id: "fireworks-firepass", name: "Fireworks Fire Pass", baseUrl: "https://api.fireworks.ai/inference/v1", docsUrl: "https://docs.fireworks.ai/firepass", category: "plan", modelsUrl: "https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue", modelsParser: "fireworks-list" }),
  openAI({ id: "gmi-cloud", name: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1", docsUrl: "https://docs.gmicloud.ai/", modelsUrl: false }),
  openAI({ id: "google-gemini-api", name: "Google Gemini API", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", docsUrl: "https://ai.google.dev/gemini-api/docs/openai" }),
  openAI({ id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", docsUrl: "https://console.groq.com/docs/overview" }),
  openAI({ id: "huggingface", name: "Hugging Face Inference Providers", baseUrl: "https://router.huggingface.co/v1", docsUrl: "https://huggingface.co/docs/inference-providers/guides/openai" }),
  openAI({ id: "kilocode", name: "Kilo Code", baseUrl: "https://api.kilo.ai/api/gateway", docsUrl: "https://kilocode.ai/docs/" }),
  dual({ id: "kimi-code", name: "Kimi Code", docsUrl: "https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents", claudeBaseUrl: "https://api.kimi.com/coding", codexBaseUrl: "https://api.kimi.com/coding/v1", category: "plan", region: "any", modelsUrl: "https://api.kimi.com/coding/v1/models" }),
  openAI({ id: "litellm", name: "LiteLLM Proxy", baseUrl: "http://127.0.0.1:4000/v1", docsUrl: "https://docs.litellm.ai/docs/proxy/quick_start", category: "local", region: "any", auth: { method: "none" } }),
  openAI({ id: "llamacpp", name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", docsUrl: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md", category: "local", region: "any", auth: { method: "none" } }),
  openAI({ id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", docsUrl: "https://lmstudio.ai/docs/app/api", category: "local", region: "any", auth: { method: "none" } }),
  dual({ id: "longcat", name: "LongCat", docsUrl: "https://longcat.chat/platform/docs/zh/", claudeBaseUrl: "https://api.longcat.chat/anthropic", codexBaseUrl: "https://api.longcat.chat/openai/v1", modelsUrl: "https://api.longcat.chat/openai/v1/models", region: "any" }),
  openAI({ id: "meta-ai", name: "Meta AI", baseUrl: "https://api.meta.ai/v1", docsUrl: "https://www.meta.ai/", modelsUrl: false }),
  dual({ id: "minimax-global", name: "MiniMax Global", docsUrl: "https://platform.minimax.io/docs/api-reference/responses-create", claudeBaseUrl: "https://api.minimax.io/anthropic", codexBaseUrl: "https://api.minimax.io/v1", codexProtocol: "openai-responses", codexRequestPath: "/responses", modelsUrl: false }),
  dual({ id: "minimax-cn", name: "MiniMax 中国大陆", docsUrl: "https://platform.minimaxi.com/docs/api-reference/responses-create", claudeBaseUrl: "https://api.minimaxi.com/anthropic", codexBaseUrl: "https://api.minimaxi.com/v1", codexProtocol: "openai-responses", codexRequestPath: "/responses", modelsUrl: false, region: "cn" }),
  openAI({ id: "minimax-code-global", name: "MiniMax Code Global", baseUrl: "https://api.minimax.io/v1", docsUrl: "https://platform.minimax.io/", category: "plan" }),
  openAI({ id: "minimax-code-cn", name: "MiniMax Code 中国大陆", baseUrl: "https://api.minimaxi.com/v1", docsUrl: "https://platform.minimaxi.com/", category: "plan", region: "cn" }),
  openAI({ id: "mistral", name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", docsUrl: "https://docs.mistral.ai/api/" }),
  dual({ id: "moonshot-global", name: "Kimi / Moonshot Global", docsUrl: "https://platform.moonshot.ai/docs/guide/agent-support", claudeBaseUrl: "https://api.moonshot.ai/anthropic", codexBaseUrl: "https://api.moonshot.ai/v1", modelsUrl: "https://api.moonshot.ai/v1/models" }),
  dual({ id: "moonshot-cn", name: "Kimi / Moonshot 中国大陆", docsUrl: "https://platform.moonshot.cn/docs/guide/agent-support", claudeBaseUrl: "https://api.moonshot.cn/anthropic", codexBaseUrl: "https://api.moonshot.cn/v1", modelsUrl: "https://api.moonshot.cn/v1/models", region: "cn" }),
  openAI({ id: "nanogpt", name: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", docsUrl: "https://nano-gpt.com/api" }),
  openAI({ id: "novita", name: "NovitaAI", baseUrl: "https://api.novita.ai/openai/v1", docsUrl: "https://novita.ai/docs/guides/llm-api" }),
  openAI({ id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", docsUrl: "https://docs.api.nvidia.com/nim/reference/llm-apis" }),
  openAI({ id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", docsUrl: "https://docs.ollama.com/api/openai-compatibility", category: "local", region: "any", auth: { method: "none" }, modelsUrl: "http://127.0.0.1:11434/api/tags", modelsParser: "ollama-tags" }),
  define({
    id: "openai-api",
    name: "OpenAI API",
    category: "api",
    region: "global",
    docsUrl: "https://platform.openai.com/docs/api-reference",
    credentialUrl: "https://platform.openai.com/api-keys",
    auth: { method: "apiKey", inference: bearer },
    runtimes: {
      "claude-code": { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-chat" },
      codex: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-responses", requestPath: "/responses" },
      pi: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-responses" },
      kimi: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-responses" },
      opencode: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-responses" },
      omp: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-responses" },
      hermes: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-responses" },
      trae: { baseUrl: "https://api.openai.com/v1", wireProtocol: "openai-chat" },
    },
    modelDiscovery: httpModels("https://api.openai.com/v1/models"),
  }),
  dual({ id: "opencode-go", name: "OpenCode Go", docsUrl: "https://opencode.ai/docs/go/", claudeBaseUrl: "https://opencode.ai/zen/go", codexBaseUrl: "https://opencode.ai/zen/go/v1", modelsUrl: "https://opencode.ai/zen/go/v1/models", category: "plan" }),
  dual({ id: "opencode-zen", name: "OpenCode Zen", docsUrl: "https://opencode.ai/docs/zen/", claudeBaseUrl: "https://opencode.ai/zen", codexBaseUrl: "https://opencode.ai/zen/v1", modelsUrl: "https://opencode.ai/zen/v1/models" }),
  dual({ id: "openrouter", name: "OpenRouter", docsUrl: "https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration", claudeBaseUrl: "https://openrouter.ai/api", codexBaseUrl: "https://openrouter.ai/api/v1", modelsUrl: "https://openrouter.ai/api/v1/models" }),
  openAI({ id: "qianfan", name: "百度千帆", baseUrl: "https://qianfan.baidubce.com/v2", docsUrl: "https://cloud.baidu.com/doc/WENXINWORKSHOP/" }),
  openAI({ id: "qwen-token-plan-global", name: "Qwen Token Plan Global", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", docsUrl: "https://www.alibabacloud.com/help/en/model-studio/", category: "plan" }),
  openAI({ id: "qwen-token-plan-cn", name: "Qwen Token Plan 中国大陆", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", docsUrl: "https://help.aliyun.com/zh/model-studio/", category: "plan", region: "cn" }),
  openAI({ id: "qwen-token-plan-individual", name: "Qwen Token Plan Individual", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", docsUrl: "https://www.alibabacloud.com/help/en/model-studio/", category: "plan" }),
  openAI({ id: "sakana", name: "Sakana AI", baseUrl: "https://api.sakana.ai/v1", docsUrl: "https://api.sakana.ai/" }),
  openAI({ id: "siliconflow-global", name: "SiliconFlow Global", baseUrl: "https://api.siliconflow.com/v1", docsUrl: "https://docs.siliconflow.com/en/userguide/quickstart" }),
  openAI({ id: "siliconflow-cn", name: "SiliconFlow 中国大陆", baseUrl: "https://api.siliconflow.cn/v1", docsUrl: "https://docs.siliconflow.cn/docs/userguide/quickstart", region: "cn" }),
  dual({ id: "stepfun", name: "StepFun", docsUrl: "https://platform.stepfun.ai/docs/en/step-plan/quick-start", claudeBaseUrl: "https://api.stepfun.ai/step_plan", codexBaseUrl: "https://api.stepfun.ai/step_plan/v1", modelsUrl: false, category: "plan" }),
  openAI({ id: "synthetic", name: "Synthetic", baseUrl: "https://api.synthetic.new/openai/v1", docsUrl: "https://docs.synthetic.new/" }),
  dual({ id: "tencentcloud-coding-plan", name: "腾讯云 Coding Plan", docsUrl: "https://cloud.tencent.com/document/product/1823/130092", claudeBaseUrl: "https://api.lkeap.cloud.tencent.com/coding/anthropic", codexBaseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3", modelsUrl: false, category: "plan", region: "cn" }),
  openAI({ id: "together", name: "Together AI", baseUrl: "https://api.together.ai/v1", docsUrl: "https://docs.together.ai/docs/inference/openai-compatibility" }),
  openAI({ id: "umans", name: "Umans", baseUrl: "https://api.code.umans.ai", docsUrl: "https://umans.ai/", modelsUrl: false }),
  openAI({ id: "upstage", name: "Upstage", baseUrl: "https://api.upstage.ai/v1", docsUrl: "https://console.upstage.ai/docs/getting-started/quick-start" }),
  openAI({ id: "venice", name: "Venice AI", baseUrl: "https://api.venice.ai/api/v1", docsUrl: "https://docs.venice.ai/" }),
  dual({ id: "vercel-ai-gateway", name: "Vercel AI Gateway", docsUrl: "https://vercel.com/docs/ai-gateway/coding-agents", claudeBaseUrl: "https://ai-gateway.vercel.sh", codexBaseUrl: "https://ai-gateway.vercel.sh/v1", modelsUrl: "https://ai-gateway.vercel.sh/v1/models" }),
  openAI({ id: "vllm", name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", docsUrl: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html", category: "local", region: "any", auth: { method: "none" } }),
  dual({ id: "volcengine-agent-plan", name: "火山方舟 Agent Plan", docsUrl: "https://docs.volcengine.com/docs/82379/2373738", claudeBaseUrl: "https://ark.cn-beijing.volces.com/api/plan", codexBaseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", modelsUrl: false, category: "plan", region: "cn" }),
  dual({ id: "volcengine-coding-plan", name: "火山方舟 Coding Plan", docsUrl: "https://www.volcengine.com/docs/82379/1925114", claudeBaseUrl: "https://ark.cn-beijing.volces.com/api/coding", codexBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", modelsUrl: false, category: "plan", region: "cn" }),
  openAI({ id: "wafer-serverless", name: "Wafer Serverless", baseUrl: "https://pass.wafer.ai/v1", docsUrl: "https://wafer.ai/" }),
  define({
    id: "xai-api",
    name: "xAI API",
    category: "api",
    region: "global",
    docsUrl: "https://docs.x.ai/docs/overview",
    auth: { method: "apiKey", inference: bearer },
    runtimes: {
      "claude-code": { baseUrl: "https://api.x.ai/v1", wireProtocol: "openai-chat" },
      codex: { baseUrl: "https://api.x.ai/v1", wireProtocol: "openai-responses", requestPath: "/responses" },
      pi: { baseUrl: "https://api.x.ai/v1", wireProtocol: "openai-responses" },
      trae: { baseUrl: "https://api.x.ai/v1", wireProtocol: "openai-chat" },
    },
    modelDiscovery: httpModels("https://api.x.ai/v1/models"),
  }),
  openAI({
    id: "xiaomi-mimo-api",
    name: "小米 MiMo API",
    baseUrl: "https://api.xiaomimimo.com/v1",
    docsUrl: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call",
    region: "any",
    auth: { method: "apiKey", inference: bearer, discovery: { header: "api-key" } },
  }),
  openAI({ id: "xiaomi-token-plan-ams", name: "小米 MiMo Token Plan AMS", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", docsUrl: "https://platform.xiaomimimo.com/token-plan", category: "plan" }),
  openAI({ id: "xiaomi-token-plan-cn", name: "小米 MiMo Token Plan 中国大陆", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", docsUrl: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call", category: "plan", region: "cn" }),
  openAI({ id: "xiaomi-token-plan-sgp", name: "小米 MiMo Token Plan Singapore", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", docsUrl: "https://platform.xiaomimimo.com/token-plan", category: "plan" }),
  openAI({ id: "yolo-auto", name: "YOLO Auto", baseUrl: "https://yolo-auto.com/v1", docsUrl: "https://yolo-auto.com/" }),
  dual({ id: "zai-api", name: "Z.ai GLM Global", docsUrl: "https://docs.z.ai/devpack/tool/claude", claudeBaseUrl: "https://api.z.ai/api/anthropic", codexBaseUrl: "https://api.z.ai/api/paas/v4" }),
  dual({ id: "zhipu-glm-cn", name: "智谱 GLM 中国大陆", docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/claude", claudeBaseUrl: "https://open.bigmodel.cn/api/anthropic", codexBaseUrl: "https://open.bigmodel.cn/api/paas/v4", region: "cn" }),
  dual({
    id: "zhipu-coding-plan-cn",
    name: "智谱 GLM Coding Plan",
    docsUrl: "https://docs.bigmodel.cn/cn/coding-plan/quick-start",
    claudeBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    codexBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    category: "plan",
    region: "cn",
  }),
  dual({ id: "zai-coding-plan-global", name: "Z.ai GLM Coding Plan Global", docsUrl: "https://docs.z.ai/devpack/overview", claudeBaseUrl: "https://api.z.ai/api/anthropic", codexBaseUrl: "https://api.z.ai/api/coding/paas/v4", category: "plan" }),
  dual({ id: "zenmux", name: "ZenMux", docsUrl: "https://docs.zenmux.ai/", claudeBaseUrl: "https://zenmux.ai/api/anthropic", codexBaseUrl: "https://zenmux.ai/api/v1", modelsUrl: false }),

  integration({ id: "amazon-bedrock", name: "Amazon Bedrock", category: "cloud", docsUrl: "https://docs.aws.amazon.com/bedrock/", adapter: "amazon-bedrock", region: "any" }),
  integration({ id: "azure-openai", name: "Azure OpenAI", category: "cloud", docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/", adapter: "azure-openai", region: "any" }),
  integration({ id: "azure-ai-foundry", name: "Azure AI Foundry", category: "cloud", docsUrl: "https://learn.microsoft.com/azure/ai-foundry/", adapter: "azure-ai-foundry", region: "any" }),
  integration({ id: "bedrock-mantle", name: "Amazon Bedrock Mantle", category: "cloud", docsUrl: "https://docs.aws.amazon.com/bedrock/", adapter: "bedrock-mantle", region: "any" }),
  integration({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", category: "cloud", docsUrl: "https://developers.cloudflare.com/ai-gateway/", adapter: "cloudflare-ai-gateway", region: "any" }),
  integration({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", category: "cloud", docsUrl: "https://developers.cloudflare.com/workers-ai/", adapter: "cloudflare-workers-ai", region: "any" }),
  integration({ id: "google-vertex", name: "Google Vertex AI", category: "cloud", docsUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs", adapter: "google-vertex", region: "any" }),
  integration({ id: "cursor", name: "Cursor", category: "account", docsUrl: "https://cursor.com/docs", adapter: "cursor" }),
  integration({ id: "devin", name: "Devin", category: "account", docsUrl: "https://docs.devin.ai/", adapter: "devin" }),
  integration({ id: "github-copilot", name: "GitHub Copilot", category: "account", docsUrl: "https://docs.github.com/copilot", adapter: "github-copilot" }),
  integration({ id: "gitlab-duo", name: "GitLab Duo", category: "account", docsUrl: "https://docs.gitlab.com/user/gitlab_duo/", adapter: "gitlab-duo" }),
  integration({ id: "google-antigravity", name: "Google Antigravity", category: "account", docsUrl: "https://cloud.google.com/gemini/docs/codeassist", adapter: "google-antigravity" }),
  integration({ id: "google-gemini-cli", name: "Google Gemini CLI", category: "account", docsUrl: "https://github.com/google-gemini/gemini-cli", adapter: "google-gemini-cli" }),
  integration({ id: "nous", name: "Nous Portal", category: "account", docsUrl: "https://nousresearch.com/", adapter: "nous" }),
  integration({ id: "ollama-cloud", name: "Ollama Cloud", category: "account", docsUrl: "https://ollama.com/", adapter: "ollama-cloud" }),
  integration({ id: "openai-codex", name: "OpenAI Codex 订阅", category: "account", docsUrl: "https://developers.openai.com/codex/", adapter: "openai-codex" }),
  integration({ id: "qwen-oauth", name: "Qwen Portal", category: "account", docsUrl: "https://portal.qwen.ai/", adapter: "qwen-oauth" }),
  integration({ id: "xai-oauth", name: "xAI SuperGrok", category: "account", docsUrl: "https://x.ai/", adapter: "xai-oauth" }),
  integration({ id: "custom", name: "自定义端点", category: "runtime", docsUrl: "https://github.com/billc8128/bento", adapter: "custom", region: "any" }),
]

export const DIRECT_PROVIDER_PRESETS = PROVIDER_PRESETS.filter((preset) => preset.directConnect)
export const SPECIAL_PROVIDER_PRESETS = PROVIDER_PRESETS.filter((preset) => !preset.directConnect)

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}
