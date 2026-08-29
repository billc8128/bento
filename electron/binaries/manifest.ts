export type ManagedBinaryName = "codex" | "codex-code-mode-host" | "kimi" | "opencode" | "omp" | "uv" | "uvx"

export type BinaryArtifact = {
  url: string
  sha256: string
  archive: "tar.gz" | "zip" | "binary"
  archiveEntry: string
  executable: string
}

export type BinaryManifestEntry = {
  version: string
  overrideEnv: string
  platforms: Partial<Record<string, BinaryArtifact>>
}

/**
 * 固定版本与摘要来自各项目的官方 GitHub Release。升级必须显式改本文件并验证 smoke。
 * 当前发行目标只有 macOS arm64；增加 electron-builder target 时同步补平台项。
 */
export const BINARY_MANIFEST: Record<ManagedBinaryName, BinaryManifestEntry> = {
  codex: {
    version: "0.149.1",
    overrideEnv: "BENTO_CODEX_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-aarch64-apple-darwin.tar.gz",
        sha256: "ed60f475c6dda6044c2c00fd7f33273cc3f3f98900ccd1204bfdf2fe935f3405",
        archive: "tar.gz",
        archiveEntry: "codex-aarch64-apple-darwin",
        executable: "codex",
      },
    },
  },
  "codex-code-mode-host": {
    version: "0.149.1",
    overrideEnv: "BENTO_CODEX_CODE_MODE_HOST_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-code-mode-host-aarch64-apple-darwin.tar.gz",
        sha256: "aae1c0c9459700a2e897adadd647351140ae7933ad73bd8d3af6505c69a4f3fd",
        archive: "tar.gz",
        archiveEntry: "codex-code-mode-host-aarch64-apple-darwin",
        executable: "codex-code-mode-host",
      },
    },
  },
  kimi: {
    version: "1.49.0",
    overrideEnv: "BENTO_KIMI_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin.tar.gz",
        sha256: "15018b20b203aee09658fdc64840c4846fc17c108d8dba1a19a95581d3ce2921",
        archive: "tar.gz",
        archiveEntry: "kimi",
        executable: "kimi",
      },
    },
  },
  opencode: {
    version: "1.18.21",
    overrideEnv: "BENTO_OPENCODE_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.21/opencode-darwin-arm64.zip",
        sha256: "72f4b6029af185eb030995cfa062d038914e3142c9aa38f714fe56448e6e87d2",
        archive: "zip",
        archiveEntry: "opencode",
        executable: "opencode",
      },
    },
  },
  omp: {
    version: "18.0.4",
    overrideEnv: "BENTO_OMP_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://github.com/can1357/oh-my-pi/releases/download/v18.0.4/omp-darwin-arm64",
        sha256: "d493163887bcf8f77b9991ab7219f77712b5b27de6564f7af7283064aca84824",
        archive: "binary",
        archiveEntry: "omp-darwin-arm64",
        executable: "omp",
      },
    },
  },
  uvx: {
    version: "0.12.6",
    overrideEnv: "BENTO_UVX_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://files.pythonhosted.org/packages/ef/5d/4c41b08b4e09729dd50f08b55238d5248a7bfb1a9f7cfba1c162046cfa1c/uv-0.12.6-py3-none-macosx_11_0_arm64.whl",
        sha256: "55bc16b317b2d6044c402e3b1f2c6a8daa031407e9efa7ecbf5348ac0a1c0df5",
        archive: "zip",
        archiveEntry: "uv-0.12.6.data/scripts/uvx",
        executable: "uvx",
      },
    },
  },
  uv: {
    version: "0.12.6",
    overrideEnv: "BENTO_UV_PATH",
    platforms: {
      "darwin-arm64": {
        url: "https://files.pythonhosted.org/packages/ef/5d/4c41b08b4e09729dd50f08b55238d5248a7bfb1a9f7cfba1c162046cfa1c/uv-0.12.6-py3-none-macosx_11_0_arm64.whl",
        sha256: "55bc16b317b2d6044c402e3b1f2c6a8daa031407e9efa7ecbf5348ac0a1c0df5",
        archive: "zip",
        archiveEntry: "uv-0.12.6.data/scripts/uv",
        executable: "uv",
      },
    },
  },
}
