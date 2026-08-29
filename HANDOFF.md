# Handoff · 交接文档(2026-08-24,v0.3.1)

> 给下一个接手的 agent。读完本文 + `PRODUCT.md` + `ARCHITECTURE.md` 即可开工。
> 治理规则:改任何扩展点契约,先改 ARCHITECTURE.md 再改代码。

## 0. 用户偏好(必须遵守)

- **始终用中文回复**(代码、命令、路径、标识符保持原文)
- **用成熟组件库,不手撕基础设施**(shadcn/dockview/ACP SDK 这个路线的由来)
- 验收方式:截图给用户看效果;UI 改动用 agent-browser 实测后再交付
- 用户是中重度 agent 用户,懂技术,汇报讲重点不用铺垫

## 1. 项目现状

开源 agent 工作台(Electron + Vite + React 19 + shadcn/ui + dockview + ACP)。
仓库:`github.com/billc8128/bento`(private,时机到了翻公开)。
本地路径 `~/Desktop/bento`(真实路径 `/Users/bcc/Desktop/bento`,同一处,git 正常)。

| 里程碑 | 状态 |
|---|---|
| v0.1 分层落地(core/views/theme,五套主题 graphite 默认) | ✅ |
| v0.2 dockview 受管布局 + 会话多实例 + 拖入分栏 + 布局持久化 | ✅ |
| v0.3 Electron 壳 + ACP 真会话 + 回放 + 离线续聊 + 会话管理 + 打包分发 | ✅ |
| v0.3.1 Driver 抽象 + 原生 Codex + model/effort + 受管二进制 | ✅ |

v0.3.1 新增:
- `electron/drivers/`:统一 `HarnessDriver`;ACP 与 Codex app-server 都翻译成
  `src/core/events.ts` 的 `HarnessEvent`
- `electron/binaries/`:Codex/Kimi/OpenCode 固定版本、SHA-256、首次使用下载;
  环境变量可覆盖绝对路径
- 会话真实持久化 `modelId / effort / capabilities`,只有底层支持时 UI 才允许热切

v0.3 三轮迭代全部完成并实测:
- 第一轮:kimi 全链路(建会话→流式→落盘)、重启后历史回放
- 第二轮(08-23):离线续聊恢复链(§2)、会话管理小件(§2)、glm 通道(§3)
- 第三轮(08-24):打包分发(§4)

## 2. 会话层机制(已完成,维护时别破坏)

`electron/sessions.ts`:

- **事件日志是唯一事实源**:`userData/sessions/<key>.jsonl` 追加落盘,
  `src/core/replay.ts` 纯函数 reducer,实时与回放同一条代码路径。
  seq 会话内单调;**恢复会话时 seq 从日志末尾续接**(reducer 按 seq 去重,
  重计数会让实时事件被 renderer 丢弃)。
- **离线续聊**:`ensureLive` 不在线时 lazy 恢复——重新 spawn + initialize,
  按 `sessionCapabilities.resume`(首选,不回放)→ `agentCapabilities.loadSession`
  (吞回放流,`LiveSession.loading` 标记防重复落盘)→ `session/new` + notice
  「上下文不保留,已开新上下文续接」降级。revive 并发去重;进程 exit 按
  引用判等防误删(同 key 重恢复的新连接不被旧进程 exit 杀掉)。
- **会话管理**:侧栏实时会话行 `…` 菜单(重命名/删除,`SidebarMenuAction`
  悬浮显形);删除 = 关布局面板 + `removeLive`(index 去项 + jsonl 删文件);
  空会话(无 user_message)关闭即删档,不留噪音。
- 权限 v0.3 自动放行是临时态,真权限 UI 与插件工具同期(v0.5)。

## 3. Claude Code 通道

- Claude Code 已改用 `@anthropic-ai/claude-agent-sdk`;旧 `glm` harness 记录恢复时
  一次性迁移为 `claude-code` + 明确 provider。
- Agent SDK 仍启动 Claude Code 子进程,但 Bento 只通过 SDK 的结构化消息、resume、
  interrupt 与权限回调交互,不再维护 Claude ACP 私有协议。
- 每次启动都剥宿主 `ANTHROPIC_*` / `CLAUDE_CODE_*`,只使用
  ProviderRoutingService 注入的 loopback env 与隔离 `CLAUDE_CONFIG_DIR`。

## 3.5 Provider 目录与 RuntimePicker(2026-08-25)

- `electron/providers.ts`:按 (harnessId,cwd) 缓存的 provider/模型发现 IPC,
  非 refresh 不重复 spawn 发现进程。
- `src/core/provider.ts`:ProviderView/ProviderModel 纯类型 + findProviderModel/
  modelsForProvider;`src/lib/provider-store.ts` 分 key snapshot,
  `useProviderCatalog(harness,cwd)` 管单 harness,`useAllProviderCatalogs(cwd)`
  聚合全部 harness(当前的立即发现,其余 400ms 错峰)。
- `HarnessPicker` 与 `RuntimePicker` 两处复用:先选 Harness，再在模型面板中只列该
  Harness 的 Provider/Model。新会话默认 Pi；已有会话切 Harness 会打开新会话页，
  不复用原 driver 上下文。`RuntimePicker session` 保留紧凑触发器和 effort 门控。
- 交互:搜索 autoFocus;hover 行 120ms 飞出详情卡;点档位一次落定
  (harness, provider, model, effort);键盘 ↑↓ 移动、→ 进卡、Enter 落定、Esc 关。
- 选中态一律 `ring-1 ring-foreground/30` 描边,不用黑底(黑底吃掉深色 harness
  图标);胶囊/小按钮用 `src/components/ui/flow-button.tsx`(arrows=false
  invert=false)。
- 「由 X 决定」文案已全面移除:无显式模型时触发器回显 harness.name。
- 会话内改模型/effort 仍受 capabilities 门控(`modelSwitch/effortSwitch ===
  "live"` 且非 running),ChatPane 传 `setLiveModel/setLiveEffort`;
  会话内选择器只列本会话 harness 的模型(单 harness 目录天然过滤)。
- Pi user provider 由 `ProviderRoutingService.piProviderEnv` 生成隔离 `models.json`，
  API Key 只进 `BENTO_PROVIDER_KEY` 环境；Pi wire model id 为 `bento/<model>`，
  会话内跨 Provider 切换会被拒绝并要求新会话。

### 3.6 Provider 管理与预设目录(2026-08-26)

- `src/data/provider-sources.ts`:Pi/OMP/Hermes/Cindy/OpenCode 的 127 个原始 provider id
  完整映射；`src/data/provider-presets.ts`:94 个 canonical Provider，其中 75 个
  API/套餐/本地预设可直接配置，7 个云平台和 11 个账户项走专用检测/鉴权流程。
- `src/core/provider-preset.ts`:preset/auth/discovery/source 公共契约；模型发现支持
  OpenAI、Anthropic、Fireworks、Ollama parser，推理与 discovery 可声明不同 Header。
- `electron/provider-import.ts`:只在 main 扫 Pi/OpenCode `auth.json` 与 Hermes `.env`；
  renderer 只拿脱敏候选，API Key 确认后才复制到 safeStorage，OAuth 不复制。
- `ProvidersSection` 是正式双栏供应商管理页；添加弹窗搜索 canonical Provider，预设
  只填 Key，自定义端点保留协议/Base URL/精确路径/Header/列表解析；模型 `enabled`
  开关直接控制 RuntimePicker 可见性。
- Pi/OMP/OpenCode 的 `provider/model` 发现结果按 canonical Provider 拆分后仅供
  “检测本机供应商”展示；`source:"runtime"` 被模型选择器和“我的供应商”过滤，
  必须由用户明确导入或重新鉴权后才能使用。

### 3.6.1 本机优先的 Harness Runtime(2026-08-26)

- `electron/harness-runtime.ts` 统一解析 Codex/Claude/Kimi/OpenCode/OMP/Pi/Hermes：
  显式 `BENTO_*_PATH` → 本机 `PATH` → Bento bundled/managed。设置页“运行环境”只显示
  来源与版本并支持重新检测；不会因为打开页面或模型选择器安装 CLI。
- 本机 CLI 存在时，Provider Registry 发布 `source:"native"` 的
  `native-<harness>`。Codex/ACP/Pi 会枚举 CLI 实际模型并优先选 CLI 当前项；Claude
  Code 展示公开的 fable/opus/sonnet 稳定别名并保留默认项。`SessionManager` 不把内部哨兵
  model id 下发，也不创建 Bento Provider 路由，真实模型 id 则按原生协议下发。
- native 与 Bento 配置不是互斥能力：用户即使已安装 CLI，也能从设置页唯一的
  “添加模型”入口添加预设或自定义 Provider。显式选择 user/builtin Provider 后，
  Kimi/OpenCode/OMP/Hermes 使用 `ProviderRoutingService.configuredHarnessEnv` 生成
  隔离配置，Pi 继续使用 `piProviderEnv`。
- 用户在使用期间删除 CLI：新会话不再显示 native Provider；已保存 native 会话在
  bundled/managed runtime 可用时继续启动，并复用仍留在用户目录里的 CLI 配置。
- Hermes 是首个专门验证缺口路径的 Harness：有本机 `hermes` 就直接用；没有时首次
  启动已配置模型的会话才下载固定 uv/uvx，并以 Python 3.12 启动固定版本
  `hermes-acp`。不要把安装放回发现/Picker 路径。
- builtin/native Provider 的模型开关按 model id 全局持久化在
  `providers/model-visibility.json`，因此 OAuth 下关闭 GPT-5.5 时本机 CLI 的同 id
  也同步隐藏；旧版 per-provider 文件自动并集迁移。user Provider 继续使用自身模型
  `enabled`。供应商设置页左侧只列 canonical Provider：runtime id 按
  `runtime-<harness>-<canonical>` 后缀合并，OMP/OpenCode/Pi 只作为右侧来源下拉项，
  不能作为供应商行。OpenAI/Anthropic/Kimi 同样聚合 OAuth/API Key 与本机来源；每次
  只显示所选来源的准确模型目录，不把不同 wire id 强行混成一张表。
  **runtime ACP/Pi 模型目录是内置 catalog，不等于已配置**：必须再与
  `scanLocalProviders()` 返回的 source+presetId 脱敏候选相交。不要因为 OpenCode
  catalog 或进程继承了 `GITHUB_TOKEN` 就展示 GitHub Copilot；实际 auth/config 没有的
  OpenCode Zen、Anthropic API 等同样过滤。
- `ProviderModelCache` 把成功发现结果持久化到 `providers/model-cache.json`；设置页打开先读
  本地缓存，再静默错峰 `discoverAll(..., true)`。切供应商不触发发现；模型开关调用
  `applyProviderModelVisibility` 原地更新所有 snapshot，禁止再用 `providers:changed` 清空
  列表。Provider CRUD 的 changed 事件也只后台 refetch，保留旧内容直到新目录返回。
- user Provider 刷新兼容旧配置：没有 `modelsUrl` 时按 runtime Base URL 推导 `/models`，
  去重候选并优先尝试显式地址和 `/vN` Base URL；首个成功列表合并到所有 runtime。
  Kimi Code 预设的模型地址固定为 `https://api.kimi.com/coding/v1/models`，实测返回
  `kimi-for-coding`、`kimi-for-coding-highspeed`、`k3`、`k3-256k`。

### 3.7 供应商设置页 UIUX 重做(2026-08-26)

- **入口合一**:独立的「检测本机供应商」按钮/弹窗已删,检测并入添加向导
  (`ProviderWizard` 第一步顶部「从本机配置导入」卡片),`DetectLocalProviders`
  是显式状态机 scanning → list → detail → importing;凭证不可复制的候选给
  「手动配置」出口,0 模型可手填后再导入,不再有死路。
- **动作落点**:向导 `onSaved(providerId?)` 回传 id,保存/导入后父级选中新供应商
  + `toast.success`(`src/lib/toast.ts` 极简模块级 store,`Toaster` 挂 App 根部)。
- **模型可见性开关**:乐观更新 + 800ms 防抖合并一次 `saveCustomProvider`,
  失败回滚 + toast;不再每击一次全量写盘。
- **ProviderForm 减负**:统一单块表单(名称/key/Base URL/模型清单各一份),
  内部仍是 per-harness runtimes 状态,统一字段是「写到所有启用 harness」的透镜
  (`patchAll`);各 harness 分歧时「按 Harness 分别配置」自动展开;高级设置默认
  收起,校验打到其字段时自动展开;slug 挪进高级,纯中文名 slugify 为空时静默
  兜底随机标识;填好 Base URL 后 800ms 防抖自动拉模型(缺 key 先给提示)。
- **ProviderMark 品牌化**:`src/components/settings/ProviderMark.tsx` 按 preset id /
  名字命中品牌色,未知供应商按名字哈希取色。
- **provider-store 修复**:`onProvidersChanged` 会把 catalog 快照置空,
  `useAllProviderCatalogs` 的初始拉取 effect 依赖加了 snapshot,否则设置页在
  CRUD 后内置供应商消失直到重载。
- **检测覆盖补全(2026-08-26 二轮)**:`LocalProviderScanner` 新增 OMP
  `~/.omp/agent/models.json`(随机 UUID provider 按 baseUrl 主机名反查预设)与
  Kimi Code CLI 登录态(OAuth 不可复制,只出「需要重新鉴权」候选);
  `provider-sources.ts` 补 `agent-plan`/`ark-agent-plan`/`glm-coding-plan`/
  `zai-coding-plan` 四条映射,`ProviderSource` 联合加 `opencode`;
  「添加自定义端点」入口卡片提到向导顶部(与「从本机配置导入」并列);
  omp 候选的模型清单直接取 models.json 自带 models(inspect 优先于预设静态/HTTP 发现),
  scanner 侧 `localModels(candidateId)` 与 credential 一样只留 main、不进扫描结果。
  注意:dev 手起 electron 前必须 `pnpm build`,`dist-electron/main.js`
  不会随 vite dev 自动重建。

## 4. 打包分发(已完成,2026-08-24)

- `pnpm dist:dir` 快构(`release/mac-arm64/Bento.app`);
  `pnpm dist` 出 dmg(`release/Bento-<version>-arm64.dmg`,166M,
  Developer ID 签名,未公证——翻公开前要配 notarize)。
- **pnpm 必须 hoisted**:`.npmrc` 里 `node-linker=hoisted`,electron-builder
  吃不了 pnpm 符号链接;改这个要完整重装 node_modules。
- PATH 坑已解:`electron/main.ts` 里 `app.isPackaged` 时跑 `fixPath()` +
  兜底拼 `~/.local/bin`、`~/.kimi-code/bin`、`~/.opencode/bin`、
  `~/.cargo/bin`(存在才加)。打包版 glm/kimi 冒烟(含离线续聊)+
  UI 实测全过,无 ENOENT。
- 图标:`build/icon.png`(qlmanage 从 `public/favicon.svg` 转的 512 png,
  够用;正式发布前建议换全套 icns)。
- `.gitignore` 已加 `release`、`build`、`dist-electron/*.mjs`。

## 5. 接下来做什么

v0.4 插件加载器(见 ARCHITECTURE.md §7,plugin-api v1 冻结前先把内部折腾稳)、
布局预设导出(v0.2 欠的小尾巴)、composer 附件真上传(现在只是 UI)、
公证(notarize)配置(翻公开前)。

## 6. 代码地图(30 秒版)

```
electron/main.ts        窗口 + IPC(create/prompt/cancel/close/list/events/rename/remove);
                        BENTO_SMOKE=1 主进程自测,BENTO_SMOKE_RESUME=1 追加离线续聊,
                        BENTO_SMOKE_HARNESS 选 harness(默认 glm);isPackaged 时 fix-path
electron/sessions.ts    SessionManager:spawn ACP 子进程、事件日志双写、
                        lazy 恢复链(ensureLive/reviveSession)、重命名/删除/空会话删档、glm env 注入
electron/preload.ts     contextBridge → window.bento(纯 web 下不存在,全要降级)
src/core/replay.ts      事件日志 → 消息流 reducer(纯函数)。实时=回放,别写第二份
src/core/harness.ts     harness 描述符(glm 已加),live 标记 = 有无 ACP 入口(codex 没有)
src/lib/live-store.ts   renderer 真会话 store(经 window.bento;renameLive/removeLive)
src/lib/layout-store.ts 布局控制器(openSession/close/reset/受管模式)
src/lib/panel-context.ts 面板实例状态(sessionId 按面板下发,不是全局)
src/views/DockWorkspace.tsx dockview 宿主:受管/自由两档、外部拖入、布局持久化
src/views/ChatPane.tsx  core.chat view:真会话/mock 双分支
src/components/RuntimePicker.tsx 运行配置选择器:新建页全功能 + 会话内 session 模式(§3.5)
src/lib/provider-store.ts provider/模型发现 store:useProviderCatalog(单)+ useAllProviderCatalogs(聚合)
src/components/AppSidebar.tsx 侧栏:实时会话行(含 … 菜单:重命名/删除)、mock 项目分组
src/data/mock.ts        展示用假数据(纯 web 模式的内容),别删
src/styles/themes.css   全部主题 token + dockview 变量桥(dockview-theme-bento)
scripts/acp-smoke.mjs   纯 Node ACP 冒烟:node scripts/acp-smoke.mjs kimi acp
```

## 7. 本机踩过的坑(重要,别再踩)

1. **Claude 子进程必须清洗 `CLAUDECODE` / `CLAUDE_CODE_*` 与宿主
   `ANTHROPIC_*`**——Agent SDK 仍会启动 Claude Code,不清洗会触发嵌套检测或串凭证。
2. Claude Agent SDK 必须作为 external 保留包目录,否则打包后找不到内置 `cli.js`。
3. **preload 必须 CJS + `.cjs` 后缀**——vite-plugin-electron 默认吐 CJS 内容的
   .mjs,ESM loader 直接炸,已在 vite.config.ts 强制 format cjs。
4. **dockview 主题要走 `theme` 选项**传 `{ name, className }`,只在外层包 class
   会被它默认的 abyss 主题类覆盖。
5. pnpm 10 构建脚本要审批:package.json 已配 `pnpm.onlyBuiltDependencies`,
   electron 二进制缺了就 `node node_modules/electron/install.js`。
6. **shell 管道 `| tail` 会缓冲**,长跑进程看不到输出;测试输出直接重定向到文件。
7. dev 模式 HMR 会换模块实例,layout-store 一类模块级单例的注册会"丢"——
   是开发态假象,整页刷新即恢复,别当 bug 修。
8. Electron E2E:`pnpm exec electron . --remote-debugging-port=9333` 然后
   `agent-browser connect 9333`,其余同 web(snapshot/click/screenshot)。
   **后台起 app 要 `nohup ... & disown`**,裸 `(... &)` 会被 shell 收尾杀掉。
9. React 受控 textarea 灌值要用 native setter + dispatchEvent('input')。
10. **改 IPC/preload 后要重新 `pnpm build` 再起 app**——main/preload 是构建产物,
    renderer 的 window.bento 方法列表是 preload 决定的,旧进程里没有新方法。
11. edit 工具 PUT 行号要看清落点,曾有两次误删(readEvents handler、
    preload closeSession/removeSession)都是行号错位造成的——改完跑 tsc 能兜住。
12. 打包:`electron-builder` 首次跑要下载 electron zip(慢),CI 检测会触发
    implicit publish 警告,加 `--publish never`。
13. **用户日常用的是 `/Applications/Bento.app` 安装版**,不是 dev 进程。改完 UI
    要在安装版生效:`pnpm dist:dir` → `kill $(pgrep -f "/Applications/Bento.app/Contents/MacOS/Bento")`
    → `rm -rf /Applications/Bento.app && cp -R release/mac-arm64/Bento.app /Applications/`
    → `open -a Bento`。
14. **Electron 的 `-webkit-app-region:drag` 不遵守普通 z-index**。全屏设置页虽然视觉上
    盖住 AppSidebar，底层 drag rect 仍会截获鼠标；设置打开时用
    `data-settings-open` 把 `.app-window-drag` 全部切成 `no-drag`，不要只扩大按钮 DOM。

## 8. 测试工作流

```bash
pnpm dev:web          # 纯浏览器跑 UI(mock),调主题/布局最快
pnpm build            # tsc -b + vite build(renderer + main + preload)
pnpm exec electron . --remote-debugging-port=9333   # 桌面版(生产构建)
BENTO_SMOKE=1 BENTO_SMOKE_RESUME=1 pnpm exec electron .    # main 自测(默认 glm,含离线续聊)
BENTO_SMOKE=1 BENTO_SMOKE_HARNESS=kimi pnpm exec electron . # kimi 回归
pnpm dist:dir         # 快构打包版
pnpm dist             # 打 dmg
node scripts/acp-smoke.mjs kimi acp                 # 纯 Node ACP 冒烟
```

测试主力 **glm**(智谱,全链路可用);kimi 也全链路可用做回归;
claude-code 通道仍是 402(用户账号无 Claude 余额),只能验到 session/new。

改完必过:`pnpm exec tsc -b --noEmit` + `pnpm build` + 关键路径 agent-browser 实测。

## 9. 与用户已对齐的关键决策(别推翻)

- 定位:中重度 agent 用户 + 开发者;行业用户等工件层(ARCHITECTURE §8,未立项,禁止抢跑)
- 布局:受管模式默认(对标 Claude Code/Codex 桌面版),自由停靠 opt-in
- L4(聊天流/composer)基线自留但**不是永久冻结**
- 主题五套,graphite 默认;主题=token+traits 双层,纯换色不收
- 权限:v0.3 自动放行是临时态,真权限 UI 与插件工具同期(v0.5)
- 测试通道:glm(智谱)为主,kimi 回归;claude-code 402 只验建会话
