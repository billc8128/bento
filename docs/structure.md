# Repository structure

This workspace contains two application packages. Root `pnpm dev`, `test`, `lint`, `build`, and `dist` commands continue to target the existing Bento desktop application.

```text
apps/
  bento/                  Existing multi-Harness Electron application
    electron/             Main process and preload
      apps/               MCP host, Harness App adapters, runtime relay assets
      binaries/           Managed executable distribution
      collaboration/      Cross-session coordination and UI commands
      drivers/            Harness process/protocol adapters
      permissions/        Permission rule persistence
      platform/           Updates, local attachments, filesystem helpers
      providers/          Catalog, discovery, credentials, model proxy/routing
      runtime/            Harness resolution and bundled Pi entry
      session-config/     Isolated per-session Harness configuration
      sessions/           Session lifecycle, history, project registry
      skills/             Skill discovery and delivery
    src/
      core/               UI-independent domain types and event replay
      components/         Renderer components; ui/ contains base controls
      views/              Panel views, registration, DockWorkspace
      lib/                Renderer services grouped by domain
        appearance/       Theme and presentation contexts
        apps/             Apps state
        i18n/             Translations and localization
        providers/        Provider state and import flow
        sessions/         Live/new-session state and session preferences
        settings/         App settings and profile preferences
        workspace/        Layout, panel context, workspace tools
      data/               Product catalogs and theme definitions
      styles/             Stylesheets and theme tokens
    build/                Tracked packaging icons and entitlement plists
    scripts/              App-specific development and install helpers
  website/                Static website source and preview configuration
docs/
  structure.md            Maintained public structure and development guide
  internal/               Ignored local architecture, design, and research notes
patches/                  Workspace dependency patches
promo/                    Marketing production work and website design variants
```

No shared `packages/` abstraction exists yet. Both applications own their dependencies; a shared package should follow demonstrated reuse, not precede it.

## Architectural boundaries

- `src/core` defines Harness, Provider, Model, session events, and pure replay independently from React and Electron.
- Electron Main owns credentials, routing, persistence, process lifecycle, and workspace tools. Drivers translate protocols into the common event vocabulary; they do not own a second history or Provider store.
- Preload exposes the restricted `window.bento` API. Renderer state consumes that API and does not import main-process implementation.
- Layout and panel context belong to the Renderer. Each conversation panel binds an explicit session; focus and the set of open sessions are separate state.
- Tests stay beside their implementation, including inside each new domain folder. Generated builds and application data stay out of Git.

## Commands

Run from the repository root:

```sh
pnpm install
pnpm dev
pnpm dev:web
pnpm test
pnpm lint
pnpm build
pnpm dist:dir
pnpm dev:website
```

For app-specific CLI arguments, use `pnpm --dir apps/bento exec ...` or `pnpm --dir apps/website ...`. Bento build outputs now live in `apps/bento/dist`, `apps/bento/dist-electron`, and `apps/bento/release`. Keep runtime `.mjs` relay assets in the electron-builder file list when moving them; they are loaded at runtime rather than bundled into main.

The root `.npmrc` retains Bento's hoisted dependency layout for Electron packaging. Native helper setup resolves `node-pty` through Node's package resolution so it works with workspace hoisting. Installation policy and dependency patches belong to the root package.

Electron is pinned to the existing installed version, 43.4.1: electron-builder cannot infer a ranged version from the app-local node_modules when dependencies are hoisted. `pnpm pack:check` creates an unsigned local macOS application without publishing.

## Local-only material

Generated output, local experiments, and internal notes are excluded from version control and application packaging.

## Website

`apps/website` contains the static website source. Preview it with `pnpm dev:website`; no build step is required. See the [website guide](../apps/website/README.md).
