use crate::local_attachment_snapshot::{PrivateSourceObservation, observe_private_source};
use crate::local_attachment_source::LocalAttachmentSourceRef;
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::collections::BTreeMap;

/// 只在本次操作内使用。Core在数据库锁外准备；事务只读本批结果和原归属/CAS。
#[derive(Debug, Default)]
pub(crate) struct PreparedSources {
    inputs: Vec<String>,
    values: BTreeMap<String, std::result::Result<PrivateSourceObservation, String>>,
}

#[derive(Debug)]
pub(crate) struct PreparationChanged;
impl std::fmt::Display for PreparationChanged {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("single_chat.source_preparation_changed")
    }
}
impl std::error::Error for PreparationChanged {}

impl PreparedSources {
    pub(crate) fn capture(sources: Vec<LocalAttachmentSourceRef>) -> Result<Self> {
        let inputs = sources
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut values = BTreeMap::new();
        for source in sources {
            let key = serde_json::to_string(&source)?;
            values.entry(key).or_insert_with(|| {
                observe_private_source(std::path::Path::new(&source.source_path))
                    .map_err(|error| format!("{error:#}"))
            });
        }
        Ok(Self { inputs, values })
    }

    fn require_inputs(&self, sources: &[LocalAttachmentSourceRef]) -> Result<()> {
        let inputs = sources
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ensure!(inputs == self.inputs, PreparationChanged);
        Ok(())
    }

    fn read(
        &self,
        source: &LocalAttachmentSourceRef,
    ) -> Result<std::result::Result<PrivateSourceObservation, String>> {
        self.values
            .get(&serde_json::to_string(source)?)
            .cloned()
            .ok_or_else(|| anyhow::Error::new(PreparationChanged))
    }
}

/// 历史缺观察的发送仍沿原兼容规则，不为其新增内容扫描或补写历史观察。
pub(crate) fn changed_source_inputs(
    connection: &Connection,
    conversation: &str,
    sources: Vec<LocalAttachmentSourceRef>,
) -> Result<Vec<LocalAttachmentSourceRef>> {
    sources
        .into_iter()
        .filter_map(|source| match load(connection, conversation, &source) {
            Ok(Some(_)) => Some(Ok(source)),
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        })
        .collect()
}

fn load(
    connection: &Connection,
    conversation: &str,
    source: &LocalAttachmentSourceRef,
) -> Result<Option<(String, String, PrivateSourceObservation)>> {
    let value:Option<(String,String,String)>=connection.query_row(
        "SELECT source_path,kind,observation_json FROM single_chat_source_observation WHERE conversation_id=?1 AND source_ref_id=?2",
        params![conversation,source.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
    value
        .map(|(path, kind, json)| {
            Ok((
                path,
                kind,
                serde_json::from_str(&json).context("private source observation corrupted")?,
            ))
        })
        .transpose()
}

// 观察完成并核对所有旧记录后才写新行；不授予文件权限，不因 scope 移动改变源身份。
pub(crate) fn capture_sources(
    tx: &Transaction<'_>,
    conversation: &str,
    sources: &[LocalAttachmentSourceRef],
    prepared: &PreparedSources,
) -> Result<Option<String>> {
    prepared.require_inputs(sources)?;
    let mut pending = Vec::new();
    for source in sources {
        let saved = load(tx, conversation, source)?;
        let Ok(observed) = prepared.read(source)? else {
            return Ok(Some(source.id.clone()));
        };
        if observed.kind != source.kind
            || (source.kind == crate::local_attachment_source::LocalAttachmentKind::File
                && source.observed_byte_size != Some(observed.byte_size))
        {
            return Ok(Some(source.id.clone()));
        }
        if let Some((path, kind, expected)) = saved {
            if path != source.source_path || kind != source.kind.as_str() || expected != observed {
                return Ok(Some(source.id.clone()));
            }
        } else {
            pending.push((source, observed));
        }
    }
    for (source, observed) in pending {
        tx.execute("INSERT INTO single_chat_source_observation(conversation_id,source_ref_id,source_path,kind,observation_json) VALUES(?1,?2,?3,?4,?5)",
            params![conversation,source.id,source.source_path,source.kind.as_str(),serde_json::to_string(&observed)?])?;
    }
    Ok(None)
}

pub(crate) fn capture_upload(
    tx: &Transaction<'_>,
    conversation: &str,
    source: &LocalAttachmentSourceRef,
    digest: &str,
    byte_size: u64,
    prepared: &PreparedSources,
) -> Result<()> {
    prepared.require_inputs(std::slice::from_ref(source))?;
    let observed = prepared.read(source)?.map_err(anyhow::Error::msg)?;
    ensure!(
        observed.kind == source.kind
            && observed.content_digest == digest
            && observed.byte_size == byte_size,
        "upload content changed"
    );
    if let Some((path, kind, expected)) = load(tx, conversation, source)? {
        ensure!(
            path == source.source_path && kind == source.kind.as_str() && expected == observed,
            "upload content changed"
        );
    } else {
        tx.execute("INSERT INTO single_chat_source_observation(conversation_id,source_ref_id,source_path,kind,observation_json) VALUES(?1,?2,?3,?4,?5)",
            params![conversation,source.id,source.source_path,source.kind.as_str(),serde_json::to_string(&observed)?])?;
    }
    Ok(())
}

// 缺少旧版观察时只允许原默认/历史排队兼容；新的卡片输入必须有真实观察。
// 存储读取错误向上传播；文件失效返回具体材料 ID，发送方保存业务拒绝并保留输入。
pub(crate) fn changed_source(
    connection: &Connection,
    conversation: &str,
    sources: &[LocalAttachmentSourceRef],
    require_observation: bool,
    prepared: &PreparedSources,
) -> Result<Option<String>> {
    prepared.require_inputs(&changed_source_inputs(
        connection,
        conversation,
        sources.to_vec(),
    )?)?;
    for source in sources {
        let Some((path, kind, expected)) = load(connection, conversation, source)? else {
            if require_observation {
                return Ok(Some(source.id.clone()));
            }
            continue;
        };
        let current = prepared.read(source)?;
        if path != source.source_path
            || kind != source.kind.as_str()
            || !matches!(current, Ok(ref value) if value==&expected)
        {
            return Ok(Some(source.id.clone()));
        }
    }
    Ok(None)
}
