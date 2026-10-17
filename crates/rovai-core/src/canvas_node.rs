//! Ports the fixed Codeg canvas behavior to Core transactions and references.
//! Apache-2.0 source license: integration/licenses/codeg/LICENSE.
//! Shared canvas geometry and references. Business objects and live PTYs remain
//! owned by their existing Core authorities, never by this graph.
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    canvas_board,
    command::{
        CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, EntityReference, sealed,
    },
    db::Database,
};

pub(crate) const TABLE_SQL: &str = "CREATE TABLE canvas_node (
 id TEXT PRIMARY KEY NOT NULL,
 board_id TEXT NOT NULL REFERENCES canvas_board(id),
 kind TEXT NOT NULL CHECK(kind IN ('folder','group','agent','conversation','custom','note','file','terminal')),
 folder_path TEXT, folder_group_id TEXT, runtime_kind TEXT, agent_id TEXT,
 thread_id TEXT, conversation_id TEXT,
 conversations_json TEXT NOT NULL CHECK(json_valid(conversations_json) AND json_type(conversations_json)='array' AND json_array_length(conversations_json)<=200),
 title TEXT, content TEXT, path TEXT, color TEXT,
 collapsed INTEGER NOT NULL CHECK(collapsed IN (0,1)),
 grid_columns INTEGER NOT NULL CHECK(grid_columns BETWEEN 0 AND 12),
 grid_rows INTEGER NOT NULL CHECK(grid_rows BETWEEN 0 AND 12),
 x REAL NOT NULL CHECK(x BETWEEN -1000000 AND 1000000),
 y REAL NOT NULL CHECK(y BETWEEN -1000000 AND 1000000),
 width REAL NOT NULL CHECK(width BETWEEN 48 AND 20000),
 height REAL NOT NULL CHECK(height BETWEEN 48 AND 20000),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((kind='folder')=(folder_path IS NOT NULL)),
 CHECK((kind='group')=(folder_group_id IS NOT NULL)),
 CHECK(kind='agent' OR (runtime_kind IS NULL AND agent_id IS NULL)),
 CHECK(kind!='agent' OR runtime_kind IS NOT NULL OR agent_id IS NOT NULL),
 CHECK((kind='conversation' AND thread_id IS NOT NULL) OR (kind!='conversation' AND thread_id IS NULL AND conversation_id IS NULL)),
 CHECK(kind='custom' OR json_array_length(conversations_json)=0),
 CHECK(kind='note' OR content IS NULL),
 CHECK((kind IN ('file','terminal'))=(path IS NOT NULL)),
 CHECK(kind IN ('folder','group','agent','custom') OR (grid_columns=0 AND grid_rows=0))
); CREATE INDEX canvas_node_board_idx ON canvas_node(board_id,id);";

const NODE_COLUMNS: &str = "id,board_id,kind,folder_path,folder_group_id,runtime_kind,agent_id,thread_id,conversation_id,conversations_json,title,content,path,color,collapsed,grid_columns,grid_rows,x,y,width,height,created_at,updated_at";

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns = connection
        .prepare("PRAGMA table_info(canvas_node)")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let required = NODE_COLUMNS
        .split(',')
        .map(|name| {
            let kind = if ["collapsed", "grid_columns", "grid_rows"].contains(&name) {
                "INTEGER"
            } else if ["x", "y", "width", "height"].contains(&name) {
                "REAL"
            } else {
                "TEXT"
            };
            let required = [
                "id",
                "board_id",
                "kind",
                "conversations_json",
                "collapsed",
                "grid_columns",
                "grid_rows",
                "x",
                "y",
                "width",
                "height",
                "created_at",
                "updated_at",
            ]
            .contains(&name);
            (
                name.to_owned(),
                kind.to_owned(),
                i64::from(required),
                i64::from(name == "id"),
            )
        })
        .collect::<Vec<_>>();
    let index = connection
        .prepare("PRAGMA index_info(canvas_node_board_idx)")?
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let board_fk: bool = connection.query_row(
        r#"SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('canvas_node')
           WHERE "table"='canvas_board' AND "from"='board_id' AND "to"='id')"#,
        [],
        |row| row.get(0),
    )?;
    Ok(columns == required && index == ["board_id", "id"] && board_fk)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasNodeKind {
    Folder,
    Group,
    Agent,
    Conversation,
    Custom,
    Note,
    File,
    Terminal,
}
impl CanvasNodeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Group => "group",
            Self::Agent => "agent",
            Self::Conversation => "conversation",
            Self::Custom => "custom",
            Self::Note => "note",
            Self::File => "file",
            Self::Terminal => "terminal",
        }
    }
    fn is_region(self) -> bool {
        matches!(
            self,
            Self::Folder | Self::Group | Self::Agent | Self::Custom
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasConversationRef {
    pub thread_id: String,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeData {
    pub kind: CanvasNodeKind,
    pub folder_path: Option<String>,
    pub folder_group_id: Option<String>,
    pub runtime_kind: Option<String>,
    pub agent_id: Option<String>,
    pub conversation: Option<CanvasConversationRef>,
    #[serde(default)]
    pub conversations: Vec<CanvasConversationRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_reference: Option<crate::canvas_object_reference::CanvasObjectReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_reference: Option<crate::canvas_file_reference::CanvasFileReference>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub path: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub grid_columns: i32,
    #[serde(default)]
    pub grid_rows: i32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn optional_text(value: &mut Option<String>) {
    *value = value
        .take()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty());
}
fn bounded_path(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|text| {
        let bytes = text.as_bytes();
        let absolute = Path::new(text).is_absolute()
            || text.starts_with('/')
            || text.starts_with("\\\\")
            || bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/');
        text.chars().count() <= 4096 && !text.contains('\0') && absolute
    })
}
fn valid_reference(reference: &CanvasConversationRef) -> bool {
    !reference.thread_id.trim().is_empty()
        && reference
            .conversation_id
            .as_ref()
            .is_none_or(|id| !id.trim().is_empty())
}
fn normalize(data: &mut CanvasNodeData) -> std::result::Result<(), &'static str> {
    if data
        .file_reference
        .as_ref()
        .is_some_and(|reference| !reference.valid() || data.kind != CanvasNodeKind::File)
    {
        return Err("invalid_file_reference");
    }
    if data.object_reference.as_ref().is_some_and(|reference| {
        !reference.valid()
            || data.kind != CanvasNodeKind::Conversation
            || data
                .conversation
                .as_ref()
                .is_none_or(|owner| owner.conversation_id.is_some())
    }) {
        return Err("invalid_object_reference");
    }
    if ![data.x, data.y, data.width, data.height]
        .iter()
        .all(|n| n.is_finite())
    {
        return Err("invalid_geometry");
    }
    data.x = data.x.clamp(-1_000_000.0, 1_000_000.0);
    data.y = data.y.clamp(-1_000_000.0, 1_000_000.0);
    data.width = data.width.clamp(48.0, 20_000.0);
    data.height = data.height.clamp(48.0, 20_000.0);
    for value in [
        &mut data.title,
        &mut data.folder_path,
        &mut data.folder_group_id,
        &mut data.runtime_kind,
        &mut data.agent_id,
    ] {
        optional_text(value);
    }
    // A new bound file keeps its exact path; trimming could select a different Unix file.
    if data.file_reference.is_none() {
        optional_text(&mut data.path);
    }
    data.color = canvas_board::color(data.color.as_deref()).map_err(|_| "invalid_color")?;
    if data.content.as_ref().is_some_and(String::is_empty) {
        data.content = None;
    }
    if data.kind != CanvasNodeKind::Note && data.content.is_some() {
        return Err("invalid_content");
    }
    let has_path = matches!(data.kind, CanvasNodeKind::File | CanvasNodeKind::Terminal);
    if has_path && !bounded_path(&data.path) || !has_path && data.path.is_some() {
        return Err("invalid_path");
    }
    if (data.kind == CanvasNodeKind::Folder) != data.folder_path.is_some()
        || data.folder_path.is_some() && !bounded_path(&data.folder_path)
        || (data.kind == CanvasNodeKind::Group) != data.folder_group_id.is_some()
        || data.kind != CanvasNodeKind::Agent
            && (data.runtime_kind.is_some() || data.agent_id.is_some())
        || data.kind == CanvasNodeKind::Agent
            && data.runtime_kind.is_none()
            && data.agent_id.is_none()
        || (data.kind == CanvasNodeKind::Conversation) != data.conversation.is_some()
        || data
            .conversation
            .as_ref()
            .is_some_and(|r| !valid_reference(r))
        || data.kind != CanvasNodeKind::Custom && !data.conversations.is_empty()
    {
        return Err("invalid_binding");
    }
    let mut unique = Vec::new();
    for reference in data.conversations.drain(..) {
        if !valid_reference(&reference) {
            return Err("invalid_binding");
        }
        if !unique.contains(&reference) {
            unique.push(reference);
        }
    }
    if unique.len() > 200 {
        return Err("too_many_members");
    }
    data.conversations = unique;
    data.grid_columns = if data.kind.is_region() {
        data.grid_columns.clamp(0, 12)
    } else {
        0
    };
    data.grid_rows = if data.kind.is_region() {
        data.grid_rows.clamp(0, 12)
    } else {
        0
    };
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNode {
    pub id: String,
    pub board_id: String,
    pub data: CanvasNodeData,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasGraphSnapshot {
    pub board: Option<canvas_board::CanvasBoard>,
    pub nodes: Vec<CanvasNode>,
    pub through_global_sequence: i64,
    pub member_transfer_version: u32,
    pub object_reference_version: u32,
    pub file_reference_version: u32,
    pub terminal_version: u32,
}
fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CanvasNode> {
    let decode = |column, error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    };
    let kind = serde_json::from_value(json!(row.get::<_, String>(2)?))
        .map_err(|error| decode(2, error))?;
    let thread_id: Option<String> = row.get(7)?;
    let conversation_id: Option<String> = row.get(8)?;
    let conversations =
        serde_json::from_str(&row.get::<_, String>(9)?).map_err(|error| decode(9, error))?;
    Ok(CanvasNode {
        id: row.get(0)?,
        board_id: row.get(1)?,
        data: CanvasNodeData {
            kind,
            folder_path: row.get(3)?,
            folder_group_id: row.get(4)?,
            runtime_kind: row.get(5)?,
            agent_id: row.get(6)?,
            conversation: thread_id.map(|thread_id| CanvasConversationRef {
                thread_id,
                conversation_id,
            }),
            conversations,
            object_reference: crate::canvas_object_reference::from_row(row, 23)?,
            file_reference: row
                .get::<_, Option<String>>(27)?
                .map(|thread_id| crate::canvas_file_reference::CanvasFileReference { thread_id }),
            title: row.get(10)?,
            content: row.get(11)?,
            path: row.get(12)?,
            color: row.get(13)?,
            collapsed: row.get(14)?,
            grid_columns: row.get(15)?,
            grid_rows: row.get(16)?,
            x: row.get(17)?,
            y: row.get(18)?,
            width: row.get(19)?,
            height: row.get(20)?,
        },
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
    })
}
fn load(connection: &Connection, board_id: &str) -> Result<Vec<CanvasNode>> {
    Ok(connection
        .prepare(&format!(
            "SELECT {NODE_COLUMNS},{},{} FROM canvas_node {} {} WHERE board_id=?1 ORDER BY created_at,id",
            crate::canvas_object_reference::COLUMNS,
            crate::canvas_file_reference::COLUMNS,
            crate::canvas_object_reference::JOIN,
            crate::canvas_file_reference::JOIN
        ))?
        .query_map([board_id], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
fn load_selected(
    connection: &Connection,
    board_id: &str,
    ids: impl IntoIterator<Item = String>,
) -> Result<Vec<CanvasNode>> {
    let ids = ids.into_iter().collect::<BTreeSet<_>>();
    let mut query = connection.prepare(&format!(
        "SELECT {NODE_COLUMNS},{},{} FROM canvas_node {} {} WHERE board_id=?1 AND id=?2",
        crate::canvas_object_reference::COLUMNS,
        crate::canvas_file_reference::COLUMNS,
        crate::canvas_object_reference::JOIN,
        crate::canvas_file_reference::JOIN
    ))?;
    let mut nodes = Vec::new();
    for id in ids {
        if let Some(node) = query
            .query_row(params![board_id, id], from_row)
            .optional()?
        {
            nodes.push(node);
        }
    }
    nodes.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(nodes)
}
fn candidates(
    connection: &Connection,
    board_id: &str,
    mutation: &CanvasNodeMutation,
) -> Result<Vec<CanvasNode>> {
    match mutation {
        CanvasNodeMutation::Create { .. } | CanvasNodeMutation::Move { .. } => Ok(vec![]),
        CanvasNodeMutation::Update { node_id, .. }
        | CanvasNodeMutation::BindFile { node_id, .. } => {
            load_selected(connection, board_id, [node_id.clone()])
        }
        CanvasNodeMutation::Detach { region_id, .. } => {
            load_selected(connection, board_id, [region_id.clone()])
        }
        CanvasNodeMutation::Delete { node_ids } => {
            load_selected(connection, board_id, node_ids.clone())
        }
        CanvasNodeMutation::Group {
            target_node_id,
            consume_node_ids,
            source_members,
            ..
        } => load_selected(
            connection,
            board_id,
            target_node_id
                .iter()
                .cloned()
                .chain(source_members.iter().map(|member| member.region_id.clone()))
                .chain(consume_node_ids.iter().cloned()),
        ),
        CanvasNodeMutation::Prune => Ok(connection
            .prepare(&format!(
                "SELECT {NODE_COLUMNS},{},{} FROM canvas_node {} {} WHERE board_id=?1
             AND kind IN ('conversation','custom') AND object_kind IS NULL ORDER BY created_at,id",
                crate::canvas_object_reference::COLUMNS,
                crate::canvas_file_reference::COLUMNS,
                crate::canvas_object_reference::JOIN,
                crate::canvas_file_reference::JOIN
            ))?
            .query_map([board_id], from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?),
    }
}

pub fn snapshot(connection: &Connection, board_id: &str) -> Result<CanvasGraphSnapshot> {
    let tx = connection.unchecked_transaction()?;
    let through_global_sequence = canvas_board::sequence(&tx)?;
    let board = canvas_board::find(&tx, board_id)?;
    let nodes = if board.is_some() {
        load(&tx, board_id)?
    } else {
        vec![]
    };
    tx.commit()?;
    Ok(CanvasGraphSnapshot {
        board,
        nodes,
        through_global_sequence,
        member_transfer_version: 1,
        object_reference_version: 1,
        file_reference_version: 1,
        terminal_version: 1,
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    pub color: Option<String>,
    pub collapsed: Option<bool>,
    pub grid_columns: Option<i32>,
    pub grid_rows: Option<i32>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub member_add: Option<CanvasConversationRef>,
    pub member_remove: Option<CanvasConversationRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeMove {
    pub node_id: String,
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasSourceMember {
    pub region_id: String,
    pub conversation: CanvasConversationRef,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CanvasNodeMutation {
    Create {
        node: CanvasNodeData,
    },
    Update {
        node_id: String,
        patch: CanvasNodePatch,
    },
    BindFile {
        node_id: String,
        thread_id: String,
    },
    Move {
        moves: Vec<CanvasNodeMove>,
    },
    Group {
        target_node_id: Option<String>,
        new_region: Option<CanvasNodeData>,
        conversations: Vec<CanvasConversationRef>,
        consume_node_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        source_members: Vec<CanvasSourceMember>,
    },
    Detach {
        region_id: String,
        conversation: CanvasConversationRef,
        x: f64,
        y: f64,
    },
    Delete {
        node_ids: Vec<String>,
    },
    Prune,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyCanvasNodesCommand {
    pub board_id: String,
    pub expected_revision: i64,
    pub mutation: CanvasNodeMutation,
}
impl sealed::Sealed for ApplyCanvasNodesCommand {}
impl DomainCommand for ApplyCanvasNodesCommand {
    const TYPE: &'static str = "canvas.nodes.apply";
}

fn live_reference(
    connection: &Connection,
    reference: &CanvasConversationRef,
) -> rusqlite::Result<bool> {
    let live: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM camp WHERE id=?1 AND deletion_operation_id IS NULL)",
        [&reference.thread_id],
        |row| row.get(0),
    )?;
    if !live {
        return Ok(false);
    }
    match &reference.conversation_id {
        Some(id) => connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM conversation WHERE id=?1 AND camp_id=?2)",
            params![id, reference.thread_id],
            |row| row.get(0),
        ),
        None => Ok(true),
    }
}
fn require_references(connection: &Connection, data: &CanvasNodeData) -> Result<bool> {
    if let Some(reference) = &data.file_reference {
        if !reference.live(connection)? {
            return Ok(false);
        }
    }
    if let Some(reference) = &data.object_reference {
        let Some(owner) = &data.conversation else {
            return Ok(false);
        };
        if !reference.live_in_thread(connection, &owner.thread_id)? {
            return Ok(false);
        }
    }
    if let Some(id) = &data.agent_id {
        if !connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_profile WHERE id=?1 AND profile_status='present')",
            [id],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(false);
        }
    }
    for reference in data.conversation.iter().chain(&data.conversations) {
        if !live_reference(connection, reference)? {
            return Ok(false);
        }
    }
    Ok(true)
}
fn node(board_id: &str, data: CanvasNodeData, now: &str) -> CanvasNode {
    CanvasNode {
        id: uuid::Uuid::new_v4().to_string(),
        board_id: board_id.into(),
        data,
        created_at: now.into(),
        updated_at: now.into(),
    }
}
fn rejected(code: &str) -> CommandHandlerResult {
    CommandHandlerResult::rejected(format!("canvas.nodes.{code}"), json!({}))
}

fn insert_node(connection: &Connection, node: &CanvasNode) -> Result<()> {
    let d = &node.data;
    connection.execute(&format!("INSERT INTO canvas_node({NODE_COLUMNS}) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)"),params![
        node.id,node.board_id,d.kind.as_str(),d.folder_path,d.folder_group_id,d.runtime_kind,d.agent_id,
        d.conversation.as_ref().map(|r|r.thread_id.as_str()),d.conversation.as_ref().and_then(|r|r.conversation_id.as_deref()),
        serde_json::to_string(&d.conversations)?,d.title,d.content,d.path,d.color,d.collapsed,d.grid_columns,d.grid_rows,d.x,d.y,d.width,d.height,node.created_at,node.updated_at])?;
    if let Some(reference) = &d.object_reference {
        reference.insert(connection, &node.id)?;
    }
    if let Some(reference) = &d.file_reference {
        reference.insert(connection, &node.id)?;
    }
    Ok(())
}
fn update_node(connection: &Connection, node: &CanvasNode, old: &CanvasNode) -> Result<()> {
    use rusqlite::types::Value;
    let text = |value: &Option<String>| {
        value
            .as_ref()
            .map(|v| Value::Text(v.clone()))
            .unwrap_or(Value::Null)
    };
    let d = &node.data;
    let mut values = vec![
        Value::Text(node.id.clone()),
        Value::Text(node.board_id.clone()),
        text(&d.title),
        text(&d.color),
        Value::Integer(i64::from(d.collapsed)),
        Value::Integer(i64::from(d.grid_columns)),
        Value::Integer(i64::from(d.grid_rows)),
        Value::Real(d.x),
        Value::Real(d.y),
        Value::Real(d.width),
        Value::Real(d.height),
        Value::Text(serde_json::to_string(&d.conversations)?),
        Value::Text(node.updated_at.clone()),
    ];
    let mut sql="UPDATE canvas_node SET title=?3,color=?4,collapsed=?5,grid_columns=?6,grid_rows=?7,x=?8,y=?9,width=?10,height=?11,conversations_json=?12,updated_at=?13".to_owned();
    if d.content != old.data.content {
        sql.push_str(",content=?14");
        values.push(text(&d.content));
    }
    sql.push_str(" WHERE id=?1 AND board_id=?2");
    connection.execute(&sql, rusqlite::params_from_iter(values))?;
    if d.file_reference != old.data.file_reference {
        anyhow::ensure!(
            old.data.file_reference.is_none(),
            "Canvas file reference is immutable"
        );
        d.file_reference
            .as_ref()
            .context("Canvas file reference cannot be cleared")?
            .insert(connection, &node.id)?;
    }
    Ok(())
}
fn finish(
    connection: &rusqlite::Transaction<'_>,
    board: &canvas_board::CanvasBoard,
    actor: &crate::command::ActorRef,
    now: &str,
    node_ids: Vec<String>,
    deleted: Vec<String>,
) -> Result<CommandHandlerResult> {
    if node_ids.is_empty() && deleted.is_empty() {
        return Ok(CommandHandlerResult::applied(
            "canvas.nodes.unchanged",
            json!({"boardId":board.id,"revision":board.revision,"nodeIds":[],"deletedNodeIds":[]}),
            None,
        ));
    }
    let revision = board
        .revision
        .checked_add(1)
        .context("Canvas board revision overflow")?;
    connection.execute(
        "UPDATE canvas_board SET revision=?2,updated_at=?3 WHERE id=?1",
        params![board.id, revision, now],
    )?;
    canvas_board::invalidated(connection, &board.id, revision, actor)?;
    Ok(CommandHandlerResult::applied(
        "canvas.nodes.updated",
        json!({"boardId":board.id,"revision":revision,"nodeIds":node_ids,"deletedNodeIds":deleted}),
        Some(EntityReference {
            entity_type: "canvas_board".into(),
            entity_id: board.id.clone(),
        }),
    ))
}
fn move_nodes(
    connection: &rusqlite::Transaction<'_>,
    board: &canvas_board::CanvasBoard,
    actor: &crate::command::ActorRef,
    moves: &[CanvasNodeMove],
    now: &str,
) -> Result<CommandHandlerResult> {
    let mut final_moves = HashMap::new();
    let mut order = Vec::new();
    for movement in moves {
        if !movement.x.is_finite() || !movement.y.is_finite() {
            return Ok(rejected("invalid_geometry"));
        }
        if !final_moves.contains_key(&movement.node_id) {
            order.push(movement.node_id.clone());
        }
        final_moves.insert(
            movement.node_id.clone(),
            (
                movement.x.clamp(-1_000_000.0, 1_000_000.0),
                movement.y.clamp(-1_000_000.0, 1_000_000.0),
            ),
        );
    }
    let mut changed = Vec::new();
    let mut query=connection.prepare("UPDATE canvas_node SET x=?3,y=?4,updated_at=?5 WHERE id=?1 AND board_id=?2 AND (x!=?3 OR y!=?4)")?;
    for id in order {
        let (x, y) = final_moves[&id];
        if query.execute(params![id, board.id, x, y, now])? == 1 {
            changed.push(id);
        }
    }
    drop(query);
    finish(connection, board, actor, now, changed, vec![])
}

// Mutations edit an owned candidate first. A validation rejection stores its
// receipt without publishing a partial gesture; SQL/event/result errors roll
// back the existing DomainCommandGateway transaction together.
pub fn apply(
    database: &mut Database,
    envelope: &CommandEnvelope<ApplyCanvasNodesCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database, envelope, |tx| {
        if !canvas_board::allowed(envelope) {
            return Ok(rejected("forbidden"));
        }
        let command = &envelope.payload;
        let Some(board) = canvas_board::find(tx, &command.board_id)? else {
            return Ok(rejected("board_not_found"));
        };
        if board.revision != command.expected_revision {
            return Ok(CommandHandlerResult::rejected(
                "canvas.nodes.conflict",
                json!({"revision":board.revision}),
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let original = candidates(tx, &board.id, &command.mutation)?;
        let original_by_id = original
            .iter()
            .enumerate()
            .map(|(index, node)| (node.id.as_str(), (index, node)))
            .collect::<HashMap<_, _>>();
        let mut nodes = original.clone();
        match &command.mutation {
            CanvasNodeMutation::Create { node: data } => {
                let mut data = data.clone();
                if let Err(code) = normalize(&mut data) {
                    return Ok(rejected(code));
                }
                if !require_references(tx, &data)? {
                    return Ok(rejected("binding_unavailable"));
                }
                nodes.push(node(&board.id, data, &now));
            }
            CanvasNodeMutation::BindFile { node_id, thread_id } => {
                let Some(target) = nodes.iter_mut().find(|n| n.id == *node_id) else {
                    return Ok(rejected("not_found"));
                };
                let reference = crate::canvas_file_reference::CanvasFileReference {
                    thread_id: thread_id.clone(),
                };
                if target.data.kind != CanvasNodeKind::File || !reference.valid() {
                    return Ok(rejected("invalid_file_reference"));
                }
                if target
                    .data
                    .file_reference
                    .as_ref()
                    .is_some_and(|current| current != &reference)
                {
                    return Ok(rejected("file_binding_immutable"));
                }
                if !reference.live(tx)? {
                    return Ok(rejected("binding_unavailable"));
                }
                target.data.file_reference = Some(reference);
            }
            CanvasNodeMutation::Update { node_id, patch } => {
                let Some(target) = nodes.iter_mut().find(|n| n.id == *node_id) else {
                    return Ok(rejected("not_found"));
                };
                let data = &mut target.data;
                for (value, change) in [
                    (&mut data.title, &patch.title),
                    (&mut data.content, &patch.content),
                    (&mut data.color, &patch.color),
                ] {
                    if let Some(change) = change {
                        *value = Some(change.clone());
                    }
                }
                if let Some(value) = patch.collapsed {
                    data.collapsed = value;
                }
                for (value, change) in [
                    (&mut data.grid_columns, patch.grid_columns),
                    (&mut data.grid_rows, patch.grid_rows),
                ] {
                    if let Some(change) = change {
                        *value = change;
                    }
                }
                for (value, change) in [
                    (&mut data.x, patch.x),
                    (&mut data.y, patch.y),
                    (&mut data.width, patch.width),
                    (&mut data.height, patch.height),
                ] {
                    if let Some(change) = change {
                        *value = change;
                    }
                }
                if patch.member_add.is_some() || patch.member_remove.is_some() {
                    if data.kind != CanvasNodeKind::Custom {
                        return Ok(rejected("invalid_region"));
                    }
                    if let Some(reference) = &patch.member_add {
                        if !live_reference(tx, reference)? {
                            return Ok(rejected("binding_unavailable"));
                        }
                        if !data.conversations.contains(reference) {
                            data.conversations.push(reference.clone());
                        }
                    }
                    if let Some(reference) = &patch.member_remove {
                        data.conversations.retain(|r| r != reference);
                    }
                }
                if let Err(code) = normalize(data) {
                    return Ok(rejected(code));
                }
            }
            CanvasNodeMutation::Move { moves } => {
                return move_nodes(tx, &board, &envelope.actor, moves, &now);
            }
            CanvasNodeMutation::Group {
                target_node_id,
                new_region,
                conversations,
                consume_node_ids,
                source_members,
            } => {
                if nodes
                    .iter()
                    .any(|node| node.data.object_reference.is_some())
                {
                    return Ok(rejected("object_reference_not_groupable"));
                }
                let mut incoming = Vec::new();
                for reference in conversations {
                    if !live_reference(tx, reference)? {
                        return Ok(rejected("binding_unavailable"));
                    }
                    if !incoming.contains(reference) {
                        incoming.push(reference.clone());
                    }
                }
                if source_members.len() > 200 {
                    return Ok(rejected("too_many_members"));
                }
                let mut unique_sources = Vec::new();
                for member in source_members {
                    if unique_sources.contains(member) || !incoming.contains(&member.conversation) {
                        return Ok(rejected("invalid_source_member"));
                    }
                    unique_sources.push(member.clone());
                    let Some(source) = nodes.iter().find(|node| node.id == member.region_id) else {
                        return Ok(rejected("not_found"));
                    };
                    if !source.data.kind.is_region() {
                        return Ok(rejected("invalid_region"));
                    }
                    if source.data.kind == CanvasNodeKind::Custom
                        && !source.data.conversations.contains(&member.conversation)
                    {
                        return Ok(rejected("member_not_found"));
                    }
                }
                let target_id = match (target_node_id, new_region) {
                    (Some(id), None) => id.clone(),
                    (None, Some(data)) => {
                        let mut data = data.clone();
                        if data.kind != CanvasNodeKind::Custom {
                            return Ok(rejected("invalid_region"));
                        }
                        if let Err(code) = normalize(&mut data) {
                            return Ok(rejected(code));
                        }
                        if !require_references(tx, &data)? {
                            return Ok(rejected("binding_unavailable"));
                        }
                        let target = node(&board.id, data, &now);
                        let id = target.id.clone();
                        nodes.push(target);
                        id
                    }
                    _ => return Ok(rejected("invalid_region")),
                };
                let Some(target) = nodes.iter_mut().find(|n| n.id == target_id) else {
                    return Ok(rejected("not_found"));
                };
                if target.data.kind != CanvasNodeKind::Custom {
                    return Ok(rejected("invalid_region"));
                }
                for reference in &incoming {
                    if !target.data.conversations.contains(reference) {
                        target.data.conversations.push(reference.clone());
                    }
                }
                if let Err(code) = normalize(&mut target.data) {
                    return Ok(rejected(code));
                }
                let adopted = target.data.conversations.clone();
                for member in source_members {
                    if member.region_id == target_id {
                        continue;
                    }
                    let source = nodes
                        .iter_mut()
                        .find(|node| node.id == member.region_id)
                        .expect("validated source region");
                    if source.data.kind == CanvasNodeKind::Custom {
                        source
                            .data
                            .conversations
                            .retain(|reference| reference != &member.conversation);
                    }
                }
                for candidate in nodes.iter().filter(|n| {
                    consume_node_ids.contains(&n.id) && n.data.kind == CanvasNodeKind::Conversation
                }) {
                    if !candidate
                        .data
                        .conversation
                        .as_ref()
                        .is_some_and(|r| adopted.contains(r))
                    {
                        return Ok(rejected("unadopted_conversation"));
                    }
                }
                nodes.retain(|n| {
                    !consume_node_ids.contains(&n.id) || n.data.kind != CanvasNodeKind::Conversation
                });
            }
            CanvasNodeMutation::Detach {
                region_id,
                conversation,
                x,
                y,
            } => {
                if !live_reference(tx, conversation)? {
                    return Ok(rejected("binding_unavailable"));
                }
                let Some(region) = nodes.iter_mut().find(|n| n.id == *region_id) else {
                    return Ok(rejected("not_found"));
                };
                if !region.data.kind.is_region() {
                    return Ok(rejected("invalid_region"));
                }
                if region.data.kind == CanvasNodeKind::Custom {
                    if !region.data.conversations.contains(conversation) {
                        return Ok(rejected("member_not_found"));
                    }
                    region.data.conversations.retain(|r| r != conversation);
                }
                let mut data = CanvasNodeData {
                    kind: CanvasNodeKind::Conversation,
                    folder_path: None,
                    folder_group_id: None,
                    runtime_kind: None,
                    agent_id: None,
                    conversation: Some(conversation.clone()),
                    conversations: vec![],
                    object_reference: None,
                    file_reference: None,
                    title: None,
                    content: None,
                    path: None,
                    color: None,
                    collapsed: false,
                    grid_columns: 0,
                    grid_rows: 0,
                    x: *x,
                    y: *y,
                    width: 224.0,
                    height: 132.0,
                };
                if let Err(code) = normalize(&mut data) {
                    return Ok(rejected(code));
                }
                nodes.push(node(&board.id, data, &now));
            }
            CanvasNodeMutation::Delete { node_ids } => nodes.retain(|n| !node_ids.contains(&n.id)),
            CanvasNodeMutation::Prune => {
                let mut retained = Vec::new();
                for mut candidate in nodes {
                    if candidate.data.kind == CanvasNodeKind::Conversation
                        && !live_reference(
                            tx,
                            candidate
                                .data
                                .conversation
                                .as_ref()
                                .context("Conversation node lost its binding")?,
                        )?
                    {
                        continue;
                    }
                    if candidate.data.kind == CanvasNodeKind::Custom {
                        let mut live = Vec::new();
                        for reference in candidate.data.conversations {
                            if live_reference(tx, &reference)? {
                                live.push(reference);
                            }
                        }
                        candidate.data.conversations = live;
                    }
                    retained.push(candidate);
                }
                nodes = retained;
            }
        }
        let surviving = nodes.iter().map(|n| n.id.as_str()).collect::<BTreeSet<_>>();
        let deleted = original
            .iter()
            .filter(|n| !surviving.contains(n.id.as_str()))
            .map(|n| n.id.clone())
            .collect::<Vec<_>>();
        let mut changed = Vec::new();
        for candidate in &mut nodes {
            if original_by_id
                .get(candidate.id.as_str())
                .is_none_or(|(_, n)| n.data != candidate.data)
            {
                candidate.updated_at = now.clone();
                changed.push(candidate.clone());
            }
        }
        for id in &deleted {
            tx.execute(
                "DELETE FROM canvas_node WHERE id=?1 AND board_id=?2",
                params![id, board.id],
            )?;
        }
        for candidate in &changed {
            if let Some((_, old)) = original_by_id.get(candidate.id.as_str()) {
                update_node(tx, candidate, old)?;
            } else {
                insert_node(tx, candidate)?;
            }
        }
        finish(
            tx,
            &board,
            &envelope.actor,
            &now,
            changed.into_iter().map(|n| n.id).collect(),
            deleted,
        )
    })
}

#[cfg(test)]
pub(crate) fn downgrade_for_test(connection: &Connection) {
    crate::db::downgrade_private_composer_scope_fixture(connection);
    if !connection.table_exists(None, "canvas_node").unwrap() {
        return;
    }
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM canvas_node", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0,
        "Cannot discard node graph in an old-source fixture"
    );
    connection.execute_batch("DROP TABLE canvas_node;DELETE FROM schema_migration WHERE version=204;UPDATE rovai_data_contract SET projection_schema_version=153 WHERE singleton=1 AND projection_schema_version=154;").unwrap();
}

#[cfg(test)]
fn fixture_data(kind: CanvasNodeKind) -> CanvasNodeData {
    CanvasNodeData {
        kind,
        folder_path: (kind == CanvasNodeKind::Folder).then(|| "C:/workspace".into()),
        folder_group_id: (kind == CanvasNodeKind::Group).then(|| "local-group".into()),
        runtime_kind: (kind == CanvasNodeKind::Agent).then(|| "codex-cli".into()),
        agent_id: (kind == CanvasNodeKind::Agent).then(|| "agent_1".into()),
        conversation: (kind == CanvasNodeKind::Conversation).then(|| CanvasConversationRef {
            thread_id: "thread-live".into(),
            conversation_id: None,
        }),
        conversations: vec![],
        object_reference: None,
        file_reference: None,
        title: Some("  节点  ".into()),
        content: (kind == CanvasNodeKind::Note).then(|| "\n中文 **便签**\n".into()),
        path: matches!(kind, CanvasNodeKind::File | CanvasNodeKind::Terminal)
            .then(|| "C:/unmounted/保留路径".into()),
        color: Some(" blue ".into()),
        collapsed: false,
        grid_columns: 99,
        grid_rows: -1,
        x: 2_000_000.0,
        y: -2_000_000.0,
        width: 1.0,
        height: 30_000.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn eight_kinds_preserve_source_geometry_text_and_reference_limits() {
        for kind in [
            CanvasNodeKind::Folder,
            CanvasNodeKind::Group,
            CanvasNodeKind::Agent,
            CanvasNodeKind::Conversation,
            CanvasNodeKind::Custom,
            CanvasNodeKind::Note,
            CanvasNodeKind::File,
            CanvasNodeKind::Terminal,
        ] {
            let mut data = fixture_data(kind);
            normalize(&mut data).unwrap();
            assert_eq!(
                (data.x, data.y, data.width, data.height),
                (1_000_000.0, -1_000_000.0, 48.0, 20_000.0)
            );
            assert_eq!(
                (data.grid_columns, data.grid_rows),
                (if kind.is_region() { 12 } else { 0 }, 0)
            );
            assert_eq!(data.title.as_deref(), Some("节点"));
            assert_eq!(data.color.as_deref(), Some("blue"));
            let mut encoded = serde_json::to_value(&data).unwrap();
            encoded["unknownField"] = json!(true);
            assert!(serde_json::from_value::<CanvasNodeData>(encoded).is_err());
        }
        let mut note = fixture_data(CanvasNodeKind::Note);
        normalize(&mut note).unwrap();
        assert_eq!(note.content.as_deref(), Some("\n中文 **便签**\n"));
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut note = fixture_data(CanvasNodeKind::Note);
            note.x = value;
            assert_eq!(normalize(&mut note), Err("invalid_geometry"));
        }
        for path in ["relative/file", "C:relative", "bad\0name"] {
            let mut file = fixture_data(CanvasNodeKind::File);
            file.path = Some(path.into());
            assert_eq!(normalize(&mut file), Err("invalid_path"));
        }
        for path in [
            "/unmounted/file",
            "C:/missing/file",
            r"C:\missing\file",
            r"\\server\offline\file",
        ] {
            let mut file = fixture_data(CanvasNodeKind::File);
            file.path = Some(path.into());
            normalize(&mut file).unwrap();
        }
        let mut file = fixture_data(CanvasNodeKind::File);
        file.path = Some(format!("/{}", "中".repeat(4095)));
        normalize(&mut file).unwrap();
        file.path = Some(format!("/{}", "中".repeat(4096)));
        assert_eq!(normalize(&mut file), Err("invalid_path"));
        let mut custom = fixture_data(CanvasNodeKind::Custom);
        custom.conversations = (0..200)
            .map(|n| CanvasConversationRef {
                thread_id: format!("thread-{n}"),
                conversation_id: None,
            })
            .collect();
        normalize(&mut custom).unwrap();
        custom.conversations.push(custom.conversations[0].clone());
        normalize(&mut custom).unwrap();
        assert_eq!(custom.conversations.len(), 200);
        custom.conversations.push(CanvasConversationRef {
            thread_id: "extra".into(),
            conversation_id: None,
        });
        assert_eq!(normalize(&mut custom), Err("too_many_members"));
        let mut malformed = fixture_data(CanvasNodeKind::Note);
        malformed.path = Some("/unrelated".into());
        assert_eq!(normalize(&mut malformed), Err("invalid_path"));
        let mut malformed = fixture_data(CanvasNodeKind::File);
        malformed.content = Some("invisible".into());
        assert_eq!(normalize(&mut malformed), Err("invalid_content"));
        let legacy = serde_json::json!({"type":"group","targetNodeId":null,"newRegion":null,"conversations":[],"consumeNodeIds":[]});
        let parsed: CanvasNodeMutation = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
        assert!(
            serde_json::to_value(fixture_data(CanvasNodeKind::Conversation))
                .unwrap()
                .get("objectReference")
                .is_none()
        );
        for object in [
            json!({"kind":"mission","missionId":"mission"}),
            json!({"kind":"task","taskId":"task"}),
            json!({"kind":"mission_diff","missionId":"mission","path":" dir/中文.rs "}),
        ] {
            let mut data = fixture_data(CanvasNodeKind::Conversation);
            data.object_reference = Some(serde_json::from_value(object.clone()).unwrap());
            normalize(&mut data).unwrap();
            assert_eq!(
                serde_json::to_value(&data.object_reference).unwrap(),
                object
            );
            data.kind = CanvasNodeKind::Note;
            assert_eq!(normalize(&mut data), Err("invalid_object_reference"));
        }
        assert!(
            serde_json::from_value::<crate::canvas_object_reference::CanvasObjectReference>(
                json!({"kind":"mission","missionId":"mission","taskId":"task"})
            )
            .is_err()
        );
        let mut bound_file = fixture_data(CanvasNodeKind::File);
        bound_file.path = Some("/workspace/原文件.txt ".into());
        bound_file.file_reference = Some(crate::canvas_file_reference::CanvasFileReference {
            thread_id: "original-thread".into(),
        });
        normalize(&mut bound_file).unwrap();
        assert_eq!(bound_file.path.as_deref(), Some("/workspace/原文件.txt "));
        bound_file.kind = CanvasNodeKind::Terminal;
        assert_eq!(normalize(&mut bound_file), Err("invalid_file_reference"));
        assert!(
            !serde_json::to_value(fixture_data(CanvasNodeKind::File))
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("fileReference")
        );
        for bad in ["", " thread", "thread ", "thread\0", &"x".repeat(129)] {
            assert!(
                !crate::canvas_file_reference::CanvasFileReference {
                    thread_id: bad.into()
                }
                .valid()
            );
        }
        assert!(
            serde_json::from_value::<crate::canvas_file_reference::CanvasFileReference>(
                json!({"threadId":"thread","rootGrantId":"injected"})
            )
            .is_err()
        );
    }
}

#[cfg(all(test, feature = "extended-tests"))]
mod persistence_tests {
    use super::*;
    use crate::command::{ActorRef, CommandResultStatus};
    fn envelope<T>(payload: T) -> CommandEnvelope<T> {
        CommandEnvelope {
            command_id: uuid::Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "graph-user".into(),
            },
            camp_id: None,
            expected_versions: vec![],
            execution_epoch: None,
            payload,
        }
    }
    fn revision(database: &Database, id: &str) -> i64 {
        snapshot(database.connection(), id)
            .unwrap()
            .board
            .unwrap()
            .revision
    }
    fn command(
        database: &Database,
        id: &str,
        mutation: CanvasNodeMutation,
    ) -> CommandEnvelope<ApplyCanvasNodesCommand> {
        envelope(ApplyCanvasNodesCommand {
            board_id: id.into(),
            expected_revision: revision(database, id),
            mutation,
        })
    }
    fn run(
        database: &mut Database,
        id: &str,
        mutation: CanvasNodeMutation,
    ) -> crate::command::StoredCommandResult {
        let request = command(database, id, mutation);
        let result = apply(database, &request).unwrap().result;
        assert_eq!(result.status, CommandResultStatus::Applied, "{result:?}");
        result
    }
    fn board(database: &mut Database) -> String {
        canvas_board::create(
            database,
            &envelope(canvas_board::CreateCanvasBoardCommand {
                name: None,
                description: None,
                color: None,
            }),
        )
        .unwrap()
        .result
        .payload["board"]["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn verify_object_pins(
        database: &mut crate::test_support::OwnedTestDatabase,
        other_thread: &str,
    ) -> String {
        use crate::canvas_object_reference::CanvasObjectReference;
        let workspace = database.directory().join("object-pin-workspace");
        std::fs::create_dir(&workspace).unwrap();
        let mission = crate::mission::MissionService::default()
            .create(
                database,
                &envelope(crate::mission::CreateMissionCommand {
                    title: "画布对象引用".into(),
                    description: "只验证对象身份，不执行模型".into(),
                    description_content: None,
                    project_path: workspace.display().to_string(),
                    project_binding_kind: crate::collaboration::ProjectBindingKind::Directory,
                    member_agent_ids: vec!["agent_1".into()],
                    default_lead_agent_id: "agent_1".into(),
                    tags: vec![],
                    source_attachments: vec![],
                }),
            )
            .unwrap()
            .result;
        assert_eq!(mission.status, CommandResultStatus::Applied);
        let mission_id = mission.payload["missionId"].as_str().unwrap().to_owned();
        let thread_id = mission.payload["threadId"].as_str().unwrap().to_owned();
        let mut task_command = envelope(crate::collaboration::CreateTaskCommand {
            camp_id: thread_id.clone(),
            title: "原任务".into(),
            description: "任务正文".into(),
            assignee_agent_id: "agent_1".into(),
        });
        task_command.camp_id = Some(thread_id.clone());
        let task = crate::collaboration::CollaborationService::default()
            .create_task(database, &task_command)
            .unwrap()
            .result;
        assert_eq!(task.status, CommandResultStatus::Applied, "{task:?}");
        let task_id = task.payload["taskId"].as_str().unwrap().to_owned();
        let references = vec![
            CanvasObjectReference::Mission {
                mission_id: mission_id.clone(),
            },
            CanvasObjectReference::Task {
                task_id: task_id.clone(),
            },
            CanvasObjectReference::MissionDiff {
                mission_id: mission_id.clone(),
                path: Some(" dir/中文.rs ".into()),
            },
        ];
        let id = board(database);
        let mut ids = Vec::new();
        for reference in &references {
            let mut data = fixture_data(CanvasNodeKind::Conversation);
            data.conversation = Some(CanvasConversationRef {
                thread_id: thread_id.clone(),
                conversation_id: None,
            });
            data.object_reference = Some(reference.clone());
            let request = command(database, &id, CanvasNodeMutation::Create { node: data });
            let first = apply(database, &request).unwrap().result;
            assert_eq!(first.status, CommandResultStatus::Applied);
            assert_eq!(apply(database, &request).unwrap().result, first);
            ids.push(first.payload["nodeIds"][0].as_str().unwrap().to_owned());
        }
        let stored = snapshot(database.connection(), &id).unwrap();
        assert_eq!(stored.object_reference_version, 1);
        assert_eq!(stored.terminal_version, 1);
        for (node_id, reference) in ids.iter().zip(&references) {
            assert_eq!(
                stored
                    .nodes
                    .iter()
                    .find(|n| n.id == *node_id)
                    .unwrap()
                    .data
                    .object_reference
                    .as_ref(),
                Some(reference)
            );
        }
        assert!(database.connection().execute("UPDATE canvas_node_object_reference SET mission_id=mission_id WHERE node_id=?1",[&ids[0]]).is_err());
        let mut wrong = stored.nodes[0].data.clone();
        wrong.conversation.as_mut().unwrap().thread_id = other_thread.into();
        let request = command(database, &id, CanvasNodeMutation::Create { node: wrong });
        assert_eq!(
            apply(database, &request).unwrap().result.code,
            "canvas.nodes.binding_unavailable"
        );
        let request = command(
            database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: None,
                new_region: Some(fixture_data(CanvasNodeKind::Custom)),
                conversations: vec![CanvasConversationRef {
                    thread_id: thread_id.clone(),
                    conversation_id: None,
                }],
                consume_node_ids: vec![ids[0].clone()],
                source_members: vec![],
            },
        );
        assert_eq!(
            apply(database, &request).unwrap().result.code,
            "canvas.nodes.object_reference_not_groupable"
        );
        let before = serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_object_pin_receipt BEFORE INSERT ON event_log WHEN NEW.command_type='canvas.nodes.apply' AND NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'object pin rollback fixture');END;").unwrap();
        let request = command(
            database,
            &id,
            CanvasNodeMutation::Create {
                node: stored.nodes[0].data.clone(),
            },
        );
        assert!(apply(database, &request).is_err());
        assert_eq!(
            before,
            serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap()
        );
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM canvas_node_object_reference",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_object_pin_receipt;")
            .unwrap();
        let extra = run(
            database,
            &id,
            CanvasNodeMutation::Create {
                node: stored.nodes[0].data.clone(),
            },
        )
        .payload["nodeIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        run(
            database,
            &id,
            CanvasNodeMutation::Delete {
                node_ids: vec![extra],
            },
        );
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM mission WHERE id=?1",
                    [&mission_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM task WHERE id=?1", [&task_id], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        database
            .connection()
            .execute("DELETE FROM mission WHERE id=?1", [mission_id])
            .unwrap();
        database
            .connection()
            .execute("DELETE FROM task WHERE id=?1", [task_id])
            .unwrap();
        // owned夹具模拟引用的Thread也已不可用，不能清除或替换其原对象身份。
        database
            .connection()
            .execute(
                "UPDATE canvas_node SET thread_id='missing-object-thread' WHERE id=?1",
                [&ids[0]],
            )
            .unwrap();
        run(database, &id, CanvasNodeMutation::Prune);
        assert_eq!(snapshot(database.connection(), &id).unwrap().nodes.len(), 3);
        run(
            database,
            &id,
            CanvasNodeMutation::Update {
                node_id: ids[0].clone(),
                patch: CanvasNodePatch {
                    title: Some("原对象不可用时仍可整理布局".into()),
                    ..Default::default()
                },
            },
        );
        assert_eq!(
            snapshot(database.connection(), &id)
                .unwrap()
                .nodes
                .iter()
                .find(|n| n.id == ids[0])
                .unwrap()
                .data
                .object_reference,
            Some(references[0].clone())
        );
        id
    }
    fn verify_file_pins(
        database: &mut crate::test_support::OwnedTestDatabase,
        thread_id: &str,
    ) -> String {
        use crate::canvas_file_reference::CanvasFileReference;
        let id = board(database);
        let reference = CanvasFileReference {
            thread_id: thread_id.into(),
        };
        let mut data = fixture_data(CanvasNodeKind::File);
        data.path = Some(
            database
                .directory()
                .join("missing #文档.txt ")
                .display()
                .to_string(),
        );
        data.file_reference = Some(reference.clone());
        let request = command(
            database,
            &id,
            CanvasNodeMutation::Create { node: data.clone() },
        );
        let first = apply(database, &request).unwrap().result;
        assert_eq!(first.status, CommandResultStatus::Applied);
        assert_eq!(apply(database, &request).unwrap().result, first);
        let node_id = first.payload["nodeIds"][0].as_str().unwrap().to_owned();
        let stored = snapshot(database.connection(), &id).unwrap();
        assert_eq!(stored.file_reference_version, 1);
        let expected = CanvasNodeData {
            title: Some("节点".into()),
            color: Some("blue".into()),
            grid_columns: 0,
            grid_rows: 0,
            x: 1_000_000.0,
            y: -1_000_000.0,
            width: 48.0,
            height: 20_000.0,
            ..data.clone()
        };
        assert_eq!(stored.nodes[0].data, expected);
        assert!(database.connection().execute("UPDATE canvas_node_file_reference SET file_thread_id=file_thread_id WHERE node_id=?1", [&node_id]).is_err());
        let mut missing = data.clone();
        missing.file_reference.as_mut().unwrap().thread_id = "missing-thread".into();
        let invalid = command(database, &id, CanvasNodeMutation::Create { node: missing });
        assert_eq!(
            apply(database, &invalid).unwrap().result.code,
            "canvas.nodes.binding_unavailable"
        );
        let legacy = run(
            database,
            &id,
            CanvasNodeMutation::Create {
                node: fixture_data(CanvasNodeKind::File),
            },
        )
        .payload["nodeIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let bind = command(
            database,
            &id,
            CanvasNodeMutation::BindFile {
                node_id: legacy.clone(),
                thread_id: thread_id.into(),
            },
        );
        let bound = apply(database, &bind).unwrap().result;
        assert_eq!(bound.status, CommandResultStatus::Applied);
        assert_eq!(apply(database, &bind).unwrap().result, bound);
        let wrong = command(
            database,
            &id,
            CanvasNodeMutation::BindFile {
                node_id: legacy.clone(),
                thread_id: "replacement".into(),
            },
        );
        assert_eq!(
            apply(database, &wrong).unwrap().result.code,
            "canvas.nodes.file_binding_immutable"
        );
        let other_board = board(database);
        let cross = command(
            database,
            &other_board,
            CanvasNodeMutation::BindFile {
                node_id: legacy,
                thread_id: thread_id.into(),
            },
        );
        assert_eq!(
            apply(database, &cross).unwrap().result.code,
            "canvas.nodes.not_found"
        );
        let before = serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_canvas_file_receipt BEFORE INSERT ON event_log WHEN NEW.command_type='canvas.nodes.apply' AND NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'file reference rollback fixture');END;").unwrap();
        let failed = command(database, &id, CanvasNodeMutation::Create { node: data });
        assert!(apply(database, &failed).is_err());
        assert_eq!(
            serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap(),
            before
        );
        assert!(!database.connection().query_row("SELECT EXISTS(SELECT 1 FROM event_log WHERE command_id=?1 AND event_type='command.result')", [&failed.command_id], |row| row.get::<_,bool>(0)).unwrap());
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_canvas_file_receipt;")
            .unwrap();
        // Missing original Thread is a retained soft reference, not a new implicit binding.
        database
            .connection()
            .execute(
                "UPDATE camp SET activation_state='pending' WHERE id=?1",
                [thread_id],
            )
            .unwrap();
        run(database, &id, CanvasNodeMutation::Prune);
        run(
            database,
            &id,
            CanvasNodeMutation::Update {
                node_id: node_id.clone(),
                patch: CanvasNodePatch {
                    title: Some("保留原引用".into()),
                    ..Default::default()
                },
            },
        );
        assert_eq!(
            snapshot(database.connection(), &id)
                .unwrap()
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .unwrap()
                .data
                .file_reference
                .as_ref(),
            Some(&reference)
        );
        assert_eq!(apply(database, &request).unwrap().result, first);
        database
            .connection()
            .execute(
                "UPDATE camp SET activation_state='active' WHERE id=?1",
                [thread_id],
            )
            .unwrap();
        id
    }
    #[test]
    fn migration_and_graph_gestures_preserve_scope_atomicity_replay_and_reopen() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        downgrade_for_test(database.connection());
        let id = board(&mut database);
        let other_id = board(&mut database);
        let before =
            serde_json::to_value(canvas_board::list(database.connection()).unwrap()).unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_node_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=204 BEGIN SELECT RAISE(ABORT,'node migration receipt fixture'); END;").unwrap();
        assert!(database.migrate_canvas_nodes().is_err());
        assert!(
            !database
                .connection()
                .table_exists(None, "canvas_node")
                .unwrap()
        );
        assert!(
            !database
                .connection()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=204)",
                    [],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap()
        );
        assert_eq!(
            before,
            serde_json::to_value(canvas_board::list(database.connection()).unwrap()).unwrap()
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_node_receipt;")
            .unwrap();
        database.migrate_canvas_nodes().unwrap();
        crate::db::upgrade_canvas_object_fixture(&mut database);
        assert!(schema_matches(database.connection()).unwrap());
        let workspace = database.directory().join("node-workspace");
        std::fs::create_dir(&workspace).unwrap();
        let created = crate::collaboration::CollaborationService::default()
            .create_camp(
                &mut database,
                &envelope(crate::collaboration::CreateThreadCommand::for_test(
                    workspace.display().to_string(),
                )),
            )
            .unwrap();
        assert_eq!(
            created.result.status,
            CommandResultStatus::Applied,
            "{:?}",
            created.result
        );
        let thread_id = created
            .result
            .payload
            .get("threadId")
            .or_else(|| created.result.payload.get("campId"))
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let reference = CanvasConversationRef {
            thread_id: thread_id.clone(),
            conversation_id: None,
        };
        for kind in [
            CanvasNodeKind::Folder,
            CanvasNodeKind::Group,
            CanvasNodeKind::Agent,
            CanvasNodeKind::Conversation,
            CanvasNodeKind::Custom,
            CanvasNodeKind::Note,
            CanvasNodeKind::File,
            CanvasNodeKind::Terminal,
        ] {
            let mut data = fixture_data(kind);
            if kind == CanvasNodeKind::Conversation {
                data.conversation = Some(reference.clone());
            }
            if kind == CanvasNodeKind::Custom {
                data.conversations = vec![reference.clone()];
            }
            run(
                &mut database,
                &id,
                CanvasNodeMutation::Create { node: data },
            );
        }
        crate::db::verify_canvas_object_fixture(&mut database);
        let initial = snapshot(database.connection(), &id).unwrap();
        assert_eq!(initial.nodes.len(), 8);
        let note = initial
            .nodes
            .iter()
            .find(|n| n.data.kind == CanvasNodeKind::Note)
            .unwrap()
            .clone();
        let pin = initial
            .nodes
            .iter()
            .find(|n| n.data.kind == CanvasNodeKind::Conversation)
            .unwrap()
            .clone();
        let region = initial
            .nodes
            .iter()
            .find(|n| n.data.kind == CanvasNodeKind::Custom)
            .unwrap()
            .clone();
        let create_other = run(
            &mut database,
            &other_id,
            CanvasNodeMutation::Create {
                node: fixture_data(CanvasNodeKind::Note),
            },
        );
        let foreign_node = create_other.payload["nodeIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let mut forbidden = command(
            &database,
            &id,
            CanvasNodeMutation::Delete {
                node_ids: vec![note.id.clone()],
            },
        );
        forbidden.actor = ActorRef::System {
            component_id: "not-a-user".into(),
        };
        assert_eq!(
            apply(&mut database, &forbidden).unwrap().result.code,
            "canvas.nodes.forbidden"
        );
        let update = command(
            &database,
            &id,
            CanvasNodeMutation::Update {
                node_id: note.id.clone(),
                patch: CanvasNodePatch {
                    x: Some(42.0),
                    content: Some("新便签".into()),
                    ..Default::default()
                },
            },
        );
        let first = apply(&mut database, &update).unwrap().result;
        assert_eq!(first.status, CommandResultStatus::Applied);
        let after = snapshot(database.connection(), &id).unwrap();
        assert_eq!(
            after
                .nodes
                .iter()
                .find(|n| n.id == note.id)
                .unwrap()
                .data
                .content
                .as_deref(),
            Some("新便签")
        );
        assert_eq!(apply(&mut database, &update).unwrap().result, first);
        assert_eq!(
            snapshot(database.connection(), &id)
                .unwrap()
                .through_global_sequence,
            after.through_global_sequence
        );
        let mut stale = update.clone();
        stale.command_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            apply(&mut database, &stale).unwrap().result.code,
            "canvas.nodes.conflict"
        );
        let previous_revision = revision(&database, &id);
        let rejected = command(
            &database,
            &id,
            CanvasNodeMutation::Move {
                moves: vec![
                    CanvasNodeMove {
                        node_id: note.id.clone(),
                        x: 99.0,
                        y: 99.0,
                    },
                    CanvasNodeMove {
                        node_id: pin.id.clone(),
                        x: f64::NAN,
                        y: 0.0,
                    },
                ],
            },
        );
        assert_eq!(
            apply(&mut database, &rejected).unwrap().result.code,
            "canvas.nodes.invalid_geometry"
        );
        assert_eq!(revision(&database, &id), previous_revision);
        assert_eq!(
            snapshot(database.connection(), &id)
                .unwrap()
                .nodes
                .iter()
                .find(|n| n.id == note.id)
                .unwrap()
                .data
                .x,
            42.0
        );
        let failure = command(
            &database,
            &id,
            CanvasNodeMutation::Move {
                moves: vec![CanvasNodeMove {
                    node_id: note.id.clone(),
                    x: 80.0,
                    y: 80.0,
                }],
            },
        );
        let before_failure =
            serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_layout_body_rewrite BEFORE UPDATE OF content ON canvas_node BEGIN SELECT RAISE(ABORT,'layout must not rewrite note body'); END;").unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_node_result BEFORE INSERT ON event_log WHEN NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'node result fixture'); END;").unwrap();
        assert!(apply(&mut database, &failure).is_err());
        assert_eq!(
            serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap(),
            before_failure
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_node_result;")
            .unwrap();
        assert_eq!(
            apply(&mut database, &failure).unwrap().result.status,
            CommandResultStatus::Applied
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_layout_body_rewrite;")
            .unwrap();
        let foreign_before =
            serde_json::to_value(snapshot(database.connection(), &other_id).unwrap()).unwrap();
        run(
            &mut database,
            &id,
            CanvasNodeMutation::Move {
                moves: vec![CanvasNodeMove {
                    node_id: foreign_node.clone(),
                    x: 800.0,
                    y: 800.0,
                }],
            },
        );
        assert_eq!(
            serde_json::to_value(snapshot(database.connection(), &other_id).unwrap()).unwrap()["nodes"],
            foreign_before["nodes"]
        );
        let mut open = envelope(
            serde_json::from_value::<crate::single_chat::OpenSingleChatCommand>(
                json!({"threadId":thread_id,"agentId":"agent_1"}),
            )
            .unwrap(),
        );
        open.camp_id = Some(thread_id.clone());
        let opened = crate::single_chat::SingleChatService::for_client(Default::default())
            .open(&mut database, &open)
            .unwrap();
        assert_eq!(
            opened.result.status,
            CommandResultStatus::Applied,
            "{:?}",
            opened.result
        );
        let conversation_id = opened.result.payload["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        let distinct = CanvasConversationRef {
            thread_id: thread_id.clone(),
            conversation_id: Some(conversation_id),
        };
        let mut data = fixture_data(CanvasNodeKind::Conversation);
        data.conversation = Some(distinct.clone());
        let second = run(
            &mut database,
            &id,
            CanvasNodeMutation::Create { node: data },
        );
        let second_pin = second.payload["nodeIds"][0].as_str().unwrap().to_owned();
        let invalid = command(
            &database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: Some(region.id.clone()),
                new_region: None,
                conversations: vec![reference.clone()],
                consume_node_ids: vec![second_pin.clone()],
                source_members: vec![],
            },
        );
        assert_eq!(
            apply(&mut database, &invalid).unwrap().result.code,
            "canvas.nodes.unadopted_conversation"
        );
        let grouped = run(
            &mut database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: Some(region.id.clone()),
                new_region: None,
                conversations: vec![distinct.clone(), reference.clone(), distinct.clone()],
                consume_node_ids: vec![
                    pin.id.clone(),
                    second_pin.clone(),
                    note.id.clone(),
                    foreign_node.clone(),
                ],
                source_members: vec![],
            },
        );
        assert_eq!(
            grouped.payload["deletedNodeIds"].as_array().unwrap().len(),
            2
        );
        let grouped_snapshot = snapshot(database.connection(), &id).unwrap();
        assert!(grouped_snapshot.nodes.iter().any(|n| n.id == note.id));
        assert_eq!(
            grouped_snapshot
                .nodes
                .iter()
                .find(|n| n.id == region.id)
                .unwrap()
                .data
                .conversations,
            [reference.clone(), distinct.clone()]
        );
        let mut mirror_data = fixture_data(CanvasNodeKind::Custom);
        mirror_data.conversations = vec![reference.clone(), distinct.clone()];
        let mirror = run(
            &mut database,
            &id,
            CanvasNodeMutation::Create { node: mirror_data },
        )
        .payload["nodeIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let mut target_data = fixture_data(CanvasNodeKind::Custom);
        target_data.conversations.clear();
        let target = run(
            &mut database,
            &id,
            CanvasNodeMutation::Create { node: target_data },
        )
        .payload["nodeIds"][0]
            .as_str()
            .unwrap()
            .to_owned();
        let invalid_source = command(
            &database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: Some(target.clone()),
                new_region: None,
                conversations: vec![reference.clone()],
                consume_node_ids: vec![],
                source_members: vec![CanvasSourceMember {
                    region_id: region.id.clone(),
                    conversation: distinct.clone(),
                }],
            },
        );
        let before_invalid = revision(&database, &id);
        assert_eq!(
            apply(&mut database, &invalid_source).unwrap().result.code,
            "canvas.nodes.invalid_source_member"
        );
        assert_eq!(revision(&database, &id), before_invalid);
        let transfer = command(
            &database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: Some(target.clone()),
                new_region: None,
                conversations: vec![reference.clone(), distinct.clone()],
                consume_node_ids: vec![],
                source_members: vec![
                    CanvasSourceMember {
                        region_id: region.id.clone(),
                        conversation: reference.clone(),
                    },
                    CanvasSourceMember {
                        region_id: mirror.clone(),
                        conversation: distinct.clone(),
                    },
                ],
            },
        );
        let transferred = apply(&mut database, &transfer).unwrap();
        assert_eq!(transferred.result.status, CommandResultStatus::Applied);
        let after_transfer = revision(&database, &id);
        assert_eq!(
            apply(&mut database, &transfer).unwrap().result,
            transferred.result
        );
        assert_eq!(revision(&database, &id), after_transfer);
        let current = snapshot(database.connection(), &id).unwrap();
        assert_eq!(
            current
                .nodes
                .iter()
                .find(|node| node.id == region.id)
                .unwrap()
                .data
                .conversations,
            [distinct.clone()]
        );
        assert_eq!(
            current
                .nodes
                .iter()
                .find(|node| node.id == mirror)
                .unwrap()
                .data
                .conversations,
            [reference.clone()]
        );
        assert_eq!(
            current
                .nodes
                .iter()
                .find(|node| node.id == target)
                .unwrap()
                .data
                .conversations,
            [reference.clone(), distinct.clone()]
        );
        let folder = current
            .nodes
            .iter()
            .find(|node| node.data.kind == CanvasNodeKind::Folder)
            .unwrap();
        let folder_id = folder.id.clone();
        let folder_data = folder.data.clone();
        run(
            &mut database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: Some(target.clone()),
                new_region: None,
                conversations: vec![reference.clone()],
                consume_node_ids: vec![],
                source_members: vec![CanvasSourceMember {
                    region_id: folder_id.clone(),
                    conversation: reference.clone(),
                }],
            },
        );
        assert_eq!(
            serde_json::to_value(
                snapshot(database.connection(), &id)
                    .unwrap()
                    .nodes
                    .iter()
                    .find(|node| node.id == folder_id)
                    .unwrap()
                    .data
                    .clone()
            )
            .unwrap(),
            serde_json::to_value(folder_data).unwrap()
        );
        run(
            &mut database,
            &id,
            CanvasNodeMutation::Group {
                target_node_id: Some(region.id.clone()),
                new_region: None,
                conversations: vec![reference.clone()],
                consume_node_ids: vec![],
                source_members: vec![],
            },
        );
        run(
            &mut database,
            &id,
            CanvasNodeMutation::Delete {
                node_ids: vec![mirror, target],
            },
        );
        run(
            &mut database,
            &id,
            CanvasNodeMutation::Detach {
                region_id: region.id.clone(),
                conversation: distinct.clone(),
                x: 12.0,
                y: 34.0,
            },
        );
        let detached = snapshot(database.connection(), &id).unwrap();
        let restored = detached
            .nodes
            .iter()
            .find(|n| n.data.conversation.as_ref() == Some(&distinct))
            .unwrap();
        assert_eq!((restored.data.width, restored.data.height), (224.0, 132.0));
        assert_eq!(
            detached
                .nodes
                .iter()
                .find(|n| n.id == region.id)
                .unwrap()
                .data
                .conversations,
            [reference.clone()]
        );
        // Model a soft reference whose target disappeared. Do not delete Camp
        // business facts merely to exercise the graph's cleanup owner.
        let mut orphan = restored.data.clone();
        orphan.conversation.as_mut().unwrap().thread_id = "missing-target".into();
        database
            .connection()
            .execute(
                "UPDATE canvas_node SET thread_id=?2 WHERE id=?1",
                params![restored.id, orphan.conversation.as_ref().unwrap().thread_id],
            )
            .unwrap();
        run(&mut database, &id, CanvasNodeMutation::Prune);
        assert!(
            !snapshot(database.connection(), &id)
                .unwrap()
                .nodes
                .iter()
                .any(|n| n.id == restored.id)
        );
        let object_board = verify_object_pins(&mut database, &thread_id);
        let file_board = verify_file_pins(&mut database, &thread_id);
        let file_preserved =
            serde_json::to_value(snapshot(database.connection(), &file_board).unwrap()).unwrap();
        let object_preserved =
            serde_json::to_value(snapshot(database.connection(), &object_board).unwrap()).unwrap();
        let preserved =
            serde_json::to_value(snapshot(database.connection(), &id).unwrap()).unwrap();
        let root = database.directory().to_path_buf();
        database.close();
        let mut reopened = Database::open(&root).unwrap();
        assert_eq!(
            file_preserved,
            serde_json::to_value(snapshot(reopened.connection(), &file_board).unwrap()).unwrap()
        );
        assert_eq!(
            object_preserved,
            serde_json::to_value(snapshot(reopened.connection(), &object_board).unwrap()).unwrap()
        );
        assert_eq!(
            preserved,
            serde_json::to_value(snapshot(reopened.connection(), &id).unwrap()).unwrap()
        );
        let delete = canvas_board::DeleteCanvasBoardCommand {
            board_id: id.clone(),
            expected_revision: revision(&reopened, &id),
        };
        canvas_board::delete(&mut reopened, &envelope(delete)).unwrap();
        assert!(
            snapshot(reopened.connection(), &id)
                .unwrap()
                .nodes
                .is_empty()
        );
        assert!(
            snapshot(reopened.connection(), &id)
                .unwrap()
                .board
                .is_none()
        );
        assert_eq!(apply(&mut reopened, &update).unwrap().result, first);
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM camp WHERE id=?1",
                    [&thread_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            reopened
                .connection()
                .query_row("SELECT COUNT(*) FROM agent_run", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            reopened
                .connection()
                .query_row("SELECT COUNT(*) FROM context_manifest", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let object_delete = canvas_board::DeleteCanvasBoardCommand {
            board_id: object_board.clone(),
            expected_revision: revision(&reopened, &object_board),
        };
        let file_delete = canvas_board::DeleteCanvasBoardCommand {
            board_id: file_board.clone(),
            expected_revision: revision(&reopened, &file_board),
        };
        canvas_board::delete(&mut reopened, &envelope(file_delete)).unwrap();
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM canvas_node_file_reference",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        canvas_board::delete(&mut reopened, &envelope(object_delete)).unwrap();
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM canvas_node_object_reference",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            reopened
                .connection()
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
}
