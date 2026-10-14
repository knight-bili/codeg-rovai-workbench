use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Mutex,
    task::JoinHandle,
};

use crate::{
    managed_process::{
        ManagedProcess, ManagedProcessLaunchSpec, ManagedProcessPurpose, ManagedStdinPolicy,
        ManagedWindowsArgvDialect,
    },
    mcp::McpServerDefinition,
    platform::private_storage::{
        atomic_write_private_bytes, atomic_write_private_json, prepare_private_directory,
    },
    runtime_probe_process::{ProbeCommandLimits, run_bounded_managed_process},
};

pub(crate) const PERMISSION_MODES: [&str; 4] = ["read-only", "guarded", "workspace", "full"];

/// A companion owned by the same Fleet Host as ACP, never a separate pool.
/// Native state is scoped to the persistent Core NativeBinding directory.
pub(crate) struct OpenClawGateway {
    child: Arc<Mutex<ManagedProcess>>,
    launch: ManagedProcessLaunchSpec,
    entrypoint: PathBuf,
    #[cfg(windows)]
    control_script: Option<(PathBuf, String)>,
    entrypoint_fingerprint: String,
    readers: Vec<JoinHandle<()>>,
    alive: Arc<AtomicBool>,
    token: String,
    pub(crate) session_key: String,
}

fn drain<R: AsyncRead + Unpin + Send + 'static>(mut reader: R) -> JoinHandle<()> {
    tokio::spawn(async move {
        // Gateway logs may contain provider diagnostics. They must not enter
        // public Runtime events, prompts or persisted Core diagnostics.
        let mut bytes = [0; 8192];
        while matches!(reader.read(&mut bytes).await, Ok(n) if n > 0) {}
    })
}

fn native_config_source(launch: &ManagedProcessLaunchSpec) -> Result<(Value, PathBuf)> {
    let home = ["OPENCLAW_HOME", "USERPROFILE", "HOME"]
        .into_iter()
        .find_map(|key| {
            launch
                .environment_value(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .context("OpenClaw native Home is unavailable")?;
    let state = launch
        .environment_value("OPENCLAW_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".openclaw"));
    ensure!(
        state.is_absolute(),
        "OpenClaw native state path must be absolute"
    );
    let explicit = launch
        .environment_value("OPENCLAW_CONFIG_PATH")
        .map(PathBuf::from);
    let config = explicit
        .clone()
        .unwrap_or_else(|| state.join("openclaw.json"));
    ensure!(
        config.is_absolute(),
        "OpenClaw native config path must be absolute"
    );
    let value = match std::fs::read_to_string(&config) {
        Ok(text) => json5::from_str::<Value>(&text)
            .map_err(|_| anyhow::anyhow!("OpenClaw native config is invalid JSON5"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && explicit.is_none() => {
            json!({})
        }
        Err(_) => bail!("OpenClaw native config is unavailable"),
    };
    ensure!(
        value.is_object(),
        "OpenClaw native config must be an object"
    );
    ensure!(
        value.get("$include").is_none(),
        "OpenClaw included config requires native source resolution before launch"
    );
    Ok((value, state))
}

fn canonical_agent_id(value: &str) -> Result<String> {
    let value = value.trim();
    // Match the native declared-agent grammar, without turning malformed or
    // path-bearing input into another existing owner through slug fallback.
    ensure!(
        !value.is_empty()
            && value.len() <= 64
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "OpenClaw native agent identity is invalid"
    );
    Ok(value.to_ascii_lowercase())
}

fn assign_session_key(agent_id: &str, binding_id: &str) -> Result<String> {
    let agent_id = canonical_agent_id(agent_id)?;
    ensure!(
        !binding_id.is_empty()
            && binding_id.len() <= 128
            && binding_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "OpenClaw managed binding identity is invalid"
    );
    Ok(format!("agent:{agent_id}:rovai:{binding_id}"))
}

fn prepare_configuration(
    mut config: Value,
    origin_state: &Path,
    workspace: &Path,
    port: u16,
    selected_agent: Option<&str>,
    servers: &BTreeMap<String, McpServerDefinition>,
) -> Result<(Value, String)> {
    ensure!(
        workspace.is_absolute(),
        "OpenClaw workspace must be absolute"
    );
    let entries = config.pointer("/agents/entries");
    let list = config.pointer("/agents/list");
    ensure!(
        entries.is_none() || list.is_none(),
        "OpenClaw native agent roster cannot contain both entries and list"
    );
    let mut ids = Vec::new();
    if let Some(entries) = entries {
        for (id, entry) in entries
            .as_object()
            .context("OpenClaw agents.entries must be an object")?
        {
            ensure!(
                entry.is_object(),
                "OpenClaw native agent entry must be an object"
            );
            ids.push(id.as_str());
        }
    }
    if let Some(list) = list {
        for entry in list
            .as_array()
            .context("OpenClaw agents.list must be an array")?
        {
            ids.push(
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .context("OpenClaw native agent list entry requires an id")?,
            );
        }
    }
    let mut canonical = std::collections::BTreeSet::new();
    for id in &ids {
        ensure!(
            canonical.insert(canonical_agent_id(id)?),
            "OpenClaw native agent roster contains duplicate identities"
        );
    }
    let agent = if let Some(agent) = selected_agent {
        let agent = canonical_agent_id(agent)?;
        ensure!(
            ids.is_empty() || canonical.contains(&agent),
            "OpenClaw selected native agent is absent from its configuration"
        );
        agent
    } else {
        match ids.len() {
            0 => "main".to_owned(),
            1 => canonical_agent_id(ids[0])?,
            _ => bail!("OpenClaw native_agent_id must select one configured native agent"),
        }
    };
    assign_session_key(&agent, "validation")?;
    // The read compatibility layer accepts list, but the pinned launch schema
    // accepts only keyed entries. Translate only the managed copy; the source
    // file, labels and provider/model settings remain owned by the native profile.
    let mut managed_entries = serde_json::Map::new();
    if let Some(list) = list {
        for entry in list.as_array().unwrap() {
            let mut entry = entry
                .as_object()
                .context("OpenClaw native agent list entry must be an object")?
                .clone();
            let raw_id = entry
                .remove("id")
                .and_then(|value| value.as_str().map(str::to_owned))
                .context("OpenClaw native agent id missing")?;
            let id = canonical_agent_id(&raw_id)?;
            entry.remove("default"); // The legacy flag is not a launch-schema property.
            managed_entries.insert(id, Value::Object(entry));
        }
    } else if let Some(entries) = entries {
        for (id, entry) in entries.as_object().unwrap() {
            managed_entries.insert(canonical_agent_id(id)?, entry.clone());
        }
    }
    let root = config
        .as_object_mut()
        .context("OpenClaw config must be an object")?;
    root.insert("gateway".into(), json!({"mode":"local","port":port,"bind":"loopback","auth":{"mode":"token"},"controlUi":{"enabled":false}}));
    // Core, rather than the native Gateway, owns channels and scheduling.
    root.insert("channels".into(), json!({}));
    root.insert("hooks".into(), json!({"enabled":false}));
    root.insert(
        "cron".into(),
        json!({"enabled":false,"triggers":{"enabled":false}}),
    );
    root.insert(
        "update".into(),
        json!({"checkOnStart":false,"auto":{"enabled":false}}),
    );
    root.insert("discovery".into(), json!({"mdns":{"mode":"off"}}));
    root.insert("browser".into(), json!({"enabled":false}));
    let agents = root
        .entry("agents")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("OpenClaw agents must be an object")?;
    let defaults = agents
        .entry("defaults")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("OpenClaw agent defaults must be an object")?;
    defaults.insert("workspace".into(), json!(workspace));
    defaults.insert("heartbeat".into(), json!({"every":"0m"}));
    agents.remove("list");
    agents.insert("entries".into(), Value::Object(managed_entries));
    let entry = agents
        .get_mut("entries")
        .and_then(Value::as_object_mut)
        .unwrap()
        .entry(agent.clone())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("OpenClaw agent entry must be an object")?;
    entry.insert("workspace".into(), json!(workspace));
    entry.insert("heartbeat".into(), json!({"every":"0m"}));
    // Native agentDir also owns mutable SQLite state, not only authentication.
    // Until the isolated auth/profile importer is implemented, refuse to bind
    // a user's existing store into a Core-owned Gateway.
    let native_agent_dir = origin_state.join("agents").join(&agent).join("agent");
    ensure!(
        !entry.contains_key("agentDir") && !native_agent_dir.exists(),
        "OpenClaw native auth/store requires isolated profile import before managed launch"
    );
    let mcp = root
        .entry("mcp")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("OpenClaw MCP must be an object")?;
    let native_servers = mcp
        .entry("servers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("OpenClaw MCP servers must be an object")?;
    for (name, definition) in servers {
        ensure!(name != "__proto__", "OpenClaw reserved MCP server name");
        let value = match definition {
            McpServerDefinition::Stdio {
                command,
                args,
                cwd,
                env,
            } => {
                let mut value = json!({"command":command,"args":args,"env":env,"enabled":true});
                if let Some(cwd) = cwd {
                    value["cwd"] = json!(cwd)
                }
                value
            }
            McpServerDefinition::StreamableHttp { url, headers } => {
                json!({"url":url,"transport":"streamable-http","headers":headers,"enabled":true})
            }
        };
        native_servers.insert(name.clone(), value);
    }
    Ok((config, agent))
}

pub(crate) fn validate_session_ack(
    result: &Value,
    key: &str,
    permission: &str,
    model: Option<&str>,
) -> Result<()> {
    ensure!(
        result["ok"] == true && result["key"] == key,
        "OpenClaw Gateway acknowledged another native Session"
    );
    ensure!(
        result
            .pointer("/entry/permissionMode")
            .and_then(Value::as_str)
            == Some(permission),
        "OpenClaw Gateway did not confirm the frozen permission mode"
    );
    if let Some(model) = model {
        let provider = result
            .pointer("/resolved/modelProvider")
            .and_then(Value::as_str)
            .context("OpenClaw Gateway omitted the resolved Provider")?;
        let id = result
            .pointer("/resolved/model")
            .and_then(Value::as_str)
            .context("OpenClaw Gateway omitted the resolved model")?;
        ensure!(
            format!("{provider}/{id}") == model,
            "OpenClaw Gateway selected another model route"
        );
    }
    Ok(())
}

impl OpenClawGateway {
    pub(crate) async fn start(
        acp_command: &mut Command,
        workspace: &Path,
        binding_root: &Path,
        selected_agent: Option<&str>,
        servers: &BTreeMap<String, McpServerDefinition>,
    ) -> Result<Self> {
        // application() is cmd.exe for a Windows npm shim. Keep the admitted
        // product entrypoint when deriving Gateway and control commands.
        let entrypoint = PathBuf::from(acp_command.as_std().get_program());
        let entrypoint_fingerprint =
            crate::agent_runtime_adapter::executable_fingerprint(&entrypoint)?;
        #[cfg(windows)]
        let control_script =
            if crate::windows_runtime_entrypoint::command_shim_extension(&entrypoint).is_some() {
                let script =
                    crate::runtime_discovery_windows::inspect_openclaw_cmd_shim(&entrypoint)
                        .context(
                            "OpenClaw control requires a verified npm/pnpm package entrypoint",
                        )?;
                let fingerprint = crate::agent_runtime_adapter::executable_fingerprint(&script)?;
                Some((script, fingerprint))
            } else {
                None
            };
        let original = ManagedProcessLaunchSpec::capture(
            acp_command,
            ManagedProcessPurpose::RuntimeHost,
            ManagedStdinPolicy::Piped,
            ManagedWindowsArgvDialect::MicrosoftCrt,
            "openclaw-native-source",
        )?;
        let (base, origin_state) = native_config_source(&original)?;
        let binding_id = binding_root
            .file_name()
            .and_then(|s| s.to_str())
            .context("OpenClaw NativeBinding directory is invalid")?;
        prepare_private_directory(binding_root)?;
        let state = prepare_private_directory(&binding_root.join("state"))?;
        let reserved = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        let port = reserved.local_addr()?.port();
        let (config, agent) = prepare_configuration(
            base,
            &origin_state,
            workspace,
            port,
            selected_agent,
            servers,
        )?;
        let session_key = assign_session_key(&agent, binding_id)?;
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("OpenClaw Gateway token generation failed"))?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let config_path = binding_root.join("openclaw.json");
        let token_path = binding_root.join("gateway-token");
        atomic_write_private_json(&config_path, &config)?;
        atomic_write_private_bytes(&token_path, token.as_bytes())?;
        acp_command
            .env("OPENCLAW_STATE_DIR", &state)
            .env("OPENCLAW_CONFIG_PATH", &config_path)
            .env("OPENCLAW_GATEWAY_TOKEN", &token)
            .env_remove("OPENCLAW_GATEWAY_URL")
            .env("OPENCLAW_GATEWAY_PORT", port.to_string())
            .env("OPENCLAW_NO_AUTO_UPDATE", "1")
            .env("NODE_DISABLE_COMPILE_CACHE", "1");
        let frozen = ManagedProcessLaunchSpec::capture(
            acp_command,
            ManagedProcessPurpose::RuntimeHost,
            ManagedStdinPolicy::Piped,
            ManagedWindowsArgvDialect::MicrosoftCrt,
            "openclaw-companion-template",
        )?;
        let mut gateway_command = Command::new(&entrypoint);
        gateway_command.env_clear();
        // LaunchSpec captures ambient keys before command overlays. Explicit
        // removals preserve the exact admitted environment on both platforms.
        for (key, _) in std::env::vars_os() {
            gateway_command.env_remove(key);
        }
        gateway_command
            .envs(frozen.environment())
            .current_dir(workspace)
            .args([
                "gateway",
                "run",
                "--bind",
                "loopback",
                "--port",
                &port.to_string(),
            ]);
        let launch = ManagedProcessLaunchSpec::capture(
            &gateway_command,
            ManagedProcessPurpose::RuntimeHost,
            ManagedStdinPolicy::Null,
            ManagedWindowsArgvDialect::MicrosoftCrt,
            "openclaw-owned-gateway",
        )?;
        drop(reserved);
        let mut child = ManagedProcess::spawn(launch.clone())?;
        #[cfg(target_os = "macos")]
        child.track_descendants(&binding_root.join("gateway-owned-processes"))?;
        let mut readers = vec![
            drain(
                child
                    .take_stdout()
                    .context("OpenClaw Gateway stdout unavailable")?,
            ),
            drain(
                child
                    .take_stderr()
                    .context("OpenClaw Gateway stderr unavailable")?,
            ),
        ];
        let child = Arc::new(Mutex::new(child));
        let alive = Arc::new(AtomicBool::new(true));
        let watched = child.clone();
        let running = alive.clone();
        readers.push(tokio::spawn(async move {
            while running.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if !matches!(watched.lock().await.try_wait(), Ok(None)) {
                    running.store(false, Ordering::Release);
                    break;
                }
            }
        }));
        let gateway = Self {
            child,
            launch,
            entrypoint,
            entrypoint_fingerprint,
            #[cfg(windows)]
            control_script,
            readers,
            alive,
            token,
            session_key,
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()?;
        let ready = async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                ensure!(
                    gateway.child.lock().await.try_wait()?.is_none(),
                    "OpenClaw Gateway exited before readiness"
                );
                if let Ok(response) = client
                    .get(format!("http://127.0.0.1:{port}/readyz"))
                    .send()
                    .await
                    && response.status().is_success()
                {
                    break;
                }
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "OpenClaw Gateway readiness timed out"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            // HTTP liveness alone does not authenticate the owned endpoint.
            gateway.call("health", json!({})).await?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = ready {
            gateway.shutdown().await;
            return Err(error);
        }
        acp_command
            .args([
                "acp",
                "--url",
                &format!("ws://127.0.0.1:{port}"),
                "--token-file",
            ])
            .arg(token_path);
        Ok(gateway)
    }

    pub(crate) fn configure_session_request(&self, params: &mut Value, existing: bool) {
        params["mcpServers"] = json!([]);
        params["_meta"] = json!({"sessionKey":self.session_key,"requireExistingSession":existing,"prefixCwd":false});
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(crate) fn redact_text(&self, text: &str) -> String {
        text.replace(&self.token, "[redacted]")
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        ensure!(
            matches!(
                method,
                "health" | "models.list" | "sessions.patch" | "sessions.resolve"
            ),
            "OpenClaw Gateway method is outside the adapter control surface"
        );
        ensure!(
            crate::agent_runtime_adapter::executable_fingerprint(&self.entrypoint)?
                == self.entrypoint_fingerprint,
            "OpenClaw entrypoint changed during its Host lease"
        );
        let arguments = [
            "gateway".to_owned(),
            "call".into(),
            method.into(),
            "--json".into(),
            "--timeout".into(),
            "15000".into(),
            "--params".into(),
            serde_json::to_string(&params)?,
        ]
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
        let entrypoint = self.entrypoint.clone().into_os_string();
        #[cfg(windows)]
        let (entrypoint, arguments) = if let Some((script, fingerprint)) = &self.control_script {
            ensure!(
                crate::agent_runtime_adapter::executable_fingerprint(script)? == *fingerprint,
                "OpenClaw control script changed during its Host lease"
            );
            let mut arguments = arguments;
            arguments.insert(0, script.as_os_str().to_owned());
            let adjacent_node = self
                .entrypoint
                .parent()
                .context("OpenClaw entrypoint parent missing")?
                .join("node.exe");
            let entrypoint = if adjacent_node.is_file() {
                adjacent_node.into_os_string()
            } else {
                OsString::from("node")
            };
            (entrypoint, arguments)
        } else {
            (entrypoint, arguments)
        };
        let spec = self.launch.derive_runtime_one_shot_command(
            &entrypoint,
            arguments,
            self.launch.working_directory().to_path_buf(),
            BTreeMap::new(),
            format!("openclaw-control:{method}"),
        )?;
        let child = ManagedProcess::spawn(spec)?;
        let mut limits = ProbeCommandLimits::new(Duration::from_secs(20));
        limits.stdout_bytes = 4 * 1024 * 1024;
        let result = run_bounded_managed_process(child, None, limits).await?;
        ensure!(
            result.status.success() && !result.stdout.truncated,
            "OpenClaw Gateway control request failed: {method}"
        );
        serde_json::from_slice(&result.stdout.bytes).map_err(|_| {
            anyhow::anyhow!("OpenClaw Gateway returned invalid control JSON: {method}")
        })
    }

    pub(crate) async fn configure_session(
        &self,
        permission: &str,
        model: Option<&str>,
        existing: bool,
    ) -> Result<Value> {
        ensure!(
            PERMISSION_MODES.contains(&permission),
            "OpenClaw native permission mode is invalid"
        );
        if existing {
            let resolved = self
                .call("sessions.resolve", json!({"key":self.session_key}))
                .await?;
            ensure!(
                resolved["key"] == self.session_key,
                "OpenClaw existing native Session identity changed"
            );
        }
        let catalog = self.call("models.list", json!({})).await?;
        let models = catalog["models"]
            .as_array()
            .context("OpenClaw Gateway omitted its model catalog")?;
        let choices = models.iter().map(|model| {
            let provider=model["provider"].as_str().context("OpenClaw model omitted its Provider")?;
            let id=model["id"].as_str().context("OpenClaw model omitted its ID")?;
            Ok(json!({"modelId":format!("{provider}/{id}"),"name":model["name"].as_str().unwrap_or(id)}))
        }).collect::<Result<Vec<_>>>()?;
        if let Some(model) = model {
            ensure!(
                choices.iter().any(|choice| choice["modelId"] == model),
                "OpenClaw selected model is absent from the live Gateway catalog"
            );
        }
        let mut patch = json!({"key":self.session_key,"permissionMode":permission});
        if let Some(model) = model {
            patch["model"] = json!(model)
        }
        let result = self.call("sessions.patch", patch).await?;
        validate_session_ack(&result, &self.session_key, permission, model)?;
        let provider = result
            .pointer("/resolved/modelProvider")
            .and_then(Value::as_str)
            .context("OpenClaw Session omitted its Provider")?;
        let model = result
            .pointer("/resolved/model")
            .and_then(Value::as_str)
            .context("OpenClaw Session omitted its model")?;
        Ok(json!({"currentModelId":format!("{provider}/{model}"),"availableModels":choices}))
    }

    pub(crate) async fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        let mut child = self.child.lock().await;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let _ = child.capture_descendants();
        let _ = child.request_graceful_termination();
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            let _ = child.force_terminate_tree();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
        }
        let _ = child.force_terminate_tree();
        for reader in &self.readers {
            reader.abort()
        }
    }

    pub(crate) async fn force_reap_until(&self, deadline: tokio::time::Instant) -> bool {
        self.alive.store(false, Ordering::Release);
        let Ok(mut child) = tokio::time::timeout_at(deadline, self.child.lock()).await else {
            return false;
        };
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if child.capture_descendants().is_err() {
            let _ = child.force_terminate_tree();
            return false;
        }
        if child.force_terminate_tree().is_err()
            || !matches!(
                tokio::time::timeout_at(deadline, child.wait()).await,
                Ok(Ok(_))
            )
        {
            return false;
        }
        #[cfg(windows)]
        return child.tree_is_empty().unwrap_or(false);
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        return child.captured_tree_is_empty().unwrap_or(false);
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        false
    }
}

impl Drop for OpenClawGateway {
    fn drop(&mut self) {
        for reader in &self.readers {
            reader.abort()
        }
    }
}

// Kept out of ordinary tests: this owner needs a real, pinned external Runtime.
// The caller supplies a private fixture and local metadata-only provider; it
// never inherits a user's Home, credentials or ambient MCP configuration.
#[cfg(all(test, feature = "extended-tests"))]
#[tokio::test]
#[ignore = "requires an explicit isolated OpenClaw installation and metadata-only native fixture"]
async fn managed_native_gateway_freezes_routes_and_reaps_its_process_tree() {
    let root = PathBuf::from(
        std::env::var_os("ROVAI_OPENCLAW_SMOKE_ROOT").expect("isolated fixture root required"),
    );
    let binary = PathBuf::from(
        std::env::var_os("ROVAI_OPENCLAW_SMOKE_BIN").expect("isolated product entry required"),
    );
    let node_root = PathBuf::from(
        std::env::var_os("ROVAI_OPENCLAW_SMOKE_NODE_DIR")
            .expect("isolated Node directory required"),
    );
    assert!(root.is_absolute() && binary.is_absolute() && node_root.is_absolute());
    let marker: Value = serde_json::from_slice(
        &std::fs::read(root.join("fixture.json")).expect("fixture marker required"),
    )
    .unwrap();
    assert_eq!(marker["purpose"], "rovai-openclaw-metadata-only");
    let config = root.join("native.json");
    let workspace = root.join("project");
    let mut command = Command::new(&binary);
    command.env_clear().current_dir(&workspace);
    for (key, _) in std::env::vars_os() {
        command.env_remove(key);
    }
    for name in ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut paths = vec![node_root];
    if let Some(system) = std::env::var_os("SystemRoot") {
        paths.push(PathBuf::from(system).join("System32"));
    }
    command
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("HOME", &root)
        .env("USERPROFILE", &root)
        .env("APPDATA", root.join("AppData/Roaming"))
        .env("LOCALAPPDATA", root.join("AppData/Local"))
        .env("OPENCLAW_HOME", &root)
        .env("OPENCLAW_STATE_DIR", root.join("native-state"))
        .env("OPENCLAW_CONFIG_PATH", config);
    let native_environment = command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    let binding = root.join("binding-probe");
    let gateway =
        OpenClawGateway::start(&mut command, &workspace, &binding, None, &BTreeMap::new())
            .await
            .unwrap();
    let state = gateway
        .configure_session(
            "read-only",
            Some("integration-probe/metadata-only-model"),
            false,
        )
        .await
        .unwrap();
    assert_eq!(
        state["currentModelId"],
        "integration-probe/metadata-only-model"
    );
    assert_eq!(state["availableModels"].as_array().unwrap().len(), 1);
    gateway
        .configure_session(
            "guarded",
            Some("integration-probe/metadata-only-model"),
            true,
        )
        .await
        .unwrap();
    let mut request = json!({"cwd":workspace,"mcpServers":[{"name":"must-not-leak-into-ACP"}]});
    gateway.configure_session_request(&mut request, true);
    assert_eq!(request["mcpServers"], json!([]));
    assert_eq!(request["_meta"]["sessionKey"], gateway.session_key);
    assert_eq!(request["_meta"]["requireExistingSession"], true);
    let token = std::fs::read_to_string(binding.join("gateway-token")).unwrap();
    assert!(
        !command
            .as_std()
            .get_args()
            .any(|arg| arg.to_string_lossy().contains(&token))
    );
    assert_eq!(gateway.redact_text(&token), "[redacted]");
    gateway.shutdown().await;
    assert!(!gateway.is_alive());
    assert!(
        gateway
            .force_reap_until(tokio::time::Instant::now() + Duration::from_secs(3))
            .await
    );
    // Exercise the actual ACP Host/Fleet seam as well as Gateway control. There
    // is no Core database, business input, prompt or model request in this owner.
    use crate::{
        acp::{AcpCliRuntimeAdapter, AcpSessionRestoreError},
        agent_profile::{
            AdapterKind, AdapterPermissionConfig, FrozenAgentRuntimeConfig, ResolvedModelSelection,
        },
        builtin_tool_runtime::BuiltinToolProcessConfig,
        builtin_tool_transport::LocalIpcEndpoint,
        compaction::CompactionDetectorPolicy,
        member_environment::LaunchEnvironment,
        runtime::{AgentRunWorkspace, PermissionSemantics},
        runtime_fleet::{AgentRuntimeFleetConfig, AgentRuntimeFleetManager},
    };
    let digest = crate::command::canonical_json_digest(
        &json!({"fixture":"metadata-only","kind":"openclaw-cli"}),
    )
    .unwrap();
    let mut frozen = FrozenAgentRuntimeConfig {
        environment: Some(LaunchEnvironment {
            values: Some(native_environment),
            overlay: None,
        }),
        custom_api: None,
        camp_fast: None,
        adapter_kind: AdapterKind::OpenClawCli,
        installation_id: "fixture-openclaw".into(),
        installation_generation: 1,
        search_environment_generation: 1,
        executable_path: binary.to_string_lossy().into_owned(),
        auth_scope: "isolated-fixture".into(),
        reported_version: Some("2026.9.8".into()),
        executable_fingerprint: crate::agent_runtime_adapter::executable_fingerprint(&binary)
            .unwrap(),
        capabilities: vec!["session.resume".into(), "session.load".into()],
        protocol_version: "acp-v1".into(),
        model: ResolvedModelSelection {
            source: "explicit".into(),
            model_id: "integration-probe/metadata-only-model".into(),
            options: json!({}),
            dsh_source: None,
        },
        permissions: AdapterPermissionConfig {
            adapter_kind: AdapterKind::OpenClawCli,
            schema_version: 1,
            values: json!({"permission_mode":"guarded"}),
        },
        native_session_compatibility_key: None,
        binding_compatibility_digest: digest.clone(),
        host_config_digest: digest.clone(),
        config_digest: String::new(),
    };
    frozen.refresh_config_digest().unwrap();
    let attachment_root = prepare_private_directory(&root.join("attachments")).unwrap();
    let ipc = if cfg!(windows) {
        LocalIpcEndpoint::WindowsNamedPipe {
            name: format!(
                r"\\.\pipe\rovai-ai-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ),
        }
    } else {
        LocalIpcEndpoint::UnixSocket {
            path: root.join("fixture.sock").to_string_lossy().into_owned(),
        }
    };
    // This executable is only an inert Builtin context locator, never invoked.
    let builtin = BuiltinToolProcessConfig::create(
        &std::env::current_exe().unwrap(),
        &ipc,
        &root.join("builtin"),
    )
    .unwrap();
    let fleet_root = root.join("fleet");
    let workspace =
        AgentRunWorkspace::runtime_managed_path(workspace.to_string_lossy().into_owned());
    let acquire = async |adapter: &AcpCliRuntimeAdapter, run: &str, binding: &str| {
        adapter
            .ensure_agent_run_runtime(
                run,
                1,
                "fixture-camp",
                "fixture-agent",
                binding,
                &workspace,
                PermissionSemantics::RuntimeManagedV2,
                &frozen,
                &builtin,
                &BTreeMap::new(),
                &digest,
                &attachment_root,
                &digest,
            )
            .await
            .unwrap()
    };
    let (incoming, _receiver) = tokio::sync::mpsc::unbounded_channel();
    let fleet = Arc::new(AgentRuntimeFleetManager::new(
        AgentRuntimeFleetConfig::default(),
    ));
    let adapter = AcpCliRuntimeAdapter::new(
        AdapterKind::OpenClawCli,
        incoming.clone(),
        fleet_root.clone(),
        fleet.clone(),
        CompactionDetectorPolicy::Disabled,
    )
    .unwrap();
    let first = acquire(&adapter, "fixture-run-one", "fixture-binding").await;
    let caps = first.session_capabilities().await;
    assert!(caps.can_resume && caps.can_load_history);
    let first_host = first.host_instance_id().to_owned();
    let session = first
        .start_or_resume_session_with_native_rules(
            None,
            caps,
            "explicit",
            &frozen.model.model_id,
            &json!({}),
            &BTreeMap::new(),
            None,
        )
        .await
        .unwrap();
    adapter.complete_agent_run("fixture-run-one", 1).await;
    let warm = acquire(&adapter, "fixture-run-two", "fixture-binding").await;
    assert_eq!(warm.host_instance_id(), first_host);
    assert_eq!(
        warm.start_or_resume_session_with_native_rules(
            Some(&session),
            caps,
            "explicit",
            &frozen.model.model_id,
            &json!({}),
            &BTreeMap::new(),
            None
        )
        .await
        .unwrap(),
        session
    );
    adapter.complete_agent_run("fixture-run-two", 1).await;
    adapter.shutdown_all().await;
    assert!(
        fleet
            .shutdown_all_until(tokio::time::Instant::now() + Duration::from_secs(12))
            .await
            .all_reaped()
    );
    // Recreating both managers exercises a cold Host and its persisted native
    // binding, rather than relying on the old process's Session cache.
    let cold_fleet = Arc::new(AgentRuntimeFleetManager::new(
        AgentRuntimeFleetConfig::default(),
    ));
    let cold_adapter = AcpCliRuntimeAdapter::new(
        AdapterKind::OpenClawCli,
        incoming,
        fleet_root,
        cold_fleet.clone(),
        CompactionDetectorPolicy::Disabled,
    )
    .unwrap();
    let cold = acquire(&cold_adapter, "fixture-run-three", "fixture-binding").await;
    assert_ne!(cold.host_instance_id(), first_host);
    assert_eq!(
        cold.start_or_resume_session_with_native_rules(
            Some(&session),
            caps,
            "explicit",
            &frozen.model.model_id,
            &json!({}),
            &BTreeMap::new(),
            None
        )
        .await
        .unwrap(),
        session
    );
    cold_adapter
        .complete_agent_run("fixture-run-three", 1)
        .await;
    let missing = acquire(&cold_adapter, "fixture-run-missing", "missing-binding").await;
    let rejected = missing
        .start_or_resume_session_with_native_rules(
            Some(&session),
            caps,
            "explicit",
            &frozen.model.model_id,
            &json!({}),
            &BTreeMap::new(),
            None,
        )
        .await
        .unwrap_err();
    assert!(
        rejected.downcast_ref::<AcpSessionRestoreError>().is_some(),
        "{rejected:#}"
    );
    cold_adapter.shutdown_all().await;
    assert!(
        cold_fleet
            .shutdown_all_until(tokio::time::Instant::now() + Duration::from_secs(15))
            .await
            .all_reaped()
    );
    atomic_write_private_json(&root.join("core-probe-result.json"),&json!({"status":"passed","model":"integration-probe/metadata-only-model","source":"local_metadata_fixture","permissionModes":["read-only","guarded"],"nativeSessionKey":gateway.session_key,"processTreeReaped":true,"modelInference":false,"CoreAgentRun":false,"AcpHostFleet":{"newSession":true,"warmHostReused":true,"coldHostRecreated":true,"coldSessionIdPreserved":true,"missingBindingRejected":true,"allPairedProcessesReaped":true,"promptSent":false,"builtinCliInvoked":false}})).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    // This owner covers the new Gateway authority boundary without a database
    // or real Runtime: untrusted identifiers/acks cannot select another scope.
    #[test]
    fn gateway_configuration_and_acknowledgement_keep_the_owned_scope() {
        let workspace = std::env::temp_dir().join("openclaw-pure-workspace");
        let native = std::env::temp_dir().join("openclaw-pure-native");
        let source = json!({"models":{"providers":{"native":{"apiKey":"fixture-secret"}}},"gateway":{"mode":"remote","auth":{"token":"old-secret"}},"cron":{"enabled":true},"agents":{"entries":{"native-agent":{"workspace":"old"}}}});
        let (config, agent) =
            prepare_configuration(source, &native, &workspace, 12345, None, &BTreeMap::new())
                .unwrap();
        assert_eq!(agent, "native-agent");
        assert_eq!(
            config["models"]["providers"]["native"]["apiKey"],
            "fixture-secret"
        );
        assert_eq!(config["gateway"]["mode"], "local");
        assert!(config["gateway"]["auth"].get("token").is_none());
        assert_eq!(config["cron"]["enabled"], false);
        assert_eq!(
            config["agents"]["entries"]["native-agent"]["workspace"],
            json!(workspace)
        );
        for invalid in ["", "../escape", "a:b", "a/b", "a\\b"] {
            assert!(assign_session_key(invalid, "binding").is_err());
            assert!(assign_session_key("main", invalid).is_err())
        }
        let key = assign_session_key("native-agent", "binding-1").unwrap();
        assert_eq!(
            assign_session_key(" Native-Agent ", "binding-1").unwrap(),
            key
        );
        let ack = json!({"ok":true,"key":key,"entry":{"permissionMode":"guarded"},"resolved":{"modelProvider":"provider","model":"model/name"}});
        validate_session_ack(&ack, &key, "guarded", Some("provider/model/name")).unwrap();
        assert!(
            validate_session_ack(&ack, "agent:other:rovai:binding-1", "guarded", None).is_err()
        );
        assert!(validate_session_ack(&ack, &key, "full", None).is_err());
        assert!(validate_session_ack(&ack, &key, "guarded", Some("other/model/name")).is_err());
        let ambiguous = json!({"agents":{"entries":{"a":{},"b":{}}}});
        assert!(
            prepare_configuration(
                ambiguous,
                &native,
                &workspace,
                12345,
                None,
                &BTreeMap::new()
            )
            .is_err()
        );
        let unknown = json!({"agents":{"entries":{"a":{}}}});
        assert!(
            prepare_configuration(
                unknown,
                &native,
                &workspace,
                12345,
                Some("b"),
                &BTreeMap::new()
            )
            .is_err()
        );
        let shared = json!({"agents":{"entries":{"a":{"agentDir":"native-private-store"}}}});
        assert!(
            prepare_configuration(shared, &native, &workspace, 12345, None, &BTreeMap::new())
                .is_err()
        );
        let legacy = json!({"agents":{"list":[{"id":"Native-Agent","default":true,"name":"Kept name","model":{"primary":"provider/kept-model"}}]}});
        let (legacy, selected) =
            prepare_configuration(legacy, &native, &workspace, 12345, None, &BTreeMap::new())
                .unwrap();
        assert_eq!(selected, "native-agent");
        assert!(legacy["agents"].get("list").is_none());
        let projected = &legacy["agents"]["entries"]["native-agent"];
        assert!(projected.get("id").is_none() && projected.get("default").is_none());
        assert_eq!(projected["name"], "Kept name");
        assert_eq!(projected["model"]["primary"], "provider/kept-model");
        assert_eq!(projected["workspace"], json!(workspace));
        for bad in [
            json!({"agents":{"list":[{"name":"no id"}]}}),
            json!({"agents":{"list":[{"id":"a"},{"id":"A"}]}}),
            json!({"agents":{"list":[{"id":"a"},{"id":"b"}]}}),
            json!({"agents":{"list":[],"entries":{}}}),
        ] {
            assert!(
                prepare_configuration(bad, &native, &workspace, 12345, None, &BTreeMap::new())
                    .is_err()
            );
        }
    }
}
