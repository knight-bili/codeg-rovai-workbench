//! 已确认私聊材料隔离 r1 的原子存储升级；旧行只进入默认 scope。
use super::*;

const DRAFT_TABLE_SQL: &str = "CREATE TABLE single_chat_composer_draft_v171 (
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL DEFAULT 'desktop',
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    source_attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_attachments_json) AND json_type(source_attachments_json)='array'),
    updated_at TEXT NOT NULL,
    quotes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(quotes_json) AND json_type(quotes_json)='array'),
    quote_trash_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(quote_trash_json) AND json_type(quote_trash_json)='array'),
    scope_key TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(conversation_id,client_id,scope_key)
);";

const TABLES_SQL: &str = "CREATE TABLE single_chat_composer_scope (
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    scope_key TEXT NOT NULL CHECK(scope_key='canvas:'||board_id||':'||node_id),
    board_id TEXT NOT NULL CHECK(length(board_id)=36 AND board_id NOT GLOB '*[^0-9a-f-]*'),
    node_id TEXT NOT NULL CHECK(length(node_id)=36 AND node_id NOT GLOB '*[^0-9a-f-]*'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id,client_id,scope_key)
);
CREATE TABLE single_chat_retained_input (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    body TEXT NOT NULL,
    source_attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_attachments_json) AND json_type(source_attachments_json)='array'),
    quotes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(quotes_json) AND json_type(quotes_json)='array'),
    quote_trash_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(quote_trash_json) AND json_type(quote_trash_json)='array'),
    source_pending_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX single_chat_retained_input_recovery_idx
    ON single_chat_retained_input(conversation_id,client_id,created_at,id);
ALTER TABLE single_chat_pending_input_edit_session ADD COLUMN scope_key TEXT NOT NULL DEFAULT '';";

const GUARDS_SQL: &str = "CREATE TRIGGER single_chat_composer_scope_insert_guard
BEFORE INSERT ON single_chat_composer_scope
WHEN NOT EXISTS(
    SELECT 1 FROM canvas_node AS node
    JOIN canvas_board AS board ON board.id=node.board_id
    JOIN conversation ON conversation.id=node.conversation_id
    JOIN camp ON camp.id=conversation.camp_id
    WHERE node.id=NEW.node_id AND node.board_id=NEW.board_id AND node.kind='conversation'
      AND node.conversation_id=NEW.conversation_id AND node.thread_id=conversation.camp_id
      AND conversation.kind='single_chat' AND conversation.ended_at IS NULL
      AND camp.activation_state='active' AND camp.deletion_operation_id IS NULL
      AND board.deleted_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'Private composer scope requires the exact active pin'); END;
CREATE TRIGGER single_chat_composer_scope_identity_guard
BEFORE UPDATE OF conversation_id,client_id,scope_key,board_id,node_id ON single_chat_composer_scope
WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.client_id IS NOT OLD.client_id
  OR NEW.scope_key IS NOT OLD.scope_key OR NEW.board_id IS NOT OLD.board_id OR NEW.node_id IS NOT OLD.node_id
BEGIN SELECT RAISE(ABORT,'Private composer scope identity is immutable'); END;
CREATE TRIGGER single_chat_composer_draft_binding_insert
BEFORE INSERT ON single_chat_composer_draft
WHEN NEW.scope_key<>'' AND NOT EXISTS(SELECT 1 FROM single_chat_composer_scope
    WHERE conversation_id=NEW.conversation_id AND client_id=NEW.client_id AND scope_key=NEW.scope_key)
BEGIN SELECT RAISE(ABORT,'Private composer draft requires its registered scope'); END;
CREATE TRIGGER single_chat_composer_draft_identity_guard
BEFORE UPDATE OF conversation_id,client_id,scope_key ON single_chat_composer_draft
WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.client_id IS NOT OLD.client_id OR NEW.scope_key IS NOT OLD.scope_key
BEGIN SELECT RAISE(ABORT,'Private composer draft identity is immutable'); END;
CREATE TRIGGER single_chat_retained_input_insert_guard
BEFORE INSERT ON single_chat_retained_input
WHEN NOT EXISTS(SELECT 1 FROM conversation WHERE id=NEW.conversation_id AND kind='single_chat' AND ended_at IS NULL)
 OR (NEW.scope_key<>'' AND NOT EXISTS(SELECT 1 FROM single_chat_composer_scope
     WHERE conversation_id=NEW.conversation_id AND client_id=NEW.client_id AND scope_key=NEW.scope_key))
 OR (NEW.source_pending_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM single_chat_pending_input
     WHERE id=NEW.source_pending_id AND conversation_id=NEW.conversation_id))
BEGIN SELECT RAISE(ABORT,'Private retained input requires its original owner and source'); END;
CREATE TRIGGER single_chat_retained_input_identity_guard
BEFORE UPDATE OF conversation_id,client_id,scope_key ON single_chat_retained_input
WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.client_id IS NOT OLD.client_id OR NEW.scope_key IS NOT OLD.scope_key
BEGIN SELECT RAISE(ABORT,'Private retained input identity is immutable'); END;
CREATE TRIGGER single_chat_pending_edit_scope_insert
BEFORE INSERT ON single_chat_pending_input_edit_session
WHEN NEW.scope_key<>'' AND NOT EXISTS(SELECT 1 FROM single_chat_composer_scope
    WHERE conversation_id=NEW.conversation_id AND client_id=NEW.client_id AND scope_key=NEW.scope_key)
BEGIN SELECT RAISE(ABORT,'Private pending edit requires its registered scope'); END;
CREATE TRIGGER single_chat_pending_edit_scope_update
BEFORE UPDATE OF conversation_id,client_id,scope_key ON single_chat_pending_input_edit_session
WHEN NEW.scope_key<>'' AND NOT EXISTS(SELECT 1 FROM single_chat_composer_scope
    WHERE conversation_id=NEW.conversation_id AND client_id=NEW.client_id AND scope_key=NEW.scope_key)
BEGIN SELECT RAISE(ABORT,'Private pending edit requires its registered scope'); END;";

const GUARDS: &[&str] = &[
    "single_chat_composer_scope_insert_guard",
    "single_chat_composer_scope_identity_guard",
    "single_chat_composer_draft_binding_insert",
    "single_chat_composer_draft_identity_guard",
    "single_chat_retained_input_insert_guard",
    "single_chat_retained_input_identity_guard",
    "single_chat_pending_edit_scope_insert",
    "single_chat_pending_edit_scope_update",
];

fn primary_key(connection: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    connection
        .prepare("SELECT name FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk")?
        .query_map([table], |row| row.get(0))?
        .collect()
}

pub(super) fn source_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    if !private_client_draft_v154_schema_matches(connection)? {
        return Ok(false);
    }
    connection.query_row("SELECT
        NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name IN ('single_chat_composer_scope','single_chat_retained_input'))
        AND NOT EXISTS(SELECT 1 FROM pragma_table_info('single_chat_pending_input_edit_session') WHERE name='scope_key')
        AND NOT EXISTS(SELECT 1 FROM schema_migration WHERE version=205)", [], |row| row.get(0))
}

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    for (table, key, columns) in [
        (
            "single_chat_composer_draft",
            vec!["conversation_id", "client_id", "scope_key"],
            "conversation_id,client_id,scope_key,revision,source_attachments_json,quotes_json,quote_trash_json,updated_at",
        ),
        (
            "single_chat_composer_scope",
            vec!["conversation_id", "client_id", "scope_key"],
            "conversation_id,client_id,scope_key,board_id,node_id,created_at,updated_at",
        ),
        (
            "single_chat_retained_input",
            vec!["id"],
            "id,conversation_id,client_id,scope_key,revision,body,source_attachments_json,quotes_json,quote_trash_json,source_pending_id,created_at,updated_at",
        ),
        (
            "single_chat_pending_input_edit_session",
            vec!["conversation_id"],
            "conversation_id,pending_input_id,client_id,scope_key,edit_token,base_pending_revision,working_body,working_source_attachments_json,quotes_json,quote_trash_json",
        ),
    ] {
        if primary_key(connection, table)? != key
            || connection
                .prepare(&format!("SELECT {columns} FROM {table} LIMIT 0"))
                .is_err()
        {
            return Ok(false);
        }
        let owned: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list(?1) WHERE [table]='conversation' AND [from]='conversation_id' AND [to]='id' AND on_delete='CASCADE')", [table], |row| row.get(0))?;
        if !owned {
            return Ok(false);
        }
    }
    for table in [
        "single_chat_composer_draft",
        "single_chat_pending_input_edit_session",
    ] {
        let default_scope: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name='scope_key' AND type='TEXT' AND [notnull]=1 AND dflt_value=char(39)||char(39))", [table], |row| row.get(0))?;
        if !default_scope {
            return Ok(false);
        }
    }
    let recovery_index = connection.prepare("SELECT name FROM pragma_index_info('single_chat_retained_input_recovery_idx') ORDER BY seqno")?
        .query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if recovery_index != ["conversation_id", "client_id", "created_at", "id"] {
        return Ok(false);
    }
    for name in GUARDS {
        if !connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?1)",
            [name],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==154)
            && source_schema_matches(&tx)?,
        "Private composer scopes require exact schema154"
    );
    rebuild_table_v171(&tx, "single_chat_composer_draft", DRAFT_TABLE_SQL, &[], &[])?;
    tx.execute_batch(TABLES_SQL)?;
    tx.execute_batch(GUARDS_SQL)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(205,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=155,updated_at=datetime('now') WHERE singleton=1;")?;
    validate_migration_foreign_keys(
        &tx,
        &[
            "single_chat_composer_draft",
            "single_chat_composer_scope",
            "single_chat_retained_input",
            "single_chat_pending_input_edit_session",
        ],
    )?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::Current(ref marker) | DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==155),
        "Private composer scope schema admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::private_source_observation::downgrade_for_test(connection);
    if !connection
        .table_exists(None, "single_chat_composer_scope")
        .unwrap()
    {
        return;
    }
    for table in ["single_chat_composer_scope", "single_chat_retained_input"] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            count, 0,
            "Old-source fixture cannot discard private inputs: {table}"
        );
    }
    for table in [
        "single_chat_composer_draft",
        "single_chat_pending_input_edit_session",
    ] {
        let count: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE scope_key<>''"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 0,
            "Old-source fixture cannot discard scoped work: {table}"
        );
    }
    let tx = connection.unchecked_transaction().unwrap();
    for name in GUARDS {
        tx.execute_batch(&format!("DROP TRIGGER {name}")).unwrap();
    }
    tx.execute_batch(
        "DROP TABLE single_chat_retained_input;DROP TABLE single_chat_composer_scope;
        ALTER TABLE single_chat_pending_input_edit_session DROP COLUMN scope_key;",
    )
    .unwrap();
    let original = DRAFT_TABLE_SQL
        .replace("    scope_key TEXT NOT NULL DEFAULT '',\n", "")
        .replace(
            "PRIMARY KEY(conversation_id,client_id,scope_key)",
            "PRIMARY KEY(conversation_id,client_id)",
        );
    rebuild_table_v171(
        &tx,
        "single_chat_composer_draft",
        &original,
        &["scope_key"],
        &[],
    )
    .unwrap();
    tx.execute_batch("DELETE FROM schema_migration WHERE version=205;
        UPDATE rovai_data_contract SET projection_schema_version=154 WHERE singleton=1 AND projection_schema_version=155;").unwrap();
    tx.commit().unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    use crate::{
        collaboration::{CollaborationService, CreateThreadCommand},
        command::{ActorRef, CommandEnvelope, CommandResultStatus},
        local_attachment_source::{
            LocalAttachmentOwnerLocator, load_source_attachment, observe_source_attachment,
        },
        single_chat::{OpenSingleChatCommand, SingleChatService},
        single_chat_composer_scope::SingleChatComposerScope,
    };

    fn request<T>(camp_id: Option<&str>, payload: T) -> CommandEnvelope<T> {
        CommandEnvelope {
            command_id: Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: crate::current_user::CURRENT_USER_ID.into(),
            },
            camp_id: camp_id.map(str::to_owned),
            execution_epoch: None,
            expected_versions: vec![],
            payload,
        }
    }

    fn legacy_rows(connection: &Connection) -> Vec<(String, i64, String, String, String, String)> {
        connection.prepare("SELECT client_id,revision,source_attachments_json,quotes_json,quote_trash_json,updated_at FROM single_chat_composer_draft ORDER BY conversation_id,client_id")
            .unwrap().query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
            .unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    // 新主键与三类新归属在同一迁移内切换；运行和最终模型输入由原 owner 分别拥有。
    #[test]
    fn migration_preserves_default_materials_fences_scopes_and_rolls_back_receipts() {
        let mut database = crate::test_support::seeded_runtime_database_owned();
        let directory = database.directory().to_path_buf();
        downgrade_for_test(database.connection());
        assert!(source_schema_matches(database.connection()).unwrap());
        let workspace = directory.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let created = CollaborationService::default()
            .create_camp(
                &mut database,
                &request(
                    None,
                    CreateThreadCommand::for_test(workspace.to_string_lossy().into()),
                ),
            )
            .unwrap();
        assert_eq!(created.result.status, CommandResultStatus::Applied);
        let thread = created.result.payload["threadId"]
            .as_str()
            .unwrap()
            .to_owned();
        let open_request = request(
            Some(&thread),
            OpenSingleChatCommand {
                draft_client: Default::default(),
                camp_id: thread.clone(),
                agent_id: "agent_1".into(),
            },
        );
        let opened = SingleChatService::default()
            .open(&mut database, &open_request)
            .unwrap();
        let conversation = opened.result.payload["conversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        let file = directory.join("legacy-private.md");
        std::fs::write(&file, b"original private source").unwrap();
        let source =
            observe_source_attachment(&file, "legacy-private.md", Some("text/markdown")).unwrap();
        let original_refs = serde_json::to_string(&vec![source]).unwrap();
        database.connection().execute("UPDATE single_chat_composer_draft SET revision=7,source_attachments_json=?1,quotes_json='[ ]',quote_trash_json=' [ ] ',updated_at='2026-10-01T00:00:00Z'",[&original_refs]).unwrap();
        database.connection().execute("INSERT INTO single_chat_composer_draft(conversation_id,client_id,revision,source_attachments_json,quotes_json,quote_trash_json,updated_at) VALUES(?1,?2,9,?3,' [ ] ','[ ]','2026-10-02T00:00:00Z')",params![conversation,"a".repeat(64),original_refs]).unwrap();
        database.connection().execute("INSERT INTO single_chat_pending_input(id,conversation_id,enqueue_sequence,body,user_id,created_at,updated_at) VALUES('pending-scope',?1,1,'queued body',?2,'now','now')",params![conversation,crate::current_user::CURRENT_USER_ID]).unwrap();
        database.connection().execute("INSERT INTO single_chat_pending_input_edit_session(conversation_id,pending_input_id,edit_token,base_pending_revision,working_body) VALUES(?1,'pending-scope','original-token',1,'working body')",[&conversation]).unwrap();
        let board = Uuid::new_v4().to_string();
        let pin = Uuid::new_v4().to_string();
        database.connection().execute("INSERT INTO canvas_board(id,revision,created_at,updated_at) VALUES(?1,1,'now','now')",[&board]).unwrap();
        database.connection().execute("INSERT INTO canvas_node(id,board_id,kind,thread_id,conversation_id,conversations_json,collapsed,grid_columns,grid_rows,x,y,width,height,created_at,updated_at) VALUES(?1,?2,'conversation',?3,?4,'[]',0,0,0,0,0,224,132,'now','now')",params![pin,board,thread,conversation]).unwrap();
        let before = legacy_rows(database.connection());
        let old_receipt: String = database
            .connection()
            .query_row(
                "SELECT result_payload_json FROM event_log WHERE command_id=?1",
                [&open_request.command_id],
                |row| row.get(0),
            )
            .unwrap();
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_private_scope_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=205 BEGIN SELECT RAISE(ABORT,'private scope receipt rollback fixture'); END;").unwrap();
        let failure = migrate(&mut database).unwrap_err();
        assert!(
            failure.to_string().contains("rollback fixture"),
            "{failure:#}"
        );
        assert_eq!(legacy_rows(database.connection()), before);
        assert!(source_schema_matches(database.connection()).unwrap());
        assert_eq!(
            database
                .connection()
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_private_scope_receipt")
            .unwrap();
        migrate(&mut database).unwrap();
        super::super::private_source_observation::migrate(&mut database).unwrap();
        super::super::private_source_observation::verify_migration_fixture(&mut database);
        assert!(connection_has_current_data_contract(database.connection()).unwrap());
        assert_eq!(legacy_rows(database.connection()), before);
        let event_count: i64 = database
            .connection()
            .query_row("SELECT COUNT(*) FROM event_log", [], |row| row.get(0))
            .unwrap();
        let replay = SingleChatService::default()
            .open(&mut database, &open_request)
            .unwrap();
        assert_eq!(
            serde_json::to_value(replay.result).unwrap(),
            serde_json::to_value(opened.result).unwrap()
        );
        assert_eq!(
            database
                .connection()
                .query_row("SELECT COUNT(*) FROM event_log", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            event_count
        );
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT result_payload_json FROM event_log WHERE command_id=?1",
                    [&open_request.command_id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            old_receipt
        );
        for damaged in [
            "DROP INDEX single_chat_retained_input_recovery_idx",
            "DROP TRIGGER single_chat_composer_scope_identity_guard",
        ] {
            let tx = database.connection().unchecked_transaction().unwrap();
            tx.execute_batch(damaged).unwrap();
            assert!(
                !connection_has_current_data_contract(&tx).unwrap(),
                "{damaged}"
            );
            tx.rollback().unwrap();
            assert!(connection_has_current_data_contract(database.connection()).unwrap());
        }
        let old = SingleChatService::default()
            .snapshot(&database, &conversation)
            .unwrap()
            .unwrap();
        assert_eq!(old.draft.revision, 7);
        assert_eq!(old.draft.attachments.len(), 1);
        assert_eq!(
            old.pending_inputs.edit_session.unwrap().edit_token,
            "original-token"
        );
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM single_chat_composer_draft WHERE scope_key<>''",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let scope = SingleChatComposerScope::Canvas {
            board_id: board.clone(),
            node_id: pin.clone(),
        };
        let key = scope.storage_key().unwrap();
        database
            .connection()
            .execute(
                "INSERT INTO single_chat_composer_scope VALUES(?1,'desktop',?2,?3,?4,'now','now')",
                params![conversation, key, board, pin],
            )
            .unwrap();
        let other =
            observe_source_attachment(&file, "card-only.md", Some("text/markdown")).unwrap();
        let other_id = other.id.clone();
        let other_refs = serde_json::to_string(&vec![other]).unwrap();
        database.connection().execute("INSERT INTO single_chat_composer_draft(conversation_id,scope_key,revision,source_attachments_json,updated_at) VALUES(?1,?2,22,?3,'now')",params![conversation,key,other_refs]).unwrap();
        database.connection().execute("INSERT INTO single_chat_retained_input(id,conversation_id,client_id,scope_key,body,source_attachments_json,created_at,updated_at) VALUES('retained',?1,'desktop',?2,'complete retained body',?3,'now','now')",params![conversation,key,other_refs]).unwrap();
        let current = SingleChatService::default()
            .snapshot(&database, &conversation)
            .unwrap()
            .unwrap();
        assert_eq!(current.draft.revision, 7);
        assert_eq!(current.draft.attachments.len(), 1);
        assert_ne!(current.draft.attachments[0].id, other_id);
        assert!(
            load_source_attachment(
                &database,
                &LocalAttachmentOwnerLocator::SingleChatComposer {
                    camp_id: thread.clone(),
                    conversation_id: conversation.clone(),
                    attachment_ref_id: other_id.clone(),
                }
            )
            .unwrap()
            .is_none()
        );
        database.connection().execute("UPDATE single_chat_pending_input_edit_session SET scope_key=?1,working_source_attachments_json=?2 WHERE conversation_id=?3",params![key,other_refs,conversation]).unwrap();
        assert!(
            SingleChatService::default()
                .snapshot(&database, &conversation)
                .unwrap()
                .unwrap()
                .pending_inputs
                .edit_session
                .is_none()
        );
        assert!(
            load_source_attachment(
                &database,
                &LocalAttachmentOwnerLocator::SingleChatPendingEdit {
                    camp_id: thread.clone(),
                    conversation_id: conversation.clone(),
                    pending_input_id: "pending-scope".into(),
                    edit_token: "original-token".into(),
                    attachment_ref_id: other_id,
                }
            )
            .unwrap()
            .is_none()
        );
        assert!(database.connection().execute("INSERT INTO single_chat_composer_draft(conversation_id,scope_key,updated_at) VALUES(?1,'unregistered','now')",[&conversation]).is_err());
        assert!(database.connection().execute("INSERT INTO single_chat_retained_input(id,conversation_id,client_id,scope_key,body,created_at,updated_at) VALUES('foreign',?1,'foreign',?2,'body','now','now')",params![conversation,key]).is_err());
        assert!(
            database
                .connection()
                .execute(
                    "UPDATE single_chat_composer_scope SET node_id=?1 WHERE conversation_id=?2",
                    params![Uuid::new_v4().to_string(), conversation]
                )
                .is_err()
        );
        database
            .connection()
            .execute("DELETE FROM canvas_node WHERE id=?1", [&pin])
            .unwrap();
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM single_chat_composer_scope",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT body FROM single_chat_retained_input WHERE id='retained'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "complete retained body"
        );
        assert!(
            !scope
                .matches_current_pin(database.connection(), &thread, &conversation)
                .unwrap()
        );
        database.close();
        let reopened = Database::open(&directory).unwrap();
        assert!(connection_has_current_data_contract(reopened.connection()).unwrap());
        assert_eq!(
            reopened
                .connection()
                .query_row(
                    "SELECT body FROM single_chat_retained_input WHERE id='retained'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "complete retained body"
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"original private source");
        reopened
            .connection()
            .execute("DELETE FROM conversation WHERE id=?1", [&conversation])
            .unwrap();
        for table in [
            "single_chat_composer_scope",
            "single_chat_retained_input",
            "single_chat_composer_draft",
        ] {
            assert_eq!(
                reopened
                    .connection()
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        assert_eq!(std::fs::read(&file).unwrap(), b"original private source");
        assert_eq!(
            reopened
                .connection()
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        drop(reopened);
    }
}
