---
document_type: architecture
authority: integration-canvas-boundaries
last_updated: 2026-10-14
---

# Codeg canvas integration

I03 ports multi-board navigation and all eight Codeg node kinds: folder, group, agent,
conversation, custom, note, file and terminal. The [full plan](../../integration/planning/plan-v4.md)
and C12/C13/C14 acceptance cases remain the completion boundary. A board API is foundation work,
not a substitute for interactive nodes, task execution or cross-platform qualification.

## Authority and migration

Use Rovai Core's SQLite, typed Domain Command Gateway and authenticated Host transport.
Board identity and metadata are owned by [Canvas Boards v1](../contracts/canvas-boards-v1.md).
Schema152/Migration202 appends one table to schema151 without changing previous model, skill,
member, Mission or Thread facts. Retain the closed source-contract and existing command-result
replay; do not copy Codeg's database or SeaORM/Tauri lifecycle into the Core.

Each mutation validates the User scope and exact board revision in the existing write transaction.
Commit a small invalidation event and the first command result together. Each read captures its
through-sequence and rows in one transaction. Reconnect, gap and stale responses cause a refetch;
they do not authorize clients to rebuild a state store from event payloads.

## Remaining node and interaction work

The next I03 slices port board-unit geometry, grid regions, collapse/expand, dragging,
box selection, alignment, resize, grouping/detach, previews and minimap. Keep the board's own
zoom independent of the application's text zoom. Persist shared node geometry separately from
client-local viewport, selection, expanded cards and unsent conversation drafts. Scope local
view keys by Core identity and board ID to avoid cross-backend state reuse.

References to AI members, Mission, Task, Thread and project files identify existing Core objects;
the canvas does not own copied business status or a second execution engine. Resolve visibility
and actions through the object's existing permissions and current snapshot. Missing or removed
objects must be visibly unavailable; never recreate one because its card survived. A board/node
operation may change layout without changing or deleting the referenced business object.

File nodes use the existing file-preview handle/root grant and actual path validation. A stored
path is not file authorization. Terminal nodes keep launch intent and geometry, never a durable
PTY ID or credential. Rovai currently has no interactive canvas PTY operation; its
`RuntimeTerminalAdmission` admits AgentRun terminal-state settlement, not PTY startup. Port
Codeg's actual PTY lifecycle and add explicit Core ownership, launch authorization and planned
shutdown integration before claiming terminal support. Reopening after restart requires a new
ephemeral session. Board removal must settle its owned terminals and remove node bindings,
while keeping independent Mission/Thread histories and user files. Those ownership and lifecycle
joins need implementation and actual process tests before terminal nodes are qualified.

## Current evidence boundary

This slice implements the multi-board Core lifecycle and snapshot only. UI board list/switching,
all node rendering, graph persistence, business navigation, actual PTY, execution round-trip and
platform acceptance remain pending. No canvas content is sent to a model by this slice; any
later model-visible context change must follow the existing revision confirmation governance.

## Node mapping and retained behavior

| Codeg source | Destination authority / integration requirement |
|---|---|
| folder region | Actual directory plus the current navigation group/query; client directory preferences stay JSON and do not become a second project registry in SQLite |
| group region | Preserve folder-group membership and worktree inclusion; source numeric folder/group IDs cannot be copied into Core object IDs |
| agent region | Preserve source Runtime-type filtering and additionally bind the intended Core member identity; Runtime kind and member ID are different facts |
| conversation | Reference the real Thread and optional private conversation with its actual permissions; open through the current conversation surface |
| custom region | Ordered, deduplicated curated Thread references; grouping/detach changes board placement, not Thread business membership |
| note | Core-owned plain/structured note content and geometry; rendering must use the existing safe Markdown rules, with no implicit model input |
| file | Absolute source path plus current owner/root-grant resolution; path text cannot bypass file-preview authorization |
| terminal | Port `portable-pty` manager behavior: process generation, output sequence, bounded whole-chunk scrollback, resize and real shutdown; PTY process identity remains ephemeral |

Source graph operations include create/update, batch move, collect/group, detach, single/batch
delete and deleted-conversation pruning. Preserve their atomic gesture boundaries, exact board
identity and stale-response protection. The donor's LWW event replay is adapted to Core's
revision/CAS and invalidation snapshot rules; do not run both protocols as parallel authorities.
