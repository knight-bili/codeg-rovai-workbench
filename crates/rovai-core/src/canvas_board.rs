//! Codeg canvas metadata, owned by the Core command transaction and read snapshot.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    collaboration::append_domain_event,
    command::{
        ActorRef, CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, EntityReference, sealed,
    },
    db::Database,
};

pub(crate) const TABLE_SQL: &str = "CREATE TABLE canvas_board (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT CHECK(name IS NULL OR length(name)<=200),
    description TEXT CHECK(description IS NULL OR length(description)<=2000),
    color TEXT CHECK(color IS NULL OR color IN ('neutral','zinc','slate','stone','gray','red','rose','orange','green','blue','yellow','violet')),
    revision INTEGER NOT NULL CHECK(revision>0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);";

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns = connection
        .prepare("PRAGMA table_info(canvas_board)")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns
        == [
            ("id".into(), "TEXT".into(), 1, 1),
            ("name".into(), "TEXT".into(), 0, 0),
            ("description".into(), "TEXT".into(), 0, 0),
            ("color".into(), "TEXT".into(), 0, 0),
            ("revision".into(), "INTEGER".into(), 1, 0),
            ("created_at".into(), "TEXT".into(), 1, 0),
            ("updated_at".into(), "TEXT".into(), 1, 0),
            ("deleted_at".into(), "TEXT".into(), 0, 0),
        ])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCanvasBoardCommand {
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
}
impl sealed::Sealed for CreateCanvasBoardCommand {}
impl DomainCommand for CreateCanvasBoardCommand {
    const TYPE: &'static str = "canvas.board.create";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCanvasBoardCommand {
    pub board_id: String,
    pub expected_revision: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
}
impl sealed::Sealed for UpdateCanvasBoardCommand {}
impl DomainCommand for UpdateCanvasBoardCommand {
    const TYPE: &'static str = "canvas.board.update";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteCanvasBoardCommand {
    pub board_id: String,
    pub expected_revision: i64,
}
impl sealed::Sealed for DeleteCanvasBoardCommand {}
impl DomainCommand for DeleteCanvasBoardCommand {
    const TYPE: &'static str = "canvas.board.delete";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoard {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub color: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoardsSnapshot {
    pub boards: Vec<CanvasBoard>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summaries: Option<Vec<CanvasBoardSummary>>,
    pub through_global_sequence: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoardSummary {
    pub board_id: String,
    pub revision: i64,
    pub node_count: i64,
    pub terminal_count: i64,
    pub preview: Vec<CanvasBoardPreviewRect>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoardPreviewRect {
    pub kind: crate::canvas_node::CanvasNodeKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: Option<String>,
}
// Codeg canvas_service.rs:1091-1218; Apache-2.0: integration/licenses/codeg/LICENSE.
// Keep exact counts while materializing only the largest 200 footprints per board.
const BOARD_PREVIEW_SQL: &str = "WITH footprints AS (
 SELECT n.board_id,n.kind,n.x,n.y,n.width,n.height,n.color,
 COUNT(*) OVER (PARTITION BY n.board_id) AS node_count,
 SUM(n.kind='terminal') OVER (PARTITION BY n.board_id) AS terminal_count,
 ROW_NUMBER() OVER (PARTITION BY n.board_id ORDER BY n.width*n.height DESC,n.id) AS position
 FROM canvas_node n JOIN canvas_board b ON b.id=n.board_id WHERE b.deleted_at IS NULL
)
SELECT board_id,kind,x,y,width,height,color,node_count,terminal_count
FROM footprints WHERE position<=200 ORDER BY board_id,position";

fn summaries(
    connection: &Connection,
    boards: &[CanvasBoard],
) -> Result<Option<Vec<CanvasBoardSummary>>> {
    // The metadata-only schema152 read owner also uses this function before nodes exist.
    if !connection.table_exists(None, "canvas_node")? {
        return Ok(None);
    }
    let mut summaries = boards
        .iter()
        .map(|board| CanvasBoardSummary {
            board_id: board.id.clone(),
            revision: board.revision,
            node_count: 0,
            terminal_count: 0,
            preview: vec![],
        })
        .collect::<Vec<_>>();
    let indexes = boards
        .iter()
        .enumerate()
        .map(|(i, board)| (board.id.as_str(), i))
        .collect::<std::collections::HashMap<_, _>>();
    let mut query = connection.prepare(BOARD_PREVIEW_SQL)?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let board_id: String = row.get(0)?;
        let summary = &mut summaries[indexes[board_id.as_str()]];
        summary.node_count = row.get(7)?;
        summary.terminal_count = row.get(8)?;
        let kind = serde_json::from_value(json!(row.get::<_, String>(1)?)).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        summary.preview.push(CanvasBoardPreviewRect {
            kind,
            x: row.get(2)?,
            y: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
            color: row.get(6)?,
        });
    }
    Ok(Some(summaries))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBoardSnapshot {
    pub board: Option<CanvasBoard>,
    pub through_global_sequence: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<CanvasBoard> {
    Ok(CanvasBoard {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        color: row.get(3)?,
        revision: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}
pub(crate) fn find(connection: &Connection, id: &str) -> Result<Option<CanvasBoard>> {
    Ok(connection.query_row("SELECT id,name,description,color,revision,created_at,updated_at FROM canvas_board WHERE id=?1 AND deleted_at IS NULL", [id], from_row).optional()?)
}
pub(crate) fn sequence(connection: &Connection) -> rusqlite::Result<i64> {
    connection.query_row(
        "SELECT COALESCE(MAX(global_sequence),0) FROM event_log",
        [],
        |row| row.get(0),
    )
}
pub fn list(connection: &Connection) -> Result<CanvasBoardsSnapshot> {
    let tx = connection.unchecked_transaction()?;
    let through_global_sequence = sequence(&tx)?;
    let boards=tx.prepare("SELECT id,name,description,color,revision,created_at,updated_at FROM canvas_board WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC")?.query_map([],from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let summaries = summaries(&tx, &boards)?;
    tx.commit()?;
    Ok(CanvasBoardsSnapshot {
        boards,
        summaries,
        through_global_sequence,
    })
}
pub fn get(connection: &Connection, id: &str) -> Result<CanvasBoardSnapshot> {
    let tx = connection.unchecked_transaction()?;
    let through_global_sequence = sequence(&tx)?;
    let board = find(&tx, id)?;
    tx.commit()?;
    Ok(CanvasBoardSnapshot {
        board,
        through_global_sequence,
    })
}

pub(crate) fn allowed<C>(envelope: &CommandEnvelope<C>) -> bool {
    matches!(envelope.actor, ActorRef::User { .. })
        && envelope.camp_id.is_none()
        && envelope.execution_epoch.is_none()
        && envelope.expected_versions.is_empty()
}
fn text(value: Option<&str>, max: usize) -> std::result::Result<Option<String>, ()> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if value.is_some_and(|value| value.chars().count() > max) {
        return Err(());
    }
    Ok(value.map(str::to_owned))
}
pub(crate) fn color(value: Option<&str>) -> std::result::Result<Option<String>, ()> {
    let value = text(value, 20)?;
    if value.as_ref().is_some_and(|value| {
        ![
            "neutral", "zinc", "slate", "stone", "gray", "red", "rose", "orange", "green", "blue",
            "yellow", "violet",
        ]
        .contains(&value.as_str())
    }) {
        return Err(());
    }
    Ok(value)
}
fn rejected(code: &str) -> CommandHandlerResult {
    CommandHandlerResult::rejected(format!("canvas.board.{code}"), json!({}))
}
fn entity(id: &str) -> Option<EntityReference> {
    Some(EntityReference {
        entity_type: "canvas_board".into(),
        entity_id: id.into(),
    })
}
pub(crate) fn invalidated(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    revision: i64,
    actor: &ActorRef,
) -> Result<()> {
    append_domain_event(
        tx,
        "canvas.board.invalidated",
        None,
        Some(("canvas_board", id)),
        actor,
        None,
        &json!({"boardId":id,"revision":revision}),
    )
}
pub fn create(
    database: &mut Database,
    envelope: &CommandEnvelope<CreateCanvasBoardCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database,envelope,|tx|{
        if !allowed(envelope) {return Ok(rejected("forbidden"));}
        let command=&envelope.payload;
        let (Ok(name),Ok(description),Ok(color))=(text(command.name.as_deref(),200),text(command.description.as_deref(),2000),color(command.color.as_deref())) else {return Ok(rejected("invalid_metadata"));};
        let id=uuid::Uuid::new_v4().to_string();
        let now=chrono::Utc::now().to_rfc3339();
        tx.execute("INSERT INTO canvas_board(id,name,description,color,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?5)",params![id,name,description,color,now])?;
        invalidated(tx,&id,1,&envelope.actor)?;
        Ok(CommandHandlerResult::applied("canvas.board.created",json!({"board":find(tx,&id)?}),entity(&id)))
    })
}
pub fn update(
    database: &mut Database,
    envelope: &CommandEnvelope<UpdateCanvasBoardCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database,envelope,|tx|{
        if !allowed(envelope) {return Ok(rejected("forbidden"));}
        let command=&envelope.payload;
        let Some(mut board)=find(tx,&command.board_id)? else {return Ok(rejected("not_found"));};
        if board.revision!=command.expected_revision {return Ok(CommandHandlerResult::rejected("canvas.board.conflict",json!({"revision":board.revision})));}
        let (Ok(name),Ok(description),Ok(color))=(command.name.as_deref().map(|value|text(Some(value),200)).transpose(),command.description.as_deref().map(|value|text(Some(value),2000)).transpose(),command.color.as_deref().map(|value|color(Some(value))).transpose()) else {return Ok(rejected("invalid_metadata"));};
        if let Some(name)=name {board.name=name;}
        if let Some(description)=description {board.description=description;}
        if let Some(color)=color {board.color=color;}
        board.revision=board.revision.checked_add(1).ok_or_else(||anyhow::anyhow!("Canvas board revision overflow"))?;
        board.updated_at=chrono::Utc::now().to_rfc3339();
        tx.execute("UPDATE canvas_board SET name=?2,description=?3,color=?4,revision=?5,updated_at=?6 WHERE id=?1",params![board.id,board.name,board.description,board.color,board.revision,board.updated_at])?;
        invalidated(tx,&board.id,board.revision,&envelope.actor)?;
        Ok(CommandHandlerResult::applied("canvas.board.updated",json!({"board":board}),entity(&board.id)))
    })
}
pub fn delete(
    database: &mut Database,
    envelope: &CommandEnvelope<DeleteCanvasBoardCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database, envelope, |tx| {
        if !allowed(envelope) {
            return Ok(rejected("forbidden"));
        }
        let command = &envelope.payload;
        let Some(board) = find(tx, &command.board_id)? else {
            return Ok(rejected("not_found"));
        };
        if board.revision != command.expected_revision {
            return Ok(CommandHandlerResult::rejected(
                "canvas.board.conflict",
                json!({"revision":board.revision}),
            ));
        }
        let revision = board
            .revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("Canvas board revision overflow"))?;
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute("DELETE FROM canvas_node WHERE board_id=?1", [&board.id])?;
        tx.execute(
            "UPDATE canvas_board SET revision=?2,updated_at=?3,deleted_at=?3 WHERE id=?1",
            params![board.id, revision, now],
        )?;
        invalidated(tx, &board.id, revision, &envelope.actor)?;
        Ok(CommandHandlerResult::applied(
            "canvas.board.deleted",
            json!({"boardId":board.id,"revision":revision}),
            entity(&board.id),
        ))
    })
}

#[cfg(test)]
pub(crate) fn downgrade_for_test(connection: &Connection) {
    crate::db::downgrade_skill_pack_context_fixture(connection);
    if !connection.table_exists(None, "canvas_board").unwrap() {
        return;
    }
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM canvas_board", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        count, 0,
        "Synthetic old sources must not discard canvas boards"
    );
    connection.execute_batch("DROP TABLE canvas_board; DELETE FROM schema_migration WHERE version=202; UPDATE rovai_data_contract SET projection_schema_version=151 WHERE singleton=1 AND projection_schema_version=152;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    fn envelope<C>(payload: C) -> CommandEnvelope<C> {
        CommandEnvelope {
            command_id: uuid::Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "local_user".into(),
            },
            camp_id: None,
            expected_versions: vec![],
            execution_epoch: None,
            payload,
        }
    }
    #[test]
    fn board_migration_and_command_lifecycle_preserve_replay_and_atomic_snapshot() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        downgrade_for_test(database.connection());
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_canvas_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=202 BEGIN SELECT RAISE(ABORT,'canvas receipt fixture'); END;").unwrap();
        assert!(database.migrate_canvas_boards().is_err());
        assert!(
            !database
                .connection()
                .table_exists(None, "canvas_board")
                .unwrap()
        );
        let receipt: bool = database
            .connection()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=202)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!receipt);
        let marker: i64 = database
            .connection()
            .query_row(
                "SELECT projection_schema_version FROM rovai_data_contract",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, 151);
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_canvas_receipt;")
            .unwrap();
        database.migrate_canvas_boards().unwrap();
        assert!(schema_matches(database.connection()).unwrap());
        database
            .connection()
            .execute_batch("ALTER TABLE canvas_board RENAME COLUMN name TO broken_name;")
            .unwrap();
        assert!(!schema_matches(database.connection()).unwrap());
        assert!(matches!(
            crate::db::classify_database_contract(database.connection()).unwrap(),
            crate::db::DatabaseContractClassification::Unknown(_)
        ));
        database
            .connection()
            .execute_batch("ALTER TABLE canvas_board RENAME COLUMN broken_name TO name;")
            .unwrap();
        assert!(list(database.connection()).unwrap().boards.is_empty());
        assert!(list(database.connection()).unwrap().summaries.is_none());
        let create_command = envelope(CreateCanvasBoardCommand {
            name: Some("  中文画板  ".into()),
            description: Some(" 说明 ".into()),
            color: Some("blue".into()),
        });
        let created = create(&mut database, &create_command).unwrap();
        let id = created.result.payload["board"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(created.result.payload["board"]["name"], "中文画板");
        let before = list(database.connection()).unwrap();
        let mut changed = create_command.clone();
        changed.payload.name = Some("不能另建".into());
        assert_eq!(
            create(&mut database, &changed).unwrap().result,
            created.result
        );
        assert_eq!(
            list(database.connection()).unwrap().through_global_sequence,
            before.through_global_sequence
        );
        let mut forbidden = envelope(CreateCanvasBoardCommand {
            name: None,
            description: None,
            color: None,
        });
        forbidden.actor = ActorRef::System {
            component_id: "test".into(),
        };
        assert_eq!(
            create(&mut database, &forbidden).unwrap().result.code,
            "canvas.board.forbidden"
        );
        for (name, description, color) in [
            (Some("中".repeat(201)), None, None),
            (None, Some("🙂".repeat(2001)), None),
            (None, None, Some("url(evil)".into())),
        ] {
            assert_eq!(
                create(
                    &mut database,
                    &envelope(CreateCanvasBoardCommand {
                        name,
                        description,
                        color
                    })
                )
                .unwrap()
                .result
                .code,
                "canvas.board.invalid_metadata"
            );
        }
        let update_command = envelope(UpdateCanvasBoardCommand {
            board_id: id.clone(),
            expected_revision: 1,
            name: Some(" ".into()),
            description: None,
            color: Some("".into()),
        });
        let before_failure = list(database.connection()).unwrap().through_global_sequence;
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_canvas_result BEFORE INSERT ON event_log WHEN NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'canvas result fixture'); END;").unwrap();
        assert!(update(&mut database, &update_command).is_err());
        assert_eq!(
            list(database.connection()).unwrap().through_global_sequence,
            before_failure
        );
        assert_eq!(
            get(database.connection(), &id)
                .unwrap()
                .board
                .unwrap()
                .revision,
            1
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_canvas_result;")
            .unwrap();
        assert_eq!(
            update(&mut database, &update_command).unwrap().result.code,
            "canvas.board.updated"
        );
        let updated = get(database.connection(), &id).unwrap().board.unwrap();
        assert_eq!(updated.revision, 2);
        assert!(updated.name.is_none());
        assert!(updated.color.is_none());
        assert_eq!(updated.description.as_deref(), Some("说明"));
        let mut stale = update_command.clone();
        stale.command_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            update(&mut database, &stale).unwrap().result.code,
            "canvas.board.conflict"
        );
        let deletion = envelope(DeleteCanvasBoardCommand {
            board_id: id.clone(),
            expected_revision: 2,
        });
        database.close();
        let mut database = Database::open(database.directory()).unwrap();
        assert_eq!(
            get(database.connection(), &id)
                .unwrap()
                .board
                .unwrap()
                .revision,
            2
        );
        // The reopened current schema has nodes; list summaries remain one read-only snapshot.
        database.connection().execute("WITH RECURSIVE series(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM series WHERE i<200)
            INSERT INTO canvas_node(id,board_id,kind,conversations_json,title,content,color,collapsed,grid_columns,grid_rows,x,y,width,height,created_at,updated_at)
            SELECT 'summary-'||i,?1,'note','[]','never-read-title','never-read-note-body','orange',0,0,0,i*10,0,CASE WHEN i=0 THEN 5000 ELSE 200+i END,100,'time','time' FROM series", [&id]).unwrap();
        database.connection().execute_batch("INSERT INTO canvas_board(id,revision,created_at,updated_at) VALUES('summary-other',1,'time','time');
            INSERT INTO canvas_node(id,board_id,kind,conversations_json,path,collapsed,grid_columns,grid_rows,x,y,width,height,created_at,updated_at)
            VALUES('summary-other-node','summary-other','terminal','[]','/never-read-path',0,0,0,0,0,480,300,'time','time');").unwrap();
        let changes: i64 = database
            .connection()
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        let before_read = sequence(database.connection()).unwrap();
        let overview = list(database.connection()).unwrap();
        let rows = overview.summaries.as_ref().unwrap();
        let summary = rows.iter().find(|row| row.board_id == id).unwrap();
        assert_eq!(
            (summary.revision, summary.node_count, summary.terminal_count),
            (2, 201, 0)
        );
        assert_eq!(summary.preview.len(), 200);
        assert_eq!(summary.preview[0].width, 5000.0);
        assert!(summary.preview.iter().all(|rect| rect.x != 10.0));
        assert!(
            summary
                .preview
                .windows(2)
                .all(|pair| pair[0].width * pair[0].height >= pair[1].width * pair[1].height)
        );
        let other = rows
            .iter()
            .find(|row| row.board_id == "summary-other")
            .unwrap();
        assert_eq!(
            (other.node_count, other.terminal_count, other.preview.len()),
            (1, 1, 1)
        );
        let encoded = serde_json::to_string(&overview).unwrap();
        for private in [
            "never-read-title",
            "never-read-note-body",
            "/never-read-path",
        ] {
            assert!(!encoded.contains(private));
        }
        assert_eq!(overview.through_global_sequence, before_read);
        assert_eq!(
            database
                .connection()
                .query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            changes
        );
        database
            .connection()
            .execute_batch("UPDATE canvas_board SET deleted_at='time' WHERE id='summary-other';")
            .unwrap();
        assert_eq!(
            list(database.connection())
                .unwrap()
                .summaries
                .unwrap()
                .len(),
            1
        );
        database.connection().execute_batch("DELETE FROM canvas_node WHERE board_id='summary-other'; DELETE FROM canvas_board WHERE id='summary-other';").unwrap();
        let deleted = delete(&mut database, &deletion).unwrap();
        assert_eq!(deleted.result.code, "canvas.board.deleted");
        assert!(get(database.connection(), &id).unwrap().board.is_none());
        assert_eq!(
            create(&mut database, &create_command).unwrap().result,
            created.result
        );
        assert_eq!(
            update(&mut database, &update_command).unwrap().result.code,
            "canvas.board.updated"
        );
        assert!(list(database.connection()).unwrap().boards.is_empty());
        assert_eq!(
            delete(&mut database, &deletion).unwrap().result,
            deleted.result
        );
        let second = create(
            &mut database,
            &envelope(CreateCanvasBoardCommand {
                name: None,
                description: None,
                color: None,
            }),
        )
        .unwrap();
        assert_ne!(second.result.payload["board"]["id"], id);
        assert_eq!(list(database.connection()).unwrap().boards.len(), 1);
        assert_eq!(
            list(database.connection()).unwrap().summaries.unwrap()[0].node_count,
            0
        );
        let integrity: String = database
            .connection()
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }
}
