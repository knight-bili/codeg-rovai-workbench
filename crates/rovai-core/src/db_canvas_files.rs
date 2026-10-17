//! Schema158/Migration208 只追加文件节点的来源，旧路径和业务数据保持。
use super::*;
use crate::canvas_file_reference::{IMMUTABLE_SQL, OWNER_SQL, TABLE_SQL};

pub(super) fn source_schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    connection.query_row("SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name IN
        ('canvas_node_file_reference','canvas_node_file_reference_owner','canvas_node_file_reference_immutable'))
        AND NOT EXISTS(SELECT 1 FROM schema_migration WHERE version=208)", [], |row| row.get(0))
}
pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    for (name, expected) in [
        ("canvas_node_file_reference", TABLE_SQL),
        ("canvas_node_file_reference_owner", OWNER_SQL),
        ("canvas_node_file_reference_immutable", IMMUTABLE_SQL),
    ] {
        let actual: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        let normalize = |text: &str| {
            text.trim()
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
        matches!(classify_database_contract(&tx)?,DatabaseContractClassification::SupportedMigrationSource(ref marker) if marker.projection_schema_version==157)
            && source_schema_matches(&tx)?,
        "Canvas files require exact schema157"
    );
    tx.execute_batch(TABLE_SQL)?;
    tx.execute_batch(OWNER_SQL)?;
    tx.execute_batch(IMMUTABLE_SQL)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(208,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=158,updated_at=datetime('now') WHERE singleton=1;")?;
    validate_migration_foreign_keys(&tx, &["canvas_node_file_reference"])?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,DatabaseContractClassification::Current(ref marker) if marker.projection_schema_version==158),
        "Canvas file admission failed"
    );
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    if !connection
        .table_exists(None, "canvas_node_file_reference")
        .unwrap()
    {
        return;
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM canvas_node_file_reference",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0,
        "Old-source fixtures must not discard file references"
    );
    let tx = connection.unchecked_transaction().unwrap();
    tx.execute_batch("DROP TRIGGER canvas_node_file_reference_owner;DROP TRIGGER canvas_node_file_reference_immutable;
        DROP TABLE canvas_node_file_reference;DELETE FROM schema_migration WHERE version=208;
        UPDATE rovai_data_contract SET projection_schema_version=157 WHERE singleton=1 AND projection_schema_version=158;").unwrap();
    tx.commit().unwrap();
}
#[cfg(test)]
pub(super) fn verify_fixture(database: &mut Database) {
    let count = |connection: &Connection| {
        connection
            .query_row("SELECT COUNT(*) FROM canvas_node", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    let before = count(database.connection());
    downgrade_for_test(database.connection());
    assert!(source_schema_matches(database.connection()).unwrap());
    database.connection().execute_batch("CREATE TEMP TRIGGER reject_canvas_file_migration BEFORE INSERT ON schema_migration WHEN NEW.version=208 BEGIN SELECT RAISE(ABORT,'canvas files rollback fixture');END;").unwrap();
    assert!(
        migrate(database)
            .unwrap_err()
            .to_string()
            .contains("rollback fixture")
    );
    assert!(source_schema_matches(database.connection()).unwrap());
    assert_eq!(count(database.connection()), before);
    database
        .connection()
        .execute_batch("DROP TRIGGER reject_canvas_file_migration;")
        .unwrap();
    migrate(database).unwrap();
    assert!(connection_has_current_data_contract(database.connection()).unwrap());
    assert_eq!(count(database.connection()), before);
    let tx = database.connection().unchecked_transaction().unwrap();
    tx.execute_batch("DROP TRIGGER canvas_node_file_reference_immutable;CREATE TRIGGER canvas_node_file_reference_immutable BEFORE UPDATE ON canvas_node_file_reference BEGIN SELECT 1;END;").unwrap();
    assert!(!schema_matches(&tx).unwrap());
    assert!(matches!(
        classify_database_contract(&tx).unwrap(),
        DatabaseContractClassification::Unknown(_)
    ));
    tx.rollback().unwrap();
}
