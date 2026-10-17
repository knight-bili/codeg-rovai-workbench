//! 终端公开操作在原 Core Owner 入口内调用，与画布生命周期及计划退出准入共用围栏。
use super::*;
use crate::canvas_terminal::{
    ReadTerminal, ResizeTerminal, StartTerminal, StopTerminal, WriteTerminal,
};
use anyhow::ensure;

impl Core {
    pub(super) async fn start_canvas_terminal(&self, request: StartTerminal) -> Result<Value> {
        let environment = self.runtime_search_environment.read().await.clone();
        let permit = self
            .planned_shutdown
            .enter_launch()
            .await
            .context("canvas_terminal.closing")?;
        let _lifecycle = self.canvas_terminals.lifecycle.lock().await;
        ensure!(
            !self.planned_shutdown.shutdown_started(),
            "canvas_terminal.closing"
        );
        let size = request.validate()?;
        let directory = {
            let database = self.database.lock().await;
            request.target.directory_path(database.connection())?
        };
        let (launch, spec) = self
            .canvas_terminals
            .prepare_launch(
                directory,
                size,
                environment,
                format!(
                    "canvas/{}/{}/{}",
                    request.target.board_id, request.target.node_id, request.request_id
                ),
            )
            .await?;
        Ok(serde_json::to_value(
            self.canvas_terminals.start(request, launch, spec, permit)?,
        )?)
    }

    pub(super) async fn read_canvas_terminal(&self, request: ReadTerminal) -> Result<Value> {
        let _lifecycle = self.canvas_terminals.lifecycle.lock().await;
        let database = self.database.lock().await;
        ensure!(
            request.target.live(database.connection())?,
            "canvas_terminal.source_unavailable"
        );
        Ok(serde_json::to_value(self.canvas_terminals.read(request)?)?)
    }

    pub(super) async fn write_canvas_terminal(&self, request: WriteTerminal) -> Result<Value> {
        let pending = {
            let _lifecycle = self.canvas_terminals.lifecycle.lock().await;
            let database = self.database.lock().await;
            ensure!(
                request.target.live(database.connection())?,
                "canvas_terminal.source_unavailable"
            );
            self.canvas_terminals.enqueue_write(request)?
        };
        Ok(serde_json::to_value(pending.wait().await?)?)
    }

    pub(super) async fn resize_canvas_terminal(&self, request: ResizeTerminal) -> Result<Value> {
        let pending = {
            let _lifecycle = self.canvas_terminals.lifecycle.lock().await;
            let database = self.database.lock().await;
            ensure!(
                request.target.live(database.connection())?,
                "canvas_terminal.source_unavailable"
            );
            self.canvas_terminals.enqueue_resize(request)?
        };
        tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .context("canvas_terminal.resize_pending")?
            .context("canvas_terminal.session_closed")??;
        Ok(json!({"resized":true}))
    }

    pub(super) async fn stop_canvas_terminal(&self, request: StopTerminal) -> Result<Value> {
        let _lifecycle = self.canvas_terminals.lifecycle.lock().await;
        {
            let database = self.database.lock().await;
            ensure!(
                request.target.live(database.connection())?,
                "canvas_terminal.source_unavailable"
            );
        }
        self.canvas_terminals.stop(request)?;
        Ok(json!({"stopping":true}))
    }
}
