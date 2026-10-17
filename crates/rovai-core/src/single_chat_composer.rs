//! 私聊卡片材料、完整保留输入与有界恢复。正文编辑器仍拥有本机活动正文。
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use uuid::Uuid;

static CURSOR_KEY: OnceLock<[u8; 32]> = OnceLock::new();

fn cursor_key() -> Result<ring::hmac::Key> {
    let bytes = if let Some(bytes) = CURSOR_KEY.get() {
        bytes
    } else {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("single_chat.cursor_unavailable"))?;
        CURSOR_KEY.get_or_init(|| bytes)
    };
    Ok(ring::hmac::Key::new(ring::hmac::HMAC_SHA256, bytes))
}

fn encode_cursor(cursor: &RecoveryCursor) -> Result<String> {
    let payload = serde_json::to_vec(cursor)?;
    let tag = ring::hmac::sign(&cursor_key()?, &payload);
    Ok(format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(tag.as_ref())
    ))
}

fn decode_cursor(value: &str) -> Result<RecoveryCursor> {
    ensure!(value.len() <= 4096, "single_chat.cursor_invalid");
    let (payload, tag) = value
        .split_once('.')
        .context("single_chat.cursor_invalid")?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload)
        .context("single_chat.cursor_invalid")?;
    let tag = URL_SAFE_NO_PAD
        .decode(tag)
        .context("single_chat.cursor_invalid")?;
    ring::hmac::verify(&cursor_key()?, &payload, &tag)
        .map_err(|_| anyhow::anyhow!("single_chat.cursor_invalid"))?;
    serde_json::from_slice(&payload).context("single_chat.cursor_invalid")
}

use crate::{
    collaboration::append_domain_event,
    command::{
        ActorRef, CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, EntityReference, sealed,
    },
    db::Database,
    draft_client::DraftClient,
    local_attachment_source::{
        LocalAttachmentSourceRef, LocalAttachmentSourceView, parse_source_attachments,
        serialize_source_attachments,
    },
    message_quote::{MessageQuoteSnapshot, QuoteAction, parse_quotes, prepare_quote_mutation},
    single_chat::{SingleChatComposerDraftView, source_attachment_views},
    single_chat_composer_scope::{PrivateComposerKey, SingleChatComposerScope},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PrivateComposerAction {
    RegisterScope,
    RemoveAttachment {
        #[serde(rename = "attachmentRefId")]
        attachment_ref_id: String,
    },
    ReorderAttachments {
        #[serde(rename = "attachmentRefIds")]
        attachment_ref_ids: Vec<String>,
    },
    Quote {
        action: QuoteAction,
    },
    SwapRetained {
        #[serde(rename = "retainedInputId")]
        retained_input_id: String,
        #[serde(rename = "expectedRetainedRevision")]
        expected_retained_revision: i64,
        #[serde(rename = "currentBody")]
        current_body: String,
    },
    DiscardRetained {
        #[serde(rename = "retainedInputId")]
        retained_input_id: String,
        #[serde(rename = "expectedRetainedRevision")]
        expected_retained_revision: i64,
    },
    AdoptLegacyMaterials {
        #[serde(rename = "expectedSourceRevision")]
        expected_source_revision: i64,
        #[serde(rename = "targetBody")]
        target_body: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutatePrivateComposerCommand {
    #[serde(
        default,
        skip_deserializing,
        skip_serializing_if = "DraftClient::is_desktop"
    )]
    pub draft_client: DraftClient,
    #[serde(
        rename = "threadId",
        alias = "campId",
        deserialize_with = "crate::camp_id::deserialize_camp_id_string"
    )]
    pub camp_id: String,
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_scope: Option<SingleChatComposerScope>,
    pub expected_draft_revision: i64,
    pub action: PrivateComposerAction,
}
impl sealed::Sealed for MutatePrivateComposerCommand {}
impl DomainCommand for MutatePrivateComposerCommand {
    const TYPE: &'static str = "single_chat.composer_draft.mutate";
    fn draft_client(&self) -> Option<&DraftClient> {
        Some(&self.draft_client)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedPrivateDraftView {
    #[serde(flatten)]
    pub draft: SingleChatComposerDraftView,
    pub scope_version: u32,
    pub scope_key: String,
    pub composer_scope: Option<SingleChatComposerScope>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateScopeEntry {
    pub scope_key: String,
    pub composer_scope: Option<SingleChatComposerScope>,
    pub orphaned: bool,
    pub draft_revision: i64,
    pub attachment_count: usize,
    pub quote_count: usize,
    pub retained_input_count: usize,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedPrivateInput {
    pub id: String,
    pub conversation_id: String,
    pub scope_key: String,
    pub revision: i64,
    pub body: String,
    pub attachments: Vec<LocalAttachmentSourceView>,
    pub quotes: Vec<MessageQuoteSnapshot>,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrivateRecoveryItem {
    Scope { scope: PrivateScopeEntry },
    Retained { input: RetainedPrivateInput },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateRecoveryResult {
    pub items: Vec<PrivateRecoveryItem>,
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub through_global_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateRecoveryParams {
    #[serde(
        rename = "threadId",
        alias = "campId",
        deserialize_with = "crate::camp_id::deserialize_camp_id_string"
    )]
    pub camp_id: String,
    pub conversation_id: String,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryCursor {
    version: u32,
    thread_id: String,
    conversation_id: String,
    client_id: String,
    state_digest: String,
    after_kind: u8,
    after_key: String,
}

#[derive(Debug, Clone)]
pub(crate) struct DraftMaterials {
    pub revision: i64,
    pub source_json: String,
    pub quotes_json: String,
    pub trash_json: String,
    pub updated_at: Option<String>,
}
impl Default for DraftMaterials {
    fn default() -> Self {
        Self {
            revision: 0,
            source_json: "[]".into(),
            quotes_json: "[]".into(),
            trash_json: "[]".into(),
            updated_at: None,
        }
    }
}
impl DraftMaterials {
    pub(crate) fn load(
        connection: &Connection,
        conversation: &str,
        client: &DraftClient,
        key: &PrivateComposerKey,
    ) -> Result<Self> {
        Ok(connection.query_row("SELECT revision,source_attachments_json,quotes_json,quote_trash_json,updated_at
            FROM single_chat_composer_draft WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3",
            params![conversation,client.id(),key.sql_key()], |row| Ok(Self {
                revision:row.get(0)?,source_json:row.get(1)?,quotes_json:row.get(2)?,trash_json:row.get(3)?,updated_at:Some(row.get(4)?),
            })).optional()?.unwrap_or_default())
    }
    pub(crate) fn sources(&self) -> Result<Vec<LocalAttachmentSourceRef>> {
        parse_source_attachments(&self.source_json)
    }
    pub(crate) fn quotes(&self) -> Result<Vec<MessageQuoteSnapshot>> {
        parse_quotes(&self.quotes_json)
    }
    fn has_materials(&self) -> Result<bool> {
        Ok(!self.sources()?.is_empty()
            || !self.quotes()?.is_empty()
            || !serde_json::from_str::<Vec<serde_json::Value>>(&self.trash_json)?.is_empty())
    }
    pub(crate) fn view(
        &self,
        key: &PrivateComposerKey,
        scope: Option<&SingleChatComposerScope>,
    ) -> Result<ScopedPrivateDraftView> {
        Ok(ScopedPrivateDraftView {
            draft: SingleChatComposerDraftView {
                quotes: self.quotes()?,
                revision: self.revision,
                attachments: source_attachment_views(&self.source_json)?,
                updated_at: self.updated_at.clone(),
            },
            scope_version: 1,
            scope_key: key.sql_key().into(),
            composer_scope: scope.cloned(),
        })
    }
    fn store(
        &self,
        tx: &Transaction<'_>,
        conversation: &str,
        client: &DraftClient,
        key: &PrivateComposerKey,
    ) -> Result<()> {
        let next = self
            .revision
            .checked_add(1)
            .context("single_chat.revision_exhausted")?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed=tx.execute("UPDATE single_chat_composer_draft SET revision=?4,source_attachments_json=?5,quotes_json=?6,quote_trash_json=?7,updated_at=?8
            WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3 AND revision=?9",
            params![conversation,client.id(),key.sql_key(),next,self.source_json,self.quotes_json,self.trash_json,now,self.revision])?;
        if changed == 0 {
            ensure!(self.revision == 0, "single_chat.draft_changed");
            tx.execute("INSERT INTO single_chat_composer_draft(conversation_id,client_id,scope_key,revision,source_attachments_json,quotes_json,quote_trash_json,updated_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![conversation,client.id(),key.sql_key(),next,self.source_json,self.quotes_json,self.trash_json,now])?;
        }
        Ok(())
    }
}

pub(crate) fn owner_exists(
    connection: &Connection,
    thread: &str,
    conversation: &str,
    active: bool,
) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation JOIN camp ON camp.id=conversation.camp_id
        WHERE conversation.id=?1 AND conversation.camp_id=?2 AND conversation.kind='single_chat'
          AND camp.deletion_operation_id IS NULL
          AND (?3=0 OR (conversation.ended_at IS NULL AND camp.activation_state='active')))",
        params![conversation, thread, active],
        |row| row.get(0),
    )?)
}

pub(crate) fn resolve_scope(
    connection: &Connection,
    thread: &str,
    conversation: &str,
    client: &DraftClient,
    scope: Option<&SingleChatComposerScope>,
) -> Result<Option<(PrivateComposerKey, bool)>> {
    let key = PrivateComposerKey::for_scope(scope)?;
    let Some(scope) = scope else {
        return Ok(Some((key, true)));
    };
    let registered=connection.query_row("SELECT board_id,node_id FROM single_chat_composer_scope WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3",
        params![conversation,client.id(),key.sql_key()],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional()?;
    if let Some((board_id, node_id)) = registered {
        ensure!(
            *scope == SingleChatComposerScope::Canvas { board_id, node_id },
            "single_chat.scope_corrupt"
        );
        Ok(Some((key, true)))
    } else if scope.matches_current_pin(connection, thread, conversation)? {
        Ok(Some((key, false)))
    } else {
        Ok(None)
    }
}

pub(crate) fn register(
    tx: &Transaction<'_>,
    conversation: &str,
    client: &DraftClient,
    scope: Option<&SingleChatComposerScope>,
    key: &PrivateComposerKey,
    registered: bool,
) -> Result<()> {
    if !registered && let Some(SingleChatComposerScope::Canvas { board_id, node_id }) = scope {
        tx.execute("INSERT INTO single_chat_composer_scope(conversation_id,client_id,scope_key,board_id,node_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
            params![conversation,client.id(),key.sql_key(),board_id,node_id,chrono::Utc::now().to_rfc3339()])?;
    }
    Ok(())
}

pub fn read_draft(
    database: &Database,
    client: &DraftClient,
    thread: &str,
    conversation: &str,
    scope: Option<&SingleChatComposerScope>,
) -> Result<ScopedPrivateDraftView> {
    let tx = database.connection().unchecked_transaction()?;
    ensure!(
        owner_exists(&tx, thread, conversation, false)?,
        "single_chat.not_found"
    );
    let (key, _) = resolve_scope(&tx, thread, conversation, client, scope)?
        .context("single_chat.scope_unavailable")?;
    let view = DraftMaterials::load(&tx, conversation, client, &key)?.view(&key, scope)?;
    tx.commit()?;
    Ok(view)
}

/// 调用方已在同一写事务核对排队项版本、归属和无未完成编辑。
pub(crate) fn return_pending_input(
    tx: &Transaction<'_>,
    command: &crate::single_chat::EditSingleChatPendingInputCommand,
    key: &PrivateComposerKey,
    registered: bool,
    body: &str,
    source_json: &str,
    quotes_json: &str,
    prepared: &crate::private_source_observation::PreparedSources,
) -> Result<CommandHandlerResult> {
    let crate::single_chat::SingleChatPendingInputEditAction::ReturnToComposer {
        expected_draft_revision,
        target_body,
    } = &command.action
    else {
        anyhow::bail!("single_chat.invalid_return_action");
    };
    let Some(target_body) = target_body else {
        return Ok(CommandHandlerResult::rejected(
            "single_chat.capability_required",
            json!({}),
        ));
    };
    let client = &command.draft_client;
    let current = DraftMaterials::load(tx, &command.conversation_id, client, key)?;
    if current.revision != *expected_draft_revision {
        return Ok(CommandHandlerResult::rejected(
            "single_chat.draft_changed",
            json!({"currentRevision":current.revision}),
        ));
    }
    if let Some(id) = crate::private_source_observation::capture_sources(
        tx,
        &command.conversation_id,
        &parse_source_attachments(source_json)?,
        prepared,
    )? {
        return Ok(CommandHandlerResult::rejected(
            "single_chat.attachment_source_changed",
            json!({"attachmentRefId":id,"message":"附件源文件已变化，请先编辑排队消息。"}),
        ));
    }
    let occupied = !target_body.trim().is_empty() || current.has_materials()?;
    register(
        tx,
        &command.conversation_id,
        client,
        command.composer_scope.as_ref(),
        key,
        registered,
    )?;
    let mut retained_id = None;
    if occupied {
        let id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO single_chat_retained_input(id,conversation_id,client_id,scope_key,body,source_attachments_json,quotes_json,quote_trash_json,source_pending_id,created_at,updated_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,'[]',?8,?9,?9)",
            params![id,command.conversation_id,client.id(),key.sql_key(),body,source_json,quotes_json,command.pending_input_id,chrono::Utc::now().to_rfc3339()])?;
        retained_id = Some(id);
    } else {
        DraftMaterials {
            source_json: source_json.into(),
            quotes_json: quotes_json.into(),
            trash_json: "[]".into(),
            ..current
        }
        .store(tx, &command.conversation_id, client, key)?;
    }
    let changed = tx.execute(
        "UPDATE single_chat_pending_input SET state='cancelled',revision=revision+1,updated_at=?4
        WHERE conversation_id=?1 AND id=?2 AND revision=?3 AND state IN ('queued','needs_repair')",
        params![
            command.conversation_id,
            command.pending_input_id,
            command.expected_revision,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    ensure!(changed == 1, "single_chat.pending_input_changed");
    let draft = DraftMaterials::load(tx, &command.conversation_id, client, key)?
        .view(key, command.composer_scope.as_ref())?;
    let mut payload = json!({"pendingInputId":command.pending_input_id,"body":body,"draft":draft,
        "placement":if occupied {"retained"} else {"active"}});
    if let Some(id) = retained_id {
        payload["retainedInput"] = serde_json::to_value(
            load_retained(tx, &command.conversation_id, client, key.sql_key(), &id)?
                .context("single_chat.retained_not_found")?
                .view(&command.conversation_id, key.sql_key())?,
        )?;
    }
    Ok(CommandHandlerResult::applied(
        "single_chat.pending_input_returned_to_composer",
        payload,
        None,
    ))
}

#[derive(Debug, Clone)]
struct StoredRetained {
    id: String,
    revision: i64,
    body: String,
    materials: DraftMaterials,
}
fn load_retained(
    connection: &Connection,
    conversation: &str,
    client: &DraftClient,
    key: &str,
    id: &str,
) -> Result<Option<StoredRetained>> {
    Ok(connection.query_row("SELECT id,revision,body,source_attachments_json,quotes_json,quote_trash_json,updated_at FROM single_chat_retained_input
        WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3 AND id=?4",params![conversation,client.id(),key,id],|row|Ok(StoredRetained {
            id:row.get(0)?,revision:row.get(1)?,body:row.get(2)?,materials:DraftMaterials {revision:0,source_json:row.get(3)?,quotes_json:row.get(4)?,trash_json:row.get(5)?,updated_at:Some(row.get(6)?)},
        })).optional()?)
}
impl StoredRetained {
    fn view(&self, conversation: &str, key: &str) -> Result<RetainedPrivateInput> {
        Ok(RetainedPrivateInput {
            id: self.id.clone(),
            conversation_id: conversation.into(),
            scope_key: key.into(),
            revision: self.revision,
            body: self.body.clone(),
            attachments: source_attachment_views(&self.materials.source_json)?,
            quotes: self.materials.quotes()?,
            updated_at: self
                .materials
                .updated_at
                .clone()
                .context("single_chat.retained_corrupt")?,
        })
    }
}

// 只由可信 Host 上传入口调用，来源文件及内容已由 Host 接收并校验。
pub(crate) fn bind_uploaded_source(
    tx: &Transaction<'_>,
    client: &DraftClient,
    intent: &crate::web_upload::UploadIntent,
    source: LocalAttachmentSourceRef,
) -> Result<()> {
    let (conversation, scope, pending) = match &intent.target {
        crate::web_upload::UploadTarget::SingleChat {
            conversation_id,
            composer_scope: Some(scope),
        } => (conversation_id, scope, None),
        crate::web_upload::UploadTarget::SingleChatPending {
            conversation_id,
            pending_input_id,
            edit_token,
            composer_scope: Some(scope),
        } => (conversation_id, scope, Some((pending_input_id, edit_token))),
        _ => anyhow::bail!("single_chat.scope_required"),
    };
    ensure!(
        owner_exists(tx, &intent.camp_id, conversation, true)?,
        "single_chat.not_active"
    );
    let (key, registered) = resolve_scope(tx, &intent.camp_id, conversation, client, Some(scope))?
        .context("single_chat.scope_unavailable")?;
    crate::local_attachment_source::validate_source_attachment(&source)
        .map_err(anyhow::Error::new)?;
    if let Some((pending_id, token)) = pending {
        let working: Option<String> = tx.query_row(
            "SELECT e.working_source_attachments_json FROM single_chat_pending_input_edit_session e
             JOIN single_chat_pending_input p ON p.conversation_id=e.conversation_id AND p.id=e.pending_input_id
             WHERE e.conversation_id=?1 AND e.client_id=?2 AND e.scope_key=?3 AND e.pending_input_id=?4
               AND e.edit_token=?5 AND e.base_pending_revision=?6 AND e.recovery_required=0
               AND p.revision=?6 AND p.state IN ('queued','needs_repair')",
            params![conversation,client.id(),key.sql_key(),pending_id,token,intent.expected_revision], |row| row.get(0),
        ).optional()?;
        let mut refs =
            parse_source_attachments(&working.context("single_chat.pending_input_edit_fenced")?)?;
        ensure!(
            refs.len() < crate::camp_attachment::MAX_PREPARED_ATTACHMENTS,
            "attachment_count_exceeded"
        );
        ensure!(
            !refs.iter().any(|item| item.id == source.id),
            "attachment_reference_conflict"
        );
        refs.push(source);
        let changed = tx.execute(
            "UPDATE single_chat_pending_input_edit_session SET working_source_attachments_json=?7
             WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3 AND pending_input_id=?4
               AND edit_token=?5 AND base_pending_revision=?6 AND recovery_required=0",
            params![
                conversation,
                client.id(),
                key.sql_key(),
                pending_id,
                token,
                intent.expected_revision,
                serialize_source_attachments(&refs)?
            ],
        )?;
        ensure!(changed == 1, "single_chat.pending_input_edit_fenced");
    } else {
        let mut draft = DraftMaterials::load(tx, conversation, client, &key)?;
        ensure!(
            draft.revision == intent.expected_revision,
            "single_chat.draft_changed"
        );
        let mut refs = draft.sources()?;
        ensure!(
            refs.len() < crate::camp_attachment::MAX_PREPARED_ATTACHMENTS,
            "attachment_count_exceeded"
        );
        ensure!(
            !refs.iter().any(|item| item.id == source.id),
            "attachment_reference_conflict"
        );
        refs.push(source);
        draft.source_json = serialize_source_attachments(&refs)?;
        register(tx, conversation, client, Some(scope), &key, registered)?;
        draft.store(tx, conversation, client, &key)?;
    }
    Ok(())
}

pub fn mutate(
    database: &mut Database,
    envelope: &CommandEnvelope<MutatePrivateComposerCommand>,
) -> Result<CommandExecution> {
    if let Some(execution) = DomainCommandGateway.replay_if_recorded(database, envelope)? {
        return Ok(execution);
    }
    let prepared = crate::private_source_observation::PreparedSources::capture(
        mutation_source_inputs(database, envelope)?,
    )?;
    mutate_with_prepared_sources(database, envelope, &prepared)
}

pub(crate) fn mutation_source_inputs(
    database: &Database,
    envelope: &CommandEnvelope<MutatePrivateComposerCommand>,
) -> Result<Vec<LocalAttachmentSourceRef>> {
    let command = &envelope.payload;
    let PrivateComposerAction::AdoptLegacyMaterials {
        expected_source_revision,
        ..
    } = &command.action
    else {
        return Ok(vec![]);
    };
    let connection = database.connection();
    if !matches!(envelope.actor, ActorRef::User { .. })
        || !owner_exists(connection, &command.camp_id, &command.conversation_id, true)?
    {
        return Ok(vec![]);
    }
    let Some((key, _)) = resolve_scope(
        connection,
        &command.camp_id,
        &command.conversation_id,
        &command.draft_client,
        command.composer_scope.as_ref(),
    )?
    else {
        return Ok(vec![]);
    };
    let current = DraftMaterials::load(
        connection,
        &command.conversation_id,
        &command.draft_client,
        &key,
    )?;
    let legacy = DraftMaterials::load(
        connection,
        &command.conversation_id,
        &command.draft_client,
        &PrivateComposerKey::default(),
    )?;
    if current.revision != command.expected_draft_revision
        || legacy.revision != *expected_source_revision
        || key.sql_key().is_empty()
    {
        return Ok(vec![]);
    }
    legacy.sources()
}

pub(crate) fn mutate_with_prepared_sources(
    database: &mut Database,
    envelope: &CommandEnvelope<MutatePrivateComposerCommand>,
    prepared: &crate::private_source_observation::PreparedSources,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database,envelope,|tx| {
        let command=&envelope.payload;
        let client=&command.draft_client;
        if !matches!(envelope.actor,ActorRef::User {..}) || envelope.camp_id.as_deref()!=Some(&command.camp_id)
            || !owner_exists(tx,&command.camp_id,&command.conversation_id,true)? {
            return Ok(CommandHandlerResult::rejected("single_chat.not_active",json!({})));
        }
        let Some((key,registered))=resolve_scope(tx,&command.camp_id,&command.conversation_id,client,command.composer_scope.as_ref())? else {
            return Ok(CommandHandlerResult::rejected("single_chat.scope_unavailable",json!({})));
        };
        let current=DraftMaterials::load(tx,&command.conversation_id,client,&key)?;
        let mut scope_registered=registered;
        if current.revision!=command.expected_draft_revision {
            return Ok(CommandHandlerResult::rejected("single_chat.draft_changed",json!({"currentRevision":current.revision})));
        }
        let mut body=None;
        let mut retained=None;
        let mut next=current.clone();
        let mut write=false;
        let mut legacy=None;
        match &command.action {
            PrivateComposerAction::RegisterScope => {},
            PrivateComposerAction::RemoveAttachment {attachment_ref_id} => {
                let mut refs=current.sources()?; let count=refs.len();refs.retain(|r|r.id!=*attachment_ref_id);
                if refs.len()==count {return Ok(CommandHandlerResult::rejected("attachment_not_found",json!({})));}
                next.source_json=serialize_source_attachments(&refs)?;write=true;
            },
            PrivateComposerAction::ReorderAttachments {attachment_ref_ids} => {
                let refs=current.sources()?;
                let mut ordered=Vec::new();
                for id in attachment_ref_ids {
                    let Some(found)=refs.iter().find(|r|r.id==*id) else {return Ok(CommandHandlerResult::rejected("attachment_not_found",json!({})));};
                    if ordered.iter().any(|r:&LocalAttachmentSourceRef|r.id==*id) {return Ok(CommandHandlerResult::rejected("attachment_order_invalid",json!({})));}
                    ordered.push(found.clone());
                }
                if ordered.len()!=refs.len() {return Ok(CommandHandlerResult::rejected("attachment_order_invalid",json!({})));}
                next.source_json=serialize_source_attachments(&ordered)?;write=true;
            },
            PrivateComposerAction::Quote {action} => {
                match prepare_quote_mutation(tx,&command.camp_id,Some(&command.conversation_id),current.quotes()?,&current.trash_json,action) {
                    Ok((quotes,trash)) => {next.quotes_json=serde_json::to_string(&quotes)?;next.trash_json=trash;write=true;},
                    Err(error) => {
                        if error.downcast_ref::<rusqlite::Error>().is_some() {return Err(error);}
                        let reason=error.to_string();
                        let code=if reason.starts_with("quote.") && reason.len()<=80 && reason.bytes().all(|b|b.is_ascii_lowercase() || b==b'_' || b==b'.') {reason} else {"quote.invalid_snapshot".into()};
                        return Ok(CommandHandlerResult::rejected(code,json!({})));
                    }
                }
            },
            PrivateComposerAction::SwapRetained {retained_input_id,expected_retained_revision,current_body} => {
                let Some(saved)=load_retained(tx,&command.conversation_id,client,key.sql_key(),retained_input_id)? else {
                    return Ok(CommandHandlerResult::rejected("single_chat.retained_not_found",json!({})));};
                if saved.revision!=*expected_retained_revision {return Ok(CommandHandlerResult::rejected("single_chat.retained_changed",json!({"currentRevision":saved.revision})));}
                let revision=saved.revision.checked_add(1).context("single_chat.revision_exhausted")?;
                let changed=tx.execute("UPDATE single_chat_retained_input SET revision=?5,body=?6,source_attachments_json=?7,quotes_json=?8,quote_trash_json=?9,source_pending_id=NULL,updated_at=?10
                    WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3 AND id=?4 AND revision=?11",
                    params![command.conversation_id,client.id(),key.sql_key(),saved.id,revision,current_body,current.source_json,current.quotes_json,current.trash_json,chrono::Utc::now().to_rfc3339(),saved.revision])?;
                ensure!(changed==1,"single_chat.retained_changed");
                body=Some(saved.body); next.source_json=saved.materials.source_json;next.quotes_json=saved.materials.quotes_json;next.trash_json=saved.materials.trash_json;write=true;
                retained=Some(saved.id);
            },
            PrivateComposerAction::DiscardRetained {retained_input_id,expected_retained_revision} => {
                let Some(saved)=load_retained(tx,&command.conversation_id,client,key.sql_key(),retained_input_id)? else {return Ok(CommandHandlerResult::rejected("single_chat.retained_not_found",json!({})));};
                if saved.revision!=*expected_retained_revision {return Ok(CommandHandlerResult::rejected("single_chat.retained_changed",json!({"currentRevision":saved.revision})));}
                let changed=tx.execute("DELETE FROM single_chat_retained_input WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3 AND id=?4 AND revision=?5",params![command.conversation_id,client.id(),key.sql_key(),saved.id,saved.revision])?;
                ensure!(changed==1,"single_chat.retained_changed");
            },
            PrivateComposerAction::AdoptLegacyMaterials {expected_source_revision,target_body} => {
                if key.sql_key().is_empty() {return Ok(CommandHandlerResult::rejected("single_chat.scope_must_differ",json!({})));}
                let source=DraftMaterials::load(tx,&command.conversation_id,client,&PrivateComposerKey::default())?;
                if source.revision!=*expected_source_revision {return Ok(CommandHandlerResult::rejected("single_chat.draft_changed",json!({"currentRevision":source.revision})));}
                if !source.has_materials()? {return Ok(CommandHandlerResult::rejected("single_chat.no_legacy_materials",json!({})));}
                if let Some(id)=crate::private_source_observation::capture_sources(tx,&command.conversation_id,&source.sources()?, prepared)? {
                    return Ok(CommandHandlerResult::rejected("single_chat.attachment_source_changed",json!({"attachmentRefId":id,"message":"旧材料源文件已变化或不可读，请重新选择。"})));
                }
                register(tx,&command.conversation_id,client,command.composer_scope.as_ref(),&key,registered)?;
                scope_registered=true;
                if !target_body.trim().is_empty() || current.has_materials()? {
                    let id=Uuid::new_v4().to_string();
                    tx.execute("INSERT INTO single_chat_retained_input(id,conversation_id,client_id,scope_key,body,source_attachments_json,quotes_json,quote_trash_json,created_at,updated_at)
                        VALUES(?1,?2,?3,?4,'',?5,?6,?7,?8,?8)",params![id,command.conversation_id,client.id(),key.sql_key(),source.source_json,source.quotes_json,source.trash_json,chrono::Utc::now().to_rfc3339()])?;
                    retained=Some(id);
                } else { next.source_json=source.source_json.clone();next.quotes_json=source.quotes_json.clone();next.trash_json=source.trash_json.clone();write=true; }
                legacy=Some(DraftMaterials {source_json:"[]".into(),quotes_json:"[]".into(),trash_json:"[]".into(),..source});
            },
        }
        register(tx,&command.conversation_id,client,command.composer_scope.as_ref(),&key,scope_registered)?;
        if write {next.store(tx,&command.conversation_id,client,&key)?;}
        if let Some(source)=legacy {source.store(tx,&command.conversation_id,client,&PrivateComposerKey::default())?;}
        let draft=DraftMaterials::load(tx,&command.conversation_id,client,&key)?.view(&key,command.composer_scope.as_ref())?;
        let mut payload=json!({"draft":draft});
        if let Some(body)=body {payload["body"]=json!(body);}
        if let Some(id)=retained {payload["retainedInput"]=serde_json::to_value(load_retained(tx,&command.conversation_id,client,key.sql_key(),&id)?.context("single_chat.retained_not_found")?.view(&command.conversation_id,key.sql_key())?)?;}
        append_domain_event(tx,"single_chat.composer_draft_changed",Some(&command.camp_id),Some(("conversation",&command.conversation_id)),&envelope.actor,None,&json!({"conversationId":command.conversation_id}))?;
        Ok(CommandHandlerResult::applied("single_chat.composer_draft_updated",payload,Some(EntityReference {entity_type:"conversation".into(),entity_id:command.conversation_id.clone()})))
    })
}

const SCOPE_METADATA_SQL: &str = "WITH owners AS (
    SELECT scope_key FROM single_chat_composer_scope WHERE conversation_id=?2 AND client_id=?3
    UNION SELECT scope_key FROM single_chat_composer_draft WHERE conversation_id=?2 AND client_id=?3
    UNION SELECT scope_key FROM single_chat_retained_input WHERE conversation_id=?2 AND client_id=?3
), retained_counts AS (
    SELECT scope_key,COUNT(*) AS count FROM single_chat_retained_input WHERE conversation_id=?2 AND client_id=?3 GROUP BY scope_key
)
SELECT owners.scope_key,scope.board_id,scope.node_id,COALESCE(draft.revision,0),
    COALESCE(json_array_length(draft.source_attachments_json),0),COALESCE(json_array_length(draft.quotes_json),0),COALESCE(retained_counts.count,0),
    COALESCE(draft.updated_at,scope.updated_at),
    owners.scope_key<>'' AND NOT EXISTS(SELECT 1 FROM canvas_node AS node JOIN canvas_board AS board ON board.id=node.board_id
        JOIN conversation ON conversation.id=node.conversation_id JOIN camp ON camp.id=conversation.camp_id
        WHERE node.board_id=scope.board_id AND node.id=scope.node_id AND node.kind='conversation'
          AND node.thread_id=?1 AND node.conversation_id=?2 AND conversation.camp_id=?1 AND conversation.kind='single_chat'
          AND conversation.ended_at IS NULL AND camp.activation_state='active' AND camp.deletion_operation_id IS NULL AND board.deleted_at IS NULL)
FROM owners LEFT JOIN single_chat_composer_scope AS scope ON scope.conversation_id=?2 AND scope.client_id=?3 AND scope.scope_key=owners.scope_key
LEFT JOIN single_chat_composer_draft AS draft ON draft.conversation_id=?2 AND draft.client_id=?3 AND draft.scope_key=owners.scope_key
LEFT JOIN retained_counts ON retained_counts.scope_key=owners.scope_key ORDER BY owners.scope_key";

#[derive(Debug, Serialize)]
struct RetainedSummary {
    id: String,
    scope_key: String,
    revision: i64,
    updated_at: String,
}

pub fn recovery(
    database: &Database,
    client: &DraftClient,
    input: &PrivateRecoveryParams,
) -> Result<PrivateRecoveryResult> {
    let cursor = if let Some(value) = &input.cursor {
        let cursor = decode_cursor(value)?;
        ensure!(
            cursor.version == 1
                && cursor.thread_id == input.camp_id
                && cursor.conversation_id == input.conversation_id
                && cursor.client_id == client.id()
                && cursor.after_kind <= 1
                && cursor.after_key.len() <= 160
                && cursor.state_digest.len() == 64
                && cursor.state_digest.bytes().all(|b| b.is_ascii_hexdigit()),
            "single_chat.cursor_invalid"
        );
        Some(cursor)
    } else {
        None
    };
    let tx = database.connection().unchecked_transaction()?;
    ensure!(
        owner_exists(&tx, &input.camp_id, &input.conversation_id, false)?,
        "single_chat.not_found"
    );
    let through_global_sequence = tx.query_row(
        "SELECT COALESCE(MAX(global_sequence),0) FROM event_log",
        [],
        |row| row.get(0),
    )?;
    let mut scopes = Vec::new();
    let mut query = tx.prepare(SCOPE_METADATA_SQL)?;
    let rows = query.query_map(
        params![input.camp_id, input.conversation_id, client.id()],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, bool>(8)?,
            ))
        },
    )?;
    for row in rows {
        let (key, board, node, revision, attachments, quotes, retained, updated, orphaned) = row?;
        let scope = if key.is_empty() {
            None
        } else {
            Some(SingleChatComposerScope::Canvas {
                board_id: board.context("single_chat.scope_corrupt")?,
                node_id: node.context("single_chat.scope_corrupt")?,
            })
        };
        ensure!(
            PrivateComposerKey::for_scope(scope.as_ref())?.sql_key() == key,
            "single_chat.scope_corrupt"
        );
        scopes.push(PrivateScopeEntry {
            scope_key: key,
            composer_scope: scope,
            orphaned,
            draft_revision: revision,
            attachment_count: attachments
                .try_into()
                .context("single_chat.scope_corrupt")?,
            quote_count: quotes.try_into().context("single_chat.scope_corrupt")?,
            retained_input_count: retained.try_into().context("single_chat.scope_corrupt")?,
            updated_at: updated,
        });
    }
    drop(query);
    let retained=tx.prepare("SELECT id,scope_key,revision,updated_at FROM single_chat_retained_input WHERE conversation_id=?1 AND client_id=?2 ORDER BY id")?
        .query_map(params![input.conversation_id,client.id()],|row|Ok(RetainedSummary {id:row.get(0)?,scope_key:row.get(1)?,revision:row.get(2)?,updated_at:row.get(3)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&scopes, &retained))?)
    );
    let original_digest = cursor
        .as_ref()
        .map_or(digest.as_str(), |c| c.state_digest.as_str());
    let stable = original_digest == digest;
    let limit = input.limit.unwrap_or(50).clamp(1, 100);
    let indices = scopes
        .iter()
        .enumerate()
        .map(|(i, s)| (0, s.scope_key.as_str(), i))
        .chain(
            retained
                .iter()
                .enumerate()
                .map(|(i, s)| (1, s.id.as_str(), i)),
        )
        .filter(|(kind, key, _)| {
            cursor
                .as_ref()
                .is_none_or(|c| (*kind, *key) > (c.after_kind, c.after_key.as_str()))
        })
        .take(limit + 1)
        .collect::<Vec<_>>();
    let has_more = indices.len() > limit;
    let selected = &indices[..indices.len().min(limit)];
    let mut items = Vec::new();
    for (kind, _, index) in selected {
        if *kind == 0 {
            items.push(PrivateRecoveryItem::Scope {
                scope: scopes[*index].clone(),
            });
        } else {
            let saved = &retained[*index];
            items.push(PrivateRecoveryItem::Retained {
                input: load_retained(
                    &tx,
                    &input.conversation_id,
                    client,
                    &saved.scope_key,
                    &saved.id,
                )?
                .context("single_chat.retained_not_found")?
                .view(&input.conversation_id, &saved.scope_key)?,
            });
        }
    }
    let next_cursor = if has_more {
        let (after_kind, after_key, _) = selected.last().context("single_chat.cursor_invalid")?;
        Some(encode_cursor(&RecoveryCursor {
            version: 1,
            thread_id: input.camp_id.clone(),
            conversation_id: input.conversation_id.clone(),
            client_id: client.id().into(),
            state_digest: original_digest.into(),
            after_kind: *after_kind,
            after_key: (*after_key).into(),
        })?)
    } else {
        None
    };
    tx.commit()?;
    Ok(PrivateRecoveryResult {
        items,
        next_cursor,
        complete: stable && !has_more,
        through_global_sequence,
    })
}

#[cfg(all(test, feature = "extended-tests"))]
#[path = "single_chat_composer_tests.rs"]
mod tests;
