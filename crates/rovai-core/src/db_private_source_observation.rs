//! 私聊源观察独立存储；旧 SourceRef/材料/回执不回写，不在迁移时读取用户文件。
use super::*;

pub(super) const TABLE_SQL: &str = "CREATE TABLE single_chat_source_observation (
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    source_ref_id TEXT NOT NULL CHECK(length(source_ref_id)=36 AND source_ref_id NOT GLOB '*[^0-9a-f-]*'),
    source_path TEXT NOT NULL CHECK(length(source_path)>0),
    kind TEXT NOT NULL CHECK(kind IN ('file','directory')),
    observation_json TEXT NOT NULL CHECK(json_valid(observation_json)
        AND json_extract(observation_json,'$.version') IS 1
        AND json_extract(observation_json,'$.kind') IS kind
        AND length(json_extract(observation_json,'$.contentDigest')) IS 64
        AND length(json_extract(observation_json,'$.identityDigest')) IS 64
        AND json_extract(observation_json,'$.contentDigest') NOT GLOB '*[^0-9a-f]*'
        AND json_extract(observation_json,'$.identityDigest') NOT GLOB '*[^0-9a-f]*'
        AND json_type(observation_json,'$.byteSize') IS 'integer' AND json_extract(observation_json,'$.byteSize')>=0
        AND json_type(observation_json,'$.fileCount') IS 'integer' AND json_extract(observation_json,'$.fileCount')>=0),
    PRIMARY KEY(conversation_id,source_ref_id)
);";
const OWNER_GUARD_SQL: &str = "CREATE TRIGGER single_chat_source_observation_owner
BEFORE INSERT ON single_chat_source_observation
WHEN NOT EXISTS(SELECT 1 FROM conversation WHERE id=NEW.conversation_id AND kind='single_chat')
BEGIN SELECT RAISE(ABORT,'Private source observation owner required'); END;";
const IMMUTABLE_GUARD_SQL: &str = "CREATE TRIGGER single_chat_source_observation_immutable
BEFORE UPDATE ON single_chat_source_observation
BEGIN SELECT RAISE(ABORT,'Private source observation is immutable'); END;";

pub(super) fn source_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema
        WHERE name IN ('single_chat_source_observation','single_chat_source_observation_owner','single_chat_source_observation_immutable'))
        AND NOT EXISTS(SELECT 1 FROM schema_migration WHERE version=206)", [], |row|row.get(0))
}
pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    for (name, expected) in [
        ("single_chat_source_observation", TABLE_SQL),
        ("single_chat_source_observation_owner", OWNER_GUARD_SQL),
        (
            "single_chat_source_observation_immutable",
            IMMUTABLE_GUARD_SQL,
        ),
    ] {
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        let normalize = |value: &str| {
            value
                .trim()
                .trim_end_matches(';')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };
        if !actual.is_some_and(|sql| normalize(&sql) == normalize(expected)) {
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
        DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==155)
            && source_schema_matches(&tx)?,
        "Private source observation requires exact schema155"
    );
    tx.execute_batch(TABLE_SQL)?;
    tx.execute_batch(OWNER_GUARD_SQL)?;
    tx.execute_batch(IMMUTABLE_GUARD_SQL)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(206,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=156,updated_at=datetime('now') WHERE singleton=1;")?;
    validate_migration_foreign_keys(&tx, &["single_chat_source_observation"])?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::Current(ref marker) | DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==156),
        "Private source observation admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::canvas_objects::downgrade_for_test(connection);
    if !connection
        .table_exists(None, "single_chat_source_observation")
        .unwrap()
    {
        return;
    }
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM single_chat_source_observation",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 0,
        "Old-source fixtures cannot discard private observations"
    );
    let tx = connection.unchecked_transaction().unwrap();
    tx.execute_batch("DROP TRIGGER single_chat_source_observation_owner;
        DROP TRIGGER single_chat_source_observation_immutable;
        DROP TABLE single_chat_source_observation;
        DELETE FROM schema_migration WHERE version=206;
        UPDATE rovai_data_contract SET projection_schema_version=155 WHERE singleton=1 AND projection_schema_version=156;").unwrap();
    tx.commit().unwrap();
}

#[cfg(test)]
pub(super) fn verify_migration_fixture(database: &mut Database) {
    assert!(schema_matches(database.connection()).unwrap());
    let before: i64 = database
        .connection()
        .query_row("SELECT COUNT(*) FROM event_log", [], |row| row.get(0))
        .unwrap();
    downgrade_for_test(database.connection());
    assert!(source_schema_matches(database.connection()).unwrap());
    database.connection().execute_batch("CREATE TEMP TRIGGER reject_source_observation_migration BEFORE INSERT ON schema_migration
        WHEN NEW.version=206 BEGIN SELECT RAISE(ABORT,'source observation rollback fixture'); END;").unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("rollback fixture")
    );
    assert!(source_schema_matches(database.connection()).unwrap());
    assert!(
        matches!(classify_database_contract(database.connection()).unwrap(),DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==155)
    );
    assert_eq!(
        before,
        database
            .connection()
            .query_row("SELECT COUNT(*) FROM event_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap()
    );
    database
        .connection()
        .execute_batch("DROP TRIGGER reject_source_observation_migration;")
        .unwrap();
    migrate(database).unwrap();
    super::canvas_objects::migrate(database).unwrap();
    super::canvas_files::migrate(database).unwrap();
    assert!(schema_matches(database.connection()).unwrap());
    let tx = database.connection().unchecked_transaction().unwrap();
    tx.execute_batch("DROP TRIGGER single_chat_source_observation_immutable;
        CREATE TRIGGER single_chat_source_observation_immutable BEFORE UPDATE ON single_chat_source_observation BEGIN SELECT 1; END;").unwrap();
    assert!(!schema_matches(&tx).unwrap());
    assert!(matches!(
        classify_database_contract(&tx).unwrap(),
        DatabaseContractClassification::Unknown(_)
    ));
    tx.rollback().unwrap();
    assert!(connection_has_current_data_contract(database.connection()).unwrap());
}
