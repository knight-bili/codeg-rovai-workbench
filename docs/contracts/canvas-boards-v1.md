---
document_type: protocol-contract
contract: canvas-boards-v1
authority: core-canvas-board-lifecycle-and-snapshot
status: accepted
version: 1
last_updated: 2026-10-16
---

# Canvas Boards v1

Core owns canvas board metadata and its lifecycle. This is the first I03 implementation slice;
the eight node kinds, graph layout, object bindings, client viewport and transient PTY work
remain required by [the full integration plan](../../integration/planning/plan-v4.md).
This contract does not claim that an interactive canvas has shipped.

## Scope and source

The fixed Codeg `aff1e6c278453ed8d0b96a5f664edcdca621aa3f` source owns the reference behavior:
`src-tauri/src/db/service/canvas_service.rs`, `db/entities/canvas_board.rs`,
`models/canvas.rs`, and `src/lib/canvas-view-storage.ts`. Preserve unnamed boards,
the 200/2000 Unicode scalar limits, preset colors, per-board isolation and client-local viewport.
Port the behavior into Rovai's existing SQLite and command gateway; do not open Codeg's database
or install a parallel SeaORM/Tauri write path. License notices remain in the integration source ledger.

## API

Both Core and authenticated Host Web admit these operations:

| Operation | Parameters | Result |
|---|---|---|
| `canvas.boards.list` | `{}` | `{boards: CanvasBoard[], summaries?: CanvasBoardSummary[], throughGlobalSequence: number}` |
| `canvas.boards.get` | `{boardId: string}` | `{board: CanvasBoard \| null, throughGlobalSequence: number}` |
| `canvas.boards.create` | User command with `{name?, description?, color?}` | Stored command result with `{board}` |
| `canvas.boards.update` | User command with `{boardId, expectedRevision, name?, description?, color?}` | Stored command result with `{board}` |
| `canvas.boards.delete` | User command with `{boardId, expectedRevision}` | Stored command result with `{boardId, revision}` |

User command parameters are `{commandId: string, command: ...}`. Core creates UUID board IDs;
callers cannot choose or reuse them. Board fields are exactly:

```ts
type CanvasBoard = {
  id: string
  name: string | null
  description: string | null
  color: string | null
  revision: number
  createdAt: string
  updatedAt: string
}
```

Create fields default to null. Trim text; whitespace-only values normalize to null. Names allow
at most 200 Unicode scalar values, descriptions 2000. Color is null or one of `neutral`, `zinc`,
`slate`, `stone`, `gray`, `red`, `rose`, `orange`, `green`, `blue`, `yellow`, `violet`.
Update omits or passes null to leave a field unchanged; an empty string clears it.
Unknown command fields and unknown get parameters fail decoding. List is global to the authenticated
User's Core instance, not a Camp capability. Board commands reject Agent/System actors, Camp scope,
execution epochs and separate expected-entity lists. They never start tasks, sessions or tools.

List excludes deleted boards and orders by `updatedAt DESC, id DESC`. Get returns null for unknown
or deleted IDs. Each result and `throughGlobalSequence` come from one SQLite read transaction.
Reads have no maintenance or creation side effects. Timestamp ordering is a display preference;
only revision participates in write admission.

### List summaries

`summaries` is an additive read projection; `boards` and all request shapes remain compatible.
When present, it has exactly one entry per returned board with the same `boardId` and `revision`:
`{boardId, revision, nodeCount, terminalCount, preview}`. Both counts cover persisted `canvas_node`
rows, including independent business pins; derived region members and running PTY processes are
not counted as additional nodes. Empty boards have real zero counts and an empty preview.

Each preview contains at most 200 `{kind, x, y, width, height, color}` footprints, ordered by
descending stored width × height, then node ID. Counts remain exact beyond the preview cap.
Only the eight persisted node kinds and the existing geometry/color domain are used. No node
title, note body, path, Thread/private-conversation identity, member list, file content or terminal
output enters this projection. The Core query materializes bounded footprints rather than full
node rows. Board rows, summaries and the sequence are read in the same transaction; reads do not
touch revisions, timestamps, events or receipts. Deleted boards contribute neither counts nor
footprints. This adds no schema or migration and creates no parallel cache or execution authority.

Metadata-only older Hosts omit the field; clients show an unavailable statistic, never a fabricated
zero. The schema152 metadata test owner can also read before `canvas_node` exists. Live database
contract admission remains mandatory and must not treat missing current-schema tables as healthy.
Clients reject mismatched/duplicate board identities or revisions, invalid counts and invalid/capped
geometry before replacing their last valid list. The thumbnail is a silhouette of persisted geometry,
not a render of open conversations, resolved region memberships, file viewers or terminal sessions.

## Writes, events and recovery

Use [Domain Command Result v2](domain-command-result-v2.md). Revision starts at 1. Update and delete
require the exact current revision and increment it once. A stale request returns
`canvas.board.conflict` with `{revision}` and cannot partially change metadata. A missing/deleted
board returns `canvas.board.not_found`; invalid metadata returns `canvas.board.invalid_metadata`;
invalid write scope returns `canvas.board.forbidden`. These rejected command results are durable.

An applied mutation and `canvas.board.invalidated` event, plus its single stored command result,
commit in the same transaction. Event payload is only `{boardId, revision}`; clients invalidate and
read the authoritative snapshot, rather than applying an event as a replacement state store.
Replay returns the first result without emitting another event or restoring a deleted board.
On reconnect or a subscription gap, discard uncertain cache and refetch. Clients must not infer
cross-board authority from response arrival order.

Schema152/Migration202 atomically adds `canvas_board`, the receipt and marker to exact schema151.
It does not modify any existing installation, member choice, Run input or model contract.
Deletion retains a metadata tombstone to avoid identity reuse. [Canvas Nodes v1](canvas-nodes-v1.md)
extends this lifecycle in schema154: nodes are deleted in the same transaction and graph writes use
the same board revision. There are no interactive PTY processes in these slices. Actual ephemeral
terminal settlement must join the deletion lifecycle before that capability is introduced;
a tombstone alone must never claim terminal settlement.

## Verification boundary

The extended SQLite owner proves receipt/result rollback, Unicode and color admission,
actor isolation, CAS, read sequence, reopen, delete and old command replay. The isolated actual
151→152 Host HTTP seam also preserves existing installation/member facts and checks no AgentRun
or ContextManifest is created. These are API/storage qualifications only, not canvas UI, model,
eight-node interaction or cross-platform qualifications.
