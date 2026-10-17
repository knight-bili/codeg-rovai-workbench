//! 画布临时终端的 Core 来源校验与闭合请求。进程身份不写入画布数据库。
//! Codeg 行为来源固定 aff1e6c，许可证见 integration/licenses/codeg/LICENSE。
//! 父端、关闭流程及公共方法已接线；界面与真实平台验证仍待后续批次。
pub(crate) mod helper;
pub(crate) mod manager;
pub(crate) mod state;
pub use manager::run_helper_if_requested;

use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub(crate) const SOURCE_SQL: &str = "SELECT n.path FROM canvas_node AS n
 JOIN canvas_board AS b ON b.id=n.board_id
 WHERE n.id=?1 AND n.board_id=?2 AND n.kind='terminal' AND b.deleted_at IS NULL";

pub(crate) const INPUT_LIMIT: usize = 16 * 1024;

fn valid_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn decode_input(encoded: &str) -> Result<Vec<u8>> {
    ensure!(
        encoded.len() <= INPUT_LIMIT.div_ceil(3) * 4,
        "canvas_terminal.input_too_large"
    );
    let bytes = STANDARD.decode(encoded)?;
    ensure!(
        !bytes.is_empty() && bytes.len() <= INPUT_LIMIT,
        "canvas_terminal.invalid_input"
    );
    Ok(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalTarget {
    pub board_id: String,
    pub node_id: String,
}

impl TerminalTarget {
    pub(crate) fn live(&self, connection: &Connection) -> Result<bool> {
        self.validate()?;
        Ok(connection
            .query_row(SOURCE_SQL, params![self.node_id, self.board_id], |_| Ok(()))
            .optional()?
            .is_some())
    }
    pub fn validate(&self) -> Result<()> {
        for id in [&self.board_id, &self.node_id] {
            ensure!(
                !id.is_empty() && id.trim() == id && id.len() <= 128 && !id.contains('\0'),
                "canvas_terminal.invalid_target"
            );
        }
        Ok(())
    }

    /// 必须由可信 Owner 入口在画布生命周期锁内调用；请求体不接受 cwd 或 shell。
    /// 目录是启动位置，不是 OS 沙箱，也不由文件预览 RootGrant 授权执行。
    pub(crate) fn directory_path(&self, connection: &Connection) -> Result<PathBuf> {
        self.validate()?;
        let path: Option<String> = connection
            .query_row(SOURCE_SQL, params![self.node_id, self.board_id], |row| {
                row.get(0)
            })
            .optional()?;
        let path = PathBuf::from(path.context("canvas_terminal.source_unavailable")?);
        ensure!(
            path.is_absolute() && !path.as_os_str().is_empty(),
            "canvas_terminal.invalid_directory"
        );
        Ok(path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartTerminal {
    pub target: TerminalTarget,
    pub core_generation: String,
    pub request_id: String,
    pub expected_generation: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

impl StartTerminal {
    pub(crate) fn validate(&self) -> Result<state::Size> {
        self.target.validate()?;
        ensure!(
            valid_uuid(&self.core_generation),
            "canvas_terminal.invalid_core_generation"
        );
        ensure!(
            valid_uuid(&self.request_id),
            "canvas_terminal.invalid_request_id"
        );
        if let Some(generation) = &self.expected_generation {
            ensure!(valid_uuid(generation), "canvas_terminal.invalid_generation");
        }
        state::Size::new(self.cols, self.rows).map_err(anyhow::Error::msg)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadTerminal {
    pub target: TerminalTarget,
    pub generation: Option<String>,
    #[serde(default)]
    pub after_seq: u64,
}

impl ReadTerminal {
    pub(crate) fn validate(&self) -> Result<()> {
        self.target.validate()?;
        ensure!(
            self.generation.as_deref().is_none_or(valid_uuid),
            "canvas_terminal.invalid_generation"
        );
        ensure!(
            self.generation.is_some() || self.after_seq == 0,
            "canvas_terminal.cursor_without_generation"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteTerminal {
    pub target: TerminalTarget,
    pub generation: String,
    pub input_id: String,
    pub expected_input_sequence: u64,
    pub bytes_base64: String,
}

impl WriteTerminal {
    pub(crate) fn decode(&self) -> Result<Vec<u8>> {
        self.target.validate()?;
        ensure!(
            valid_uuid(&self.generation) && valid_uuid(&self.input_id),
            "canvas_terminal.invalid_input_identity"
        );
        decode_input(&self.bytes_base64)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeTerminal {
    pub target: TerminalTarget,
    pub generation: String,
    pub cols: u16,
    pub rows: u16,
}

impl ResizeTerminal {
    pub(crate) fn validate(&self) -> Result<state::Size> {
        self.target.validate()?;
        ensure!(
            valid_uuid(&self.generation),
            "canvas_terminal.invalid_generation"
        );
        state::Size::new(self.cols, self.rows).map_err(anyhow::Error::msg)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopTerminal {
    pub target: TerminalTarget,
    pub generation: String,
}

impl StopTerminal {
    pub(crate) fn validate(&self) -> Result<()> {
        self.target.validate()?;
        ensure!(
            valid_uuid(&self.generation),
            "canvas_terminal.invalid_generation"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terminal_requests_are_closed_and_keep_original_generation_and_bytes() {
        let generation = "b7a24047-8f99-4ad7-8d7f-b34ca2a0359d";
        let target = json!({"boardId":"board", "nodeId":"node"});
        let start = json!({"target":target, "coreGeneration":generation, "requestId":generation, "cols":80, "rows":24});
        let request: StartTerminal = serde_json::from_value(start.clone()).unwrap();
        assert!(request.validate().is_ok());
        for extra in [
            "cwd",
            "shell",
            "clientId",
            "ownerId",
            "rootGrant",
            "terminalId",
        ] {
            let mut invalid = start.clone();
            invalid[extra] = json!("injected");
            assert!(serde_json::from_value::<StartTerminal>(invalid).is_err());
        }
        let mut invalid = start.clone();
        invalid["target"]["cwd"] = json!("/different");
        assert!(serde_json::from_value::<StartTerminal>(invalid).is_err());
        let mut invalid = start;
        invalid["requestId"] = json!(generation.to_uppercase());
        assert!(
            serde_json::from_value::<StartTerminal>(invalid)
                .unwrap()
                .validate()
                .is_err()
        );
        let read: ReadTerminal =
            serde_json::from_value(json!({"target":target,"afterSeq":1})).unwrap();
        assert!(read.validate().is_err());
        let read: ReadTerminal =
            serde_json::from_value(json!({"target":target,"generation":generation,"afterSeq":1}))
                .unwrap();
        read.validate().unwrap();
        let raw = vec![0, 0xff, 0xe4, 0xbd, 0xa0, 0x1b];
        let write: WriteTerminal = serde_json::from_value(json!({"target":target,"generation":generation,"inputId":generation,"expectedInputSequence":0,"bytesBase64":STANDARD.encode(&raw)})).unwrap();
        assert_eq!(write.decode().unwrap(), raw);
        for bytes in [vec![], vec![0; INPUT_LIMIT + 1]] {
            assert!(decode_input(&STANDARD.encode(bytes)).is_err());
        }
        assert_eq!(
            decode_input(&STANDARD.encode(vec![0; INPUT_LIMIT]))
                .unwrap()
                .len(),
            INPUT_LIMIT
        );
        assert!(decode_input("not base64!").is_err());
        let resize: ResizeTerminal = serde_json::from_value(
            json!({"target":target,"generation":generation,"cols":0,"rows":24}),
        )
        .unwrap();
        assert!(resize.validate().is_err());
        let stop: StopTerminal =
            serde_json::from_value(json!({"target":target,"generation":generation})).unwrap();
        stop.validate().unwrap();
    }
}
