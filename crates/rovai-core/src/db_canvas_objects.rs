//! 只新增画布对象引用表，不回写既有图、任务、使命或冻结结果。
use super::*;
use crate::canvas_object_reference::{IMMUTABLE_SQL, OWNER_SQL, TABLE_SQL};

pub(super) fn source_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name IN
        ('canvas_node_object_reference','canvas_node_object_reference_owner','canvas_node_object_reference_immutable'))
        AND NOT EXISTS(SELECT 1 FROM schema_migration WHERE version=207)", [], |row|row.get(0))
}
pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    for (name, expected) in [
        ("canvas_node_object_reference", TABLE_SQL),
        ("canvas_node_object_reference_owner", OWNER_SQL),
        ("canvas_node_object_reference_immutable", IMMUTABLE_SQL),
    ] {
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        let normalized = |text: &str| {
            text.trim()
                .trim_end_matches(';')
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };
        if !actual.is_some_and(|sql| normalized(&sql) == normalized(expected)) {
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
        matches!(classify_database_contract(&tx)?,DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==156)
            && source_schema_matches(&tx)?,
        "Canvas objects require exact schema156"
    );
    tx.execute_batch(TABLE_SQL)?;
    tx.execute_batch(OWNER_SQL)?;
    tx.execute_batch(IMMUTABLE_SQL)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(207,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=157,updated_at=datetime('now') WHERE singleton=1;")?;
    validate_migration_foreign_keys(&tx, &["canvas_node_object_reference"])?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,DatabaseContractClassification::Current(ref marker) | DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==157),
        "Canvas object admission failed"
    );
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    super::canvas_files::downgrade_for_test(connection);
    if !connection
        .table_exists(None, "canvas_node_object_reference")
        .unwrap()
    {
        return;
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM canvas_node_object_reference",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0,
        "Old-source fixtures must not discard object references"
    );
    let tx = connection.unchecked_transaction().unwrap();
    tx.execute_batch("DROP TRIGGER canvas_node_object_reference_owner;DROP TRIGGER canvas_node_object_reference_immutable;
        DROP TABLE canvas_node_object_reference;DELETE FROM schema_migration WHERE version=207;
        UPDATE rovai_data_contract SET projection_schema_version=156 WHERE singleton=1 AND projection_schema_version=157;").unwrap();
    tx.commit().unwrap();
}
#[cfg(test)]
pub(super) fn verify_fixture(database: &mut Database) {
    fn rows(connection: &Connection) -> Vec<Vec<rusqlite::types::Value>> {
        let mut result = Vec::new();
        for table in [
            "canvas_board",
            "canvas_node",
            "mission",
            "task",
            "event_log",
        ] {
            let mut statement = connection
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let values = statement
                .query_map([], |row| {
                    (0..row.as_ref().column_count())
                        .map(|i| row.get::<_, rusqlite::types::Value>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            result.extend(values);
        }
        result
    }
    let before = rows(database.connection());
    downgrade_for_test(database.connection());
    assert!(source_schema_matches(database.connection()).unwrap());
    database.connection().execute_batch("CREATE TEMP TRIGGER reject_canvas_object_migration BEFORE INSERT ON schema_migration WHEN NEW.version=207 BEGIN SELECT RAISE(ABORT,'canvas objects rollback fixture');END;").unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("rollback fixture")
    );
    assert!(source_schema_matches(database.connection()).unwrap());
    assert_eq!(rows(database.connection()), before);
    database
        .connection()
        .execute_batch("DROP TRIGGER reject_canvas_object_migration;")
        .unwrap();
    migrate(database).unwrap();
    super::canvas_files::migrate(database).unwrap();
    assert!(connection_has_current_data_contract(database.connection()).unwrap());
    assert_eq!(rows(database.connection()), before);
    let tx = database.connection().unchecked_transaction().unwrap();
    tx.execute_batch("DROP TRIGGER canvas_node_object_reference_immutable;CREATE TRIGGER canvas_node_object_reference_immutable BEFORE UPDATE ON canvas_node_object_reference BEGIN SELECT 1;END;").unwrap();
    assert!(!schema_matches(&tx).unwrap());
    assert!(matches!(
        classify_database_contract(&tx).unwrap(),
        DatabaseContractClassification::Unknown(_)
    ));
    tx.rollback().unwrap();
}
