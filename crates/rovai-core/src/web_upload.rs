//! Host temporary-file ingress into the existing source-reference Draft. There
//! is no new asset lifetime: after binding, Core never deletes the source file.
use crate::{
    command::*,
    db::Database,
    draft_client::DraftClient,
    local_attachment_source::{LocalAttachmentKind, LocalAttachmentSourceRef},
};
use anyhow::{Result, ensure};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeUploadPreparation {
    pub command_id: String,
    #[serde(rename = "threadId")]
    pub camp_id: String,
    pub expected_revision: i64,
    pub target: UploadTarget,
    pub source_path: String,
    pub display_name: String,
    pub media_type: Option<String>,
}

// Host 私有入口只观察本机文件，不写草稿、不登记 scope、不执行上传。
pub fn observe_native(
    client: &DraftClient,
    params: NativeUploadPreparation,
) -> Result<serde_json::Value> {
    ensure!(
        client.is_desktop(),
        "native upload requires the desktop editor"
    );
    ensure!(
        !matches!(params.target, UploadTarget::Camp),
        "native upload requires a private target"
    );
    crate::camp_id::ThreadId::parse(&params.camp_id)?;
    let id = uuid::Uuid::parse_str(&params.command_id)?;
    ensure!(
        id.hyphenated().to_string() == params.command_id,
        "invalid upload identity"
    );
    ensure!(params.expected_revision >= 0, "invalid upload revision");
    let path = std::path::Path::new(&params.source_path);
    ensure!(path.is_absolute(), "upload path must be absolute");
    let observed = crate::local_attachment_snapshot::observe_private_source(path)?;
    let source = LocalAttachmentSourceRef {
        id: params.command_id.clone(),
        source_path: params.source_path,
        display_name: crate::local_attachment_snapshot::normalize_display_name(
            &params.display_name,
        )?,
        kind: observed.kind,
        media_type: if observed.kind == LocalAttachmentKind::File {
            params
                .media_type
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        } else {
            None
        },
        observed_byte_size: (observed.kind == LocalAttachmentKind::File)
            .then_some(observed.byte_size),
    };
    let intent = UploadIntent {
        target: params.target,
        command_id: params.command_id,
        camp_id: params.camp_id,
        expected_revision: params.expected_revision,
        display_name: source.display_name.clone(),
        source_kind: observed.kind,
        byte_size: observed.byte_size,
        sha256: observed.content_digest,
    };
    Ok(json!({"intent":intent,"source":source}))
}

fn file_source_kind() -> LocalAttachmentKind {
    LocalAttachmentKind::File
}
fn is_file_source_kind(kind: &LocalAttachmentKind) -> bool {
    *kind == LocalAttachmentKind::File
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadIntent {
    #[serde(default, skip_serializing_if = "UploadTarget::is_camp")]
    pub target: UploadTarget,
    pub command_id: String,
    #[serde(rename = "threadId", alias = "campId")]
    pub camp_id: String,
    pub expected_revision: i64,
    pub display_name: String,
    pub byte_size: u64,
    pub sha256: String,
    #[serde(
        default = "file_source_kind",
        skip_serializing_if = "is_file_source_kind"
    )]
    pub source_kind: LocalAttachmentKind,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UploadTarget {
    #[default]
    Camp,
    SingleChat {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(
            rename = "composerScope",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        composer_scope: Option<crate::single_chat_composer_scope::SingleChatComposerScope>,
    },
    SingleChatPending {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "pendingInputId")]
        pending_input_id: String,
        #[serde(rename = "editToken")]
        edit_token: String,
        #[serde(
            rename = "composerScope",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        composer_scope: Option<crate::single_chat_composer_scope::SingleChatComposerScope>,
    },
}
impl UploadTarget {
    fn is_camp(&self) -> bool {
        matches!(self, Self::Camp)
    }
}

pub fn snapshot(
    database: &Database,
    _data_dir: &std::path::Path,
    client: &DraftClient,
    intent: &UploadIntent,
) -> Result<serde_json::Value> {
    match &intent.target {
        UploadTarget::Camp => {
            let recorded = reconcile(database, client, intent.clone())?
                .ok_or_else(|| anyhow::anyhow!("upload receipt is missing"))?;
            Ok(recorded.result.payload["source"].clone())
        }
        UploadTarget::SingleChat {
            conversation_id,
            composer_scope,
        }
        | UploadTarget::SingleChatPending {
            conversation_id,
            composer_scope,
            ..
        } => {
            let service = crate::single_chat::SingleChatService::for_client(client.clone());
            if let Some(scope) = composer_scope {
                let draft = crate::single_chat_composer::read_draft(
                    database,
                    client,
                    &intent.camp_id,
                    conversation_id,
                    Some(scope),
                )?;
                let key =
                    crate::single_chat_composer_scope::PrivateComposerKey::for_scope(Some(scope))?;
                let snapshot = service.snapshot_for_key(database, conversation_id, &key)?;
                let mut value = serde_json::to_value(snapshot)?;
                ensure!(!value.is_null(), "single_chat.not_found");
                value["draft"] = serde_json::to_value(draft)?;
                let editing_elsewhere: bool = database.connection().query_row(
                    "SELECT EXISTS(SELECT 1 FROM single_chat_pending_input_edit_session WHERE conversation_id=?1 AND (client_id<>?2 OR scope_key<>?3))",
                    rusqlite::params![conversation_id, client.id(), key.sql_key()], |row| row.get(0),
                )?;
                value["pendingInputs"]["editingElsewhere"] = json!(editing_elsewhere);
                return Ok(value);
            }
            let snapshot = service.snapshot(database, conversation_id)?;
            ensure!(
                snapshot
                    .as_ref()
                    .is_some_and(|view| view.conversation.camp_id == intent.camp_id),
                "single_chat.camp_mismatch"
            );
            Ok(serde_json::to_value(snapshot)?)
        }
    }
}

#[derive(Serialize)]
pub struct BindUpload {
    client: DraftClient,
    intent: UploadIntent,
}
impl sealed::Sealed for BindUpload {}
impl DomainCommand for BindUpload {
    const TYPE: &'static str = "camp.source_attachment.upload.bind";
    fn draft_client(&self) -> Option<&DraftClient> {
        Some(&self.client)
    }
}

pub(crate) fn envelope(
    client: &DraftClient,
    intent: UploadIntent,
) -> Result<CommandEnvelope<BindUpload>> {
    ensure!(
        !client.is_desktop() || !matches!(intent.target, UploadTarget::Camp),
        "public upload requires a verified Web editor"
    );
    ensure!(
        intent.source_kind == LocalAttachmentKind::File
            || (client.is_desktop() && !matches!(intent.target, UploadTarget::Camp)),
        "directory upload requires a native private target"
    );
    crate::camp_id::ThreadId::parse(&intent.camp_id)?;
    uuid::Uuid::parse_str(&intent.command_id)?;
    ensure!(
        intent.sha256.len() == 64 && intent.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid upload digest"
    );
    Ok(CommandEnvelope {
        command_id: intent.command_id.clone(),
        actor: ActorRef::User {
            user_id: crate::current_user::CURRENT_USER_ID.into(),
        },
        camp_id: Some(intent.camp_id.clone()),
        expected_versions: Vec::new(),
        execution_epoch: None,
        payload: BindUpload {
            client: client.clone(),
            intent,
        },
    })
}

pub fn reconcile(
    database: &Database,
    client: &DraftClient,
    intent: UploadIntent,
) -> Result<Option<CommandExecution>> {
    DomainCommandGateway.replay_if_recorded(database, &envelope(client, intent)?)
}

#[derive(Debug)]
struct UploadSourceRequired;
impl std::fmt::Display for UploadSourceRequired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("private_upload.source_required")
    }
}
impl std::error::Error for UploadSourceRequired {}

/// 用户明确重试：原结果优先；已知准入拒绝可直接结清，其余情况回滚并要求原源。
pub fn retry_without_source(
    database: &mut Database,
    client: &DraftClient,
    intent: UploadIntent,
) -> Result<Option<CommandExecution>> {
    ensure!(
        !matches!(&intent.target, UploadTarget::Camp),
        "private upload target required"
    );
    let envelope = envelope(client, intent)?;
    match DomainCommandGateway.execute(database, &envelope, |transaction| {
        private_binding_rejection(transaction, client, &envelope.payload.intent)?
            .ok_or_else(|| UploadSourceRequired.into())
    }) {
        Ok(execution) => Ok(Some(execution)),
        Err(error) if error.is::<UploadSourceRequired>() => Ok(None),
        Err(error) => Err(error),
    }
}

/// 用户明确结束准备：同一首次结果围栏，不修改任何已绑定材料或删除源文件。
pub fn finish_preparation(
    database: &mut Database,
    client: &DraftClient,
    intent: UploadIntent,
) -> Result<CommandExecution> {
    ensure!(
        !matches!(&intent.target, UploadTarget::Camp),
        "private upload target required"
    );
    DomainCommandGateway.execute(database, &envelope(client, intent)?, |_| {
        Ok(CommandHandlerResult::rejected(
            "attachment.upload_preparation_ended",
            json!({}),
        ))
    })
}

pub fn bind(
    database: &mut Database,
    _data_dir: &std::path::Path,
    client: &DraftClient,
    intent: UploadIntent,
    source: LocalAttachmentSourceRef,
) -> Result<CommandExecution> {
    let envelope = envelope(client, intent.clone())?;
    validate_bind_source(&intent, &source)?;
    if let Some(execution) = DomainCommandGateway.replay_if_recorded(database, &envelope)? {
        return Ok(execution);
    }
    let sources = binding_source_inputs(database, client, &intent, &source)?;
    let prepared = crate::private_source_observation::PreparedSources::capture(sources)?;
    bind_with_prepared(database, _data_dir, client, intent, source, &prepared)
}

pub(crate) fn binding_source_inputs(
    database: &Database,
    client: &DraftClient,
    intent: &UploadIntent,
    source: &LocalAttachmentSourceRef,
) -> Result<Vec<LocalAttachmentSourceRef>> {
    if matches!(intent.target, UploadTarget::Camp)
        || private_binding_rejection(database.connection(), client, intent)?.is_some()
    {
        return Ok(vec![]);
    }
    Ok(vec![source.clone()])
}

pub(crate) fn validate_bind_source(
    intent: &UploadIntent,
    source: &LocalAttachmentSourceRef,
) -> Result<()> {
    ensure!(source.id == intent.command_id, "upload reference changed");
    ensure!(
        source.display_name == intent.display_name
            && source.kind == intent.source_kind
            && match source.kind {
                LocalAttachmentKind::File => source.observed_byte_size == Some(intent.byte_size),
                LocalAttachmentKind::Directory =>
                    source.observed_byte_size.is_none() && source.media_type.is_none(),
            },
        "upload observation changed"
    );
    Ok(())
}

pub(crate) fn bind_with_prepared(
    database: &mut Database,
    _data_dir: &std::path::Path,
    client: &DraftClient,
    intent: UploadIntent,
    source: LocalAttachmentSourceRef,
    prepared: &crate::private_source_observation::PreparedSources,
) -> Result<CommandExecution> {
    let envelope = envelope(client, intent)?;
    validate_bind_source(&envelope.payload.intent, &source)?;
    DomainCommandGateway.execute(database, &envelope, |transaction| {
        let intent = &envelope.payload.intent;
        if let Some(rejected) = private_binding_rejection(transaction, client, intent)? {
            return Ok(rejected);
        }
        match &intent.target {
            UploadTarget::Camp => {
                ensure!(
                    transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM camp WHERE id = ?1)",
                        [&intent.camp_id],
                        |row| row.get::<_, bool>(0),
                    )?,
                    "camp.not_found"
                );
            }
            UploadTarget::SingleChat { composer_scope: Some(_), .. }
            | UploadTarget::SingleChatPending { composer_scope: Some(_), .. } => {
                crate::single_chat_composer::bind_uploaded_source(transaction, client, intent, source.clone())?;
            }
            UploadTarget::SingleChat { conversation_id, composer_scope: None } => {
                ensure!(transaction.query_row("SELECT EXISTS(SELECT 1 FROM conversation WHERE id=?1 AND camp_id=?2 AND kind='single_chat' AND ended_at IS NULL)", rusqlite::params![conversation_id,intent.camp_id], |r| r.get::<_, bool>(0))?, "single_chat.camp_mismatch");
                crate::single_chat::SingleChatService::for_client(client.clone()).commit_source_attachment_in_transaction(transaction, conversation_id, intent.expected_revision, source.clone(), prepared)?;
            }
            UploadTarget::SingleChatPending { conversation_id, pending_input_id, edit_token, composer_scope: None } => crate::single_chat::SingleChatService::for_client(client.clone()).commit_pending_source_attachment_in_transaction(transaction, &intent.camp_id, conversation_id, pending_input_id, intent.expected_revision, edit_token, source.clone(), prepared)?,
        }
        if let UploadTarget::SingleChat { conversation_id, .. } | UploadTarget::SingleChatPending { conversation_id, .. } = &intent.target {
            crate::private_source_observation::capture_upload(transaction,conversation_id,&source,&intent.sha256,intent.byte_size, prepared)?;
        }
        let payload = if matches!(intent.target, UploadTarget::Camp) {
            json!({"attachmentRefId":intent.command_id, "source":source})
        } else {
            json!({"attachmentRefId":intent.command_id, "draftId":client.draft_id(&intent.camp_id), "revision":intent.expected_revision+1})
        };
        Ok(CommandHandlerResult::applied("attachment.upload_bound", payload, None))
    })
}

/// 计划阶段可只读预检；最终必须在同一Gateway事务内、材料/观察写入前重新核实。
/// 存储损坏、文件读取及真正的 Handler 错误继续上抛并回滚，不能冒充业务拒绝。
fn private_binding_rejection(
    transaction: &rusqlite::Connection,
    client: &DraftClient,
    intent: &UploadIntent,
) -> Result<Option<CommandHandlerResult>> {
    let (conversation, scope, pending) = match &intent.target {
        UploadTarget::Camp => return Ok(None),
        UploadTarget::SingleChat {
            conversation_id,
            composer_scope,
        } => (conversation_id, composer_scope.as_ref(), None),
        UploadTarget::SingleChatPending {
            conversation_id,
            composer_scope,
            pending_input_id,
            edit_token,
        } => (
            conversation_id,
            composer_scope.as_ref(),
            Some((pending_input_id, edit_token)),
        ),
    };
    let rejected = |code| Some(CommandHandlerResult::rejected(code, json!({})));
    if !crate::single_chat_composer::owner_exists(transaction, &intent.camp_id, conversation, true)?
    {
        return Ok(rejected("single_chat.not_active"));
    }
    let Some((key, _)) = crate::single_chat_composer::resolve_scope(
        transaction,
        &intent.camp_id,
        conversation,
        client,
        scope,
    )?
    else {
        return Ok(rejected("single_chat.scope_unavailable"));
    };
    let refs = if let Some((pending_id, token)) = pending {
        let working: Option<String> = transaction.query_row(
            "SELECT e.working_source_attachments_json FROM single_chat_pending_input_edit_session e
             JOIN single_chat_pending_input p ON p.conversation_id=e.conversation_id AND p.id=e.pending_input_id
             WHERE e.conversation_id=?1 AND e.client_id=?2 AND e.scope_key=?3 AND e.pending_input_id=?4
               AND e.edit_token=?5 AND e.base_pending_revision=?6 AND e.recovery_required=0
               AND p.revision=?6 AND p.state IN ('queued','needs_repair')",
            rusqlite::params![conversation,client.id(),key.sql_key(),pending_id,token,intent.expected_revision], |row| row.get(0),
        ).optional()?;
        let Some(working) = working else {
            return Ok(rejected("single_chat.pending_input_edit_fenced"));
        };
        crate::local_attachment_source::parse_source_attachments(&working)?
    } else {
        let draft = crate::single_chat_composer::DraftMaterials::load(
            transaction,
            conversation,
            client,
            &key,
        )?;
        if draft.revision != intent.expected_revision {
            return Ok(Some(CommandHandlerResult::rejected(
                "single_chat.draft_changed",
                json!({"currentRevision":draft.revision}),
            )));
        }
        draft.sources()?
    };
    if refs.len() >= crate::camp_attachment::MAX_PREPARED_ATTACHMENTS {
        return Ok(rejected("attachment_count_exceeded"));
    }
    if refs.iter().any(|source| source.id == intent.command_id) {
        return Ok(rejected("attachment_reference_conflict"));
    }
    Ok(None)
}
