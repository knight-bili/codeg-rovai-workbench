//! Fixed Codeg Skill pack sources. Catalog reads use embedded, fixed source
//! bytes only; they do not install, discover, enable or execute a Skill.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::skill::{SkillContentFile, SkillContentView};

mod bundle {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/codeg-skill-packs/files.rs"
    ));
}

const SOURCE_REPOSITORY: &str = "https://github.com/spacering-net/codeg";
const SOURCE_COMMIT: &str = "aff1e6c278453ed8d0b96a5f664edcdca621aa3f";
const MAX_PREVIEW_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillPackFamily {
    Experts,
    Science,
    Office,
    Ui,
    Custom,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackFamilyView {
    pub family: SkillPackFamily,
    pub source_kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackNotice {
    pub name: &'static str,
    pub source_url: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackEntry {
    pub id: String,
    pub family: SkillPackFamily,
    pub category: String,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub display_name: BTreeMap<String, String>,
    pub description: BTreeMap<String, String>,
    pub featured: bool,
    pub accent: Option<String>,
    pub needs_key: bool,
    pub needs_env: bool,
    pub source_path: String,
    pub source_url: String,
    pub content_source: &'static str,
    pub required_capability: Option<&'static str>,
    pub load_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackCatalogView {
    pub schema_version: u32,
    pub repository: &'static str,
    pub commit: &'static str,
    pub families: Vec<SkillPackFamilyView>,
    pub entries: Vec<SkillPackEntry>,
    pub notices: Vec<SkillPackNotice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadSkillPackParams {
    pub skill_id: String,
    #[serde(default = "default_manifest_path")]
    pub path: String,
}

fn default_manifest_path() -> String {
    "SKILL.md".into()
}

#[derive(Debug, Deserialize)]
struct MetadataEntry {
    id: String,
    category: String,
    icon: Option<String>,
    #[serde(default)]
    sort_order: i32,
    #[serde(default)]
    display_name: BTreeMap<String, String>,
    #[serde(default)]
    description: BTreeMap<String, String>,
    #[serde(default)]
    featured: bool,
    accent: Option<String>,
    #[serde(default)]
    needs_key: bool,
    #[serde(default)]
    needs_env: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfficeEntry {
    id: String,
    load_id: String,
    category: String,
    icon: String,
    sort_order: i32,
    display_name: BTreeMap<String, String>,
    description: BTreeMap<String, String>,
}

fn file_bytes(path: &str) -> Result<&'static [u8]> {
    bundle::FILES
        .iter()
        .find(|(name, _)| *name == path)
        .map(|(_, bytes)| *bytes)
        .context("Skill pack source file is unavailable")
}

fn source_url(path: &str) -> String {
    format!("{SOURCE_REPOSITORY}/blob/{SOURCE_COMMIT}/{path}")
}

pub(crate) struct InstallationFile {
    pub path: String,
    pub bytes: &'static [u8],
    pub executable: bool,
}

pub(crate) struct InstallationSource {
    pub revision: &'static str,
    pub files: Vec<InstallationFile>,
}

pub(crate) fn installation_source(id: &str) -> Result<InstallationSource> {
    use sha2::{Digest, Sha256};
    let entry = catalog()?
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .context("Skill pack entry is unavailable")?;
    ensure!(
        entry.content_source == "embedded",
        "Skill pack content is not bundled"
    );
    let prefix = entry
        .source_path
        .strip_prefix("src-tauri/")
        .and_then(|path| path.strip_suffix("SKILL.md"))
        .context("Skill pack source is invalid")?;
    let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/codeg-skill-packs/manifest.json"
    )))?;
    let mut files = Vec::new();
    for record in manifest["files"]
        .as_array()
        .context("Skill pack manifest is invalid")?
    {
        let path = record["path"]
            .as_str()
            .context("Skill pack source path is missing")?;
        if let Some(relative) = path.strip_prefix(prefix) {
            let bytes = file_bytes(path)?;
            ensure!(
                record["sha256"] == format!("{:x}", Sha256::digest(bytes)),
                "Skill pack source digest changed"
            );
            files.push(InstallationFile {
                path: relative.into(),
                bytes,
                executable: record["mode"] == "100755",
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    ensure!(
        files.iter().any(|file| file.path == "SKILL.md"),
        "Skill pack manifest has no guide"
    );
    Ok(InstallationSource {
        revision: SOURCE_COMMIT,
        files,
    })
}

fn metadata_entries(path: &str, key: &str, family: SkillPackFamily) -> Result<Vec<SkillPackEntry>> {
    let source: toml::Value = toml::from_str(std::str::from_utf8(file_bytes(path)?)?)?;
    let entries: Vec<MetadataEntry> = source
        .get(key)
        .context("Skill pack metadata is missing")?
        .clone()
        .try_into()?;
    entries
        .into_iter()
        .map(|entry| {
            let prefix = match family {
                SkillPackFamily::Experts => "experts",
                SkillPackFamily::Science => "science",
                _ => bail!("Invalid bundled family"),
            };
            let source_path = format!("src-tauri/{prefix}/skills/{}/SKILL.md", entry.id);
            file_bytes(source_path.strip_prefix("src-tauri/").unwrap())?;
            Ok(SkillPackEntry {
                id: entry.id,
                family,
                category: entry.category,
                icon: entry.icon,
                sort_order: entry.sort_order,
                display_name: entry.display_name,
                description: entry.description,
                featured: entry.featured,
                accent: entry.accent,
                needs_key: entry.needs_key,
                needs_env: entry.needs_env,
                source_url: source_url(&source_path),
                source_path,
                content_source: "embedded",
                required_capability: None,
                load_id: None,
            })
        })
        .collect()
}

fn build_catalog() -> Result<SkillPackCatalogView> {
    let mut entries = metadata_entries("experts/experts.toml", "expert", SkillPackFamily::Experts)?;
    entries.extend(metadata_entries(
        "science/science.toml",
        "skill",
        SkillPackFamily::Science,
    )?);
    let office: Vec<OfficeEntry> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/resources/codeg-skill-packs/office.json"
    )))?;
    for entry in office {
        let source_path = "src-tauri/src/commands/office_tools.rs".to_string();
        entries.push(SkillPackEntry {
            id: entry.id,
            family: SkillPackFamily::Office,
            category: entry.category,
            icon: Some(entry.icon),
            sort_order: entry.sort_order,
            display_name: entry.display_name,
            description: entry.description,
            featured: false,
            accent: None,
            needs_key: false,
            needs_env: true,
            source_url: source_url(&source_path),
            source_path,
            content_source: "officecli",
            required_capability: Some("officecli"),
            load_id: Some(entry.load_id),
        });
    }
    let ui_path = "src-tauri/genui/ui-render/SKILL.md";
    let ui = std::str::from_utf8(file_bytes("genui/ui-render/SKILL.md")?)?;
    let frontmatter = ui
        .strip_prefix("---\n")
        .and_then(|x| x.split_once("\n---").map(|(frontmatter, _)| frontmatter))
        .context("UI Skill frontmatter is missing")?;
    let frontmatter: serde_yaml::Value = serde_yaml::from_str(frontmatter)?;
    let description = frontmatter
        .get("description")
        .and_then(|x| x.as_str())
        .context("UI Skill description is missing")?;
    entries.push(SkillPackEntry {
        id: "ui-render".into(),
        family: SkillPackFamily::Ui,
        category: "interactive_ui".into(),
        icon: None,
        sort_order: 0,
        display_name: BTreeMap::from([
            ("en".into(), "Interactive UI".into()),
            ("zh-CN".into(), "交互式卡片".into()),
        ]),
        description: BTreeMap::from([("en".into(), description.into())]),
        featured: false,
        accent: None,
        needs_key: false,
        needs_env: false,
        source_path: ui_path.into(),
        source_url: source_url(ui_path),
        content_source: "embedded",
        required_capability: Some("generative_ui_renderer"),
        load_id: None,
    });
    let mut ids = BTreeSet::new();
    for entry in &entries {
        ensure!(
            !entry.id.is_empty()
                && entry.id.len() <= 64
                && entry
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c)),
            "Invalid bundled Skill id"
        );
        ensure!(
            ids.insert(entry.id.clone()),
            "Bundled Skill ids must have one source owner"
        );
    }
    entries.sort_by(|a, b| {
        a.family
            .cmp(&b.family)
            .then(a.sort_order.cmp(&b.sort_order))
            .then(a.id.cmp(&b.id))
    });
    Ok(SkillPackCatalogView {
        schema_version: 1,
        repository: SOURCE_REPOSITORY,
        commit: SOURCE_COMMIT,
        families: vec![
            SkillPackFamilyView {
                family: SkillPackFamily::Experts,
                source_kind: "embedded",
            },
            SkillPackFamilyView {
                family: SkillPackFamily::Science,
                source_kind: "embedded",
            },
            SkillPackFamilyView {
                family: SkillPackFamily::Office,
                source_kind: "officecli",
            },
            SkillPackFamilyView {
                family: SkillPackFamily::Ui,
                source_kind: "embedded",
            },
            SkillPackFamilyView {
                family: SkillPackFamily::Custom,
                source_kind: "user_authored",
            },
        ],
        entries,
        notices: vec![
            SkillPackNotice {name:"Codeg Apache-2.0",source_url:source_url("LICENSE"),content:std::str::from_utf8(file_bytes("LICENSE")?)?.to_owned()},
            SkillPackNotice {name:"Scientific Research Skills MIT",source_url:source_url("src-tauri/science/NOTICE.md"),content:std::str::from_utf8(file_bytes("science/NOTICE.md")?)?.to_owned()},
            SkillPackNotice {name:"Superpowers MIT",source_url:"https://github.com/obra/superpowers/blob/b36e0829c6d0140e93cfef2ca599b1b07d4a7797/LICENSE".into(),content:include_str!(concat!(env!("CARGO_MANIFEST_DIR"),"/../../integration/licenses/superpowers/LICENSE")).to_owned()},
        ],
    })
}

fn catalog() -> Result<&'static SkillPackCatalogView> {
    static CATALOG: OnceLock<Result<SkillPackCatalogView, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| build_catalog().map_err(|error| format!("{error:#}")))
        .as_ref()
        .map_err(|error| anyhow::anyhow!(error.clone()))
}

pub fn list() -> Result<SkillPackCatalogView> {
    Ok(catalog()?.clone())
}

pub fn read(params: &ReadSkillPackParams) -> Result<SkillContentView> {
    let entry = catalog()?
        .entries
        .iter()
        .find(|entry| entry.id == params.skill_id)
        .context("Skill pack entry is unavailable")?;
    ensure!(
        entry.content_source == "embedded",
        "Skill pack content requires OfficeCLI and is not bundled"
    );
    ensure!(
        !params.path.is_empty()
            && !params.path.contains(['\\', ':'])
            && params
                .path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "Skill pack file path is invalid"
    );
    let source = entry
        .source_path
        .strip_prefix("src-tauri/")
        .context("Skill pack source is invalid")?;
    let prefix = source
        .strip_suffix("SKILL.md")
        .context("Skill pack source is invalid")?;
    let mut files: Vec<_> = bundle::FILES
        .iter()
        .filter_map(|(name, bytes)| {
            name.strip_prefix(prefix).map(|path| SkillContentFile {
                path: path.into(),
                bytes: bytes.len() as u64,
            })
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    ensure!(
        files.iter().any(|file| file.path == params.path),
        "Skill pack file is unavailable"
    );
    let bytes = file_bytes(&format!("{prefix}{}", params.path))?;
    let (status, content) = if bytes.len() > MAX_PREVIEW_BYTES {
        ("too_large", None)
    } else if bytes.contains(&0) {
        ("binary", None)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(text) => ("text", Some(text.to_owned())),
            Err(_) => ("binary", None),
        }
    };
    Ok(SkillContentView {
        path: params.path.clone(),
        content,
        status,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    // New source/provenance owner: no database, files, Home or Runtime fixture.
    #[test]
    fn catalog_preserves_pinned_sources_and_bounds_content_reads() {
        let catalog = list().unwrap();
        assert_eq!(catalog.entries.len(), 37);
        for (family, count) in [
            (SkillPackFamily::Experts, 14),
            (SkillPackFamily::Science, 13),
            (SkillPackFamily::Office, 9),
            (SkillPackFamily::Ui, 1),
        ] {
            assert_eq!(
                catalog
                    .entries
                    .iter()
                    .filter(|entry| entry.family == family)
                    .count(),
                count
            );
        }
        assert_eq!(catalog.families.len(), 5);
        assert_eq!(catalog.notices.len(), 3);
        assert!(
            catalog
                .notices
                .iter()
                .all(|notice| !notice.content.is_empty())
        );
        let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/resources/codeg-skill-packs/manifest.json"
        )))
        .unwrap();
        assert_eq!(manifest["commit"], SOURCE_COMMIT);
        assert_eq!(manifest["repository"], SOURCE_REPOSITORY);
        let records = manifest["files"].as_array().unwrap();
        assert_eq!(records.len(), bundle::FILES.len());
        for file in records {
            let bytes = file_bytes(file["path"].as_str().unwrap()).unwrap();
            assert_eq!(file["bytes"].as_u64().unwrap(), bytes.len() as u64);
            assert_eq!(file["sha256"], format!("{:x}", Sha256::digest(bytes)));
        }
        for entry in &catalog.entries {
            let request = ReadSkillPackParams {
                skill_id: entry.id.clone(),
                path: "SKILL.md".into(),
            };
            if entry.family == SkillPackFamily::Office {
                assert!(read(&request).is_err());
                assert!(installation_source(&entry.id).is_err());
                assert!(entry.load_id.is_some());
                continue;
            }
            let preview = read(&request).unwrap();
            let source = installation_source(&entry.id).unwrap();
            assert_eq!(source.revision, SOURCE_COMMIT);
            assert_eq!(source.files.len(), preview.files.len());
            assert_eq!(preview.status, "text");
            assert!(preview.content.unwrap().starts_with("---"));
            assert!(preview.files.iter().any(|file| file.path == "SKILL.md"));
        }
        for bad in [
            "../SKILL.md",
            "/SKILL.md",
            "C:/SKILL.md",
            "./SKILL.md",
            "scripts/../SKILL.md",
            "SKILL.md/",
            "..\\SKILL.md",
            "SKILL.md:secret",
            "unknown.md",
        ] {
            assert!(
                read(&ReadSkillPackParams {
                    skill_id: "brainstorming".into(),
                    path: bad.into()
                })
                .is_err(),
                "{bad}"
            );
        }
        assert!(
            read(&ReadSkillPackParams {
                skill_id: "../science/skills/scientific-writing".into(),
                path: "SKILL.md".into()
            })
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReadSkillPackParams>(
                serde_json::json!({"skillId":"ui-render","absolutePath":"C:/private"})
            )
            .is_err()
        );
        let scientific = catalog
            .entries
            .iter()
            .find(|entry| entry.id == "scientific-brainstorming")
            .unwrap();
        assert!(!scientific.display_name.is_empty());
        assert!(!scientific.description.is_empty());
        let ui = catalog
            .entries
            .iter()
            .find(|entry| entry.id == "ui-render")
            .unwrap();
        assert_eq!(ui.required_capability, Some("generative_ui_renderer"));
    }
}
