//! Navigation reads saved Camp facts. Historical events are used only by migration v175.
use super::*;

const GROUP_KEY: &str = "CASE WHEN camp.project_binding_kind = 'directory' THEN 'directory:' || camp.project_path ELSE 'quick-chat' END";
const ACTIVE_RUN_STATUSES: &str = "'queued', 'running', 'waiting'";
const VISIBLE: &str = r#"
    camp.deletion_operation_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM mission WHERE mission.camp_id = camp.id)
    AND (camp.activation_state = 'active'
      OR EXISTS(SELECT 1 FROM pending_camp_draft_presence d WHERE d.camp_id = camp.id AND d.client_id = ?1)
      OR EXISTS(SELECT 1 FROM camp_composer_draft d WHERE d.camp_id = camp.id AND d.client_id = ?1
                AND (length(trim(d.body)) > 0 OR d.source_attachments_json <> '[]'))
      OR EXISTS(SELECT 1 FROM prepared_attachment WHERE camp_id = camp.id AND client_id = ?1))
"#;
const ORDER: &str = "COALESCE(camp.navigation_activity_at, camp.created_at) DESC, camp.navigation_activity_sequence DESC, camp.id";

const ACTIVITY_SQL: &str = r#"
    WITH requested(group_key) AS (SELECT value FROM json_each(?2)),
    active_camp_ids(camp_id) AS (
        SELECT camp_id FROM agent_run WHERE camp_id IS NOT NULL AND status IN ({ACTIVE_RUN_STATUSES})
        UNION
        SELECT t.camp_id FROM camp_turn t JOIN agent_run r ON r.camp_turn_id = t.id
        WHERE r.camp_id IS NULL AND r.status IN ({ACTIVE_RUN_STATUSES})
    ), counts AS (
        SELECT {GROUP_KEY} AS group_key, COUNT(*) AS active_thread_count
        FROM camp JOIN active_camp_ids active ON active.camp_id = camp.id
        WHERE {VISIBLE} AND {GROUP_KEY} IN (SELECT group_key FROM requested)
        GROUP BY {GROUP_KEY}
    )
    SELECT requested.group_key, COALESCE(counts.active_thread_count, 0)
    FROM requested LEFT JOIN counts ON counts.group_key = requested.group_key
    ORDER BY requested.group_key
"#;

pub(super) fn load_navigation_activity(
    tx: &Transaction<'_>,
    client: &crate::draft_client::DraftClient,
    keys: &[String],
    thread_ids: Option<&[String]>,
) -> Result<Vec<NavigationGroupActivity>> {
    anyhow::ensure!(
        !keys.is_empty() && keys.len() <= 200,
        "navigation activity requires 1 to 200 groups"
    );
    let mut seen = std::collections::HashSet::new();
    for key in keys {
        anyhow::ensure!(
            seen.insert(key)
                && (key == "quick-chat"
                    || key.strip_prefix("directory:").is_some_and(|path| {
                        let bytes = path.as_bytes();
                        let drive = bytes
                            .first()
                            .is_some_and(|value| value.is_ascii_alphabetic())
                            && bytes.get(1) == Some(&b':')
                            && bytes
                                .get(2)
                                .is_some_and(|value| matches!(*value, b'/' | b'\\'));
                        !path.is_empty()
                            && path.encode_utf16().count() <= 8192
                            && !path.contains('\0')
                            && (path.starts_with('/') || path.starts_with("\\\\") || drive)
                            && !path
                                .split(['/', '\\'])
                                .any(|part| matches!(part, "." | ".."))
                    })),
            "invalid or duplicate navigation activity group"
        );
    }
    let mut selected = keys.to_vec();
    if let Some(ids) = thread_ids {
        let mut unique = std::collections::HashSet::new();
        anyhow::ensure!(
            !ids.is_empty()
                && ids.len() <= 200
                && ids
                    .iter()
                    .all(|id| !id.is_empty() && !id.contains('\0') && unique.insert(id)),
            "invalid navigation activity thread ids"
        );
        let mut lookup = tx.prepare(&format!(
            "SELECT {GROUP_KEY} FROM camp WHERE id IN (SELECT value FROM json_each(?1))"
        ))?;
        let groups = lookup
            .query_map([serde_json::to_string(ids)?], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // A physically removed Thread no longer has an owner to resolve; reconcile the caller's bounded metadata scope.
        if groups.len() == ids.len() {
            selected.retain(|key| groups.contains(key));
            if selected.is_empty() {
                return Ok(Vec::new());
            }
        }
    }
    let sql = ACTIVITY_SQL
        .replace("{GROUP_KEY}", GROUP_KEY)
        .replace("{VISIBLE}", VISIBLE)
        .replace("{ACTIVE_RUN_STATUSES}", ACTIVE_RUN_STATUSES);
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params![client.id(), serde_json::to_string(&selected)?],
        |row| {
            Ok(NavigationGroupActivity {
                group_key: row.get(0)?,
                active_thread_count: row.get::<_, i64>(1)? as usize,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn load_rows(
    tx: &Transaction<'_>,
    client: &crate::draft_client::DraftClient,
    predicate: &str,
    selection: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<NavigationThreadItem>> {
    let sql = format!(
        r#"
        SELECT camp.id, camp.title, camp.project_binding_kind, camp.project_path,
            lead.id, lead.display_name, camp.navigation_activity_sequence,
            COALESCE(camp.navigation_activity_at, camp.created_at), camp.navigation_completion_sequence,
            COALESCE(v.last_seen_global_sequence, 0),
            (EXISTS(SELECT 1 FROM agent_run r WHERE r.camp_id = camp.id AND r.status IN ({ACTIVE_RUN_STATUSES}))
             OR EXISTS(SELECT 1 FROM camp_turn t JOIN agent_run r ON r.camp_turn_id = t.id
                       WHERE t.camp_id = camp.id AND r.camp_id IS NULL AND r.status IN ({ACTIVE_RUN_STATUSES}))),
            camp.version, camp.activation_state, channel.provider, channel.conversation_kind
        FROM camp
        LEFT JOIN agent_profile lead ON lead.id = camp.default_lead_agent_id
        LEFT JOIN camp_view_state v ON v.camp_id = camp.id
        LEFT JOIN channel_conversation_binding binding ON binding.camp_id = camp.id
        LEFT JOIN channel_conversation channel ON channel.id = binding.channel_conversation_id
        WHERE {predicate} AND {VISIBLE}
        ORDER BY {ORDER} LIMIT ?3 OFFSET ?4
    "#
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            client.id(),
            selection,
            limit.min(i64::MAX as usize) as i64,
            offset.min(i64::MAX as usize) as i64
        ],
        |row| {
            let lead_id: Option<String> = row.get(4)?;
            let completion: i64 = row.get(8)?;
            let seen: i64 = row.get(9)?;
            let loading: bool = row.get(10)?;
            Ok(NavigationThreadItem {
                id: row.get(0)?,
                title: row.get(1)?,
                channel_source: camp_channel_source_from_row(row, 13)?,
                activation_state: row.get(12)?,
                project_binding_kind: row.get(2)?,
                project_path: row.get(3)?,
                default_lead: lead_id.map(|agent_id| NavigationLeadSummary {
                    agent_id,
                    display_name: row
                        .get::<_, Option<String>>(5)
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                }),
                marker: if loading {
                    "loading"
                } else if completion > seen {
                    "unread_completed"
                } else {
                    "none"
                }
                .into(),
                last_activity_at: row.get(7)?,
                last_activity_global_sequence: row.get(6)?,
                latest_completion_global_sequence: completion,
                last_seen_global_sequence: seen,
                version: row.get(11)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn load_navigation_rows(
    tx: &Transaction<'_>,
    client: &crate::draft_client::DraftClient,
    ids: &[String],
) -> Result<Vec<NavigationThreadItem>> {
    load_rows(
        tx,
        client,
        "camp.id IN (SELECT value FROM json_each(?2))",
        &serde_json::to_string(ids)?,
        0,
        ids.len(),
    )
}

pub(super) fn navigation_group_count(
    tx: &Transaction<'_>,
    client: &crate::draft_client::DraftClient,
    key: &str,
) -> Result<usize> {
    Ok(tx.query_row(
        &format!("SELECT COUNT(*) FROM camp WHERE {GROUP_KEY} = ?2 AND {VISIBLE}"),
        params![client.id(), key],
        |row| row.get::<_, i64>(0),
    )? as usize)
}

pub(super) fn load_navigation_group(
    tx: &Transaction<'_>,
    client: &crate::draft_client::DraftClient,
    key: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<NavigationThreadItem>> {
    load_rows(tx, client, &format!("{GROUP_KEY} = ?2"), key, offset, limit)
}

pub(super) fn load_navigation_groups(
    tx: &Transaction<'_>,
    client: &crate::draft_client::DraftClient,
    limits: &BTreeMap<String, usize>,
    keys: Option<&[String]>,
) -> Result<(NavigationThreadGroup, Vec<ProjectNavigationGroup>)> {
    // Only directory/count metadata spans the requested groups. Full Camp rows, run
    // markers and channel/lead details are read for each indexed prefix, never all rows.
    let filter = if keys.is_some() {
        format!("{GROUP_KEY} IN (SELECT value FROM json_each(?2))")
    } else {
        "?2 IS NULL".into()
    };
    let mut statement = tx.prepare(&format!(
        "SELECT {GROUP_KEY}, COUNT(*) FROM camp WHERE {filter} AND {VISIBLE} GROUP BY {GROUP_KEY}"
    ))?;
    let groups = statement
        .query_map(
            params![client.id(), keys.map(serde_json::to_string).transpose()?],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut quick_chat = NavigationThreadGroup {
        total_count: 0,
        recent_camps: vec![],
    };
    let mut projects = vec![];
    for (key, total_count) in groups {
        let limit = limits
            .get(&key)
            .copied()
            .unwrap_or(NAVIGATION_RECENT_CAMP_LIMIT)
            .max(NAVIGATION_RECENT_CAMP_LIMIT);
        let camps = load_navigation_group(tx, client, &key, 0, limit)?;
        if key == "quick-chat" {
            quick_chat = NavigationThreadGroup {
                total_count,
                recent_camps: camps,
            };
        } else if let Some(first) = camps.first() {
            projects.push(ProjectNavigationGroup {
                project_key: key,
                name: project_display_name(&first.project_path),
                project_path: first.project_path.clone(),
                last_activity_at: first.last_activity_at.clone(),
                last_activity_global_sequence: first.last_activity_global_sequence,
                total_count,
                recent_camps: camps,
            });
        }
    }
    projects.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| {
                b.last_activity_global_sequence
                    .cmp(&a.last_activity_global_sequence)
            })
            .then_with(|| a.project_key.cmp(&b.project_key))
    });
    Ok((quick_chat, projects))
}

pub(super) fn navigation_camp_group_keys(
    tx: &Transaction<'_>,
    ids: &[String],
) -> Result<Vec<String>> {
    let mut statement = tx.prepare(&format!(
        "SELECT DISTINCT {GROUP_KEY} FROM camp WHERE camp.id IN (SELECT value FROM json_each(?1))"
    ))?;
    Ok(statement
        .query_map([serde_json::to_string(ids)?], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn activity_counts_complete_visible_threads_once_and_resolves_external_window_owners() {
        const ACTIVITY_TEST_SCHEMA: &str = r#"
            CREATE TABLE camp(id TEXT PRIMARY KEY, project_binding_kind TEXT, project_path TEXT, deletion_operation_id TEXT, activation_state TEXT);
            CREATE TABLE agent_run(id TEXT PRIMARY KEY, camp_id TEXT, camp_turn_id TEXT, status TEXT);
            CREATE TABLE camp_turn(id TEXT PRIMARY KEY, camp_id TEXT);
            CREATE TABLE mission(camp_id TEXT);
            CREATE TABLE pending_camp_draft_presence(camp_id TEXT, client_id TEXT);
            CREATE TABLE camp_composer_draft(camp_id TEXT, client_id TEXT, body TEXT, source_attachments_json TEXT);
            CREATE TABLE prepared_attachment(camp_id TEXT, client_id TEXT);
        "#;
        const ACTIVITY_TEST_ROWS: &str = r#"
            INSERT INTO camp VALUES
            ('a1','directory','/a',NULL,'active'), ('a2','directory','/a',NULL,'active'),
            ('b1','directory','/b',NULL,'active'), ('deleted','directory','/a','delete','active'),
            ('mission','directory','/a',NULL,'active'), ('own','directory','/a',NULL,'pending'),
            ('foreign','directory','/a',NULL,'pending'), ('empty','directory','/a',NULL,'pending'),
            ('attachment','directory','/a',NULL,'pending'), ('terminal','directory','/a',NULL,'active'),
            ('q1','managed','/quick',NULL,'active'), ('wrong-turn','directory','/a',NULL,'active');
            INSERT INTO camp_turn VALUES ('t2','a2'),('wrong','wrong-turn');
            INSERT INTO agent_run VALUES
            ('r1','a1',NULL,'running'),('r2','a1',NULL,'queued'),('r3','a1','wrong','waiting'),
            ('private',NULL,'t2','running'),('private2',NULL,'t2','waiting'),('b','b1',NULL,'queued'),
            ('deleted','deleted',NULL,'running'),('mission','mission',NULL,'running'),
            ('own','own',NULL,'running'),('foreign','foreign',NULL,'running'),('empty','empty',NULL,'running'),
            ('attachment','attachment',NULL,'waiting'),('terminal','terminal',NULL,'succeeded'),('q','q1',NULL,'waiting');
            INSERT INTO mission VALUES ('mission');
            INSERT INTO pending_camp_draft_presence VALUES ('foreign','another-client');
        "#;
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(ACTIVITY_TEST_SCHEMA).unwrap();
        connection.execute_batch(ACTIVITY_TEST_ROWS).unwrap();
        let client = crate::draft_client::DraftClient::default();
        connection
            .execute(
                "INSERT INTO pending_camp_draft_presence VALUES ('own',?1)",
                [client.id()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO camp_composer_draft VALUES ('empty',?1,'   ','[]')",
                [client.id()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO prepared_attachment VALUES ('attachment',?1)",
                [client.id()],
            )
            .unwrap();
        let tx = connection.transaction().unwrap();
        let keys = vec![
            "directory:/a".into(),
            "directory:/b".into(),
            "quick-chat".into(),
            "directory:/outside".into(),
        ];
        let before: i64 = tx
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        let counts = load_navigation_activity(&tx, &client, &keys, None)
            .unwrap()
            .into_iter()
            .map(|group| (group.group_key, group.active_thread_count))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            counts,
            BTreeMap::from([
                ("directory:/a".into(), 4),
                ("directory:/b".into(), 1),
                ("directory:/outside".into(), 0),
                ("quick-chat".into(), 1)
            ])
        );
        let scoped = load_navigation_activity(&tx, &client, &keys, Some(&["a1".into()])).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].group_key, "directory:/a");
        assert_eq!(scoped[0].active_thread_count, 4);
        assert!(
            load_navigation_activity(&tx, &client, &["directory:/a".into()], Some(&["b1".into()]))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            load_navigation_activity(&tx, &client, &keys, Some(&["physically-absent".into()]))
                .unwrap()
                .len(),
            4
        );
        let after: i64 = tx
            .query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
        let legacy = vec![
            "directory:C:\\old\\project".into(),
            "directory:\\\\server\\share".into(),
            "directory:/空间".into(),
        ];
        assert!(
            load_navigation_activity(&tx, &client, &legacy, None)
                .unwrap()
                .iter()
                .all(|group| group.active_thread_count == 0)
        );
        for invalid in [
            vec![],
            vec!["directory:relative".into()],
            vec!["directory:C:relative".into()],
            vec!["directory:/a/../b".into()],
            vec!["quick-chat".into(), "quick-chat".into()],
            vec!["quick-chat".into(); 201],
        ] {
            assert!(load_navigation_activity(&tx, &client, &invalid, None).is_err());
        }
        for invalid in [
            vec![],
            vec!["".into()],
            vec!["a1".into(), "a1".into()],
            vec!["a1".into(); 201],
        ] {
            assert!(load_navigation_activity(&tx, &client, &keys, Some(&invalid)).is_err());
        }
    }

    fn metered(database: &mut Database, row_only: bool) -> usize {
        database
            .connection()
            .authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "event_log",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))
            .unwrap();
        let steps = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&steps);
        database
            .connection()
            .progress_handler(
                1,
                Some(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        if row_only {
            let rows = ReadModelService
                .navigation_camps(
                    database,
                    &["local-1".into()],
                    &crate::draft_client::DraftClient::default(),
                )
                .unwrap();
            assert_eq!(rows.camps.len(), 1);
        } else {
            let window = ReadModelService
                .navigation_snapshot_for_groups(
                    database,
                    &BTreeMap::new(),
                    Some(&["directory:/local".into()]),
                    &crate::draft_client::DraftClient::default(),
                )
                .unwrap();
            assert_eq!(window.projects.len(), 1);
            assert_eq!(window.projects[0].total_count, 20);
            assert_eq!(window.projects[0].recent_camps.len(), 5);
            assert_eq!(window.quick_chat.total_count, 0);
        }
        database
            .connection()
            .progress_handler(0, None::<fn() -> bool>)
            .unwrap();
        database
            .connection()
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        steps.load(Ordering::Relaxed)
    }

    // The new read scopes own this cost boundary: CampOpen's volume test cannot
    // detect accidentally materializing other groups or re-aggregating navigation.
    #[test]
    fn navigation_reads_no_history_and_scoped_work_does_not_grow_with_other_groups() {
        let directory =
            std::env::temp_dir().join(format!("rovai-navigation-volume-{}", uuid::Uuid::new_v4()));
        let mut database = crate::test_support::fresh_schema_database_at(&directory);
        database
            .connection()
            .execute_batch(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20)
            INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at)
            SELECT 'local-'||i,'local','directory','/local','2026-01-01','2026-01-01' FROM n;",
            )
            .unwrap();
        let baseline = [metered(&mut database, true), metered(&mut database, false)];
        database
            .connection()
            .execute_batch(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
            INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at)
            SELECT 'other-'||i,'other','directory','/other','2026-01-01','2026-01-01' FROM n;
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000)
            INSERT INTO event_log(event_type,camp_id,payload_json,created_at)
            SELECT 'agent_run.succeeded','other-1','{}','2026-02-01' FROM n;",
            )
            .unwrap();
        let scaled = [metered(&mut database, true), metered(&mut database, false)];
        assert_eq!(baseline[0], scaled[0]);
        // With a following index group, terminating the range needs one extra
        // comparison; work must remain constant rather than visit its 2,000 rows.
        assert!(
            scaled[1] <= baseline[1] + 1,
            "scoped work grew: {baseline:?} -> {scaled:?}"
        );
        eprintln!(
            "navigation_scope_scale rows=2020 events=50000 row_vm_steps={} group_vm_steps={}",
            scaled[0], scaled[1]
        );
        database
            .connection()
            .authorizer(Some(|context: AuthContext<'_>| match context.action {
                AuthAction::Read {
                    table_name: "event_log",
                    ..
                } => Authorization::Deny,
                _ => Authorization::Allow,
            }))
            .unwrap();
        let snapshot = ReadModelService.navigation_snapshot(&mut database).unwrap();
        assert_eq!(snapshot.projects.len(), 2);
        let page = ReadModelService
            .navigation_group_camps(&mut database, Some("/local"), 5, 10)
            .unwrap();
        assert_eq!(page.camps.len(), 10);
        let acknowledgement = ReadModelService
            .acknowledge_camp_viewed(&mut database, "local-1", snapshot.through_global_sequence)
            .unwrap();
        assert!(acknowledgement.changed);
        let repeat = ReadModelService
            .acknowledge_camp_viewed(&mut database, "local-1", snapshot.through_global_sequence)
            .unwrap();
        assert!(!repeat.changed);
        drop(database);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
