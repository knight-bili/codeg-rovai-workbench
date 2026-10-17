//! Core 内唯一的临时终端 owner。后台任务持有实际进程，页面和请求 Future 不拥有它。
#[cfg(test)]
mod tests;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, watch},
    time::{Instant, timeout, timeout_at},
};

use super::{
    ReadTerminal, ResizeTerminal, StartTerminal, StopTerminal, TerminalTarget, WriteTerminal,
    helper::{HelperInput, HelperLaunch, HelperOutput},
    state::{Phase, READ_CHUNK_LIMIT, Session, Size},
};
use crate::{
    managed_process::{
        ManagedProcess, ManagedProcessLaunchSpec, ManagedProcessPurpose, ManagedStdinPolicy,
        ManagedWindowsArgvDialect,
    },
    planned_shutdown::ExecutionLaunchPermit,
};

const MAX_LIVE: usize = 16;
const OUTPUT_HISTORY: usize = 64;
const INPUT_HISTORY: usize = 64;
const FRAME_LIMIT: usize = 64 * 1024;
const HELPER_FLAG: &str = "--canvas-pty-helper";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputReceipt {
    sequence: u64,
    input_id: String,
    status: &'static str,
    #[serde(skip)]
    digest: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputChunk {
    seq: u64,
    bytes_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    core_generation: String,
    target: TerminalTarget,
    exists: bool,
    generation: Option<String>,
    launch_request_id: Option<String>,
    phase: &'static str,
    cols: Option<u16>,
    rows: Option<u16>,
    exit_code: Option<u32>,
    through_seq: u64,
    first_available_seq: u64,
    gap: bool,
    chunks: Vec<OutputChunk>,
    input_sequence: u64,
    inputs: Vec<InputReceipt>,
    issue: Option<&'static str>,
    cleanup_complete: bool,
}

struct Data {
    session: Session,
    inputs: VecDeque<InputReceipt>,
    input_sequence: u64,
    issue: Option<&'static str>,
}

struct Entry {
    request: StartTerminal,
    data: Mutex<Data>,
    controls: mpsc::Sender<Control>,
    stop: watch::Sender<bool>,
    changed: watch::Sender<u64>,
    done: watch::Sender<bool>,
    forget: AtomicBool,
    last_used: AtomicU64,
}

pub(crate) struct InputWait {
    entry: Arc<Entry>,
    sequence: u64,
}
impl InputWait {
    pub(crate) async fn wait(self) -> Result<InputReceipt> {
        let mut changed = self.entry.changed.subscribe();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let receipt = self
                .entry
                .data()?
                .inputs
                .iter()
                .find(|receipt| receipt.sequence == self.sequence)
                .cloned()
                .context("canvas_terminal.input_receipt_expired")?;
            if !matches!(receipt.status, "queued" | "pending") || Instant::now() >= deadline {
                return Ok(receipt);
            }
            if !matches!(timeout_at(deadline, changed.changed()).await, Ok(Ok(()))) {
                return Ok(receipt);
            }
        }
    }
}

impl Entry {
    fn data(&self) -> Result<MutexGuard<'_, Data>> {
        self.data
            .lock()
            .map_err(|_| anyhow::anyhow!("canvas_terminal.state_poisoned"))
    }
    fn notify(&self) {
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }
    fn finished(&self) -> bool {
        *self.done.borrow()
    }
    fn stop(&self) {
        if let Ok(mut data) = self.data() {
            data.session.request_stop();
        }
        self.stop.send_replace(true);
        self.notify();
    }
}

enum Control {
    Write {
        input_id: String,
        bytes_base64: String,
    },
    Resize {
        size: Size,
        reply: oneshot::Sender<Result<()>>,
    },
}

enum Pending {
    Write(String),
    Resize(Size, oneshot::Sender<Result<()>>),
}

pub(crate) struct Manager {
    pub(crate) lifecycle: tokio::sync::Mutex<()>,
    entries: Mutex<HashMap<TerminalTarget, Arc<Entry>>>,
    closing: AtomicBool,
    core_generation: String,
    data_dir: PathBuf,
    usage: AtomicU64,
    directory_reads: Arc<tokio::sync::Semaphore>,
}

impl Manager {
    pub(crate) fn new(data_dir: PathBuf, core_generation: String) -> Result<Arc<Self>> {
        #[cfg(target_os = "macos")]
        ManagedProcess::recover_runtime_descendants(&data_dir.join("runtime/canvas-terminals"))?;
        Ok(Arc::new(Self {
            lifecycle: tokio::sync::Mutex::new(()),
            entries: Mutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
            core_generation,
            data_dir,
            usage: AtomicU64::new(0),
            directory_reads: Arc::new(tokio::sync::Semaphore::new(4)),
        }))
    }

    fn entries(&self) -> Result<MutexGuard<'_, HashMap<TerminalTarget, Arc<Entry>>>> {
        self.entries
            .lock()
            .map_err(|_| anyhow::anyhow!("canvas_terminal.registry_poisoned"))
    }

    pub(crate) async fn prepare_launch(
        &self,
        path: PathBuf,
        size: Size,
        environment: Arc<crate::runtime_discovery::RuntimeSearchEnvironment>,
        ownership: String,
    ) -> Result<(HelperLaunch, ManagedProcessLaunchSpec)> {
        let slot = self
            .directory_reads
            .clone()
            .try_acquire_owned()
            .context("canvas_terminal.directory_busy")?;
        // 超时后 worker 持有名额直到实际FS调用结束，不会无限堆积卡住的网络目录读取。
        let (reply, work) = oneshot::channel();
        // 只读FS工作不加入Tokio blocking池，卡住的网络文件系统不会阻止Runtime退出。
        std::thread::Builder::new()
            .name("canvas-terminal-admission".into())
            .spawn(move || {
                let _slot = slot;
                let prepared = (|| {
                    let directory = path
                        .canonicalize()
                        .context("canvas_terminal.directory_unavailable")?;
                    ensure!(directory.is_dir(), "canvas_terminal.not_directory");
                    let launch = default_launch(directory, size, &environment)?;
                    let spec = launch_spec(&launch, &ownership, &environment)?;
                    Ok::<_, anyhow::Error>((launch, spec))
                })();
                let _ = reply.send(prepared);
            })?;
        timeout(Duration::from_secs(3), work)
            .await
            .context("canvas_terminal.directory_timeout")?
            .context("canvas_terminal.directory_worker_failed")?
    }

    fn entry(&self, target: &TerminalTarget) -> Result<Arc<Entry>> {
        let entry = self
            .entries()?
            .get(target)
            .cloned()
            .context("canvas_terminal.session_missing")?;
        entry.last_used.store(
            self.usage.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
        Ok(entry)
    }

    pub(crate) fn targets(&self, board_id: &str) -> Result<Vec<TerminalTarget>> {
        Ok(self
            .entries()?
            .keys()
            .filter(|target| target.board_id == board_id)
            .cloned()
            .collect())
    }

    /// 调用者持有生命周期锁且已从真实节点核对目录；启动规格与原请求在这里冻结。
    pub(crate) fn start(
        self: &Arc<Self>,
        request: StartTerminal,
        launch: HelperLaunch,
        spec: ManagedProcessLaunchSpec,
        permit: ExecutionLaunchPermit,
    ) -> Result<Snapshot> {
        let size = request.validate()?;
        ensure!(
            request.core_generation == self.core_generation,
            "canvas_terminal.core_restarted"
        );
        ensure!(
            !self.closing.load(Ordering::Acquire),
            "canvas_terminal.closing"
        );
        let mut entries = self.entries()?;
        ensure!(
            !self.closing.load(Ordering::Acquire),
            "canvas_terminal.closing"
        );
        if let Some(previous) = entries.get(&request.target) {
            let data = previous.data()?;
            if data.session.request_id() == request.request_id {
                ensure!(
                    previous.request == request,
                    "canvas_terminal.request_conflict"
                );
                drop(data);
                drop(entries);
                return self.read(ReadTerminal {
                    target: request.target,
                    generation: None,
                    after_seq: 0,
                });
            }
            ensure!(previous.finished(), "canvas_terminal.session_busy");
            ensure!(
                request.expected_generation.as_deref() == Some(data.session.generation()),
                "canvas_terminal.stale_generation"
            );
        } else {
            ensure!(
                request.expected_generation.is_none(),
                "canvas_terminal.session_missing"
            );
        }
        ensure!(
            entries.values().filter(|entry| !entry.finished()).count() < MAX_LIVE,
            "canvas_terminal.capacity_exhausted"
        );
        let generation = uuid::Uuid::new_v4().to_string();
        let (controls, receiver) = mpsc::channel(32);
        let (stop, stop_rx) = watch::channel(false);
        let (changed, _) = watch::channel(0);
        let (done, _) = watch::channel(false);
        let entry = Arc::new(Entry {
            request: request.clone(),
            data: Mutex::new(Data {
                session: Session::new(request.request_id, generation.clone(), size),
                inputs: VecDeque::new(),
                input_sequence: 0,
                issue: None,
            }),
            controls,
            stop,
            changed,
            done,
            forget: AtomicBool::new(false),
            last_used: AtomicU64::new(self.usage.fetch_add(1, Ordering::Relaxed)),
        });
        entries.insert(request.target.clone(), entry.clone());
        drop(entries);
        let owner = Arc::downgrade(self);
        let process_dir = self
            .data_dir
            .join("runtime/canvas-terminals")
            .join(generation);
        tokio::spawn(async move {
            run_entry(
                owner,
                entry,
                launch,
                spec,
                permit,
                receiver,
                stop_rx,
                process_dir,
            )
            .await;
        });
        self.trim_history()?;
        self.read(ReadTerminal {
            target: request.target,
            generation: None,
            after_seq: 0,
        })
    }

    fn trim_history(&self) -> Result<()> {
        let entries = self.entries()?;
        let mut completed = entries
            .values()
            .filter(|entry| entry.finished())
            .collect::<Vec<_>>();
        completed.sort_by_key(|entry| entry.last_used.load(Ordering::Relaxed));
        let count = completed.len().saturating_sub(OUTPUT_HISTORY);
        // 保留原代次/启动回执元数据，不能因淘汰输出而把旧启动当作首次新启动。
        for entry in completed.into_iter().take(count) {
            let mut data = entry.data()?;
            data.session.discard_output();
            data.inputs.clear();
        }
        Ok(())
    }

    pub(crate) fn read(&self, request: ReadTerminal) -> Result<Snapshot> {
        request.validate()?;
        let entry = self.entries()?.get(&request.target).cloned();
        let Some(entry) = entry else {
            ensure!(
                request.generation.is_none(),
                "canvas_terminal.session_missing"
            );
            return Ok(Snapshot {
                core_generation: self.core_generation.clone(),
                target: request.target,
                exists: false,
                generation: None,
                launch_request_id: None,
                phase: "missing",
                cols: None,
                rows: None,
                exit_code: None,
                through_seq: 0,
                first_available_seq: 1,
                gap: false,
                chunks: vec![],
                input_sequence: 0,
                inputs: vec![],
                issue: None,
                cleanup_complete: true,
            });
        };
        entry.last_used.store(
            self.usage.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
        let data = entry.data()?;
        let generation = request
            .generation
            .as_deref()
            .unwrap_or(data.session.generation());
        let replay = data
            .session
            .replay(generation, request.after_seq)
            .map_err(anyhow::Error::msg)?;
        Ok(Snapshot {
            core_generation: self.core_generation.clone(),
            target: request.target,
            exists: true,
            generation: Some(data.session.generation().into()),
            launch_request_id: Some(data.session.request_id().into()),
            phase: match data.session.phase() {
                Phase::Starting => "starting",
                Phase::Running => "running",
                Phase::Stopping => "stopping",
                Phase::Exited => "exited",
                Phase::Failed => "failed",
            },
            cols: Some(data.session.size().cols()),
            rows: Some(data.session.size().rows()),
            exit_code: data.session.exit_code(),
            through_seq: replay.through_seq,
            first_available_seq: replay.first_available_seq,
            gap: replay.gap,
            chunks: replay
                .chunks
                .into_iter()
                .map(|chunk| OutputChunk {
                    seq: chunk.seq,
                    bytes_base64: STANDARD.encode(chunk.bytes),
                })
                .collect(),
            input_sequence: data.input_sequence,
            inputs: data.inputs.iter().cloned().collect(),
            issue: data.issue,
            cleanup_complete: entry.finished(),
        })
    }

    pub(crate) fn enqueue_write(&self, request: WriteTerminal) -> Result<InputWait> {
        let bytes = request.decode()?;
        let digest = Sha256::digest(&bytes).to_vec();
        let entry = self.entry(&request.target)?;
        let sequence;
        {
            let mut data = entry.data()?;
            data.session
                .require_generation(&request.generation)
                .map_err(anyhow::Error::msg)?;
            ensure!(
                request.expected_input_sequence <= data.input_sequence,
                "canvas_terminal.input_sequence_conflict"
            );
            sequence = request
                .expected_input_sequence
                .checked_add(1)
                .context("canvas_terminal.input_sequence_exhausted")?;
            if request.expected_input_sequence < data.input_sequence {
                let receipt = data
                    .inputs
                    .iter()
                    .find(|receipt| receipt.sequence == sequence)
                    .context("canvas_terminal.input_receipt_expired")?;
                ensure!(
                    receipt.input_id == request.input_id && receipt.digest == digest,
                    "canvas_terminal.input_identity_conflict"
                );
            } else {
                data.session
                    .require_input(&request.generation)
                    .map_err(anyhow::Error::msg)?;
                ensure!(
                    data.inputs
                        .back()
                        .is_none_or(|receipt| receipt.status == "written"),
                    "canvas_terminal.input_pending"
                );
                ensure!(
                    !data
                        .inputs
                        .iter()
                        .any(|receipt| receipt.input_id == request.input_id),
                    "canvas_terminal.input_identity_conflict"
                );
                let slot = entry
                    .controls
                    .try_reserve()
                    .context("canvas_terminal.input_busy")?;
                data.input_sequence = sequence;
                data.inputs.push_back(InputReceipt {
                    sequence,
                    input_id: request.input_id.clone(),
                    status: "queued",
                    digest,
                });
                while data.inputs.len() > INPUT_HISTORY {
                    data.inputs.pop_front();
                }
                slot.send(Control::Write {
                    input_id: request.input_id.clone(),
                    bytes_base64: request.bytes_base64,
                });
            }
        }
        Ok(InputWait { entry, sequence })
    }

    pub(crate) fn enqueue_resize(
        &self,
        request: ResizeTerminal,
    ) -> Result<oneshot::Receiver<Result<()>>> {
        let size = request.validate()?;
        let entry = self.entry(&request.target)?;
        entry
            .data()?
            .session
            .require_input(&request.generation)
            .map_err(anyhow::Error::msg)?;
        let (reply, result) = oneshot::channel();
        entry
            .controls
            .try_send(Control::Resize { size, reply })
            .map_err(|_| anyhow::anyhow!("canvas_terminal.control_busy"))?;
        Ok(result)
    }

    pub(crate) fn stop(&self, request: StopTerminal) -> Result<()> {
        request.validate()?;
        let entry = self.entry(&request.target)?;
        entry
            .data()?
            .session
            .require_generation(&request.generation)
            .map_err(anyhow::Error::msg)?;
        entry.stop();
        Ok(())
    }

    pub(crate) fn forget(&self, target: &TerminalTarget) -> Result<()> {
        let mut entries = self.entries()?;
        if let Some(entry) = entries.get(target) {
            entry.forget.store(true, Ordering::Release);
            entry.stop();
            if entry.finished() {
                entries.remove(target);
            }
        }
        Ok(())
    }

    pub(crate) fn begin_shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        // 关闭只遍历已经持有的资源；即使先前状态操作panic，也不能跳过实际进程回收。
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in entries.values() {
            entry.stop();
        }
    }

    pub(crate) async fn shutdown_until(&self, deadline: Instant) -> bool {
        self.begin_shutdown();
        let entries = match self.entries() {
            Ok(entries) => entries.values().cloned().collect::<Vec<_>>(),
            Err(_) => return false,
        };
        for entry in entries {
            let mut done = entry.done.subscribe();
            loop {
                let complete = *done.borrow_and_update();
                if complete {
                    break;
                }
                if !matches!(timeout_at(deadline, done.changed()).await, Ok(Ok(()))) {
                    return false;
                }
            }
        }
        true
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}

pub(crate) fn launch_spec(
    launch: &HelperLaunch,
    ownership: &str,
    environment: &crate::runtime_discovery::RuntimeSearchEnvironment,
) -> Result<ManagedProcessLaunchSpec> {
    let mut command = tokio::process::Command::new(std::env::current_exe()?.canonicalize()?);
    command
        .arg(HELPER_FLAG)
        .current_dir(&launch.cwd)
        .env("PATH", environment.path_value());
    #[cfg(target_os = "linux")]
    command.env(
        "ROVAI_CANVAS_CORE_PARENT_PID",
        std::process::id().to_string(),
    );
    ManagedProcessLaunchSpec::capture(
        &command,
        ManagedProcessPurpose::RuntimeHost,
        ManagedStdinPolicy::Piped,
        ManagedWindowsArgvDialect::MicrosoftCrt,
        ownership,
    )
}

pub(crate) fn default_launch(
    directory: PathBuf,
    size: Size,
    environment: &crate::runtime_discovery::RuntimeSearchEnvironment,
) -> Result<HelperLaunch> {
    let requested = std::env::var("SHELL")
        .ok()
        .map(|shell| shell.trim().to_owned())
        .filter(|shell| !shell.is_empty());
    #[cfg(windows)]
    let requested = requested
        .or_else(|| {
            std::env::var("COMSPEC")
                .ok()
                .map(|shell| shell.trim().to_owned())
                .filter(|shell| !shell.is_empty())
        })
        .unwrap_or_else(|| "cmd.exe".into());
    #[cfg(not(windows))]
    let requested = requested.unwrap_or_else(|| {
        ["/bin/zsh", "/bin/bash", "/bin/sh"]
            .into_iter()
            .find(|shell| std::path::Path::new(shell).is_file())
            .unwrap_or("/bin/sh")
            .to_owned()
    });
    let candidate = PathBuf::from(&requested);
    let shell = if candidate.is_absolute() {
        candidate
    } else {
        environment
            .resolve_command_path(&requested)
            .context("canvas_terminal.shell_unavailable")?
    };
    ensure!(
        shell.is_absolute() && shell.is_file(),
        "canvas_terminal.shell_unavailable"
    );
    let name = shell
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let args: Vec<String> = match name.as_str() {
        "cmd" => vec!["/D", "/S", "/K", "chcp 65001 >nul"],
        "powershell" | "pwsh" => vec![
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-Command",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        ],
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "ash" | "mksh" | "busybox" | "fish" => {
            vec!["-l", "-i"]
        }
        _ => vec![],
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    Ok(HelperLaunch {
        shell: shell.canonicalize()?,
        cwd: directory,
        args,
        cols: size.cols(),
        rows: size.rows(),
    })
}

pub fn run_helper_if_requested() -> Result<bool> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(HELPER_FLAG)) {
        return Ok(false);
    }
    ensure!(
        std::env::args_os().count() == 2,
        "canvas_terminal.invalid_helper_arguments"
    );
    super::helper::run()?;
    Ok(true)
}

async fn read_frame(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<HelperOutput>> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            ensure!(frame.is_empty(), "canvas_terminal.incomplete_helper_frame");
            return Ok(None);
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(bytes.len(), |index| index + 1);
        ensure!(
            frame.len() + count <= FRAME_LIMIT,
            "canvas_terminal.helper_frame_too_large"
        );
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(Some(serde_json::from_slice(&frame)?));
        }
    }
}

async fn write_frame(
    writer: &mut crate::managed_process::ManagedChildStdin,
    value: &impl Serialize,
) -> Result<()> {
    let mut frame = serde_json::to_vec(value)?;
    frame.push(b'\n');
    ensure!(
        frame.len() <= FRAME_LIMIT,
        "canvas_terminal.helper_frame_too_large"
    );
    timeout(Duration::from_secs(1), async {
        writer.write_all(&frame).await?;
        writer.flush().await
    })
    .await
    .context("canvas_terminal.helper_write_timeout")??;
    Ok(())
}

fn capture(_process: &mut ManagedProcess) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    _process.capture_descendants()?;
    Ok(())
}

fn tree_empty(process: &ManagedProcess) -> Result<bool> {
    #[cfg(any(windows, target_os = "macos"))]
    return Ok(process.tree_is_empty()?);
    #[cfg(target_os = "linux")]
    return Ok(process.captured_tree_is_empty()?);
    #[allow(unreachable_code)]
    Ok(false)
}

struct IoTasks(Vec<tokio::task::JoinHandle<()>>);
impl Drop for IoTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_entry(
    owner: Weak<Manager>,
    entry: Arc<Entry>,
    launch: HelperLaunch,
    spec: ManagedProcessLaunchSpec,
    permit: ExecutionLaunchPermit,
    mut controls: mpsc::Receiver<Control>,
    mut stop: watch::Receiver<bool>,
    process_dir: PathBuf,
) {
    let spawned = tokio::task::spawn_blocking(move || ManagedProcess::spawn(spec)).await;
    let mut process = match spawned {
        Ok(Ok(process)) => process,
        _ => {
            if let Ok(mut data) = entry.data() {
                data.session.fail_spawn();
                data.issue = Some("canvas_terminal.launch_failed");
            }
            finish_entry(&owner, &entry);
            return;
        }
    };
    let mut tasks = IoTasks(vec![]);
    let mut pending = None;
    let mut exit_code = None;
    let mut ready = false;
    let (frames, mut incoming) = mpsc::channel(8);
    let result = async {
        #[cfg(target_os = "macos")]
        process.track_descendants(&process_dir.join("owned-processes"))?;
        let _ = &process_dir;
        capture(&mut process)?;
        let mut writer = process.take_stdin().context("canvas_terminal.stdin_missing")?;
        let stdout = process.take_stdout().context("canvas_terminal.stdout_missing")?;
        let mut stderr = process.take_stderr().context("canvas_terminal.stderr_missing")?;
        tasks.0.push(tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop { let frame = read_frame(&mut reader).await; let terminal = !matches!(frame, Ok(Some(_))); if frames.send(frame).await.is_err() || terminal { break; } }
        }));
        tasks.0.push(tokio::spawn(async move { let mut bytes = [0u8; 8192]; while matches!(stderr.read(&mut bytes).await, Ok(count) if count>0) {} }));
        ensure!(!*stop.borrow(), "canvas_terminal.launch_cancelled");
        permit.check_cancelled()?;
        write_frame(&mut writer, &launch).await?;
        let mut permit = Some(permit);
        let mut maintenance = tokio::time::interval(Duration::from_millis(50));
        let launch_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            tokio::select! {
                changed = stop.changed() => { let _ = changed; break; },
                frame = incoming.recv() => {
                    let Some(frame) = frame else { anyhow::bail!("canvas_terminal.helper_closed"); };
                    let Some(frame) = frame? else { break; };
                    match frame {
                        HelperOutput::Ready {} => { ensure!(!ready, "canvas_terminal.duplicate_ready"); entry.data()?.session.commit_spawn().map_err(anyhow::Error::msg)?; ready = true; permit.take(); },
                        HelperOutput::Output { bytes_base64 } => { let bytes = STANDARD.decode(bytes_base64)?; ensure!(bytes.len() <= READ_CHUNK_LIMIT, "canvas_terminal.invalid_output_chunk"); entry.data()?.session.append(&bytes).map_err(anyhow::Error::msg)?; },
                        HelperOutput::Written { input_id } => {
                            ensure!(matches!(&pending, Some(Pending::Write(id)) if *id==input_id), "canvas_terminal.input_ack_mismatch");
                            if let Some(receipt) = entry.data()?.inputs.iter_mut().find(|receipt| receipt.input_id==input_id) { receipt.status="written"; } pending.take();
                        },
                        HelperOutput::Resized { cols, rows } => {
                            let Some(Pending::Resize(size, reply)) = pending.take() else { anyhow::bail!("canvas_terminal.resize_ack_mismatch"); };
                            ensure!(size.cols()==cols && size.rows()==rows, "canvas_terminal.resize_ack_mismatch");
                            let mut data = entry.data()?; let generation = data.session.generation().to_owned(); data.session.resized(&generation, size).map_err(anyhow::Error::msg)?; let _=reply.send(Ok(()));
                        },
                        HelperOutput::Exited { exit_code: code, output_drained } => { exit_code=Some(code); if !output_drained { entry.data()?.issue=Some("canvas_terminal.output_incomplete"); } break; }
                    }
                    entry.notify();
                },
                action = controls.recv(), if ready && pending.is_none() => {
                    let Some(action) = action else { break; };
                    match action {
                        Control::Write { input_id, bytes_base64 } => {
                            { let mut data = entry.data()?; let generation=data.session.generation().to_owned(); data.session.require_input(&generation).map_err(anyhow::Error::msg)?; let receipt=data.inputs.iter_mut().find(|receipt| receipt.input_id==input_id).context("canvas_terminal.input_missing")?; receipt.status="pending"; }
                            pending=Some(Pending::Write(input_id.clone()));
                            write_frame(&mut writer, &HelperInput::Write {input_id,bytes_base64}).await?;
                        },
                        Control::Resize { size, reply } => { pending=Some(Pending::Resize(size,reply)); write_frame(&mut writer, &HelperInput::Resize {cols:size.cols(),rows:size.rows()}).await?; }
                    }
                },
                _ = maintenance.tick() => { capture(&mut process)?; if !ready { ensure!(Instant::now()<launch_deadline, "canvas_terminal.launch_timeout"); } }
            }
        }
        Ok::<(), anyhow::Error>(())
    }.await;
    entry.stop();
    if let Some(Pending::Resize(_, reply)) = pending.take() {
        let _ = reply.send(Err(anyhow::anyhow!("canvas_terminal.session_closed")));
    }
    if let Ok(mut data) = entry.data() {
        if result.is_err() {
            data.issue = Some("canvas_terminal.helper_failed");
        }
        for receipt in &mut data.inputs {
            if receipt.status == "queued" {
                receipt.status = "not_written";
            } else if receipt.status == "pending" {
                receipt.status = "unknown";
            }
        }
    }
    entry.notify();
    // 清理失败仍保留实际owner并重试；外层退出期限只能报告未收完，不能伪造完成。
    loop {
        let captured = capture(&mut process).is_ok();
        let killed = process.force_terminate_tree().is_ok();
        let reaped = matches!(
            timeout(Duration::from_millis(200), process.wait()).await,
            Ok(Ok(_))
        );
        if captured && killed && reaped && matches!(tree_empty(&process), Ok(true)) {
            break;
        }
        if let Ok(mut data) = entry.data() {
            if data.issue.is_none() {
                data.issue = Some("canvas_terminal.cleanup_incomplete");
            }
        }
        entry.notify();
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let drain_deadline = Instant::now() + Duration::from_millis(300);
    loop {
        match timeout_at(drain_deadline, incoming.recv()).await {
            Ok(Some(Ok(Some(HelperOutput::Output { bytes_base64 })))) => {
                let accepted = (|| -> Result<()> {
                    let bytes = STANDARD.decode(bytes_base64)?;
                    entry
                        .data()?
                        .session
                        .append(&bytes)
                        .map_err(anyhow::Error::msg)?;
                    Ok(())
                })();
                if accepted.is_err() {
                    if let Ok(mut data) = entry.data() {
                        data.issue = Some("canvas_terminal.output_incomplete");
                    }
                }
            }
            Ok(Some(Ok(Some(HelperOutput::Written { input_id })))) => {
                if let Ok(mut data) = entry.data() {
                    if let Some(receipt) = data
                        .inputs
                        .iter_mut()
                        .find(|receipt| receipt.input_id == input_id)
                    {
                        receipt.status = "written";
                    }
                }
            }
            Ok(Some(Ok(Some(HelperOutput::Exited {
                exit_code: code,
                output_drained,
            })))) => {
                exit_code = Some(code);
                if !output_drained {
                    if let Ok(mut data) = entry.data() {
                        data.issue = Some("canvas_terminal.output_incomplete");
                    }
                }
            }
            Ok(Some(Ok(Some(_)))) => {}
            Ok(Some(Ok(None))) | Ok(None) => break,
            _ => {
                if let Ok(mut data) = entry.data() {
                    data.issue = Some("canvas_terminal.output_incomplete");
                }
                break;
            }
        }
    }
    drop(tasks);
    if let Ok(mut data) = entry.data() {
        if data.issue == Some("canvas_terminal.cleanup_incomplete") {
            data.issue = None;
        }
        if ready {
            data.session.finish(exit_code);
        } else {
            data.session.fail_spawn();
        }
    }
    finish_entry(&owner, &entry);
}

fn finish_entry(owner: &Weak<Manager>, entry: &Arc<Entry>) {
    entry.done.send_replace(true);
    entry.notify();
    if let Some(owner) = owner.upgrade() {
        if entry.forget.load(Ordering::Acquire) {
            if let Ok(mut entries) = owner.entries() {
                if entries
                    .get(&entry.request.target)
                    .is_some_and(|current| Arc::ptr_eq(current, &entry))
                {
                    entries.remove(&entry.request.target);
                }
            }
        }
        let _ = owner.trim_history();
    }
}
