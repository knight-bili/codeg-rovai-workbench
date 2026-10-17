//! 只读源内容观察不持有数据库锁；原Gateway事务仍核对身份、CAS和首次回执。
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::{Mutex, Semaphore};

use crate::{
    command::{CommandEnvelope, CommandExecution, DomainCommand, DomainCommandGateway},
    db::Database,
    local_attachment_source::LocalAttachmentSourceRef,
    private_source_observation::PreparedSources,
};

pub(super) const CONCURRENCY_LIMIT: usize = 4;

#[derive(Debug)]
pub(super) struct ObservationBusy;
impl std::fmt::Display for ObservationBusy {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("single_chat.source_observation_busy")
    }
}
impl std::error::Error for ObservationBusy {}

pub(super) async fn worker<T: Send + 'static>(
    capacity: &Arc<Semaphore>,
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow::Error::new(ObservationBusy))?;
    tokio::task::spawn_blocking(move || {
        // 取消等待不提前归还名额；实际只读工作结束后才释放，不在后台写业务数据。
        let _permit = permit;
        work()
    })
    .await
    .context("private source observation worker failed")?
}

pub(super) async fn prepare(
    capacity: &Arc<Semaphore>,
    sources: Vec<LocalAttachmentSourceRef>,
) -> Result<Arc<PreparedSources>> {
    if sources.is_empty() {
        return Ok(Arc::new(PreparedSources::default()));
    }
    worker(capacity, move || {
        Ok(Arc::new(PreparedSources::capture(sources)?))
    })
    .await
}

pub(super) async fn command<C: DomainCommand>(
    database: &Mutex<Database>,
    capacity: &Arc<Semaphore>,
    envelope: &CommandEnvelope<C>,
    select: impl FnOnce(&Database) -> Result<Vec<LocalAttachmentSourceRef>>,
    commit: impl FnOnce(&mut Database, Arc<PreparedSources>) -> Result<CommandExecution>,
) -> Result<CommandExecution> {
    let sources = {
        let database = database.lock().await;
        if let Some(execution) = DomainCommandGateway.replay_if_recorded(&database, envelope)? {
            return Ok(execution);
        }
        select(&database)?
    };
    let prepared = prepare(capacity, sources).await?;
    let mut database = database.lock().await;
    // 再次进入原Gateway：并发原UUID、版本或材料变化仍由真实事务决定，缺准备时回滚。
    commit(&mut database, prepared)
}
