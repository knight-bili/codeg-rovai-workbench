# AGENTS.md

## Project documentation

- Documentation map, authority boundaries, and task-based reading rules: [`docs/README.md`](docs/README.md). Read this first for architecture, implementation, planning, or documentation work.
- Current version architecture and implementation status: follow the canonical `current_version` pointer and `current` row in [`docs/versions/README.md`](docs/versions/README.md); do not hard-code a version path here.
- When creating a version or changing `current_version`, follow the canonical [version transition checklist](docs/versions/README.md#版本切换清单) and record every conclusion in the new version overview.
- Current cross-version architecture navigation: [`docs/architecture/README.md`](docs/architecture/README.md); current authority and decision-rationale routing: [`docs/decisions/CURRENT.md`](docs/decisions/CURRENT.md); decision admission and historical governance: [`docs/decisions/README.md`](docs/decisions/README.md).
- Do not create numbered ADR files. When adding or changing a Version Decision, Architecture, Contract, version document, or documentation route, run the generic documentation gates described in [`docs/decisions/README.md#自动治理`](docs/decisions/README.md#自动治理). Do not add feature-, version-, or Skill-specific checker exceptions.
- Local environment, development run, tests, and macOS builds: [`docs/development/README.md`](docs/development/README.md).
- Before adding, merging, permanently disabling, or deleting Rust tests, follow the canonical
  [Rust test admission and retirement policy](docs/development/testing.md#rust-测试准入与退役门槛).
- Before starting Electron, `rovai-core`, a packaged App, or a real Runtime, read and follow
  [`docs/development/local-workflow.md`](docs/development/local-workflow.md). Use `pnpm dev` rather than
  bare `electron-vite dev`; never run the daily App from `dist/`, and never point development or acceptance
  processes at daily Electron `userData`.
- Do not treat historical version documents as current constraints, and do not infer implementation completion from historical decision status. Follow the conflict rules in `docs/README.md`.

## Frontend design

- 一期全部页面与复杂弹窗必须遵循客户明确指定的 [原应用源码 UI 规则](integration/ui-source-policy.md)：参考固定 Codeg/Rovai 原组件与交互，优先复用，禁止无依据原创发挥；允许有具体依据的优化，但不得降低视觉、功能和使用体验。每页要有真实运行的同场景对照；代码检查不替代视觉检查，不新增客户逐页技术验收门槛。

- For any UI/UX or renderer-facing change, read [`DESIGN.md`](DESIGN.md) and
  [`docs/ui/README.md`](docs/ui/README.md) first.
- Read `PRODUCT.md`, when it exists, only when the task depends on users, product purpose,
  positioning, terminology, or durable brand commitments.
- When a matching `apps/desktop/.impeccable/surfaces/*.md` brief exists for a Renderer target, use
  it as local surface strategy. It cannot override current Architecture, Contracts, current version scope,
  `DESIGN.md`, or theme contracts.
- Impeccable is optional provider-local tooling. It may be installed under the current coding
  agent's native skill directory; do not assume `.agents/skills/impeccable`, a slash command, or a
  specific provider.
- When native skill discovery is unavailable, read the installed `impeccable/SKILL.md` and its
  referenced files directly. The skill is not a repository authority.
- Do not install or enable Impeccable hooks or plugins without explicit user approval.
- Incremental work preserves the established Rovai AI visual world. Do not enter a
  replacement-world flow unless the user explicitly requests a redesign.

## Codeg 与 Rovai 融合项目

- 融合范围、阶段及验收先读 [integration/README.md](integration/README.md)，完整一期终点不得缩减。
- 当前I01状态见 integration/foundation/README.md；current_version仍指向源骨架，不表示融合交付状态。
- 中文回复和中文提交，不加工具署名，main由客户验收控制。
- 融合期执行频率以 [阶段批量验证规则](integration/ci-cost-policy.md#阶段版本与验证频率) 为准：小切片先编码、自审和最低成本检查，多次本地提交；阶段编码集齐后冻结候选版本，集中编译/回归、少量推送和 Actions。不要按每个切片自动推送、全量编译或等待 CI。
- CodeGraph仅用已有索引，缺索引使用文件查询；不隐式初始化，源码改动后同步已有索引。
- 2026-10-16 客户已明确授权两份固定供体和当前融合工程建立本地 CodeGraph 索引；实际路径、源码提交与 UI 参考规则见 [画布源码参考](integration/inventory/canvas-ui-reference.md)。三处索引现已建立，优先查询；此授权不扩展到其他仓库或全局 MCP 配置。
