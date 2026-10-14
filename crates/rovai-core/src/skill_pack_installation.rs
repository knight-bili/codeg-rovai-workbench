//! Core-owned package versions. Publish complete files before the SQLite pointer;
//! an interrupted preparation is unreachable, and updates never overwrite a tree.

use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

use crate::{
    codeg_skill_catalog::{InstallationSource, installation_source},
    command::{
        ActorRef, CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, canonical_json_digest, sealed,
    },
    db::Database,
    platform::private_storage::{create_private_new_file, open_private_read_file},
    skill::inspect_installed_pack_tree,
};

pub(crate) const TABLE_SQL: &str = "CREATE TABLE skill_pack_installation (
    skill_id TEXT PRIMARY KEY NOT NULL,
    source_revision TEXT NOT NULL,
    source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
    active_version TEXT NOT NULL UNIQUE,
    content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:'),
    status TEXT NOT NULL CHECK(status IN ('installed','removed')),
    generation INTEGER NOT NULL CHECK(generation>0),
    updated_at TEXT NOT NULL
)";

#[cfg(test)]
pub(crate) fn downgrade_for_test(connection: &Connection) {
    crate::skill_pack_members::downgrade_for_test(connection);
    if !connection
        .table_exists(None, "skill_pack_installation")
        .unwrap()
    {
        return;
    }
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM skill_pack_installation", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        count, 0,
        "Synthetic old sources cannot discard installed packages"
    );
    connection
        .execute_batch(
            "DROP TABLE skill_pack_installation;
        DELETE FROM schema_migration WHERE version=200;
        UPDATE rovai_data_contract SET projection_schema_version=149
        WHERE singleton=1 AND projection_schema_version=150;",
        )
        .unwrap();
}

pub(crate) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let columns = connection
        .prepare("PRAGMA table_info(skill_pack_installation)")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let expected = [
        ("skill_id", "TEXT", 1, 1),
        ("source_revision", "TEXT", 1, 0),
        ("source_digest", "TEXT", 1, 0),
        ("active_version", "TEXT", 1, 0),
        ("content_digest", "TEXT", 1, 0),
        ("status", "TEXT", 1, 0),
        ("generation", "INTEGER", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ];
    if columns
        != expected.map(|(name, kind, required, key)| (name.into(), kind.into(), required, key))
    {
        return Ok(false);
    }
    let indexes = connection
        .prepare("PRAGMA index_list(skill_pack_installation)")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, bool>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, unique, partial) in indexes {
        if !unique || partial {
            continue;
        }
        let fields = connection
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?
            .query_map([name], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if fields == ["active_version"] {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallSkillPackCommand {
    pub skill_id: String,
    pub source_revision: String,
    pub expected_version: String,
}
impl sealed::Sealed for InstallSkillPackCommand {}
impl DomainCommand for InstallSkillPackCommand {
    const TYPE: &'static str = "skill_pack.install";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallSkillPackCommand {
    pub skill_id: String,
    pub expected_version: String,
}
impl sealed::Sealed for UninstallSkillPackCommand {}
impl DomainCommand for UninstallSkillPackCommand {
    const TYPE: &'static str = "skill_pack.uninstall";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackInstallationView {
    pub skill_id: String,
    pub source_revision: String,
    pub status: String,
    pub version: String,
    pub availability: &'static str,
    pub content_path: Option<String>,
    pub retained_content: bool,
    pub member_delivery_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Installation {
    skill_id: String,
    source_revision: String,
    source_digest: String,
    active_version: String,
    content_digest: String,
    status: String,
    generation: i64,
    updated_at: String,
}
impl Installation {
    fn version(&self) -> Result<String> {
        canonical_json_digest(&serde_json::to_value(self)?)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    schema_version: u32,
    skill_id: String,
    active_version: String,
    source_revision: String,
    source_digest: String,
    content_digest: String,
}

#[derive(Clone)]
pub struct SkillPackStore {
    root: PathBuf,
}
pub struct InstallPlan {
    skill_id: String,
    source: InstallationSource,
    source_digest: String,
    previous: Option<Installation>,
}
pub enum InstallBeginning {
    Complete(CommandExecution),
    Prepare(InstallPlan),
}
pub struct PreparedInstall {
    installation: Installation,
    reused: bool,
}

impl SkillPackStore {
    pub fn new(data_dir: &Path) -> Result<Self> {
        ensure!(
            data_dir.is_absolute(),
            "Core data directory must be absolute"
        );
        Ok(Self {
            root: data_dir.join("skill-packs"),
        })
    }

    pub fn list(&self, connection: &Connection) -> Result<Vec<SkillPackInstallationView>> {
        self.views(&snapshot(connection)?)
    }

    pub(crate) fn views(&self, rows: &[Installation]) -> Result<Vec<SkillPackInstallationView>> {
        rows.iter()
            .map(|row| {
                let inspection = if row.status == "installed" {
                    self.inspect(row).ok()
                } else {
                    None
                };
                Ok(SkillPackInstallationView {
                    skill_id: row.skill_id.clone(),
                    source_revision: row.source_revision.clone(),
                    status: row.status.clone(),
                    version: row.version()?,
                    availability: if row.status == "removed" {
                        "removed"
                    } else {
                        match &inspection {
                            Some((_, true)) => "available",
                            Some((_, false)) => "modified",
                            None => "unavailable",
                        }
                    },
                    content_path: inspection.map(|(path, _)| path.to_string_lossy().into_owned()),
                    retained_content: true,
                    member_delivery_enabled: false,
                })
            })
            .collect()
    }

    /// Called under the database lock; replay/precondition rejection does no IO.
    pub fn begin_install(
        &self,
        database: &mut Database,
        envelope: &CommandEnvelope<InstallSkillPackCommand>,
    ) -> Result<InstallBeginning> {
        if let Some(execution) = DomainCommandGateway.replay_if_recorded(database, envelope)? {
            return Ok(InstallBeginning::Complete(execution));
        }
        let command = &envelope.payload;
        let previous = load(database.connection(), &command.skill_id)?;
        let actual = version(previous.as_ref())?;
        let source = installation_source(&command.skill_id);
        let rejection = if !is_user(envelope) {
            Some(("skill_pack.invalid_request", json!({})))
        } else if actual != command.expected_version {
            Some(("skill_pack.version_conflict", json!({"version":actual})))
        } else if source.is_err() {
            Some((
                "skill_pack.source_not_bundled",
                json!({"skillId":command.skill_id}),
            ))
        } else if source.as_ref().unwrap().revision != command.source_revision {
            Some((
                "skill_pack.source_changed",
                json!({"sourceRevision":source.as_ref().unwrap().revision}),
            ))
        } else {
            None
        };
        if let Some((code, payload)) = rejection {
            return Ok(InstallBeginning::Complete(DomainCommandGateway.execute(
                database,
                envelope,
                |_| Ok(CommandHandlerResult::rejected(code, payload)),
            )?));
        }
        let source = source?;
        let digest = source_digest(&source)?;
        Ok(InstallBeginning::Prepare(InstallPlan {
            skill_id: command.skill_id.clone(),
            source,
            source_digest: digest,
            previous,
        }))
    }

    /// Run outside the SQLite lock on a blocking worker. A complete, private new
    /// tree remains invisible until commit_install atomically changes the row.
    pub fn prepare(&self, plan: InstallPlan) -> Result<PreparedInstall> {
        if let Some(previous) = &plan.previous
            && previous.status == "installed"
            && previous.source_revision == plan.source.revision
            && previous.source_digest == plan.source_digest
            && self.inspect(previous).is_ok_and(|(_, same)| same)
        {
            return Ok(PreparedInstall {
                installation: previous.clone(),
                reused: true,
            });
        }
        ensure!(
            plan.source.files.len() <= 512
                && plan
                    .source
                    .files
                    .iter()
                    .map(|file| file.bytes.len())
                    .sum::<usize>()
                    <= 16 * 1024 * 1024,
            "Skill package is too large"
        );
        prepare_directory(&self.root)?;
        let versions = self.root.join("versions");
        prepare_directory(&versions)?;
        let active_version = Uuid::new_v4().to_string();
        let version_root = versions.join(&active_version);
        create_directory(&version_root)?;
        let mut notices = create_private_new_file(&version_root.join("THIRD_PARTY_NOTICES.json"))?;
        notices.write_all(&serde_json::to_vec(
            &crate::codeg_skill_catalog::list()?.notices,
        )?)?;
        notices.sync_all()?;
        let content = version_root.join(&plan.skill_id);
        create_directory(&content)?;
        for file in &plan.source.files {
            ensure!(
                !file.path.is_empty()
                    && !file.path.contains(['\\', ':'])
                    && file
                        .path
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != ".."),
                "Skill package source path is invalid"
            );
            let relative = Path::new(&file.path);
            let mut directory = content.clone();
            if let Some(parent) = relative.parent() {
                for component in parent.components() {
                    directory.push(component);
                    prepare_directory(&directory)?;
                }
            }
            let destination = content.join(relative);
            let mut output = create_private_new_file(&destination)?;
            output.write_all(file.bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                output.set_permissions(fs::Permissions::from_mode(if file.executable {
                    0o700
                } else {
                    0o600
                }))?;
            }
            #[cfg(not(unix))]
            let _ = file.executable;
            output.sync_all()?;
        }
        let content_digest = inspect_installed_pack_tree(&content, &plan.skill_id)?;
        let owner = Owner {
            schema_version: 1,
            skill_id: plan.skill_id.clone(),
            active_version: active_version.clone(),
            source_revision: plan.source.revision.into(),
            source_digest: plan.source_digest.clone(),
            content_digest: content_digest.clone(),
        };
        let mut marker = create_private_new_file(&version_root.join(".rovai-skill-pack.json"))?;
        marker.write_all(&serde_json::to_vec(&owner)?)?;
        marker.sync_all()?;
        #[cfg(unix)]
        {
            fs::File::open(&content)?.sync_all()?;
            fs::File::open(&version_root)?.sync_all()?;
            fs::File::open(&versions)?.sync_all()?;
        }
        Ok(PreparedInstall {
            installation: Installation {
                skill_id: plan.skill_id,
                source_revision: plan.source.revision.into(),
                source_digest: plan.source_digest,
                active_version,
                content_digest,
                status: "installed".into(),
                generation: plan.previous.as_ref().map_or(1, |row| row.generation + 1),
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
            reused: false,
        })
    }

    pub fn commit_install(
        &self,
        database: &mut Database,
        envelope: &CommandEnvelope<InstallSkillPackCommand>,
        prepared: PreparedInstall,
    ) -> Result<CommandExecution> {
        DomainCommandGateway.execute(database,envelope,|transaction| {
            let previous=load(transaction,&envelope.payload.skill_id)?;
            let actual=version(previous.as_ref())?;
            if !is_user(envelope) || actual!=envelope.payload.expected_version {return Ok(CommandHandlerResult::rejected("skill_pack.version_conflict",json!({"version":actual})));}
            let row=&prepared.installation;
            ensure!(row.skill_id==envelope.payload.skill_id && row.source_revision==envelope.payload.source_revision,"Prepared package does not match the command");
            let (content,healthy)=self.inspect(row)?;ensure!(healthy,"Prepared Skill package content changed");
            if !prepared.reused {
                transaction.execute("INSERT INTO skill_pack_installation(skill_id,source_revision,source_digest,active_version,content_digest,status,generation,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(skill_id) DO UPDATE SET source_revision=excluded.source_revision,source_digest=excluded.source_digest,active_version=excluded.active_version,content_digest=excluded.content_digest,status=excluded.status,generation=excluded.generation,updated_at=excluded.updated_at",params![row.skill_id,row.source_revision,row.source_digest,row.active_version,row.content_digest,row.status,row.generation,row.updated_at])?;
            }
            Ok(CommandHandlerResult::applied(if prepared.reused {"skill_pack.already_current"}else{"skill_pack.installed"},json!({"skillId":row.skill_id,"version":row.version()?,"contentPath":content,"previousVersionRetained":previous.as_ref().is_some_and(|old|old.active_version!=row.active_version),"retainedVersion":previous.filter(|old|old.active_version!=row.active_version).map(|old|old.active_version),"memberDeliveryEnabled":false}),None))
        })
    }

    pub fn uninstall(
        &self,
        database: &mut Database,
        envelope: &CommandEnvelope<UninstallSkillPackCommand>,
    ) -> Result<CommandExecution> {
        DomainCommandGateway.execute(database,envelope,|transaction| {
            if !is_user(envelope) {return Ok(CommandHandlerResult::rejected("skill_pack.invalid_request",json!({})));}
            let current=load(transaction,&envelope.payload.skill_id)?;
            let actual=version(current.as_ref())?;
            if actual!=envelope.payload.expected_version {return Ok(CommandHandlerResult::rejected("skill_pack.version_conflict",json!({"version":actual})));}
            let Some(mut row)=current else {return Ok(CommandHandlerResult::rejected("skill_pack.not_installed",json!({})));};
            if row.status!="removed" {crate::skill_pack_members::clear_for_uninstall(transaction,&row.skill_id)?;row.status="removed".into();row.generation+=1;row.updated_at=chrono::Utc::now().to_rfc3339();
                transaction.execute("UPDATE skill_pack_installation SET status='removed',generation=?2,updated_at=?3 WHERE skill_id=?1",params![row.skill_id,row.generation,row.updated_at])?;}
            Ok(CommandHandlerResult::applied("skill_pack.uninstalled",json!({"skillId":row.skill_id,"version":row.version()?,"retainedContent":true,"memberDeliveryEnabled":false}),None))
        })
    }

    fn inspect(&self, row: &Installation) -> Result<(PathBuf, bool)> {
        ensure!(
            Uuid::parse_str(&row.active_version)?.to_string() == row.active_version,
            "Invalid owned package version"
        );
        ensure!(
            !row.skill_id.is_empty()
                && row
                    .skill_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)),
            "Invalid package id"
        );
        let versions = self.root.join("versions");
        let version = versions.join(&row.active_version);
        let content = version.join(&row.skill_id);
        for path in [&self.root, &versions, &version, &content] {
            admit_directory(path)?;
        }
        let mut marker = open_private_read_file(&version.join(".rovai-skill-pack.json"))?;
        ensure!(
            marker.metadata()?.len() <= 4096,
            "Skill package owner marker is too large"
        );
        let mut bytes = Vec::new();
        Read::by_ref(&mut marker)
            .take(4097)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 4096, "Skill package owner marker changed");
        let owner: Owner = serde_json::from_slice(&bytes)?;
        ensure!(
            owner.schema_version == 1
                && owner.skill_id == row.skill_id
                && owner.active_version == row.active_version
                && owner.source_revision == row.source_revision
                && owner.source_digest == row.source_digest
                && owner.content_digest == row.content_digest,
            "Skill package ownership cannot be confirmed"
        );
        let observed = inspect_installed_pack_tree(&content, &row.skill_id)?;
        Ok((content, observed == row.content_digest))
    }
}

fn row_installation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Installation> {
    Ok(Installation {
        skill_id: row.get(0)?,
        source_revision: row.get(1)?,
        source_digest: row.get(2)?,
        active_version: row.get(3)?,
        content_digest: row.get(4)?,
        status: row.get(5)?,
        generation: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
pub(crate) fn snapshot(connection: &Connection) -> Result<Vec<Installation>> {
    let mut query=connection.prepare("SELECT skill_id,source_revision,source_digest,active_version,content_digest,status,generation,updated_at FROM skill_pack_installation ORDER BY skill_id")?;
    Ok(query
        .query_map([], row_installation)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
fn load(connection: &Connection, id: &str) -> Result<Option<Installation>> {
    Ok(connection.query_row("SELECT skill_id,source_revision,source_digest,active_version,content_digest,status,generation,updated_at FROM skill_pack_installation WHERE skill_id=?1",[id],row_installation).optional()?)
}
fn version(row: Option<&Installation>) -> Result<String> {
    row.map_or(Ok("absent".into()), Installation::version)
}

pub(crate) fn member_configuration_source(
    connection: &Connection,
    id: &str,
) -> Result<Option<(String, bool)>> {
    load(connection, id)?
        .map(|row| Ok((row.version()?, row.status == "installed")))
        .transpose()
}
fn is_user<C>(envelope: &CommandEnvelope<C>) -> bool {
    matches!(envelope.actor, ActorRef::User { .. })
        && envelope.camp_id.is_none()
        && envelope.execution_epoch.is_none()
}
fn source_digest(source: &InstallationSource) -> Result<String> {
    canonical_json_digest(&json!(source.files.iter().map(|file|json!({"path":file.path,"sha256":format!("{:x}",Sha256::digest(file.bytes)),"executable":file.executable})).collect::<Vec<_>>()))
}

fn admit_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Skill package directory is not ordinary"
    );
    #[cfg(windows)]
    crate::platform::private_storage::admit_private_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Skill package directory is not private"
        );
    }
    Ok(())
}
fn prepare_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => admit_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_directory(path),
        Err(error) => Err(error.into()),
    }
}
fn create_directory(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        crate::platform::private_storage::create_private_directory(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        fs::create_dir(path)?;
    }
    admit_directory(path)
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    fn envelope<C>(payload: C) -> CommandEnvelope<C> {
        CommandEnvelope {
            command_id: Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "local_user".into(),
            },
            camp_id: None,
            expected_versions: Vec::new(),
            execution_epoch: None,
            payload,
        }
    }
    fn install_command(id: &str, expected: &str) -> CommandEnvelope<InstallSkillPackCommand> {
        envelope(InstallSkillPackCommand {
            skill_id: id.into(),
            source_revision: crate::codeg_skill_catalog::list().unwrap().commit.into(),
            expected_version: expected.into(),
        })
    }
    fn apply(
        store: &SkillPackStore,
        database: &mut Database,
        command: &CommandEnvelope<InstallSkillPackCommand>,
    ) -> CommandExecution {
        match store.begin_install(database, command).unwrap() {
            InstallBeginning::Complete(execution) => execution,
            InstallBeginning::Prepare(plan) => store
                .commit_install(database, command, store.prepare(plan).unwrap())
                .unwrap(),
        }
    }
    fn plan(
        store: &SkillPackStore,
        database: &mut Database,
        command: &CommandEnvelope<InstallSkillPackCommand>,
    ) -> InstallPlan {
        match store.begin_install(database, command).unwrap() {
            InstallBeginning::Prepare(plan) => plan,
            InstallBeginning::Complete(execution) => {
                panic!("Unexpected terminal result: {execution:?}")
            }
        }
    }
    #[test]
    fn version_publication_preserves_edits_fences_stale_commits_and_replays_across_reopen() {
        let directory =
            std::env::temp_dir().join(format!("rovai-skill-pack-store-{}", Uuid::new_v4()));
        let mut database = Database::open(&directory).unwrap();
        let store = SkillPackStore::new(&directory).unwrap();
        let mut source_changed = install_command("brainstorming", "absent");
        source_changed.payload.source_revision = "old-source".into();
        for (command, code) in [
            (source_changed, "skill_pack.source_changed"),
            (
                install_command("officecli-pptx", "absent"),
                "skill_pack.source_not_bundled",
            ),
            (
                install_command("../outside", "absent"),
                "skill_pack.source_not_bundled",
            ),
            (
                install_command("brainstorming", "stale"),
                "skill_pack.version_conflict",
            ),
        ] {
            assert_eq!(apply(&store, &mut database, &command).result.code, code);
        }
        assert!(!store.root.exists());
        let first = install_command("brainstorming", "absent");
        let interrupted = store.prepare(plan(&store, &mut database, &first)).unwrap();
        let interrupted_path = store.inspect(&interrupted.installation).unwrap().0;
        assert!(interrupted_path.exists());
        assert!(store.list(database.connection()).unwrap().is_empty());
        // No commit simulates interruption after staging; retry must not adopt it.
        let committed = apply(&store, &mut database, &first);
        assert_eq!(committed.result.code, "skill_pack.installed");
        let initial = store.list(database.connection()).unwrap().remove(0);
        assert_eq!(initial.availability, "available");
        let initial_path = PathBuf::from(initial.content_path.as_ref().unwrap());
        assert_ne!(initial_path, interrupted_path);
        let versions_before = fs::read_dir(store.root.join("versions")).unwrap().count();
        assert!(apply(&store, &mut database, &first).replayed);
        assert_eq!(
            apply(
                &store,
                &mut database,
                &install_command("brainstorming", &initial.version)
            )
            .result
            .code,
            "skill_pack.already_current"
        );
        assert_eq!(
            fs::read_dir(store.root.join("versions")).unwrap().count(),
            versions_before
        );
        let user_text = format!(
            "{}\nUser change retained\n",
            fs::read_to_string(initial_path.join("SKILL.md")).unwrap()
        );
        fs::write(initial_path.join("SKILL.md"), &user_text).unwrap();
        assert_eq!(
            store.list(database.connection()).unwrap()[0].availability,
            "modified"
        );
        let losing = install_command("brainstorming", &initial.version);
        let winning = install_command("brainstorming", &initial.version);
        let losing_prepared = store.prepare(plan(&store, &mut database, &losing)).unwrap();
        let winning_prepared = store
            .prepare(plan(&store, &mut database, &winning))
            .unwrap();
        store
            .commit_install(&mut database, &winning, winning_prepared)
            .unwrap();
        assert_eq!(
            store
                .commit_install(&mut database, &losing, losing_prepared)
                .unwrap()
                .result
                .code,
            "skill_pack.version_conflict"
        );
        assert_eq!(
            fs::read_to_string(initial_path.join("SKILL.md")).unwrap(),
            user_text
        );
        let current = store.list(database.connection()).unwrap().remove(0);
        assert_eq!(current.availability, "available");
        assert_ne!(current.version, initial.version);
        let current_path = PathBuf::from(current.content_path.as_ref().unwrap());
        let notices: serde_json::Value = serde_json::from_slice(
            &fs::read(
                current_path
                    .parent()
                    .unwrap()
                    .join("THIRD_PARTY_NOTICES.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(notices.as_array().unwrap().len(), 3);
        // Receipt failure must roll back the package pointer and all events;
        // completed but unreferenced files remain harmless, never auto-enabled.
        let failed = install_command("scientific-brainstorming", "absent");
        let prepared = store.prepare(plan(&store, &mut database, &failed)).unwrap();
        let event_count: i64 = database
            .connection()
            .query_row("SELECT count(*) FROM event_log", [], |row| row.get(0))
            .unwrap();
        database.connection().execute_batch(&format!("CREATE TRIGGER reject_pack_receipt BEFORE INSERT ON event_log WHEN NEW.event_type='command.result' AND NEW.command_id='{}' BEGIN SELECT RAISE(ABORT,'receipt failure'); END",failed.command_id)).unwrap();
        assert!(
            store
                .commit_install(&mut database, &failed, prepared)
                .is_err()
        );
        assert!(
            load(database.connection(), "scientific-brainstorming")
                .unwrap()
                .is_none()
        );
        assert!(
            DomainCommandGateway
                .replay_if_recorded(&database, &failed)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            database
                .connection()
                .query_row("SELECT count(*) FROM event_log", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            event_count
        );
        database
            .connection()
            .execute_batch("DROP TRIGGER reject_pack_receipt")
            .unwrap();
        // Uninstall must not traverse or delete an ownership-damaged tree.
        fs::write(
            current_path
                .parent()
                .unwrap()
                .join(".rovai-skill-pack.json"),
            "invalid owner",
        )
        .unwrap();
        assert_eq!(
            store.list(database.connection()).unwrap()[0].availability,
            "unavailable"
        );
        let uninstall = envelope(UninstallSkillPackCommand {
            skill_id: "brainstorming".into(),
            expected_version: current.version.clone(),
        });
        assert_eq!(
            store
                .uninstall(&mut database, &uninstall)
                .unwrap()
                .result
                .code,
            "skill_pack.uninstalled"
        );
        assert!(current_path.exists());
        let removed = store.list(database.connection()).unwrap().remove(0);
        assert_eq!(removed.availability, "removed");
        drop(database);
        let mut reopened = Database::open(&directory).unwrap();
        assert_eq!(
            store.list(reopened.connection()).unwrap()[0].version,
            removed.version
        );
        assert!(store.uninstall(&mut reopened, &uninstall).unwrap().replayed);
        assert!(interrupted_path.exists());
        assert_eq!(
            fs::read_to_string(initial_path.join("SKILL.md")).unwrap(),
            user_text
        );
        apply(
            &store,
            &mut reopened,
            &install_command("brainstorming", &removed.version),
        );
        assert_eq!(
            store.list(reopened.connection()).unwrap()[0].availability,
            "available"
        );
    }
}
