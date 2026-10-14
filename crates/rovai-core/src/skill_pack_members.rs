//! Member choices are user configuration, separate from runtime/model delivery.
use std::collections::BTreeSet;

use anyhow::Result;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    command::{
        ActorRef, CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, canonical_json_digest, sealed,
    },
    db::Database,
    skill_pack_installation::member_configuration_source,
};

pub(crate) const TABLE_SQL: &str = "CREATE TABLE member_skill_pack (
    skill_id TEXT NOT NULL REFERENCES skill_pack_installation(skill_id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_profile(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(skill_id,agent_id)
);
CREATE INDEX member_skill_pack_agent_idx ON member_skill_pack(agent_id,skill_id);";

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns = connection
        .prepare("PRAGMA table_info(member_skill_pack)")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns
        != [
            ("skill_id".into(), "TEXT".into(), 1, 1),
            ("agent_id".into(), "TEXT".into(), 1, 2),
            ("updated_at".into(), "TEXT".into(), 1, 0),
        ]
    {
        return Ok(false);
    }
    let mut foreign_keys = connection
        .prepare("PRAGMA foreign_key_list(member_skill_pack)")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    foreign_keys.sort();
    if foreign_keys
        != [
            (
                "agent_profile".into(),
                "agent_id".into(),
                "id".into(),
                "CASCADE".into(),
            ),
            (
                "skill_pack_installation".into(),
                "skill_id".into(),
                "skill_id".into(),
                "CASCADE".into(),
            ),
        ]
    {
        return Ok(false);
    }
    let index = connection
        .prepare("PRAGMA index_info(member_skill_pack_agent_idx)")?
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(index == ["agent_id", "skill_id"])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSkillPackMembersCommand {
    pub skill_id: String,
    pub member_ids: Vec<String>,
    pub expected_version: String,
}
impl sealed::Sealed for SetSkillPackMembersCommand {}
impl DomainCommand for SetSkillPackMembersCommand {
    const TYPE: &'static str = "skill_pack.members.set";
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackMembersView {
    pub skill_id: String,
    pub installed: bool,
    pub member_ids: Vec<String>,
    pub version: String,
    pub member_delivery_enabled: bool,
}

fn member_ids(connection: &Connection, skill_id: &str) -> Result<Vec<String>> {
    Ok(connection.prepare("SELECT choice.agent_id FROM member_skill_pack AS choice JOIN agent_profile AS member ON member.id=choice.agent_id WHERE choice.skill_id=?1 AND member.profile_status<>'removed' ORDER BY choice.agent_id")?
        .query_map([skill_id],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn version(installation: Option<&str>, members: &[String]) -> Result<String> {
    canonical_json_digest(&json!({"installationVersion":installation,"memberIds":members}))
}

pub fn list(connection: &Connection) -> Result<Vec<SkillPackMembersView>> {
    let ids = connection
        .prepare("SELECT skill_id FROM skill_pack_installation ORDER BY skill_id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.into_iter()
        .map(|id| {
            let source = member_configuration_source(connection, &id)?;
            let members = member_ids(connection, &id)?;
            Ok(SkillPackMembersView {
                skill_id: id,
                installed: source.as_ref().is_some_and(|(_, installed)| *installed),
                version: version(
                    source.as_ref().map(|(version, _)| version.as_str()),
                    &members,
                )?,
                member_ids: members,
                member_delivery_enabled: crate::current_input_skill::pack_context_enabled(
                    connection,
                )?,
            })
        })
        .collect()
}

pub fn set_members(
    database: &mut Database,
    envelope: &CommandEnvelope<SetSkillPackMembersCommand>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database,envelope,|transaction|{
        if !matches!(envelope.actor,ActorRef::User{..}) || envelope.camp_id.is_some() || envelope.execution_epoch.is_some() {
            return Ok(CommandHandlerResult::rejected("skill_pack.members.invalid_request",json!({})));
        }
        let command=&envelope.payload;
        let source=member_configuration_source(transaction,&command.skill_id)?;
        if !source.as_ref().is_some_and(|(_,installed)|*installed) {
            return Ok(CommandHandlerResult::rejected("skill_pack.members.not_installed",json!({})));
        }
        let current=member_ids(transaction,&command.skill_id)?;
        let observed=version(source.as_ref().map(|(version,_)|version.as_str()),&current)?;
        if command.expected_version!=observed {
            return Ok(CommandHandlerResult::rejected("skill_pack.members.conflict",json!({"version":observed})));
        }
        let desired=command.member_ids.iter().cloned().collect::<BTreeSet<_>>();
        for member_id in &desired {
            let available: bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM agent_profile WHERE id=?1 AND profile_status<>'removed')",[member_id],|row|row.get(0))?;
            if !available {return Ok(CommandHandlerResult::rejected("skill_pack.members.member_unavailable",json!({"agentId":member_id})));}
        }
        clear_for_uninstall(transaction,&command.skill_id)?;
        let now=chrono::Utc::now().to_rfc3339();
        for member_id in &desired {
            transaction.execute("INSERT INTO member_skill_pack(skill_id,agent_id,updated_at) VALUES(?1,?2,?3)",params![command.skill_id,member_id,now])?;
        }
        let desired=desired.into_iter().collect::<Vec<_>>();
        Ok(CommandHandlerResult::applied("skill_pack.members.updated",json!({"skillId":command.skill_id,"memberIds":desired,"version":version(source.as_ref().map(|(version,_)|version.as_str()),&desired)?,"memberDeliveryEnabled":crate::current_input_skill::pack_context_enabled(transaction)?}),None))
    })
}

pub(crate) fn clear_for_uninstall(connection: &Connection, skill_id: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM member_skill_pack WHERE skill_id=?1",
        [skill_id],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn downgrade_for_test(connection: &Connection) {
    crate::canvas_board::downgrade_for_test(connection);
    if !connection.table_exists(None, "member_skill_pack").unwrap() {
        return;
    }
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM member_skill_pack", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        count, 0,
        "Synthetic old sources cannot discard member choices"
    );
    connection.execute_batch("DROP TABLE member_skill_pack; DELETE FROM schema_migration WHERE version=201;
        UPDATE rovai_data_contract SET projection_schema_version=150 WHERE singleton=1 AND projection_schema_version=151;").unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    use crate::{
        agent_profile::AdapterKind,
        camp_content::StructuredThreadMessageSegment,
        command::ActorRef,
        current_input_skill::{
            CurrentInputSkillOmissionReason as Reason, SkillSource, freeze_skill_selection,
            freeze_skill_selection_with_packs, resolve_current_input_skills,
            resolve_current_input_skills_with_packs, validate_persisted_resolution,
        },
        skill_pack_delivery::{PackUnavailable, PreparedMemberSkillPacks},
        skill_pack_installation::{
            InstallBeginning, InstallSkillPackCommand, SkillPackStore, UninstallSkillPackCommand,
        },
    };
    fn envelope<C>(payload: C) -> CommandEnvelope<C> {
        CommandEnvelope {
            command_id: uuid::Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "local_user".into(),
            },
            camp_id: None,
            expected_versions: vec![],
            execution_epoch: None,
            payload,
        }
    }
    fn install(database: &mut Database, store: &SkillPackStore, expected: &str) {
        let command = envelope(InstallSkillPackCommand {
            skill_id: "brainstorming".into(),
            source_revision: crate::codeg_skill_catalog::list().unwrap().commit.into(),
            expected_version: expected.into(),
        });
        let InstallBeginning::Prepare(plan) = store.begin_install(database, &command).unwrap()
        else {
            panic!("fixture expected a new preparation")
        };
        let prepared = store.prepare(plan).unwrap();
        assert_eq!(
            store
                .commit_install(database, &command, prepared)
                .unwrap()
                .result
                .code,
            "skill_pack.installed"
        );
    }
    // One real SQLite/file owner proves the new table's atomic migration and its
    // interaction with install/uninstall/replay; pure collection tests cannot.
    #[test]
    fn migration_and_member_choices_survive_reopen_and_uninstall_fences_old_replay() {
        let (mut database, directory) = crate::test_support::seeded_runtime_database();
        downgrade_for_test(database.connection());
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_pack_members_receipt BEFORE INSERT ON schema_migration WHEN NEW.version=201 BEGIN SELECT RAISE(ABORT,'members migration receipt fixture'); END;").unwrap();
        assert!(database.migrate_skill_pack_members().is_err());
        assert!(
            !database
                .connection()
                .table_exists(None, "member_skill_pack")
                .unwrap()
        );
        assert_eq!(
            database
                .connection()
                .query_row(
                    "SELECT projection_schema_version FROM rovai_data_contract",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            150
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_pack_members_receipt")
            .unwrap();
        database.migrate_skill_pack_members().unwrap();
        assert!(schema_matches(database.connection()).unwrap());
        let store = SkillPackStore::new(&directory).unwrap();
        install(&mut database, &store, "absent");
        let mentions = [
            ("pack:brainstorming", "brainstorming"),
            ("pack:brainstorming", "brainstorming"),
            ("native:brainstorming", "brainstorming"),
            ("rovai:brainstorming", "brainstorming"),
            ("pack:missing", "missing"),
        ]
        .map(|(id, name)| StructuredThreadMessageSegment::SkillMention {
            skill_id: id.into(),
            name_at_send: name.into(),
        });
        let transaction = database.connection_mut().transaction().unwrap();
        let selection =
            freeze_skill_selection_with_packs(&transaction, &mentions, &[0, 1, 1, 1, 2]).unwrap();
        let old_selection =
            freeze_skill_selection(&transaction, &mentions, AdapterKind::CodexCli).unwrap();
        transaction.commit().unwrap();
        assert_eq!(selection.schema_version, 3);
        assert_eq!(selection.entries.len(), 4);
        assert_eq!(selection.entries[0].source, Some(SkillSource::Pack));
        assert!(selection.entries[0].source_path.is_none());
        assert_eq!(
            (
                selection.entries[1].first_message_index,
                selection.entries[1].first_segment_index
            ),
            (1, 1)
        );
        assert_eq!(old_selection.schema_version, 2);
        assert_eq!(old_selection.entries[0].source, Some(SkillSource::Legacy));
        let old_exposure_snapshot = crate::skill_projection::SkillExposureSnapshot {
            schema_version: 2,
            skills: vec![],
        };
        let old_exposure = crate::skill_projection::PreparedSkillExposure {
            digest: canonical_json_digest(&serde_json::to_value(&old_exposure_snapshot).unwrap())
                .unwrap(),
            snapshot: old_exposure_snapshot,
        };
        let old_resolved = resolve_current_input_skills(
            database.connection(),
            &old_selection,
            &old_selection.canonical_digest().unwrap(),
            &old_exposure,
            AdapterKind::CodexCli,
        )
        .unwrap();
        assert_eq!(
            old_resolved.resolution.entries[0].reason,
            Some(Reason::LegacyUnresolved)
        );
        let old_json = serde_json::to_value(&old_resolved.resolution).unwrap();
        assert!(
            old_json["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry.get("sourceVersion").is_none())
        );
        let resolve = |database: &Database, packs: &PreparedMemberSkillPacks| {
            resolve_current_input_skills_with_packs(
                database.connection(),
                &selection,
                &selection.canonical_digest().unwrap(),
                AdapterKind::CodexCli,
                "agent_1",
                packs,
            )
            .unwrap()
        };
        let empty = list(database.connection()).unwrap().remove(0);
        assert!(empty.member_ids.is_empty());
        assert!(!empty.member_delivery_enabled);
        let prepare = |database: &Database, member: &str| {
            PreparedMemberSkillPacks::prepare(
                database.connection(),
                &directory,
                member,
                [
                    "pack:brainstorming",
                    "pack:missing",
                    "pack:../../outside",
                    "native:brainstorming",
                ],
            )
            .unwrap()
        };
        let unselected = prepare(&database, "agent_1");
        assert_eq!(
            unselected.source("pack:brainstorming"),
            Err(PackUnavailable::NotSelected)
        );
        assert_eq!(
            unselected.source("pack:missing"),
            Err(PackUnavailable::NotInstalled)
        );
        assert_eq!(
            unselected.source("pack:../../outside"),
            Err(PackUnavailable::NotInstalled)
        );
        assert_eq!(
            unselected.source("native:brainstorming"),
            Err(PackUnavailable::NotSelected)
        );
        assert_eq!(
            unselected.section().unwrap(),
            "[ROVAI_SKILL_PACKS]\nCurrent for this run; replaces any earlier Rovai Skill Packs.\n{\"skills\":[]}\n[/ROVAI_SKILL_PACKS]"
        );
        assert_eq!(
            resolve(&database, &unselected).resolution.entries[0].reason,
            Some(Reason::PackNotSelected)
        );
        let first = envelope(SetSkillPackMembersCommand {
            skill_id: "brainstorming".into(),
            member_ids: vec!["agent_1".into(), "agent_1".into()],
            expected_version: empty.version.clone(),
        });
        let mut invalid = first.clone();
        invalid.command_id = uuid::Uuid::new_v4().to_string();
        invalid.payload.member_ids = vec!["missing-member".into()];
        assert_eq!(
            set_members(&mut database, &invalid).unwrap().result.code,
            "skill_pack.members.member_unavailable"
        );
        assert!(
            list(database.connection()).unwrap()[0]
                .member_ids
                .is_empty()
        );
        let applied = set_members(&mut database, &first).unwrap().result;
        assert_eq!(applied.code, "skill_pack.members.updated");
        assert_eq!(
            list(database.connection()).unwrap()[0].member_ids,
            ["agent_1"]
        );
        let selected = prepare(&database, "agent_1");
        let original_source = selected.source("pack:brainstorming").unwrap();
        assert_eq!(original_source.name, "brainstorming");
        assert_eq!(selected.sources().count(), 1);
        let resolved = resolve(&database, &selected);
        assert_eq!(resolved.links.len(), 1);
        assert_eq!(resolved.links[0].path, original_source.path);
        assert_eq!(
            resolved.links[0].skill_id.as_deref(),
            Some("pack:brainstorming")
        );
        assert_eq!(resolved.resolution.schema_version, 3);
        assert_eq!(
            resolved.resolution.entries[0].source_path.as_deref(),
            Some(original_source.path.as_str())
        );
        assert_eq!(
            resolved.resolution.entries[0].source_version.as_deref(),
            Some(original_source.source_version.as_str())
        );
        assert_eq!(
            resolved.resolution.entries[1].reason,
            Some(Reason::SourceMissing)
        );
        assert_eq!(
            resolved.resolution.entries[2].reason,
            Some(Reason::SourceMissing)
        );
        assert_eq!(
            resolved.resolution.entries[3].reason,
            Some(Reason::PackNotInstalled)
        );
        let resolution_json = serde_json::to_string(&resolved.resolution).unwrap();
        let parsed = validate_persisted_resolution(
            &resolution_json,
            &resolved.digest,
            &selection,
            &selection.canonical_digest().unwrap(),
            "unused-for-v3",
        )
        .unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), resolution_json);
        // A recomputed digest must not admit a relative path or version fields
        // on a different source; the closed source contract still applies.
        for (index, field, value) in [
            (0, "sourcePath", json!("relative/SKILL.md")),
            (0, "sourceVersion", json!(null)),
            (1, "sourceVersion", json!(original_source.source_version)),
            (1, "reason", json!("pack_not_selected")),
            (0, "reason", json!("legacy_unresolved")),
        ] {
            let mut forged = serde_json::to_value(&resolved.resolution).unwrap();
            forged["entries"][index][field] = value;
            assert!(
                validate_persisted_resolution(
                    &forged.to_string(),
                    &canonical_json_digest(&forged).unwrap(),
                    &selection,
                    &selection.canonical_digest().unwrap(),
                    ""
                )
                .is_err()
            );
        }
        let mut forged_selection = selection.clone();
        forged_selection.entries[0].source_path = Some(original_source.path.clone());
        assert!(forged_selection.canonical_digest().is_err());
        forged_selection.entries[0].source_path = None;
        forged_selection.schema_version = 2;
        assert!(forged_selection.canonical_digest().is_err());
        let mut wrong_name = selection.clone();
        wrong_name.entries[0].name_at_send = "review-pr".into();
        let wrong = resolve_current_input_skills_with_packs(
            database.connection(),
            &wrong_name,
            &wrong_name.canonical_digest().unwrap(),
            AdapterKind::CodexCli,
            "agent_1",
            &selected,
        )
        .unwrap();
        assert!(wrong.links.is_empty());
        assert_eq!(
            wrong.resolution.entries[0].reason,
            Some(Reason::SourceMissing)
        );
        assert!(
            resolve_current_input_skills_with_packs(
                database.connection(),
                &selection,
                &selection.canonical_digest().unwrap(),
                AdapterKind::CodexCli,
                "agent_2",
                &selected
            )
            .is_err()
        );
        let mut old_with_package_field = old_json.clone();
        old_with_package_field["entries"][0]["sourceVersion"] = json!(null);
        assert!(
            validate_persisted_resolution(
                &old_with_package_field.to_string(),
                &old_resolved.digest,
                &old_selection,
                &old_selection.canonical_digest().unwrap(),
                ""
            )
            .is_err()
        );
        let mut missing_version_field = serde_json::to_value(&resolved.resolution).unwrap();
        missing_version_field["entries"][1]
            .as_object_mut()
            .unwrap()
            .remove("sourceVersion");
        assert!(
            validate_persisted_resolution(
                &missing_version_field.to_string(),
                &resolved.digest,
                &selection,
                &selection.canonical_digest().unwrap(),
                ""
            )
            .is_err()
        );
        let section = selected.section().unwrap();
        let index: serde_json::Value =
            serde_json::from_str(section.lines().nth(2).unwrap()).unwrap();
        assert_eq!(
            index,
            json!({"skills":[{"id":"pack:brainstorming","name":"brainstorming","desc":original_source.desc,"path":original_source.path}]})
        );
        assert_eq!(
            prepare(&database, "agent_2").source("pack:brainstorming"),
            Err(PackUnavailable::NotSelected)
        );
        let transaction = database.connection_mut().transaction().unwrap();
        assert_eq!(
            PreparedMemberSkillPacks::prepare(
                &transaction,
                &directory,
                "agent_1",
                [
                    "pack:brainstorming",
                    "pack:missing",
                    "pack:../../outside",
                    "native:brainstorming"
                ]
            )
            .unwrap(),
            selected
        );
        transaction.commit().unwrap();
        let mut stale = first.clone();
        stale.command_id = uuid::Uuid::new_v4().to_string();
        stale.payload.member_ids = vec![];
        assert_eq!(
            set_members(&mut database, &stale).unwrap().result.code,
            "skill_pack.members.conflict"
        );
        let mut replay = first.clone();
        replay.payload.member_ids = vec![];
        assert_eq!(set_members(&mut database, &replay).unwrap().result, applied);
        drop(database);
        let mut database = Database::open(&directory).unwrap();
        assert_eq!(prepare(&database, "agent_1"), selected);
        assert_eq!(
            list(database.connection()).unwrap()[0].member_ids,
            ["agent_1"]
        );
        let active = store.list(database.connection()).unwrap().remove(0);
        let member_before_update = list(database.connection()).unwrap().remove(0);
        // A user edit forces a new private version; choices follow the logical pack,
        // but stale configuration observers must not write over that new version.
        std::fs::write(
            Path::new(active.content_path.as_ref().unwrap()).join("SKILL.md"),
            "broken local frontmatter",
        )
        .unwrap();
        assert_eq!(
            prepare(&database, "agent_1").source("pack:brainstorming"),
            Err(PackUnavailable::Changed)
        );
        assert_eq!(
            resolve(&database, &prepare(&database, "agent_1"))
                .resolution
                .entries[0]
                .reason,
            Some(Reason::PackChanged)
        );
        install(&mut database, &store, &active.version);
        assert_eq!(
            resolve(&database, &prepare(&database, "agent_1"))
                .links
                .len(),
            1
        );
        let updated_sources = prepare(&database, "agent_1");
        let updated_source = updated_sources.source("pack:brainstorming").unwrap();
        assert_ne!(original_source.path, updated_source.path);
        assert_ne!(
            original_source.source_version,
            updated_source.source_version
        );
        assert_eq!(updated_source.desc, original_source.desc);
        assert_eq!(
            std::fs::read_to_string(&original_source.path).unwrap(),
            "broken local frontmatter"
        );
        assert_eq!(
            list(database.connection()).unwrap()[0].member_ids,
            ["agent_1"]
        );
        let old_observer = envelope(SetSkillPackMembersCommand {
            skill_id: "brainstorming".into(),
            member_ids: vec![],
            expected_version: member_before_update.version,
        });
        assert_eq!(
            set_members(&mut database, &old_observer)
                .unwrap()
                .result
                .code,
            "skill_pack.members.conflict"
        );
        let current = store.list(database.connection()).unwrap().remove(0);
        let uninstall = envelope(UninstallSkillPackCommand {
            skill_id: "brainstorming".into(),
            expected_version: current.version,
        });
        database.connection().execute_batch("CREATE TEMP TRIGGER reject_members_uninstall BEFORE INSERT ON event_log WHEN NEW.event_type='command.result' AND NEW.command_type='skill_pack.uninstall' BEGIN SELECT RAISE(ABORT,'uninstall result fixture'); END;").unwrap();
        assert!(store.uninstall(&mut database, &uninstall).is_err());
        assert_eq!(
            list(database.connection()).unwrap()[0].member_ids,
            ["agent_1"]
        );
        assert!(list(database.connection()).unwrap()[0].installed);
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_members_uninstall")
            .unwrap();
        assert_eq!(
            store
                .uninstall(&mut database, &uninstall)
                .unwrap()
                .result
                .code,
            "skill_pack.uninstalled"
        );
        assert!(
            list(database.connection()).unwrap()[0]
                .member_ids
                .is_empty()
        );
        assert_eq!(
            prepare(&database, "agent_1").source("pack:brainstorming"),
            Err(PackUnavailable::NotInstalled)
        );
        assert!(Path::new(&updated_source.path).is_file());
        let removed = store.list(database.connection()).unwrap().remove(0);
        install(&mut database, &store, &removed.version);
        assert_eq!(set_members(&mut database, &replay).unwrap().result, applied);
        assert_eq!(
            prepare(&database, "agent_1").source("pack:brainstorming"),
            Err(PackUnavailable::NotSelected)
        );
        assert!(
            list(database.connection()).unwrap()[0]
                .member_ids
                .is_empty()
        );
        drop(database);
        let reopened = Database::open(&directory).unwrap();
        assert_eq!(
            prepare(&reopened, "agent_1").source("pack:brainstorming"),
            Err(PackUnavailable::NotSelected)
        );
        assert!(
            list(reopened.connection()).unwrap()[0]
                .member_ids
                .is_empty()
        );
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
    use std::path::Path;
}
