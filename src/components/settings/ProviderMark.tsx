import { Server } from "lucide-react"

import ai21Icon from "@lobehub/icons-static-svg/icons/ai21-brand-color.svg"
import alibabaCloudIcon from "@lobehub/icons-static-svg/icons/alibabacloud-color.svg"
import antGroupIcon from "@lobehub/icons-static-svg/icons/antgroup-color.svg"
import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg"
import arceeIcon from "@lobehub/icons-static-svg/icons/arcee-color.svg"
import awsIcon from "@lobehub/icons-static-svg/icons/aws-color.svg"
import azureIcon from "@lobehub/icons-static-svg/icons/azure-color.svg"
import bailianIcon from "@lobehub/icons-static-svg/icons/bailian-color.svg"
import baiduIcon from "@lobehub/icons-static-svg/icons/baidu-color.svg"
import basetenIcon from "@lobehub/icons-static-svg/icons/baseten.svg"
import cerebrasIcon from "@lobehub/icons-static-svg/icons/cerebras-color.svg"
import cloudflareIcon from "@lobehub/icons-static-svg/icons/cloudflare-color.svg"
import cursorIcon from "@lobehub/icons-static-svg/icons/cursor.svg"
import deepinfraIcon from "@lobehub/icons-static-svg/icons/deepinfra-color.svg"
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg"
import devinIcon from "@lobehub/icons-static-svg/icons/devin-color.svg"
import fireworksIcon from "@lobehub/icons-static-svg/icons/fireworks-color.svg"
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg"
import githubCopilotIcon from "@lobehub/icons-static-svg/icons/githubcopilot.svg"
import groqIcon from "@lobehub/icons-static-svg/icons/groq.svg"
import huggingFaceIcon from "@lobehub/icons-static-svg/icons/huggingface-color.svg"
import kiloCodeIcon from "@lobehub/icons-static-svg/icons/kilocode.svg"
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi.svg"
import lmStudioIcon from "@lobehub/icons-static-svg/icons/lmstudio.svg"
import longCatIcon from "@lobehub/icons-static-svg/icons/longcat-color.svg"
import metaIcon from "@lobehub/icons-static-svg/icons/metaai-color.svg"
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg"
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg"
import modelScopeIcon from "@lobehub/icons-static-svg/icons/modelscope-color.svg"
import nousIcon from "@lobehub/icons-static-svg/icons/nousresearch.svg"
import novitaIcon from "@lobehub/icons-static-svg/icons/novita-color.svg"
import nvidiaIcon from "@lobehub/icons-static-svg/icons/nvidia-color.svg"
import ollamaIcon from "@lobehub/icons-static-svg/icons/ollama.svg"
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg"
import openCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg"
import openRouterIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg"
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg"
import siliconFlowIcon from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg"
import stepFunIcon from "@lobehub/icons-static-svg/icons/stepfun-color.svg"
import tencentCloudIcon from "@lobehub/icons-static-svg/icons/tencentcloud-color.svg"
import togetherIcon from "@lobehub/icons-static-svg/icons/together-color.svg"
import upstageIcon from "@lobehub/icons-static-svg/icons/upstage-color.svg"
import veniceIcon from "@lobehub/icons-static-svg/icons/venice-color.svg"
import vercelIcon from "@lobehub/icons-static-svg/icons/vercel.svg"
import vllmIcon from "@lobehub/icons-static-svg/icons/vllm-color.svg"
import volcengineIcon from "@lobehub/icons-static-svg/icons/volcengine-color.svg"
import xaiIcon from "@lobehub/icons-static-svg/icons/xai.svg"
import xiaomiIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg"
import zaiIcon from "@lobehub/icons-static-svg/icons/zai.svg"
import zenmuxIcon from "@lobehub/icons-static-svg/icons/zenmux.svg"
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg"

import { cn } from "@/lib/utils"

type LogoDefinition = {
  aliases: string[]
  src: string
  monochrome?: boolean
}

const LOGOS: LogoDefinition[] = [
  { aliases: ["openai-api", "openai-codex", "openai"], src: openAiIcon, monochrome: true },
  { aliases: ["anthropic-api", "anthropic", "claude"], src: anthropicIcon, monochrome: true },
  { aliases: ["aliyun-bailian", "qwen-token-plan", "bailian"], src: bailianIcon },
  { aliases: ["alibaba-model-studio", "alibaba-token-plan", "alibabacloud"], src: alibabaCloudIcon },
  { aliases: ["ant-ling"], src: antGroupIcon },
  { aliases: ["ai21"], src: ai21Icon },
  { aliases: ["arcee"], src: arceeIcon },
  { aliases: ["amazon-bedrock", "bedrock-mantle", "aws"], src: awsIcon },
  { aliases: ["azure-openai", "azure-ai-foundry", "azure"], src: azureIcon },
  { aliases: ["qianfan", "baidu"], src: baiduIcon },
  { aliases: ["baseten"], src: basetenIcon, monochrome: true },
  { aliases: ["cerebras"], src: cerebrasIcon },
  { aliases: ["cloudflare"], src: cloudflareIcon },
  { aliases: ["cursor"], src: cursorIcon, monochrome: true },
  { aliases: ["deepinfra"], src: deepinfraIcon },
  { aliases: ["deepseek"], src: deepseekIcon },
  { aliases: ["devin"], src: devinIcon },
  { aliases: ["fireworks"], src: fireworksIcon },
  { aliases: ["google-gemini", "google-vertex", "google-antigravity", "google-gemini-cli", "gemini"], src: geminiIcon },
  { aliases: ["github-copilot"], src: githubCopilotIcon, monochrome: true },
  { aliases: ["groq"], src: groqIcon, monochrome: true },
  { aliases: ["huggingface"], src: huggingFaceIcon },
  { aliases: ["kilocode"], src: kiloCodeIcon, monochrome: true },
  { aliases: ["kimi-code", "moonshot"], src: kimiIcon, monochrome: true },
  { aliases: ["lmstudio"], src: lmStudioIcon, monochrome: true },
  { aliases: ["longcat"], src: longCatIcon },
  { aliases: ["meta-ai"], src: metaIcon },
  { aliases: ["minimax"], src: minimaxIcon },
  { aliases: ["mistral"], src: mistralIcon },
  { aliases: ["modelscope"], src: modelScopeIcon },
  { aliases: ["nous"], src: nousIcon, monochrome: true },
  { aliases: ["novita"], src: novitaIcon },
  { aliases: ["nvidia"], src: nvidiaIcon },
  { aliases: ["ollama"], src: ollamaIcon, monochrome: true },
  { aliases: ["opencode"], src: openCodeIcon, monochrome: true },
  { aliases: ["openrouter"], src: openRouterIcon },
  { aliases: ["qwen-oauth", "qwen"], src: qwenIcon },
  { aliases: ["siliconflow"], src: siliconFlowIcon },
  { aliases: ["stepfun"], src: stepFunIcon },
  { aliases: ["tencentcloud"], src: tencentCloudIcon },
  { aliases: ["together"], src: togetherIcon },
  { aliases: ["upstage"], src: upstageIcon },
  { aliases: ["venice"], src: veniceIcon },
  { aliases: ["vercel"], src: vercelIcon, monochrome: true },
  { aliases: ["vllm"], src: vllmIcon },
  { aliases: ["volcengine"], src: volcengineIcon },
  { aliases: ["xai"], src: xaiIcon, monochrome: true },
  { aliases: ["xiaomi"], src: xiaomiIcon, monochrome: true },
  { aliases: ["zai"], src: zaiIcon, monochrome: true },
  { aliases: ["zhipu"], src: zhipuIcon },
  { aliases: ["zenmux"], src: zenmuxIcon, monochrome: true },
]

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function resolveLogo(name: string, brandKey?: string): LogoDefinition | undefined {
  const candidates = [brandKey, name].filter((value): value is string => Boolean(value)).map(normalize)
  return LOGOS.find(({ aliases }) => candidates.some((candidate) => aliases.some(
    (alias) => candidate === alias || candidate.startsWith(`${alias}-`),
  )))
}

export function ProviderMark({
  name,
  brandKey,
  className,
}: {
  name: string
  brandKey?: string
  className?: string
}) {
  const logo = resolveLogo(name, brandKey)

  return (
    <span
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg bg-muted p-1.5 text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {logo ? (
        <img
          src={logo.src}
          alt=""
          draggable={false}
          className={cn("size-full object-contain", logo.monochrome && "dark:invert")}
        />
      ) : (
        <Server className="size-full" strokeWidth={1.7} />
      )}
    </span>
  )
}
