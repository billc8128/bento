# Repository layout

- Read `docs/structure.md` before changing package or directory boundaries.
- `apps/bento` is the multi-Harness Electron application. `apps/website` owns the website frontend; its `.private/` production operations are ignored and must not be force-added.
- Keep app-specific dependencies and build configuration in the owning app. Root scripts are convenience entry points; workspace dependency policy and the lockfile live at the root.
- Keep `apps/bento/src/core` free of UI dependencies. Electron owns credentials, persistence, and processes; Renderer consumes the preload API.
- Prioritize simple changes. Do not extract shared packages until both applications actually need the same implementation.
- Tests live next to the code they verify. Directory-only changes must preserve behavior and validate imports, lint, tests, builds, and runtime asset packaging.
- Private architecture and research notes remain under `docs/internal/` and must not be published implicitly.
