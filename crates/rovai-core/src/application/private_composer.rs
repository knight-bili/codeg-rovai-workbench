//! 私聊材料的封闭应用入口；编辑端只能来自可信 Request。
use super::*;
use crate::{
    single_chat_composer::{
        self, MutatePrivateComposerCommand, PrivateRecoveryParams, ScopedPrivateDraftView,
    },
    single_chat_composer_scope::SingleChatComposerScopeRequest,
};
use rusqlite::params;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotParams {
    conversation_id: String,
    #[serde(default)]
    composer_scope: SingleChatComposerScopeRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MutationParams {
    command_id: String,
    command: MutatePrivateComposerCommand,
}

pub(crate) struct Reply {
    pub result: Value,
    pub changed: Option<(String, String)>,
}

fn mutation_envelope(
    client: &crate::draft_client::DraftClient,
    value: Value,
) -> Result<CommandEnvelope<MutatePrivateComposerCommand>> {
    let mut params: MutationParams = serde_json::from_value(value)?;
    params.command.draft_client = client.clone();
    Ok(user_camp_command_envelope(
        params.command_id,
        params.command.camp_id.clone(),
        params.command,
    ))
}

pub(crate) fn reconcile(
    database: &Database,
    client: &crate::draft_client::DraftClient,
    value: Value,
) -> Result<Value> {
    let envelope = mutation_envelope(client, value)?;
    Ok(DomainCommandGateway
        .replay_if_recorded(database, &envelope)?
        .map(|execution| json!({"state":"recorded","result":execution.result}))
        .unwrap_or_else(|| json!({"state":"unknown"})))
}

pub(crate) fn handle(
    database: &mut Database,
    client: &crate::draft_client::DraftClient,
    method: &str,
    params: Value,
) -> Result<Reply> {
    let mut changed = None;
    let result = match method {
        "singleChat.get" => {
            let params: SnapshotParams = serde_json::from_value(params)?;
            let service = SingleChatService::for_client(client.clone());
            if params.composer_scope.is_legacy() {
                serde_json::to_value(service.snapshot(database, &params.conversation_id)?)?
            } else {
                let thread: Option<String> = database
                    .connection()
                    .query_row(
                        "SELECT camp_id FROM conversation WHERE id=?1 AND kind='single_chat'",
                        [&params.conversation_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(thread) = thread else {
                    return Ok(Reply {
                        result: Value::Null,
                        changed: None,
                    });
                };
                anyhow::ensure!(
                    single_chat_composer::owner_exists(
                        database.connection(),
                        &thread,
                        &params.conversation_id,
                        false
                    )?,
                    "single_chat.not_found"
                );
                let scope = params.composer_scope.scope();
                let (key, _) = single_chat_composer::resolve_scope(
                    database.connection(),
                    &thread,
                    &params.conversation_id,
                    client,
                    scope,
                )?
                .context("single_chat.scope_unavailable")?;
                let snapshot = service
                    .snapshot_for_key(database, &params.conversation_id, &key)?
                    .context("single_chat.not_found")?;
                let draft = ScopedPrivateDraftView {
                    draft: snapshot.draft.clone(),
                    scope_version: 1,
                    scope_key: key.sql_key().into(),
                    composer_scope: scope.cloned(),
                };
                let editing_elsewhere: bool = database.connection().query_row(
                    "SELECT EXISTS(SELECT 1 FROM single_chat_pending_input_edit_session WHERE conversation_id=?1 AND (client_id<>?2 OR scope_key<>?3))",
                    params![params.conversation_id, client.id(), key.sql_key()], |row| row.get(0),
                )?;
                let mut value = serde_json::to_value(snapshot)?;
                value["draft"] = serde_json::to_value(draft)?;
                value["pendingInputs"]["editingElsewhere"] = json!(editing_elsewhere);
                value
            }
        }
        "singleChat.composerDraft.mutate" => {
            let envelope = mutation_envelope(client, params)?;
            let thread = envelope.payload.camp_id.clone();
            let conversation = envelope.payload.conversation_id.clone();
            let execution = single_chat_composer::mutate(database, &envelope)?;
            if !execution.replayed && execution.result.status != CommandResultStatus::Rejected {
                changed = Some((thread, conversation));
            }
            serde_json::to_value(execution.result)?
        }
        "singleChat.composerDraft.recovery" => {
            let params: PrivateRecoveryParams = serde_json::from_value(params)?;
            serde_json::to_value(single_chat_composer::recovery(database, client, &params)?)?
        }
        _ => anyhow::bail!("single_chat.operation_not_admitted"),
    };
    Ok(Reply { result, changed })
}

pub(super) async fn handle_mutation(
    database: &Mutex<Database>,
    capacity: &Arc<Semaphore>,
    client: &crate::draft_client::DraftClient,
    params: Value,
) -> Result<Reply> {
    let envelope = mutation_envelope(client, params)?;
    let execution = super::private_sources::command(
        database,
        capacity,
        &envelope,
        |database| single_chat_composer::mutation_source_inputs(database, &envelope),
        |database, prepared| {
            single_chat_composer::mutate_with_prepared_sources(database, &envelope, &prepared)
        },
    )
    .await?;
    let changed = (!execution.replayed && execution.result.status != CommandResultStatus::Rejected)
        .then(|| {
            (
                envelope.payload.camp_id.clone(),
                envelope.payload.conversation_id.clone(),
            )
        });
    Ok(Reply {
        result: serde_json::to_value(execution.result)?,
        changed,
    })
}
