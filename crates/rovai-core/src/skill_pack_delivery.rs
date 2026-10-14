//! Preparation facts for one receiving member. This is ephemeral: the final
//! Dynamic Context Blob remains the only frozen model-input authority.
use std::{collections::BTreeMap, path::Path};

use anyhow::Result;
use rusqlite::Connection;
use serde_json::json;

use crate::skill_pack_installation::{
    SkillPackModelSource, SkillPackStore, member_configuration_source,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PackUnavailable {
    NotSelected,
    NotInstalled,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PackObservation {
    selected: bool,
    installation_version: Option<String>,
    source: Result<SkillPackModelSource, PackUnavailable>,
}

/// Includes failed observations so a write-transaction recheck can detect an
/// update/selection change even when the package was previously unavailable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedMemberSkillPacks {
    agent_id: String,
    observations: BTreeMap<String, PackObservation>,
}

impl PreparedMemberSkillPacks {
    pub(crate) fn prepare<'a>(
        connection: &Connection,
        data_dir: &Path,
        agent_id: &str,
        requested_ids: impl IntoIterator<Item = &'a str>,
    ) -> Result<Self> {
        let selected = connection.prepare(
            "SELECT choice.skill_id FROM member_skill_pack AS choice \
             JOIN agent_profile AS member ON member.id=choice.agent_id \
             WHERE choice.agent_id=?1 AND member.profile_status<>'removed' ORDER BY choice.skill_id",
        )?.query_map([agent_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // The map stores identities, never paths supplied by a message. A
        // malformed pack identity is safe to look up as a bound SQLite value;
        // it never reaches the filesystem unless an owned installation exists.
        let mut choices = BTreeMap::new();
        for id in requested_ids {
            if let Some(name) = id.strip_prefix("pack:") {
                choices.insert(name.to_owned(), false);
            }
        }
        for id in selected {
            choices.insert(id, true);
        }
        let store = SkillPackStore::new(data_dir)?;
        let mut observations = BTreeMap::new();
        for (id, selected) in choices {
            let installation = member_configuration_source(connection, &id)?;
            let source = if !installation
                .as_ref()
                .is_some_and(|(_, installed)| *installed)
            {
                Err(PackUnavailable::NotInstalled)
            } else if !selected {
                Err(PackUnavailable::NotSelected)
            } else {
                match store.model_source(connection, &id) {
                    Ok(Some(source))
                        if installation
                            .as_ref()
                            .is_some_and(|(version, _)| version == &source.source_version) =>
                    {
                        Ok(source)
                    }
                    Ok(Some(_)) => Err(PackUnavailable::Changed),
                    Ok(None) => Err(PackUnavailable::NotInstalled),
                    Err(_) => Err(PackUnavailable::Changed),
                }
            };
            observations.insert(
                format!("pack:{id}"),
                PackObservation {
                    selected,
                    installation_version: installation.map(|(version, _)| version),
                    source,
                },
            );
        }
        Ok(Self {
            agent_id: agent_id.to_owned(),
            observations,
        })
    }

    pub(crate) fn ensure_member(&self, agent_id: &str) -> Result<()> {
        anyhow::ensure!(
            self.agent_id == agent_id,
            "Skill package preparation belongs to another member"
        );
        Ok(())
    }

    pub(crate) fn source(&self, id: &str) -> Result<&SkillPackModelSource, PackUnavailable> {
        self.observations
            .get(id)
            .map_or(Err(PackUnavailable::NotSelected), |entry| {
                entry.source.as_ref().map_err(|reason| *reason)
            })
    }

    pub(crate) fn sources(&self) -> impl Iterator<Item = &SkillPackModelSource> {
        self.observations
            .values()
            .filter_map(|entry| entry.source.as_ref().ok())
    }

    pub(crate) fn section(&self) -> Result<String> {
        let skills = self
            .sources()
            .map(|source| {
                json!({
                    "id":source.id,"name":source.name,"desc":source.desc,"path":source.path,
                })
            })
            .collect::<Vec<_>>();
        Ok(format!(
            "[ROVAI_SKILL_PACKS]\nCurrent for this run; replaces any earlier Rovai Skill Packs.\n{}\n[/ROVAI_SKILL_PACKS]",
            serde_json::to_string(&json!({"skills":skills}))?,
        ))
    }

    pub(crate) fn omissions(&self) -> Vec<String> {
        self.observations
            .iter()
            .filter_map(|(id, entry)| {
                if !entry.selected {
                    return None;
                }
                let reason = match entry.source.as_ref().err()? {
                    PackUnavailable::NotSelected => "pack_not_selected",
                    PackUnavailable::NotInstalled => "pack_not_installed",
                    PackUnavailable::Changed => "pack_changed",
                };
                Some(format!("{id}:{reason}"))
            })
            .collect()
    }
}
