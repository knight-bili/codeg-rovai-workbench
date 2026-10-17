//! 画布卡片只保存不可变对象身份；业务、权限、执行和动态 Diff 仍由原 Core 服务拥有。
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CanvasObjectReference {
    Mission {
        #[serde(rename = "missionId")]
        mission_id: String,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: String,
    },
    MissionDiff {
        #[serde(rename = "missionId")]
        mission_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
}

pub(crate) const TABLE_SQL: &str = "CREATE TABLE canvas_node_object_reference (
    node_id TEXT PRIMARY KEY NOT NULL REFERENCES canvas_node(id) ON DELETE CASCADE,
    object_kind TEXT NOT NULL CHECK(object_kind IN ('mission','task','mission_diff')),
    mission_id TEXT, task_id TEXT, diff_path TEXT,
    CHECK((object_kind IN ('mission','mission_diff') AND mission_id IS NOT NULL AND length(mission_id) BETWEEN 1 AND 300 AND task_id IS NULL)
       OR (object_kind='task' AND task_id IS NOT NULL AND length(task_id) BETWEEN 1 AND 300 AND mission_id IS NULL)),
    CHECK(diff_path IS NULL OR (object_kind='mission_diff' AND length(diff_path) BETWEEN 1 AND 4096))
);";
pub(crate) const OWNER_SQL: &str = "CREATE TRIGGER canvas_node_object_reference_owner
BEFORE INSERT ON canvas_node_object_reference
WHEN NOT EXISTS(SELECT 1 FROM canvas_node n JOIN camp c ON c.id=n.thread_id AND c.deletion_operation_id IS NULL
    WHERE n.id=NEW.node_id AND n.kind='conversation' AND n.conversation_id IS NULL AND (
      (NEW.object_kind IN ('mission','mission_diff') AND EXISTS(SELECT 1 FROM mission m WHERE m.id=NEW.mission_id AND m.camp_id=n.thread_id))
      OR (NEW.object_kind='task' AND EXISTS(SELECT 1 FROM task t WHERE t.id=NEW.task_id AND t.camp_id=n.thread_id))))
BEGIN SELECT RAISE(ABORT,'Canvas object reference requires its original Thread'); END;";
pub(crate) const IMMUTABLE_SQL: &str = "CREATE TRIGGER canvas_node_object_reference_immutable
BEFORE UPDATE ON canvas_node_object_reference
BEGIN SELECT RAISE(ABORT,'Canvas object reference is immutable'); END;";
pub(crate) const JOIN: &str =
    "LEFT JOIN canvas_node_object_reference ON canvas_node_object_reference.node_id=canvas_node.id";
pub(crate) const COLUMNS: &str = "object_kind,mission_id,task_id,diff_path";

impl CanvasObjectReference {
    pub(crate) fn valid(&self) -> bool {
        let id = match self {
            Self::Mission { mission_id } | Self::MissionDiff { mission_id, .. } => mission_id,
            Self::Task { task_id } => task_id,
        };
        if id.is_empty() || id.trim() != id || id.chars().count() > 300 || id.contains('\0') {
            return false;
        }
        match self {
            Self::MissionDiff {
                path: Some(path), ..
            } => !path.is_empty() && path.chars().count() <= 4096 && !path.contains('\0'),
            _ => true,
        }
    }
    pub(crate) fn live_in_thread(
        &self,
        connection: &Connection,
        thread: &str,
    ) -> rusqlite::Result<bool> {
        match self {
            Self::Mission { mission_id } | Self::MissionDiff { mission_id, .. } => connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM mission WHERE id=?1 AND camp_id=?2)",
                    params![mission_id, thread],
                    |row| row.get(0),
                ),
            Self::Task { task_id } => connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM task WHERE id=?1 AND camp_id=?2)",
                params![task_id, thread],
                |row| row.get(0),
            ),
        }
    }
    pub(crate) fn insert(&self, connection: &Connection, node_id: &str) -> rusqlite::Result<()> {
        let (kind, mission, task, path) = match self {
            Self::Mission { mission_id } => ("mission", Some(mission_id.as_str()), None, None),
            Self::Task { task_id } => ("task", None, Some(task_id.as_str()), None),
            Self::MissionDiff { mission_id, path } => (
                "mission_diff",
                Some(mission_id.as_str()),
                None,
                path.as_deref(),
            ),
        };
        connection.execute("INSERT INTO canvas_node_object_reference(node_id,object_kind,mission_id,task_id,diff_path) VALUES(?1,?2,?3,?4,?5)",params![node_id,kind,mission,task,path])?;
        Ok(())
    }
}

pub(crate) fn from_row(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<Option<CanvasObjectReference>> {
    let kind: Option<String> = row.get(offset)?;
    let reference = match kind.as_deref() {
        None => return Ok(None),
        Some("mission") => CanvasObjectReference::Mission {
            mission_id: row.get(offset + 1)?,
        },
        Some("task") => CanvasObjectReference::Task {
            task_id: row.get(offset + 2)?,
        },
        Some("mission_diff") => CanvasObjectReference::MissionDiff {
            mission_id: row.get(offset + 1)?,
            path: row.get(offset + 3)?,
        },
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                offset,
                "object_kind".into(),
                rusqlite::types::Type::Text,
            ));
        }
    };
    if !reference.valid() {
        return Err(rusqlite::Error::InvalidColumnType(
            offset,
            "object_reference".into(),
            rusqlite::types::Type::Text,
        ));
    }
    Ok(Some(reference))
}
