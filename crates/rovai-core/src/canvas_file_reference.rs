//! 文件节点保存原 Thread 来源，不保存文件能力或绕过现行文件预览准入。
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasFileReference {
    pub thread_id: String,
}
pub(crate) const TABLE_SQL: &str = "CREATE TABLE canvas_node_file_reference (
    node_id TEXT PRIMARY KEY NOT NULL REFERENCES canvas_node(id) ON DELETE CASCADE,
    file_thread_id TEXT NOT NULL CHECK(length(file_thread_id) BETWEEN 1 AND 128 AND file_thread_id=trim(file_thread_id) AND instr(file_thread_id,char(0))=0)
);";
pub(crate) const OWNER_SQL: &str = "CREATE TRIGGER canvas_node_file_reference_owner
BEFORE INSERT ON canvas_node_file_reference
WHEN NOT EXISTS(SELECT 1 FROM canvas_node n JOIN camp c ON c.id=NEW.file_thread_id
    WHERE n.id=NEW.node_id AND n.kind='file' AND n.path IS NOT NULL
      AND c.deletion_operation_id IS NULL AND c.activation_state='active' AND c.project_binding_kind='directory')
BEGIN SELECT RAISE(ABORT,'Canvas file reference requires its original directory Thread'); END;";
pub(crate) const IMMUTABLE_SQL: &str = "CREATE TRIGGER canvas_node_file_reference_immutable
BEFORE UPDATE ON canvas_node_file_reference
BEGIN SELECT RAISE(ABORT,'Canvas file reference is immutable'); END;";
pub(crate) const JOIN: &str =
    "LEFT JOIN canvas_node_file_reference ON canvas_node_file_reference.node_id=canvas_node.id";
pub(crate) const COLUMNS: &str = "file_thread_id";

impl CanvasFileReference {
    pub(crate) fn valid(&self) -> bool {
        !self.thread_id.is_empty()
            && self.thread_id.trim() == self.thread_id
            && self.thread_id.chars().count() <= 128
            && !self.thread_id.contains('\0')
    }
    pub(crate) fn live(&self, connection: &Connection) -> rusqlite::Result<bool> {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM camp WHERE id=?1 AND deletion_operation_id IS NULL
            AND activation_state='active' AND project_binding_kind='directory')",
            [&self.thread_id],
            |row| row.get(0),
        )
    }
    pub(crate) fn insert(&self, connection: &Connection, node_id: &str) -> rusqlite::Result<()> {
        connection.execute(
            "INSERT INTO canvas_node_file_reference(node_id,file_thread_id) VALUES(?1,?2)",
            params![node_id, self.thread_id],
        )?;
        Ok(())
    }
}
