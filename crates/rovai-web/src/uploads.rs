use super::*;
use axum::extract::Multipart;
use rovai_core::{
    draft_client::DraftClient, local_attachment_source::observe_source_attachment,
    web_upload::UploadIntent,
};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

pub const MAX_BYTES: usize = 20 * 1024 * 1024;

// Before binding this guard owns cleanup, including a disconnected multipart
// request. Once submitted, only a definitive Core receipt permits deletion.
struct TemporaryUpload {
    directory: PathBuf,
    retain: bool,
}
impl TemporaryUpload {
    fn create() -> Result<Self> {
        let directory = std::env::temp_dir().join(format!("rovai-web-upload-{}", new_token()?));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        }
        #[cfg(not(unix))]
        rovai_core::platform::prepare_private_directory(&directory)?;
        Ok(Self {
            directory,
            retain: false,
        })
    }
    fn path(&self) -> PathBuf {
        self.directory.join("source")
    }
}
impl Drop for TemporaryUpload {
    fn drop(&mut self) {
        if !self.retain {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

struct ReceivedUpload {
    temporary: TemporaryUpload,
    hash: String,
    size: u64,
    prefix: Vec<u8>,
}
async fn receive(mut field: axum::extract::multipart::Field<'_>) -> Result<ReceivedUpload> {
    let temporary = TemporaryUpload::create()?;
    let file = tokio::fs::File::create(temporary.path()).await?;
    let mut file = tokio::io::BufWriter::with_capacity(64 * 1024, file);
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut prefix = Vec::with_capacity(12);
    while let Some(chunk) = field.chunk().await.context("upload_too_large")? {
        size += chunk.len() as u64;
        ensure!(size <= MAX_BYTES as u64, "upload_too_large");
        prefix.extend_from_slice(&chunk[..chunk.len().min(12 - prefix.len())]);
        digest.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    Ok(ReceivedUpload {
        temporary,
        hash: format!("{:x}", digest.finalize()),
        size,
        prefix,
    })
}

pub async fn upload(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    mut multipart: Multipart,
) -> Response {
    let Ok(_permit) = state.uploads.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "upload_capacity");
    };
    let mut intent = None;
    let mut contents = None;
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_upload"),
        };
        match field.name() {
            Some("intent") if intent.is_none() => {
                let Ok(text) = field.text().await else {
                    return error(StatusCode::BAD_REQUEST, "invalid_upload");
                };
                intent = serde_json::from_str::<UploadIntent>(&text).ok();
                if intent.is_none() {
                    return error(StatusCode::BAD_REQUEST, "invalid_upload");
                }
            }
            Some("file") if contents.is_none() => {
                contents = match receive(field).await {
                    Ok(upload) => Some(upload),
                    Err(failure) => {
                        return if failure.to_string() == "upload_too_large" {
                            error(StatusCode::PAYLOAD_TOO_LARGE, "upload_too_large")
                        } else {
                            error(StatusCode::BAD_REQUEST, "invalid_upload")
                        };
                    }
                };
            }
            _ => return error(StatusCode::BAD_REQUEST, "invalid_upload"),
        }
    }
    let (Some(intent), Some(contents)) = (intent, contents) else {
        return error(StatusCode::BAD_REQUEST, "invalid_upload");
    };
    if contents.hash != intent.sha256
        || contents.size != intent.byte_size
        || !state.sessions.is_live(&session)
    {
        return error(StatusCode::BAD_REQUEST, "upload_changed_or_session_expired");
    }
    let client = DraftClient::verified_web(&session.client_id).expect("Host editor identity");
    // A replay discards its unbound spool through the guard; it never rebinds it.
    if let Ok(reply) = state
        .core
        .request_for_editor("host.upload.receipt", json!(intent), client.clone())
        .await
    {
        if reply.error.is_some() {
            return error(StatusCode::CONFLICT, "upload_conflict");
        }
        if reply
            .result
            .as_ref()
            .is_some_and(|result| !result["receipt"].is_null())
        {
            if reply
                .result
                .as_ref()
                .is_some_and(|result| result["receipt"]["status"] == "rejected")
            {
                return error(StatusCode::CONFLICT, "upload_rejected");
            }
            return upload_draft(&state, &intent, &client).await;
        }
    } else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "core_unavailable");
    }
    // Cancellation of the HTTP handler must not remove a possibly-bound source.
    // The task owns cleanup until Core returns a definitive binding result.
    let task = tokio::spawn(async move {
        let _permit = _permit;
        let mut temporary = contents.temporary;
        let path = temporary.path();
        async {
            let media = if contents.prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
                Some("image/png")
            } else if contents.prefix.starts_with(b"\xff\xd8\xff") {
                Some("image/jpeg")
            } else if contents.prefix.starts_with(b"RIFF")
                && contents.prefix.get(8..12) == Some(b"WEBP")
            {
                Some("image/webp")
            } else {
                None
            };
            let mut source = observe_source_attachment(&path, &intent.display_name, media)?;
            source.id = intent.command_id.clone();
            temporary.retain = true;
            let reply = state
                .core
                .request_for_editor(
                    "host.upload.bind",
                    json!({"intent":intent,"source":source}),
                    client.clone(),
                )
                .await;
            match reply {
                Ok(reply) if reply.error.is_none() => {
                    let result = reply.result.context("upload binding result missing")?;
                    if result["receipt"]["status"] == "rejected" {
                        temporary.retain = false;
                        return Ok(error(StatusCode::CONFLICT, "upload_rejected"));
                    }
                    // A replay belongs to its original file, so this duplicate
                    // never became a source and can be cleaned.
                    if result["replayed"] == true {
                        temporary.retain = false;
                    }
                    Ok::<_, anyhow::Error>(
                        Json(json!({"draft":project_upload(&intent, result["draft"].clone())}))
                            .into_response(),
                    )
                }
                Ok(_) => {
                    // Core can report a post-commit error. Consult the canonical
                    // receipt before deciding whether the file is still unbound.
                    if let Ok(receipt) = state
                        .core
                        .request_for_editor("host.upload.receipt", json!(intent), client.clone())
                        .await
                    {
                        if receipt.error.is_none()
                            && receipt
                                .result
                                .as_ref()
                                .is_some_and(|value| value["receipt"].is_null())
                        {
                            temporary.retain = false;
                            return Ok(error(StatusCode::CONFLICT, "draft_changed"));
                        }
                        if receipt.error.is_none() {
                            if receipt
                                .result
                                .as_ref()
                                .is_some_and(|value| value["receipt"]["status"] == "rejected")
                            {
                                temporary.retain = false;
                                return Ok(error(StatusCode::CONFLICT, "upload_rejected"));
                            }
                            return Ok(upload_draft(&state, &intent, &client).await);
                        }
                    }
                    Ok(error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "upload_binding_unknown",
                    ))
                }
                Err(_) => Ok(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upload_binding_unknown",
                )),
            }
        }
        .await
    });
    match task.await {
        Ok(Ok(response)) => response,
        _ => error(StatusCode::SERVICE_UNAVAILABLE, "upload_binding_unknown"),
    }
}

async fn upload_draft(state: &WebState, intent: &UploadIntent, client: &DraftClient) -> Response {
    match state
        .core
        .request_for_editor(
            "host.upload.reconcile",
            json!(intent),
            client.clone(),
        )
        .await
    {
        Ok(reply) if reply.error.is_none() => Json(json!({"draft":project_upload(intent, reply.result.unwrap_or_default()["draft"].take())})).into_response(),
        _ => error(StatusCode::SERVICE_UNAVAILABLE, "upload_binding_unknown"),
    }
}

pub async fn reconcile(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Json(intent): Json<UploadIntent>,
) -> Response {
    let client = DraftClient::verified_web(&session.client_id).expect("Host editor identity");
    match state
        .core
        .request_for_editor("host.upload.receipt", json!(intent), client.clone())
        .await
    {
        Ok(reply) if reply.error.is_none() => {
            if reply
                .result
                .as_ref()
                .is_some_and(|value| !value["receipt"].is_null())
            {
                if reply
                    .result
                    .as_ref()
                    .is_some_and(|value| value["receipt"]["status"] == "rejected")
                {
                    return error(StatusCode::CONFLICT, "upload_rejected");
                }
                upload_draft(&state, &intent, &client).await
            } else {
                Json(json!({"state":"unknown"})).into_response()
            }
        }
        _ => error(StatusCode::CONFLICT, "upload_conflict"),
    }
}

/// 只返回原请求的安全结果字段，不查询当前草稿或泄漏旧公开上传的 sourcePath。
pub async fn receipt(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Json(intent): Json<UploadIntent>,
) -> Response {
    if matches!(&intent.target, rovai_core::web_upload::UploadTarget::Camp) {
        return error(StatusCode::BAD_REQUEST, "invalid_upload");
    }
    let client = DraftClient::verified_web(&session.client_id).expect("Host editor identity");
    match state
        .core
        .request_for_editor("host.upload.receipt", json!(intent), client)
        .await
    {
        Ok(reply) if reply.error.is_none() => {
            let value = reply.result.unwrap_or_default()["receipt"].take();
            receipt_response(value, "unknown")
        }
        _ => error(StatusCode::SERVICE_UNAVAILABLE, "upload_binding_unknown"),
    }
}

pub async fn retry(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Json(intent): Json<UploadIntent>,
) -> Response {
    resolve_preparation(state, session, intent, false).await
}

pub async fn finish(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Json(intent): Json<UploadIntent>,
) -> Response {
    resolve_preparation(state, session, intent, true).await
}

async fn resolve_preparation(
    state: WebState,
    session: Arc<Session>,
    intent: UploadIntent,
    finish: bool,
) -> Response {
    if matches!(&intent.target, rovai_core::web_upload::UploadTarget::Camp) {
        return error(StatusCode::BAD_REQUEST, "invalid_upload");
    }
    let client = DraftClient::verified_web(&session.client_id).expect("Host editor identity");
    let method = if finish {
        "host.upload.finish"
    } else {
        "host.upload.retry"
    };
    match state
        .core
        .request_for_editor(method, json!(intent), client)
        .await
    {
        Ok(reply) if reply.error.is_none() => receipt_response(
            reply.result.unwrap_or_default()["receipt"].take(),
            if finish { "unknown" } else { "needs_source" },
        ),
        _ => error(StatusCode::SERVICE_UNAVAILABLE, "upload_binding_unknown"),
    }
}

fn receipt_response(value: serde_json::Value, empty_state: &str) -> Response {
    if value.is_null() {
        Json(json!({"state":empty_state})).into_response()
    } else {
        let payload = if value["status"] == "rejected" {
            json!({})
        } else {
            json!({"attachmentRefId":value["payload"]["attachmentRefId"],"revision":value["payload"]["revision"]})
        };
        Json(json!({"state":"recorded","receipt":{
                    "commandId":value["commandId"],"commandType":value["commandType"],"status":value["status"],
                    "code":value["code"],"payload":payload,"resultEntity":null,"recordedAt":value["recordedAt"]
                }})).into_response()
    }
}

fn project_upload(intent: &UploadIntent, value: serde_json::Value) -> serde_json::Value {
    use rovai_core::web_upload::UploadTarget;
    let operation = match intent.target {
        UploadTarget::Camp => return value,
        UploadTarget::SingleChat { .. } | UploadTarget::SingleChatPending { .. } => {
            operations::Operation::SingleChatGet
        }
    };
    operation.project(value)
}
