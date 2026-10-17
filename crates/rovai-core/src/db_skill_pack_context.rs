//! Versioned pack input formats extend the existing input authority. No new
//! snapshot table, proof column, or historical-row rewrite is introduced.
use super::*;
use sha2::{Digest, Sha256};

const FACT28: &str = "(context_manifest_version = 28 AND formatter_version = 28 AND run_facts_schema_version = 6 AND ((camp_attachment_view_receipt_version IS NULL AND camp_attachment_view_receipt_json IS NULL AND camp_attachment_view_receipt_digest IS NULL) OR (camp_attachment_view_receipt_version = 2 AND camp_attachment_view_receipt_json IS NOT NULL AND camp_attachment_view_receipt_digest IS NOT NULL)))";
const FACT33: &str = "(context_manifest_version = 33 AND formatter_version = 33 AND run_facts_schema_version = 9 AND ((camp_attachment_view_receipt_version IS NULL AND camp_attachment_view_receipt_json IS NULL AND camp_attachment_view_receipt_digest IS NULL) OR (camp_attachment_view_receipt_version = 2 AND camp_attachment_view_receipt_json IS NOT NULL AND camp_attachment_view_receipt_digest IS NOT NULL)))";
const NEW_PROFILE_PAIRS: &str = "(NEW.context_manifest_version = 34 AND NEW.context_delivery_profile_version = 10) OR (NEW.context_manifest_version = 29 AND NEW.context_delivery_profile_version = 7) OR ";
const LEGACY_START: &str = "/* retained-legacy-admission */\n";
const LEGACY_END: &str = "\n/* end-retained-legacy-admission */";
const TABLES: &[&str] = &["agent_run", "agent_run_input", "context_manifest"];

fn schema(connection: &Connection, kind: &str, name: &str) -> Result<String> {
    Ok(connection.query_row(
        "SELECT sql FROM sqlite_schema WHERE type=?1 AND name=?2",
        params![kind, name],
        |row| row.get(0),
    )?)
}

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT
        EXISTS(SELECT 1 FROM sqlite_schema WHERE name='agent_run_input_v34_only_insert' AND instr(sql,'NEW.context_manifest_version IS NOT 34')>0)
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='context_manifest_v34_only_insert' AND instr(sql,'NEW.run_facts_schema_version = 6')>0 AND instr(sql,'NEW.context_manifest_version = 34')>0)
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE name='context_manifest_quote_profile_insert' AND instr(sql,'NEW.context_manifest_version = 29 AND NEW.context_delivery_profile_version = 7')>0)
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='context_manifest' AND instr(sql,'context_manifest_version = 34 AND formatter_version = 34 AND run_facts_schema_version = 9')>0 AND instr(sql,'context_manifest_version = 29 AND formatter_version = 29 AND run_facts_schema_version = 6')>0)
        AND EXISTS(SELECT 1 FROM pragma_table_info('agent_run') WHERE name='skill_selection_snapshot_json' AND json_extract(trim(dflt_value,char(39)),'$.schemaVersion')=3)
        AND NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='agent_run_input_v33_only_insert')",
        [], |row| row.get(0))
}

// Stream the touched rows, including NULL and raw text/blob bytes. Legacy proof
// columns are nullable, so the historical non-null digest reader is unsuitable.
// This comparison is migration-local and is never stored as a second authority.
fn preserved_rows(connection: &Connection) -> Result<String> {
    use rusqlite::types::ValueRef;
    let mut digest = Sha256::new();
    for table in TABLES {
        digest.update(table.as_bytes());
        let order = if *table == "agent_run_input" {
            "agent_run_id,ordinal"
        } else {
            "id"
        };
        let mut statement =
            connection.prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))?;
        let width = statement.column_count();
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            digest.update([0xff]);
            for column in 0..width {
                match row.get_ref(column)? {
                    ValueRef::Null => digest.update([0]),
                    ValueRef::Integer(value) => {
                        digest.update([1]);
                        digest.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        digest.update([2]);
                        digest.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(bytes) => {
                        digest.update([3]);
                        digest.update((bytes.len() as u64).to_le_bytes());
                        digest.update(bytes);
                    }
                    ValueRef::Blob(bytes) => {
                        digest.update([4]);
                        digest.update((bytes.len() as u64).to_le_bytes());
                        digest.update(bytes);
                    }
                }
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn replace_run_default(
    connection: &Connection,
    mut sql: String,
    column: &str,
    value: &str,
) -> Result<String> {
    let old: String = connection.query_row(
        "SELECT dflt_value FROM pragma_table_info('agent_run') WHERE name=?1",
        [column],
        |row| row.get(0),
    )?;
    let column_start = sql
        .find(column)
        .context("Run selection default column is missing")?;
    let suffix = &sql[column_start + column.len()..];
    let keyword = suffix
        .to_ascii_uppercase()
        .find("DEFAULT")
        .context("Run selection default is missing")?;
    let value_start = column_start + column.len() + keyword + "DEFAULT".len();
    let whitespace = sql[value_start..].len() - sql[value_start..].trim_start().len();
    let start = value_start + whitespace;
    anyhow::ensure!(
        sql[start..].starts_with(&old),
        "Run selection default is ambiguous"
    );
    sql.replace_range(
        start..start + old.len(),
        &format!("'{}'", value.replace('\'', "''")),
    );
    Ok(sql)
}

fn guard_expression(guard: &str) -> Result<&str> {
    let start = guard
        .find("WHEN NOT (")
        .context("Missing legacy manifest guard")?
        + "WHEN NOT (".len();
    let end = guard
        .find("BEGIN SELECT RAISE")
        .context("Missing manifest guard boundary")?;
    guard[start..end]
        .trim_end()
        .strip_suffix(')')
        .context("Invalid manifest guard boundary")
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    database
        .connection
        .execute_batch("PRAGMA foreign_keys=OFF;")?;
    let result = (|| -> Result<()> {
        let tx = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        anyhow::ensure!(
            matches!(classify_database_contract(&tx)?,DatabaseContractClassification::Current(ref marker)|DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==152),
            "Skill pack Context migration requires schema152"
        );
        let before = preserved_rows(&tx)?;
        let source_manifest = schema(&tx, "table", "context_manifest")?;
        anyhow::ensure!(
            source_manifest.contains(FACT28) && source_manifest.contains(FACT33),
            "Missing frozen Context28/33 constraints"
        );
        let fact34 = FACT33.replace("= 33", "= 34");
        let fact29 = FACT28.replace("= 28", "= 29");
        let manifest = replacement_table_schema_v171(source_manifest, "context_manifest")
            .replace("31, 32, 33)", "31, 32, 33, 34)")
            .replacen(FACT33, &format!("{fact34}\n OR\n {FACT33}"), 1)
            .replacen(FACT28, &format!("{fact29}\n OR\n {FACT28}"), 1);
        let input = replacement_table_schema_v171(
            schema(&tx, "table", "agent_run_input")?,
            "agent_run_input",
        )
        .replace("31, 32, 33)", "31, 32, 33, 34)");
        let empty = json!({"schemaVersion":3,"entries":[]});
        let run = replace_run_default(
            &tx,
            schema(&tx, "table", "agent_run")?,
            "skill_selection_snapshot_json",
            &serde_json::to_string(&empty)?,
        )?;
        let run = replace_run_default(
            &tx,
            run,
            "skill_selection_snapshot_digest",
            &crate::command::canonical_json_digest(&empty)?,
        )?;
        let run = replacement_table_schema_v171(run, "agent_run");
        let old_guard = schema(&tx, "trigger", "context_manifest_v33_only_insert")?;
        let legacy = guard_expression(&old_guard)?;
        let start = legacy
            .find("(NEW.context_manifest_version = 33")
            .context("Missing public33 admission")?;
        let end = start
            + legacy[start..]
                .find("\n OR\n")
                .context("Missing public33 boundary")?;
        let public34 = legacy[start..end]
            .replace("= 33", "= 34")
            .replace("IS NOT 33", "IS NOT 34");
        let new_snapshot = "EXISTS(SELECT 1 FROM agent_run AS pack_run WHERE pack_run.id=NEW.agent_run_id AND json_extract(pack_run.skill_selection_snapshot_json,'$.schemaVersion')=3)";
        let legacy_snapshot = "EXISTS(SELECT 1 FROM agent_run AS old_run WHERE old_run.id=NEW.agent_run_id AND json_extract(old_run.skill_selection_snapshot_json,'$.schemaVersion') IN (1,2))";
        let non_batch = "(NEW.context_manifest_version = 29 AND NEW.formatter_version = 29 AND NEW.run_facts_schema_version = 6 AND NEW.context_delivery_profile_version = 7 AND EXISTS(SELECT 1 FROM agent_run AS run WHERE run.id=NEW.agent_run_id AND run.invocation_kind <> 'batch'))";
        let guard = format!(
            "CREATE TRIGGER context_manifest_v34_only_insert BEFORE INSERT ON context_manifest WHEN NOT (({public34} AND {new_snapshot}) OR ({non_batch} AND {new_snapshot}) OR ({legacy_snapshot} AND ({LEGACY_START}{legacy}{LEGACY_END}))) BEGIN SELECT RAISE(ABORT,'ContextManifest does not match its frozen input format'); END;"
        );
        let profile = schema(&tx, "trigger", "context_manifest_quote_profile_insert")?.replacen(
            "WHEN NOT (",
            &format!("WHEN NOT ({NEW_PROFILE_PAIRS}"),
            1,
        );
        let attachment = schema(
            &tx,
            "trigger",
            "runtime_input_delivery_attachment_auth_insert",
        )?
        .replace("31, 32, 33)", "31, 32, 33, 34)");
        rebuild_table_v171(&tx, "agent_run", &run, &[], &[])?;
        rebuild_table_v171(
            &tx,
            "context_manifest",
            &manifest,
            &[],
            &[
                "context_manifest_v33_only_insert",
                "context_manifest_quote_profile_insert",
            ],
        )?;
        rebuild_table_v171(
            &tx,
            "agent_run_input",
            &input,
            &[],
            &["agent_run_input_v33_only_insert"],
        )?;
        tx.execute_batch(&guard)?;
        tx.execute_batch(&profile)?;
        tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")?;
        tx.execute_batch(&attachment)?;
        tx.execute_batch("CREATE TRIGGER agent_run_input_v34_only_insert BEFORE INSERT ON agent_run_input
            WHEN NEW.context_manifest_version IS NOT 34 OR NOT EXISTS(SELECT 1 FROM agent_run AS run WHERE run.id=NEW.agent_run_id AND run.invocation_kind='batch' AND json_extract(run.skill_selection_snapshot_json,'$.schemaVersion')=3)
            BEGIN SELECT RAISE(ABORT,'New public RunInput must use pack Context34/Selection3'); END;")?;
        anyhow::ensure!(
            preserved_rows(&tx)? == before,
            "Pack Context migration changed historical input rows"
        );
        validate_migration_foreign_keys(&tx, TABLES)?;
        anyhow::ensure!(schema_matches(&tx)?, "Pack Context schema is incomplete");
        tx.execute_batch("INSERT INTO schema_migration VALUES(203,datetime('now')); UPDATE rovai_data_contract SET projection_schema_version=153,updated_at=datetime('now') WHERE singleton=1;")?;
        tx.commit()?;
        Ok(())
    })();
    let foreign_keys = database.connection.execute_batch("PRAGMA foreign_keys=ON;");
    result?;
    foreign_keys?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    crate::canvas_node::downgrade_for_test(connection);
    if !connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migration WHERE version=203)",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap()
    {
        return;
    }
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM agent_run WHERE json_extract(skill_selection_snapshot_json,'$.schemaVersion')=3",[],|row|row.get::<_,i64>(0)).unwrap(),0,"Synthetic legacy sources cannot discard pack Run snapshots");
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM context_manifest WHERE context_manifest_version=34 OR (context_manifest_version=29 AND run_facts_schema_version=6)",[],|row|row.get::<_,i64>(0)).unwrap(),0,"Synthetic legacy sources cannot discard pack manifests");
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .unwrap();
    let tx = connection.unchecked_transaction().unwrap();
    let fact34 = FACT33.replace("= 33", "= 34");
    let fact29 = FACT28.replace("= 28", "= 29");
    let manifest = replacement_table_schema_v171(
        schema(&tx, "table", "context_manifest").unwrap(),
        "context_manifest",
    )
    .replace("31, 32, 33, 34)", "31, 32, 33)")
    .replace(&format!("{fact34}\n OR\n "), "")
    .replace(&format!("{fact29}\n OR\n "), "");
    let input = replacement_table_schema_v171(
        schema(&tx, "table", "agent_run_input").unwrap(),
        "agent_run_input",
    )
    .replace("31, 32, 33, 34)", "31, 32, 33)");
    let empty = json!({"schemaVersion":1,"entries":[]});
    let run = replace_run_default(
        &tx,
        schema(&tx, "table", "agent_run").unwrap(),
        "skill_selection_snapshot_json",
        r#"{"schemaVersion":1,"entries":[]}"#,
    )
    .unwrap();
    let run = replace_run_default(
        &tx,
        run,
        "skill_selection_snapshot_digest",
        &crate::command::canonical_json_digest(&empty).unwrap(),
    )
    .unwrap();
    let guard = schema(&tx, "trigger", "context_manifest_v34_only_insert").unwrap();
    let legacy = guard
        .split_once(LEGACY_START)
        .unwrap()
        .1
        .split_once(LEGACY_END)
        .unwrap()
        .0;
    let guard = format!(
        "CREATE TRIGGER context_manifest_v33_only_insert BEFORE INSERT ON context_manifest WHEN NOT ({legacy}) BEGIN SELECT RAISE(ABORT,'new ContextManifest must use the current projection'); END;"
    );
    let profile = schema(&tx, "trigger", "context_manifest_quote_profile_insert")
        .unwrap()
        .replacen(NEW_PROFILE_PAIRS, "", 1);
    let attachment = schema(
        &tx,
        "trigger",
        "runtime_input_delivery_attachment_auth_insert",
    )
    .unwrap()
    .replace("31, 32, 33, 34)", "31, 32, 33)");
    rebuild_table_v171(
        &tx,
        "agent_run",
        &replacement_table_schema_v171(run, "agent_run"),
        &[],
        &[],
    )
    .unwrap();
    rebuild_table_v171(
        &tx,
        "context_manifest",
        &manifest,
        &[],
        &[
            "context_manifest_v34_only_insert",
            "context_manifest_quote_profile_insert",
        ],
    )
    .unwrap();
    rebuild_table_v171(
        &tx,
        "agent_run_input",
        &input,
        &[],
        &["agent_run_input_v34_only_insert"],
    )
    .unwrap();
    tx.execute_batch(&guard).unwrap();
    tx.execute_batch(&profile).unwrap();
    tx.execute_batch("DROP TRIGGER runtime_input_delivery_attachment_auth_insert;")
        .unwrap();
    tx.execute_batch(&attachment).unwrap();
    tx.execute_batch("CREATE TRIGGER agent_run_input_v33_only_insert BEFORE INSERT ON agent_run_input WHEN NEW.context_manifest_version IS NOT 33 BEGIN SELECT RAISE(ABORT,'new public Thread AgentRunInput must use ContextManifest v33'); END;
        DELETE FROM schema_migration WHERE version=203; UPDATE rovai_data_contract SET projection_schema_version=152 WHERE singleton=1;").unwrap();
    tx.commit().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;

    // Owns three-table DDL/default/receipt atomicity. Runtime owners separately
    // prove old/new populated Run inputs and final-Blob delivery/recovery.
    #[test]
    fn migration_is_atomic_and_preserves_existing_authorities() {
        let directory = std::env::temp_dir().join(format!("rovai-pack-context-{}", Uuid::new_v4()));
        let mut database = crate::test_support::fresh_schema_database_at(&directory);
        downgrade_for_test(database.connection());
        let store = crate::managed_blob::ManagedBlobStore::new(&directory);
        let blob = store
            .put_bytes(
                &mut database,
                b"original frozen bytes\n",
                "text/plain",
                "sensitive",
            )
            .unwrap();
        database.connection().execute_batch("INSERT INTO event_log(event_id,event_type,command_id,command_type,actor_type,actor_id,result_status,result_code,result_payload_json,payload_json,created_at)
            VALUES('pack-legacy-result','command.result','pack-legacy-command','legacy.operation','user','test-user','rejected','legacy.code','{\"value\":\"原记录\"}','{}','2026-10-01');
            CREATE TEMP TRIGGER reject_pack_context_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=203 BEGIN SELECT RAISE(ABORT,'pack Context migration rollback fixture'); END;").unwrap();
        let before = preserved_rows(database.connection()).unwrap();
        let failure = migrate(&mut database).unwrap_err();
        assert!(
            failure.to_string().contains("rollback fixture"),
            "{failure:#}"
        );
        assert_eq!(preserved_rows(database.connection()).unwrap(), before);
        assert!(!schema_matches(database.connection()).unwrap());
        assert!(!database.schema_migration_applied(203).unwrap());
        assert_eq!(
            database
                .connection()
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_pack_context_receipt;")
            .unwrap();
        migrate(&mut database).unwrap();
        assert!(schema_matches(database.connection()).unwrap());
        assert_eq!(preserved_rows(database.connection()).unwrap(), before);
        assert!(simplification::schema_matches(database.connection()).unwrap());
        assert_eq!(
            store.read_text(&database, &blob.id).unwrap(),
            "original frozen bytes\n"
        );
        let original: String = database
            .connection()
            .query_row(
                "SELECT result_payload_json FROM event_log WHERE event_id='pack-legacy-result'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(original, "{\"value\":\"原记录\"}");
        drop(database);
        let reopened = Database::open(&directory).unwrap();
        assert!(connection_has_current_data_contract(reopened.connection()).unwrap());
        assert_eq!(
            store.read_text(&reopened, &blob.id).unwrap(),
            "original frozen bytes\n"
        );
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
