use super::{nearest_git_marker, validate_workspace_directory};
use crate::runtime_probe_process::{ProbeCommandLimits, run_bounded_command};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{collections::HashSet, path::Path, time::Duration};
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktree {
    pub project_path: String,
    pub is_main: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
    pub available: bool,
    pub branch: Option<String>,
    pub detached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktrees {
    pub schema_version: u32,
    pub requested_path: String,
    pub project_path: String,
    pub repository_root: Option<String>,
    pub main_worktree_path: Option<String>,
    pub worktrees: Vec<WorkspaceWorktree>,
}

/// Read-only topology, not a file grant or a new project registry.
pub async fn inspect_worktrees(path: &Path, data_dir: &Path) -> Result<WorkspaceWorktrees> {
    let selected = validate_workspace_directory(path, data_dir, false)?;
    let mut result = WorkspaceWorktrees {
        schema_version: 1,
        requested_path: path
            .to_str()
            .context("workspace path is not valid Unicode")?
            .to_string(),
        project_path: selected
            .to_str()
            .context("canonical workspace path is not valid Unicode")?
            .to_string(),
        repository_root: None,
        main_worktree_path: None,
        worktrees: Vec::new(),
    };
    if nearest_git_marker(&selected).is_none() {
        return Ok(result);
    }
    let root = topology_git_output(&selected, &["rev-parse", "--show-toplevel"], 64 * 1024).await?;
    let root = String::from_utf8(root).context("Git repository path is not valid Unicode")?;
    // Remove exactly the command terminator; whitespace/newlines may belong to a path.
    let root = root.strip_suffix('\n').unwrap_or(&root);
    let root = validate_workspace_directory(Path::new(root), data_dir, false)?;
    let listing = topology_git_output(
        &selected,
        &["worktree", "list", "--porcelain", "-z"],
        2 * 1024 * 1024,
    )
    .await?;
    let mut entries = parse_worktrees(&listing)?;
    for entry in &mut entries {
        entry.project_path = listed_path_representation(&entry.project_path);
        if !entry.bare && !entry.prunable {
            if let Ok(canonical) =
                validate_workspace_directory(Path::new(&entry.project_path), data_dir, false)
            {
                if let Some(path) = canonical.to_str() {
                    entry.project_path = path.to_string();
                    entry.available = true;
                }
            }
        }
    }
    let root = root
        .to_str()
        .context("canonical Git repository path is not valid Unicode")?
        .to_string();
    ensure!(
        entries
            .iter()
            .any(|entry| entry.available && entry.project_path == root),
        "Git worktree topology changed while reading"
    );
    result.repository_root = Some(root);
    result.main_worktree_path = entries
        .first()
        .filter(|entry| !entry.bare)
        .map(|entry| entry.project_path.clone());
    result.worktrees = entries;
    Ok(result)
}

async fn topology_git_output(cwd: &Path, args: &[&str], stdout_bytes: usize) -> Result<Vec<u8>> {
    let executable = crate::runtime_discovery::resolve_active_command_path("git")
        .context("Git executable is unavailable")?;
    let mut command = Command::new(executable);
    crate::runtime_discovery::configure_active_runtime_command(&mut command);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    let cwd = dunce::simplified(cwd);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(cwd)
        .args(args);
    let output = run_bounded_command(
        &mut command,
        ProbeCommandLimits {
            deadline: Duration::from_secs(10),
            stdout_bytes,
            stderr_bytes: 64 * 1024,
            cleanup_timeout: Duration::from_secs(2),
        },
    )
    .await?;
    ensure!(
        !output.stdout.truncated && !output.stderr.truncated,
        "Git topology output exceeds its capture limit"
    );
    ensure!(
        output.status.success(),
        "Git topology read failed: {}",
        output.stderr.lossy_text()
    );
    Ok(output.stdout.bytes)
}

fn listed_path_representation(path: &str) -> String {
    #[cfg(windows)]
    {
        // Missing checkouts cannot be canonicalized. Preserve their known absolute identity
        // in the same Windows representation used by persisted workspace paths.
        let path = path.replace('/', "\\");
        if path.starts_with(r"\\?\") {
            path
        } else if let Some(unc) = path.strip_prefix(r"\\") {
            format!(r"\\?\UNC\{unc}")
        } else {
            format!(r"\\?\{path}")
        }
    }
    #[cfg(not(windows))]
    path.to_string()
}

fn parse_worktrees(bytes: &[u8]) -> Result<Vec<WorkspaceWorktree>> {
    ensure!(
        bytes.len() <= 2 * 1024 * 1024 && bytes.ends_with(&[0, 0]),
        "Git worktree output is oversized or incomplete"
    );
    let text = std::str::from_utf8(bytes).context("Git worktree paths are not valid Unicode")?;
    let mut entries = Vec::new();
    let mut paths = HashSet::new();
    for record in text.split("\0\0").filter(|record| !record.is_empty()) {
        let mut fields = record.split('\0');
        let path = fields
            .next()
            .and_then(|field| field.strip_prefix("worktree "))
            .context("Git worktree record has no path")?;
        ensure!(
            Path::new(path).is_absolute() && paths.insert(path),
            "Git worktree path is relative or duplicated"
        );
        ensure!(
            entries.len() < 4096,
            "Git worktree count exceeds the metadata limit"
        );
        let mut entry = WorkspaceWorktree {
            project_path: path.to_string(),
            is_main: entries.is_empty(),
            bare: false,
            locked: false,
            prunable: false,
            available: false,
            branch: None,
            detached: false,
        };
        for field in fields {
            let label = field.split_once(' ').map_or(field, |(label, _)| label);
            match label {
                "bare" => entry.bare = true,
                "locked" => entry.locked = true,
                "prunable" => entry.prunable = true,
                "branch" => {
                    ensure!(
                        entry.branch.is_none() && !entry.detached,
                        "Git worktree has ambiguous branch metadata"
                    );
                    let branch = field
                        .strip_prefix("branch refs/heads/")
                        .filter(|branch| !branch.is_empty())
                        .context("Git worktree branch is invalid")?;
                    entry.branch = Some(branch.to_string());
                }
                "detached" => {
                    ensure!(
                        field == "detached" && entry.branch.is_none() && !entry.detached,
                        "Git worktree has ambiguous branch metadata"
                    );
                    entry.detached = true;
                }
                "worktree" => anyhow::bail!("Git worktree record separator is missing"),
                _ => {} // HEAD and future attributes do not affect folder identity.
            }
        }
        entries.push(entry);
    }
    ensure!(!entries.is_empty(), "Git worktree output is empty");
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul_records_preserve_path_characters_and_reject_incomplete_or_ambiguous_topology() {
        let base = std::env::temp_dir().join("main with space");
        let child = std::env::temp_dir().join("child\nwith newline");
        let bytes = format!(
            "worktree {}\0bare\0\0worktree {}\0HEAD 123\0detached\0locked reason\nwith newline\0prunable missing\0\0",
            base.display(),
            child.display()
        );
        let entries = parse_worktrees(bytes.as_bytes()).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_main && entries[0].bare);
        assert_eq!(entries[1].project_path, child.to_str().unwrap());
        assert!(!entries[1].is_main && entries[1].locked && entries[1].prunable);
        assert!(entries[1].detached && entries[1].branch.is_none());
        let branch = format!(
            "worktree {}\0HEAD 123\0branch refs/heads/feature/测试\0\0",
            base.display()
        );
        assert_eq!(
            parse_worktrees(branch.as_bytes()).unwrap()[0]
                .branch
                .as_deref(),
            Some("feature/测试")
        );
        for fields in [
            "branch refs/heads/\0",
            "branch refs/heads/a\0detached\0",
            "detached\0branch refs/heads/a\0",
            "branch refs/heads/a\0branch refs/heads/b\0",
        ] {
            assert!(
                parse_worktrees(format!("worktree {}\0{fields}\0", base.display()).as_bytes())
                    .is_err()
            );
        }
        for invalid in [
            String::new(),
            format!("worktree {}\0", base.display()),
            "worktree relative\0\0".to_string(),
            format!("worktree {0}\0\0worktree {0}\0\0", base.display()),
            format!("HEAD 123\0worktree {}\0\0", base.display()),
            format!("worktree {0}\0worktree {0}\0\0", base.display()),
        ] {
            assert!(parse_worktrees(invalid.as_bytes()).is_err());
        }
        assert!(parse_worktrees(b"worktree /invalid\xff\0\0").is_err());
        #[cfg(windows)]
        {
            assert_eq!(
                listed_path_representation("C:/lost checkout"),
                r"\\?\C:\lost checkout"
            );
            assert_eq!(
                listed_path_representation("//server/share/lost"),
                r"\\?\UNC\server\share\lost"
            );
        }
    }
}
