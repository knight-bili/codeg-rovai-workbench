//! 仅转发 PTY 字节的受管辅助进程；没有数据库、业务归属或模型执行权威。
//! 必须由 Core 的 ManagedProcess 启动，复用其进程树归属和强制回收。
//! Codeg aff1e6c manager 行为移植，Apache-2.0 通知见 integration/licenses/codeg/LICENSE。
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

use super::state::{READ_CHUNK_LIMIT, Size};

const FRAME_LIMIT: u64 = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HelperLaunch {
    pub shell: PathBuf,
    pub cwd: PathBuf,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum HelperInput {
    Write {
        #[serde(rename = "inputId")]
        input_id: String,
        #[serde(rename = "bytesBase64")]
        bytes_base64: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Stop {},
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum HelperOutput {
    Ready {},
    Output {
        #[serde(rename = "bytesBase64")]
        bytes_base64: String,
    },
    Written {
        #[serde(rename = "inputId")]
        input_id: String,
    },
    Resized {
        cols: u16,
        rows: u16,
    },
    Exited {
        #[serde(rename = "exitCode")]
        exit_code: u32,
        #[serde(rename = "outputDrained")]
        output_drained: bool,
    },
}

fn read_frame<T: serde::de::DeserializeOwned>(input: &mut impl BufRead) -> Result<Option<T>> {
    let mut frame = Vec::new();
    let count = input.take(FRAME_LIMIT + 1).read_until(b'\n', &mut frame)?;
    if count == 0 {
        return Ok(None);
    }
    ensure!(
        count as u64 <= FRAME_LIMIT && frame.last() == Some(&b'\n'),
        "canvas_terminal.invalid_helper_frame"
    );
    Ok(Some(serde_json::from_slice(&frame)?))
}

fn emit(output: &Mutex<std::io::Stdout>, frame: HelperOutput) -> Result<()> {
    let mut output = output
        .lock()
        .map_err(|_| anyhow::anyhow!("canvas_terminal.output_poisoned"))?;
    serde_json::to_writer(&mut *output, &frame)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

struct OwnedChild(Box<dyn portable_pty::Child + Send + Sync>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

/// 父进程先冻结受管启动规格，再写入首个 Launch 帧。
/// 三个二进制的专用早期入口调用它；普通Core/Host启动不会进入此分支。
pub(crate) fn run() -> Result<()> {
    #[cfg(target_os = "linux")]
    let resources = crate::managed_process::HelperDescendantGuard::new(
        std::env::var("ROVAI_CANVAS_CORE_PARENT_PID")?.parse()?,
    )?;
    #[cfg(target_os = "linux")]
    let interrupted = resources.interruption();
    #[cfg(not(target_os = "linux"))]
    let interrupted = Arc::new(AtomicBool::new(false));
    let result = run_session(interrupted, |slave, command| {
        #[cfg(target_os = "linux")]
        let _permit = resources.launch_permit()?;
        let child = OwnedChild(slave.spawn_command(command)?);
        #[cfg(target_os = "linux")]
        resources.protect_direct_child(
            child
                .0
                .process_id()
                .context("canvas_terminal.child_identity_missing")?,
        );
        Ok(child)
    });
    #[cfg(target_os = "linux")]
    resources.finish()?;
    result
}

fn run_session(
    interrupted: Arc<AtomicBool>,
    spawn_child: impl FnOnce(&dyn portable_pty::SlavePty, CommandBuilder) -> Result<OwnedChild>,
) -> Result<()> {
    let mut input = BufReader::new(std::io::stdin());
    let launch: HelperLaunch = read_frame(&mut input)?.context("canvas_terminal.launch_missing")?;
    let size = Size::new(launch.cols, launch.rows).map_err(anyhow::Error::msg)?;
    ensure!(
        launch.shell.is_absolute() && launch.shell.is_file(),
        "canvas_terminal.invalid_shell"
    );
    ensure!(
        launch.cwd.is_absolute() && launch.cwd.is_dir(),
        "canvas_terminal.invalid_directory"
    );
    ensure!(
        launch.args.len() <= 64
            && launch.args.iter().map(String::len).sum::<usize>() <= 16 * 1024
            && launch.args.iter().all(|arg| !arg.contains('\0')),
        "canvas_terminal.invalid_arguments"
    );
    let pair = native_pty_system().openpty(PtySize {
        rows: size.rows(),
        cols: size.cols(),
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(&launch.shell);
    command.args(&launch.args);
    command.cwd(&launch.cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    {
        command.env("PYTHONUTF8", "1");
        command.env("PYTHONIOENCODING", "utf-8");
    }
    let mut child = spawn_child(pair.slave.as_ref(), command)?;
    drop(pair.slave);
    let mut writer = pair.master.take_writer()?;
    let mut reader = pair.master.try_clone_reader()?;
    let output = Arc::new(Mutex::new(std::io::stdout()));
    emit(&output, HelperOutput::Ready {})?;

    let (drained_tx, drained_rx) = mpsc::sync_channel(1);
    let reader_output = output.clone();
    std::thread::Builder::new()
        .name("canvas-pty-output".into())
        .spawn(move || {
            let result = (|| -> Result<()> {
                let mut bytes = [0u8; READ_CHUNK_LIMIT];
                loop {
                    let count = match reader.read(&mut bytes) {
                        Ok(count) => count,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        #[cfg(unix)]
                        Err(error) if error.raw_os_error() == Some(libc::EIO) => return Ok(()),
                        Err(error) => return Err(error.into()),
                    };
                    if count == 0 {
                        return Ok(());
                    }
                    emit(
                        &reader_output,
                        HelperOutput::Output {
                            bytes_base64: STANDARD.encode(&bytes[..count]),
                        },
                    )?;
                }
            })();
            let _ = drained_tx.send(result.is_ok());
        })?;

    // 有界输入帧队列；父端未读取时 stdout 自然反压，不累积无界输出事件。
    let (input_tx, input_rx) = mpsc::sync_channel(8);
    std::thread::Builder::new()
        .name("canvas-pty-input".into())
        .spawn(move || {
            loop {
                match read_frame::<HelperInput>(&mut input) {
                    Ok(Some(frame)) => {
                        if input_tx.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        interrupted.store(true, Ordering::Release);
                        break;
                    }
                    Err(error) => {
                        let _ = input_tx.send(Err(error));
                        break;
                    }
                }
            }
        })?;
    let mut drained = None;
    loop {
        if let Ok(clean) = drained_rx.try_recv() {
            ensure!(clean, "canvas_terminal.output_read_failed");
            drained = Some(clean);
        }
        if let Some(status) = child.0.try_wait()? {
            let output_drained = drained.unwrap_or_else(|| {
                drained_rx
                    .recv_timeout(Duration::from_millis(100))
                    .unwrap_or(false)
            });
            emit(
                &output,
                HelperOutput::Exited {
                    exit_code: status.exit_code(),
                    output_drained,
                },
            )?;
            return Ok(());
        }
        let frame = match input_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(frame) => frame?,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                child.0.kill()?;
                let _ = child.0.wait()?;
                return Ok(());
            }
        };
        match frame {
            HelperInput::Write {
                input_id,
                bytes_base64,
            } => {
                ensure!(
                    super::valid_uuid(&input_id),
                    "canvas_terminal.invalid_input_id"
                );
                let bytes = super::decode_input(&bytes_base64)?;
                writer.write_all(&bytes)?;
                writer.flush()?;
                emit(&output, HelperOutput::Written { input_id })?;
            }
            HelperInput::Resize { cols, rows } => {
                Size::new(cols, rows).map_err(anyhow::Error::msg)?;
                pair.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                emit(&output, HelperOutput::Resized { cols, rows })?;
            }
            HelperInput::Stop {} => {
                // Parent 的 ManagedProcess 仍须完成整个树的回收，root wait 不替代它。
                child.0.kill()?;
            }
        }
    }
}
