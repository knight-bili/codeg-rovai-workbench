//! Bounded, metadata-only Canvas directory. Never projects transcripts, drafts or model inputs.
use super::{Database, ReadModelService, current_global_sequence};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRunModel {
    pub run_id: String,
    #[serde(flatten)]
    pub model: super::message_model::ThreadMessageRuntimeModelView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasReferenceMember {
    pub agent_id: String,
    pub display_name: String,
    pub runtime_kind: Option<String>,
    pub last_run_model: Option<CanvasRunModel>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPrivateReference {
    pub conversation_id: String,
    pub agent_id: String,
    pub updated_at: String,
    pub has_active_run: bool,
    pub last_run_model: Option<CanvasRunModel>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasThreadReference {
    pub thread_id: String,
    pub title: String,
    pub project_binding_kind: String,
    pub project_path: String,
    pub updated_at: String,
    pub version: i64,
    pub mission_id: Option<String>,
    pub members: Vec<CanvasReferenceMember>,
    pub private_conversations: Vec<CanvasPrivateReference>,
    pub public_active_run_count: i64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasReferencePage {
    pub schema_version: u32,
    pub through_global_sequence: i64,
    pub items: Vec<CanvasThreadReference>,
    pub next_after_thread_id: Option<String>,
    pub upper_thread_id: Option<String>,
}

// Same active/own-pending visibility as Navigation, including Mission-backed Threads.
// Keyset order is immutable identity, not activity: moving a row cannot skip a later page.
const HIGH_WATER_SQL: &str = r#"
SELECT camp.id FROM camp WHERE camp.deletion_operation_id IS NULL
  AND (camp.activation_state = 'active'
    OR EXISTS(SELECT 1 FROM pending_camp_draft_presence d WHERE d.camp_id = camp.id AND d.client_id = ?1)
    OR EXISTS(SELECT 1 FROM camp_composer_draft d WHERE d.camp_id = camp.id AND d.client_id = ?1
              AND (length(trim(d.body)) > 0 OR d.source_attachments_json <> '[]'))
    OR EXISTS(SELECT 1 FROM prepared_attachment WHERE camp_id = camp.id AND client_id = ?1))
ORDER BY camp.id DESC LIMIT 1
"#;
const PAGE_SQL: &str = r#"
SELECT camp.id AS thread_id, COALESCE(mission.title, camp.title) AS title, camp.project_binding_kind,
       camp.project_path, MAX(camp.updated_at, COALESCE(mission.updated_at, camp.updated_at)) AS updated_at,
       camp.version, mission.id AS mission_id
FROM camp LEFT JOIN mission ON mission.camp_id = camp.id
WHERE camp.id > ?2 AND camp.id <= ?4 AND camp.deletion_operation_id IS NULL
  AND (camp.activation_state = 'active'
    OR EXISTS(SELECT 1 FROM pending_camp_draft_presence d WHERE d.camp_id = camp.id AND d.client_id = ?1)
    OR EXISTS(SELECT 1 FROM camp_composer_draft d WHERE d.camp_id = camp.id AND d.client_id = ?1
              AND (length(trim(d.body)) > 0 OR d.source_attachments_json <> '[]'))
    OR EXISTS(SELECT 1 FROM prepared_attachment WHERE camp_id = camp.id AND client_id = ?1))
ORDER BY camp.id LIMIT ?3
"#;
const MEMBERS_SQL: &str = r#"
SELECT member.camp_id, profile.id, profile.display_name, profile.selected_runtime_adapter_kind
FROM camp_member member JOIN agent_profile profile ON profile.id = member.agent_id
WHERE member.camp_id IN (SELECT value FROM json_each(?1))
  AND member.status = 'active' AND profile.profile_status <> 'removed'
ORDER BY member.camp_id, profile.member_order, profile.id
"#;
const PRIVATE_SQL: &str = r#"
SELECT conversation.camp_id, conversation.id, conversation.agent_id, conversation.updated_at,
       EXISTS(SELECT 1 FROM agent_run run LEFT JOIN camp_turn turn ON turn.id = run.camp_turn_id
              WHERE run.conversation_id = conversation.id
              AND COALESCE(run.camp_id, turn.camp_id) = conversation.camp_id AND run.invocation_kind = 'single_chat'
              AND run.status IN ('queued', 'running', 'waiting'))
FROM conversation
JOIN camp_member member ON member.camp_id = conversation.camp_id AND member.agent_id = conversation.agent_id
JOIN agent_profile profile ON profile.id = conversation.agent_id
WHERE conversation.camp_id IN (SELECT value FROM json_each(?1))
  AND conversation.kind = 'single_chat' AND conversation.ended_at IS NULL
  AND member.status = 'active' AND profile.profile_status <> 'removed'
ORDER BY conversation.camp_id, conversation.updated_at DESC, conversation.id DESC
"#;
const ACTIVE_PUBLIC_SQL: &str = r#"
SELECT COALESCE(run.camp_id, task.camp_id), COUNT(*)
FROM agent_run run LEFT JOIN task ON task.id = run.task_id
WHERE COALESCE(run.camp_id, task.camp_id) IN (SELECT value FROM json_each(?1))
  AND run.invocation_kind <> 'single_chat' AND run.status IN ('queued', 'running', 'waiting')
GROUP BY COALESCE(run.camp_id, task.camp_id)
"#;
// Scope by indexed Thread/turn ownership before ranking; never load transcripts or permission JSON.
const RUN_MODELS_SQL: &str = r#"
WITH owned AS (
  SELECT run.camp_id AS thread_id, run.id, run.conversation_id, run.invocation_kind, run.created_at,
         run.runtime_adapter_kind, run.runtime_model_selection_json, run.runtime_observed_model_id
  FROM agent_run run WHERE run.camp_id IN (SELECT value FROM json_each(?1))
  UNION ALL
  SELECT turn.camp_id, run.id, run.conversation_id, run.invocation_kind, run.created_at,
         run.runtime_adapter_kind, run.runtime_model_selection_json, run.runtime_observed_model_id
  FROM camp_turn turn JOIN agent_run run ON run.camp_turn_id = turn.id AND run.camp_id IS NULL
  WHERE turn.camp_id IN (SELECT value FROM json_each(?1))
), ranked AS (
  SELECT owned.*, conversation.agent_id, conversation.kind,
         ROW_NUMBER() OVER (
           PARTITION BY owned.thread_id, conversation.agent_id,
                        CASE WHEN conversation.kind = 'single_chat' THEN conversation.id ELSE '' END
           ORDER BY owned.created_at DESC, owned.id DESC) AS ordinal
  FROM owned JOIN conversation ON conversation.id = owned.conversation_id AND conversation.camp_id = owned.thread_id
  JOIN camp_member member ON member.camp_id = owned.thread_id AND member.agent_id = conversation.agent_id
  JOIN agent_profile profile ON profile.id = conversation.agent_id
  WHERE member.status = 'active' AND profile.profile_status <> 'removed'
    AND ((conversation.kind = 'single_chat' AND conversation.ended_at IS NULL AND owned.invocation_kind = 'single_chat')
      OR (conversation.kind <> 'single_chat' AND owned.invocation_kind <> 'single_chat'))
)
SELECT thread_id, conversation_id, agent_id, kind, id,
       runtime_adapter_kind, runtime_model_selection_json, runtime_observed_model_id
FROM ranked WHERE ordinal = 1
ORDER BY thread_id, conversation_id
"#;

fn read_page(
    tx: &Transaction<'_>,
    client_id: &str,
    after: &str,
    upper: Option<&str>,
    limit: usize,
) -> Result<CanvasReferencePage> {
    let limit = limit.clamp(1, 200);
    let upper_thread_id = match upper {
        Some(value) => Some(value.to_owned()),
        None => tx
            .query_row(HIGH_WATER_SQL, [client_id], |row| row.get::<_, String>(0))
            .optional()?,
    };
    let mut items = tx
        .prepare(PAGE_SQL)?
        .query_map(
            params![
                client_id,
                after,
                (limit + 1) as i64,
                upper_thread_id.as_deref().unwrap_or("")
            ],
            |row| {
                Ok(CanvasThreadReference {
                    thread_id: row.get(0)?,
                    title: row.get(1)?,
                    project_binding_kind: row.get(2)?,
                    project_path: row.get(3)?,
                    updated_at: row.get(4)?,
                    version: row.get(5)?,
                    mission_id: row.get(6)?,
                    members: Vec::new(),
                    private_conversations: Vec::new(),
                    public_active_run_count: 0,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let positions = items
        .iter()
        .enumerate()
        .map(|(index, item)| (item.thread_id.clone(), index))
        .collect::<std::collections::BTreeMap<_, _>>();
    let ids = serde_json::to_string(&positions.keys().collect::<Vec<_>>())?;
    let members = tx
        .prepare(MEMBERS_SQL)?
        .query_map([&ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CanvasReferenceMember {
                    agent_id: row.get(1)?,
                    display_name: row.get(2)?,
                    runtime_kind: row.get(3)?,
                    last_run_model: None,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, member) in members {
        if let Some(index) = positions.get(&id) {
            items[*index].members.push(member);
        }
    }
    let conversations = tx
        .prepare(PRIVATE_SQL)?
        .query_map([&ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CanvasPrivateReference {
                    conversation_id: row.get(1)?,
                    agent_id: row.get(2)?,
                    updated_at: row.get(3)?,
                    has_active_run: row.get(4)?,
                    last_run_model: None,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, conversation) in conversations {
        if let Some(index) = positions.get(&id) {
            items[*index].private_conversations.push(conversation);
        }
    }
    let active = tx
        .prepare(ACTIVE_PUBLIC_SQL)?
        .query_map([&ids], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, count) in active {
        if let Some(index) = positions.get(&id) {
            items[*index].public_active_run_count = count;
        }
    }
    let models = tx
        .prepare(RUN_MODELS_SQL)?
        .query_map([&ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (thread, conversation, agent, kind, run_id, adapter, selection, observed) in models {
        let Some(model) =
            super::message_model::project_model(adapter.as_deref(), selection.as_deref(), observed)
        else {
            continue;
        };
        let Some(index) = positions.get(&thread) else {
            continue;
        };
        let value = Some(CanvasRunModel { run_id, model });
        if kind == "single_chat" {
            if let Some(target) = items[*index]
                .private_conversations
                .iter_mut()
                .find(|item| item.conversation_id == conversation && item.agent_id == agent)
            {
                target.last_run_model = value;
            }
        } else if let Some(target) = items[*index]
            .members
            .iter_mut()
            .find(|item| item.agent_id == agent)
        {
            target.last_run_model = value;
        }
    }
    let next_after_thread_id = if has_more {
        items.last().map(|item| item.thread_id.clone())
    } else {
        None
    };
    Ok(CanvasReferencePage {
        schema_version: 1,
        through_global_sequence: current_global_sequence(tx)?,
        items,
        next_after_thread_id,
        upper_thread_id,
    })
}

impl ReadModelService {
    pub fn canvas_references_page(
        &self,
        database: &mut Database,
        client: &crate::draft_client::DraftClient,
        after: Option<&str>,
        upper: Option<&str>,
        limit: usize,
    ) -> Result<CanvasReferencePage> {
        let tx = database.connection_mut().transaction()?;
        let page = read_page(&tx, client.id(), after.unwrap_or(""), upper, limit)?;
        tx.commit()?;
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Owns cross-table visibility and keyset joins, using only the columns this read side consumes.
    // Full Database migration/Host proof remains in the I03 stage verification batch.
    #[test]
    fn pages_metadata_with_exact_editor_membership_and_private_identity_without_read_side_writes() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(FIXTURE_SQL).unwrap();
        let before = connection.total_changes();
        let tx = connection.transaction().unwrap();
        let first = read_page(&tx, "desktop", "", None, 2).unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| item.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(first.next_after_thread_id.as_deref(), Some("b"));
        assert_eq!(first.upper_thread_id.as_deref(), Some("own-pending"));
        assert_eq!(first.items[1].mission_id.as_deref(), Some("mission"));
        assert_eq!(first.items[1].title, "mission title");
        assert_eq!(first.items[0].members.len(), 1);
        assert_eq!(first.items[0].public_active_run_count, 2);
        assert_eq!(first.items[1].public_active_run_count, 2);
        assert!(first.items[0].private_conversations[0].has_active_run);
        assert!(!first.items[1].private_conversations[0].has_active_run);
        let public = first.items[0].members[0].last_run_model.as_ref().unwrap();
        assert_eq!(public.run_id, "model-public-new");
        assert_eq!(public.model.model_id.as_deref(), Some("public-observed"));
        let private = first.items[0].private_conversations[0]
            .last_run_model
            .as_ref()
            .unwrap();
        assert_eq!(private.run_id, "model-private");
        assert_eq!(private.model.model_id.as_deref(), Some("private-frozen"));
        let legacy = first.items[1].members[0].last_run_model.as_ref().unwrap();
        assert_eq!(legacy.run_id, "model-legacy");
        assert_eq!(legacy.model.adapter_kind, "gemini-cli");
        assert_eq!(legacy.model.model_id.as_deref(), Some("legacy-observed"));
        assert!(
            first.items[1].private_conversations[0]
                .last_run_model
                .as_ref()
                .unwrap()
                .model
                .model_id
                .is_none()
        );
        assert!(
            !serde_json::to_string(&first)
                .unwrap()
                .contains("NEVER-PROJECT")
        );
        assert_eq!(
            first.items[0].members[0].runtime_kind.as_deref(),
            Some("codex-cli")
        );
        assert_eq!(
            first.items[0]
                .private_conversations
                .iter()
                .map(|item| item.conversation_id.as_str())
                .collect::<Vec<_>>(),
            ["private-a"]
        );
        let next = read_page(&tx, "desktop", "b", first.upper_thread_id.as_deref(), 200).unwrap();
        assert_eq!(
            next.items
                .iter()
                .map(|item| item.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["own-pending"]
        );
        assert!(next.next_after_thread_id.is_none());
        assert_eq!(next.through_global_sequence, 9);
        let other = read_page(&tx, "other", "b", None, 200).unwrap();
        assert_eq!(
            other
                .items
                .iter()
                .map(|item| item.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["foreign-pending"]
        );
        tx.commit().unwrap();
        assert_eq!(connection.total_changes(), before);
    }
    const FIXTURE_SQL: &str = r#"
CREATE TABLE camp(id TEXT PRIMARY KEY,title TEXT,project_binding_kind TEXT,project_path TEXT,updated_at TEXT,version INTEGER,deletion_operation_id TEXT,activation_state TEXT);
CREATE TABLE mission(id TEXT,camp_id TEXT,title TEXT,updated_at TEXT);
CREATE TABLE pending_camp_draft_presence(camp_id TEXT,client_id TEXT);
CREATE TABLE camp_composer_draft(camp_id TEXT,client_id TEXT,body TEXT,source_attachments_json TEXT);
CREATE TABLE prepared_attachment(camp_id TEXT,client_id TEXT);
CREATE TABLE agent_profile(id TEXT,display_name TEXT,selected_runtime_adapter_kind TEXT,profile_status TEXT,member_order INTEGER);
CREATE TABLE camp_member(camp_id TEXT,agent_id TEXT,status TEXT);
CREATE TABLE conversation(camp_id TEXT,id TEXT,agent_id TEXT,updated_at TEXT,kind TEXT,ended_at TEXT);
CREATE TABLE task(id TEXT PRIMARY KEY,camp_id TEXT);
CREATE TABLE agent_run(id TEXT PRIMARY KEY,camp_id TEXT,task_id TEXT,conversation_id TEXT,invocation_kind TEXT,status TEXT);
CREATE TABLE event_sequence(singleton INTEGER PRIMARY KEY,last_sequence INTEGER); INSERT INTO event_sequence VALUES(1,9);
INSERT INTO camp VALUES('a','public','directory','/project','time',1,NULL,'active'),('b','old title','directory','/project','time',1,NULL,'active'),
 ('deleted','removed','directory','/project','time',1,'deletion','active'),('foreign-pending','foreign','quick_chat','/quick','time',1,NULL,'pending'),
 ('own-pending','own','quick_chat','/quick','time',1,NULL,'pending'),('unowned-pending','none','quick_chat','/quick','time',1,NULL,'pending');
INSERT INTO mission VALUES('mission','b','mission title','time');
INSERT INTO pending_camp_draft_presence VALUES('own-pending','desktop'),('foreign-pending','other');
INSERT INTO agent_profile VALUES('agent-a','A','codex-cli','present',1),('agent-b','B','gemini-cli','present',2),('removed','Gone','codex-cli','removed',3);
INSERT INTO camp_member VALUES('a','agent-a','active'),('a','agent-b','left'),('a','removed','active');
INSERT INTO camp_member VALUES('b','agent-a','active');
INSERT INTO conversation VALUES('a','private-a','agent-a','time','single_chat',NULL),('a','ended','agent-a','time','single_chat','ended'),
 ('a','public-route','agent-a','time','public',NULL),('a','left-member','agent-b','time','single_chat',NULL),('a','removed-profile','removed','time','single_chat',NULL);
INSERT INTO conversation VALUES('b','private-b','agent-a','time','single_chat',NULL);
INSERT INTO task VALUES('legacy-task','b'),('wrong-task','a');
INSERT INTO agent_run VALUES('public-queued','a',NULL,NULL,'camp_request','queued'),('public-waiting','a',NULL,NULL,'camp_request','waiting'),
 ('completed','a',NULL,NULL,'camp_request','succeeded'),('private',NULL,NULL,'private-a','single_chat','running'),
 ('private-foreign','b',NULL,'private-a','single_chat','running'),('legacy-run',NULL,'legacy-task',NULL,'task','running'),
 ('direct-owner','b','wrong-task',NULL,'task','queued'),('private-wrong-camp','a',NULL,'private-b','single_chat','waiting');
ALTER TABLE agent_run ADD COLUMN camp_turn_id TEXT;
ALTER TABLE agent_run ADD COLUMN created_at TEXT;
ALTER TABLE agent_run ADD COLUMN runtime_adapter_kind TEXT;
ALTER TABLE agent_run ADD COLUMN runtime_model_selection_json TEXT;
ALTER TABLE agent_run ADD COLUMN runtime_observed_model_id TEXT;
CREATE TABLE camp_turn(id TEXT PRIMARY KEY,camp_id TEXT);
INSERT INTO camp_turn VALUES('legacy-turn','b'),('private-turn','a');
UPDATE agent_run SET camp_turn_id='private-turn' WHERE id='private';
INSERT INTO agent_run(id,camp_id,conversation_id,invocation_kind,status,camp_turn_id)
 VALUES('private-wrong-turn',NULL,'private-b','single_chat','waiting','private-turn');
INSERT INTO conversation VALUES('a','public-a','agent-a','time','public',NULL),('b','public-b','agent-a','time','public',NULL),
 ('a','public-left','agent-b','time','public',NULL);
INSERT INTO agent_run(id,camp_id,conversation_id,invocation_kind,status,camp_turn_id,created_at,runtime_adapter_kind,runtime_model_selection_json,runtime_observed_model_id) VALUES
 ('model-public-old','a','public-a','camp_request','succeeded',NULL,'2026-10-15','codex-cli','{"source":"explicit","modelId":"old-public"}',NULL),
 ('model-public-new','a','public-a','camp_request','succeeded',NULL,'2026-10-16','codex-cli','{"source":"runtime_default","modelId":"not-an-observation"}','public-observed'),
 ('model-private',NULL,'private-a','single_chat','succeeded','private-turn','2026-10-16','codex-cli','{"source":"explicit","modelId":"private-frozen","options":{"api_key":"NEVER-PROJECT"}}','ignore-explicit-observation'),
 ('model-legacy',NULL,'public-b','camp_request','succeeded','legacy-turn','2026-10-16','gemini-cli','{"source":"runtime_default"}','legacy-observed'),
 ('model-private-b-old','b','private-b','single_chat','succeeded',NULL,'2026-10-15','codex-cli','{"source":"explicit","modelId":"old-private"}',NULL),
 ('model-private-b-unknown','b','private-b','single_chat','succeeded',NULL,'2026-10-16','codex-cli','{"source":"runtime_default"}',NULL),
 ('model-wrong-thread','b','public-a','camp_request','succeeded',NULL,'2026-10-17','codex-cli','{"source":"explicit","modelId":"wrong-thread"}',NULL),
 ('model-left','a','public-left','camp_request','succeeded',NULL,'2026-10-17','gemini-cli','{"source":"explicit","modelId":"left-member"}',NULL),
 ('model-ended','a','ended','single_chat','succeeded',NULL,'2026-10-17','codex-cli','{"source":"explicit","modelId":"ended-private"}',NULL);
"#;
}
