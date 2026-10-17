use super::*;
use crate::{
    collaboration::{CollaborationService, CreateThreadCommand},
    command::CommandResultStatus,
    local_attachment_source::observe_source_attachment,
    message_quote::QuoteSelection,
    single_chat::{OpenSingleChatCommand, SendSingleChatMessageCommand, SingleChatService},
    test_support::OwnedTestDatabase,
};

struct Fixture {
    database: OwnedTestDatabase,
    thread: String,
    conversation: String,
    scopes: Vec<SingleChatComposerScope>,
}

fn envelope<T>(thread: Option<&str>, payload: T) -> CommandEnvelope<T> {
    CommandEnvelope {
        command_id: Uuid::new_v4().to_string(),
        actor: ActorRef::User {
            user_id: crate::current_user::CURRENT_USER_ID.into(),
        },
        camp_id: thread.map(str::to_owned),
        expected_versions: vec![],
        execution_epoch: None,
        payload,
    }
}

fn fixture() -> Fixture {
    let mut database = crate::test_support::seeded_runtime_database_owned();
    let workspace = database.directory().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let created = CollaborationService::default()
        .create_camp(
            &mut database,
            &envelope(
                None,
                CreateThreadCommand::for_test(workspace.to_string_lossy().into()),
            ),
        )
        .unwrap();
    let thread = created.result.payload["threadId"]
        .as_str()
        .unwrap()
        .to_owned();
    let opened = SingleChatService::default()
        .open(
            &mut database,
            &envelope(
                Some(&thread),
                OpenSingleChatCommand {
                    draft_client: Default::default(),
                    camp_id: thread.clone(),
                    agent_id: "agent_1".into(),
                },
            ),
        )
        .unwrap();
    let conversation = opened.result.payload["conversationId"]
        .as_str()
        .unwrap()
        .to_owned();
    let board = Uuid::new_v4().to_string();
    database
        .connection()
        .execute(
            "INSERT INTO canvas_board(id,revision,created_at,updated_at) VALUES(?1,1,'now','now')",
            [&board],
        )
        .unwrap();
    let mut scopes = Vec::new();
    for _ in 0..3 {
        let node = Uuid::new_v4().to_string();
        database.connection().execute("INSERT INTO canvas_node(id,board_id,kind,thread_id,conversation_id,conversations_json,collapsed,grid_columns,grid_rows,x,y,width,height,created_at,updated_at)
            VALUES(?1,?2,'conversation',?3,?4,'[]',0,0,0,0,0,224,132,'now','now')",params![node,board,thread,conversation]).unwrap();
        scopes.push(SingleChatComposerScope::Canvas {
            board_id: board.clone(),
            node_id: node,
        });
    }
    Fixture {
        database,
        thread,
        conversation,
        scopes,
    }
}

fn command(
    f: &Fixture,
    index: usize,
    revision: i64,
    action: PrivateComposerAction,
) -> CommandEnvelope<MutatePrivateComposerCommand> {
    envelope(
        Some(&f.thread),
        MutatePrivateComposerCommand {
            draft_client: Default::default(),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            composer_scope: Some(f.scopes[index].clone()),
            expected_draft_revision: revision,
            action,
        },
    )
}

fn apply(
    f: &mut Fixture,
    index: usize,
    revision: i64,
    action: PrivateComposerAction,
) -> crate::command::StoredCommandResult {
    let input = command(f, index, revision, action);
    let result = mutate(&mut f.database, &input).unwrap().result;
    assert_eq!(result.status, CommandResultStatus::Applied, "{result:?}");
    result
}

fn read(f: &Fixture, index: usize) -> ScopedPrivateDraftView {
    read_draft(
        &f.database,
        &DraftClient::default(),
        &f.thread,
        &f.conversation,
        Some(&f.scopes[index]),
    )
    .unwrap()
}

fn add_default_source(f: &mut Fixture, name: &str) {
    let file = f.database.directory().join(name);
    std::fs::write(&file, name.as_bytes()).unwrap();
    let source = observe_source_attachment(&file, name, Some("text/plain")).unwrap();
    let revision = SingleChatService::default()
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap()
        .draft
        .revision;
    SingleChatService::default()
        .add_source_attachment(&mut f.database, &f.conversation, revision, source)
        .unwrap();
}

fn default_revision(f: &Fixture) -> i64 {
    SingleChatService::default()
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap()
        .draft
        .revision
}

#[test]
fn commands_keep_complete_inputs_separate_preserve_receipts_and_rollback_both_sides() {
    let mut f = fixture();
    let before = f.database.connection().total_changes();
    assert_eq!(read(&f, 0).draft.revision, 0);
    assert_eq!(read(&f, 1).draft.revision, 0);
    assert_eq!(
        f.database.connection().total_changes(),
        before,
        "read must not register an input"
    );
    let sent = SingleChatService::default()
        .send(
            &mut f.database,
            &envelope(
                Some(&f.thread),
                SendSingleChatMessageCommand {
                    composer_scope: None,
                    draft_client: Default::default(),
                    camp_id: f.thread.clone(),
                    conversation_id: f.conversation.clone(),
                    body: "测试文本".into(),
                    draft_revision: 0,
                },
            ),
        )
        .unwrap();
    let message = sent.result.payload["conversationMessageId"]
        .as_str()
        .unwrap()
        .to_owned();
    apply(&mut f, 0, 0, PrivateComposerAction::RegisterScope);
    let quote = apply(
        &mut f,
        0,
        0,
        PrivateComposerAction::Quote {
            action: QuoteAction::Add {
                selection: QuoteSelection {
                    message_id: message,
                    body_at_selection: "测试文本".into(),
                    start_scalar: 0,
                    end_scalar: 4,
                    text: "测试文本".into(),
                    current_user_display_name: None,
                },
            },
        },
    );
    let quote_id = quote.payload["draft"]["quotes"][0]["quoteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let invalid = command(
        &f,
        1,
        0,
        PrivateComposerAction::Quote {
            action: QuoteAction::Remove {
                quote_id: quote_id.clone(),
            },
        },
    );
    assert_eq!(
        mutate(&mut f.database, &invalid).unwrap().result.status,
        CommandResultStatus::Rejected
    );
    assert_eq!(
        f.database
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM single_chat_composer_scope",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1,
        "failed first write rolls registration back"
    );
    apply(
        &mut f,
        0,
        1,
        PrivateComposerAction::Quote {
            action: QuoteAction::Remove {
                quote_id: quote_id.clone(),
            },
        },
    );
    apply(
        &mut f,
        0,
        2,
        PrivateComposerAction::Quote {
            action: QuoteAction::Restore {
                quote_id: quote_id.clone(),
            },
        },
    );
    assert_eq!(read(&f, 0).draft.quotes[0].quote_id, quote_id);
    assert!(read(&f, 1).draft.quotes.is_empty());
    assert!(
        SingleChatService::default()
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .draft
            .quotes
            .is_empty()
    );
    add_default_source(&mut f, "first.md");
    add_default_source(&mut f, "second.md");
    let source_revision = default_revision(&f);
    let active_body = "长".repeat(100_001);
    let adopted = apply(
        &mut f,
        0,
        3,
        PrivateComposerAction::AdoptLegacyMaterials {
            expected_source_revision: source_revision,
            target_body: active_body.clone(),
        },
    );
    let saved = adopted.payload["retainedInput"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(adopted.payload["retainedInput"]["body"], "");
    assert_eq!(
        adopted.payload["retainedInput"]["attachments"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(read(&f, 0).draft.quotes[0].quote_id, quote_id);
    assert_eq!(read(&f, 0).draft.revision, 3);
    assert!(
        SingleChatService::default()
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .draft
            .attachments
            .is_empty()
    );
    let swap = command(
        &f,
        0,
        3,
        PrivateComposerAction::SwapRetained {
            retained_input_id: saved.clone(),
            expected_retained_revision: 1,
            current_body: active_body.clone(),
        },
    );
    let key = PrivateComposerKey::for_scope(Some(&f.scopes[0])).unwrap();
    let previous = format!(
        "{:?}{:?}",
        DraftMaterials::load(
            f.database.connection(),
            &f.conversation,
            &DraftClient::default(),
            &key
        )
        .unwrap(),
        load_retained(
            f.database.connection(),
            &f.conversation,
            &DraftClient::default(),
            key.sql_key(),
            &saved
        )
        .unwrap()
    );
    f.database.connection().execute_batch("CREATE TEMP TRIGGER reject_composer_receipt BEFORE INSERT ON event_log WHEN NEW.command_type='single_chat.composer_draft.mutate' AND NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'composer receipt rollback fixture'); END;").unwrap();
    assert!(mutate(&mut f.database, &swap).is_err());
    assert_eq!(
        format!(
            "{:?}{:?}",
            DraftMaterials::load(
                f.database.connection(),
                &f.conversation,
                &DraftClient::default(),
                &key
            )
            .unwrap(),
            load_retained(
                f.database.connection(),
                &f.conversation,
                &DraftClient::default(),
                key.sql_key(),
                &saved
            )
            .unwrap()
        ),
        previous
    );
    f.database
        .connection()
        .execute_batch("DROP TRIGGER reject_composer_receipt")
        .unwrap();
    let swapped = mutate(&mut f.database, &swap).unwrap();
    assert!(!swapped.replayed);
    assert_eq!(swapped.result.payload["body"], "");
    assert!(swapped.result.payload["retainedInput"]["body"].as_str() == Some(active_body.as_str()));
    assert_eq!(
        swapped.result.payload["retainedInput"]["quotes"][0]["quoteId"],
        quote_id
    );
    let replay = mutate(&mut f.database, &swap).unwrap();
    assert!(replay.replayed);
    assert_eq!(
        serde_json::to_value(replay.result).unwrap(),
        serde_json::to_value(swapped.result).unwrap()
    );
    assert_eq!(read(&f, 0).draft.revision, 4);
    let refs = read(&f, 0)
        .draft
        .attachments
        .iter()
        .map(|a| a.id.clone())
        .rev()
        .collect::<Vec<_>>();
    apply(
        &mut f,
        0,
        4,
        PrivateComposerAction::ReorderAttachments {
            attachment_ref_ids: refs.clone(),
        },
    );
    assert_eq!(
        read(&f, 0)
            .draft
            .attachments
            .iter()
            .map(|a| a.id.clone())
            .collect::<Vec<_>>(),
        refs
    );
    apply(
        &mut f,
        0,
        5,
        PrivateComposerAction::RemoveAttachment {
            attachment_ref_id: refs[0].clone(),
        },
    );
    let foreign = command(
        &f,
        1,
        0,
        PrivateComposerAction::RemoveAttachment {
            attachment_ref_id: refs[1].clone(),
        },
    );
    assert_eq!(
        mutate(&mut f.database, &foreign).unwrap().result.status,
        CommandResultStatus::Rejected
    );
    let foreign = command(
        &f,
        1,
        0,
        PrivateComposerAction::DiscardRetained {
            retained_input_id: saved.clone(),
            expected_retained_revision: 2,
        },
    );
    assert_eq!(
        mutate(&mut f.database, &foreign).unwrap().result.status,
        CommandResultStatus::Rejected
    );
    let mut foreign = swap.clone();
    foreign.payload.draft_client = DraftClient::verified_web(&"b".repeat(64)).unwrap();
    assert!(
        mutate(&mut f.database, &foreign).is_err(),
        "receipt must not cross verified editors"
    );
    assert!(
        read_draft(
            &f.database,
            &foreign.payload.draft_client,
            &f.thread,
            &f.conversation,
            Some(&f.scopes[0])
        )
        .unwrap()
        .draft
        .attachments
        .is_empty()
    );
    apply(
        &mut f,
        0,
        6,
        PrivateComposerAction::DiscardRetained {
            retained_input_id: saved,
            expected_retained_revision: 2,
        },
    );
    add_default_source(&mut f, "third.md");
    let source_revision = default_revision(&f);
    let first = apply(
        &mut f,
        1,
        0,
        PrivateComposerAction::AdoptLegacyMaterials {
            expected_source_revision: source_revision,
            target_body: "乙卡原正文".into(),
        },
    );
    assert_eq!(first.payload["draft"]["revision"], 0);
    assert_eq!(
        first.payload["retainedInput"]["attachments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    add_default_source(&mut f, "fourth.md");
    let source_revision = default_revision(&f);
    let empty = apply(
        &mut f,
        2,
        0,
        PrivateComposerAction::AdoptLegacyMaterials {
            expected_source_revision: source_revision,
            target_body: "".into(),
        },
    );
    assert_eq!(
        empty.payload["draft"]["attachments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(empty.payload.get("retainedInput").is_none());
    let mut spoof = serde_json::to_value(&foreign.payload).unwrap();
    spoof["draftClient"] = json!("a".repeat(64));
    assert!(serde_json::from_value::<MutatePrivateComposerCommand>(spoof).is_err());
}

#[test]
fn recovery_pages_are_read_only_context_bound_bounded_and_incomplete_after_changes() {
    let mut f = fixture();
    apply(&mut f, 0, 0, PrivateComposerAction::RegisterScope);
    apply(&mut f, 1, 0, PrivateComposerAction::RegisterScope);
    let mut input = PrivateRecoveryParams {
        camp_id: f.thread.clone(),
        conversation_id: f.conversation.clone(),
        cursor: None,
        limit: Some(1),
    };
    let before = f.database.connection().total_changes();
    let first = recovery(&f.database, &DraftClient::default(), &input).unwrap();
    assert_eq!(f.database.connection().total_changes(), before);
    assert!(!first.complete);
    assert_eq!(first.items.len(), 1);
    input.cursor = first.next_cursor.clone();
    let other = DraftClient::verified_web(&"c".repeat(64)).unwrap();
    assert!(recovery(&f.database, &other, &input).is_err());
    let original = input.cursor.clone().unwrap();
    let mut bad = original.as_bytes().to_vec();
    bad[0] = if bad[0] == b'A' { b'B' } else { b'A' };
    input.cursor = Some(String::from_utf8(bad).unwrap());
    assert!(recovery(&f.database, &DraftClient::default(), &input).is_err());
    input.cursor = Some(original);
    apply(&mut f, 2, 0, PrivateComposerAction::RegisterScope);
    let mut pages = 0;
    while input.cursor.is_some() {
        let page = recovery(&f.database, &DraftClient::default(), &input).unwrap();
        assert!(
            !page.complete,
            "changed first-page digest must survive every later page"
        );
        input.cursor = page.next_cursor;
        pages += 1;
        assert!(pages < 8);
    }
    input.limit = Some(100);
    let fresh = recovery(&f.database, &DraftClient::default(), &input).unwrap();
    assert!(fresh.complete);
    assert_eq!(fresh.items.len(), 4);
    let SingleChatComposerScope::Canvas { node_id, .. } = &f.scopes[0];
    f.database
        .connection()
        .execute("DELETE FROM canvas_node WHERE id=?1", [node_id])
        .unwrap();
    let orphan = recovery(&f.database, &DraftClient::default(), &input).unwrap();
    assert!(orphan.items.iter().any(|item|matches!(item,PrivateRecoveryItem::Scope {scope} if scope.composer_scope.as_ref()==Some(&f.scopes[0]) && scope.orphaned)));
    let tx = f.database.connection().unchecked_transaction().unwrap();
    for index in 0..101 {
        tx.execute("INSERT INTO single_chat_retained_input(id,conversation_id,client_id,body,created_at,updated_at) VALUES(?1,?2,'desktop','whole input','now','now')",params![format!("bulk-{index:03}"),f.conversation]).unwrap();
    }
    tx.commit().unwrap();
    input.limit = Some(usize::MAX);
    let bounded = recovery(&f.database, &DraftClient::default(), &input).unwrap();
    assert_eq!(bounded.items.len(), 100);
    assert!(!bounded.complete);
    assert!(bounded.next_cursor.is_some());
    let before = f.database.connection().total_changes();
    let foreign = recovery(&f.database, &other, &input).unwrap();
    assert!(foreign.complete && foreign.items.is_empty());
    assert_eq!(f.database.connection().total_changes(), before);
    assert_eq!(
        f.database
            .connection()
            .query_row("SELECT COUNT(*) FROM agent_run", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn send_consumes_only_the_registered_scope_and_keeps_one_private_fifo_and_legacy_shape() {
    let mut f = fixture();
    let legacy = json!({"threadId":f.thread,"conversationId":f.conversation,"body":"legacy input","draftRevision":0});
    let decoded: SendSingleChatMessageCommand = serde_json::from_value(legacy.clone()).unwrap();
    assert!(decoded.composer_scope.is_none());
    assert_eq!(
        serde_json::to_value(decoded).unwrap(),
        legacy,
        "default scope must not change the old serialized request"
    );
    add_default_source(&mut f, "alpha.md");
    let source_revision = default_revision(&f);
    apply(
        &mut f,
        0,
        0,
        PrivateComposerAction::AdoptLegacyMaterials {
            expected_source_revision: source_revision,
            target_body: "".into(),
        },
    );
    let alpha = read(&f, 0).draft.attachments[0].id.clone();
    add_default_source(&mut f, "beta.md");
    let source_revision = default_revision(&f);
    apply(
        &mut f,
        1,
        0,
        PrivateComposerAction::AdoptLegacyMaterials {
            expected_source_revision: source_revision,
            target_body: "".into(),
        },
    );
    let beta = read(&f, 1).draft.attachments[0].id.clone();
    add_default_source(&mut f, "default.md");
    let default_revision = default_revision(&f);
    let unregistered = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: Default::default(),
            composer_scope: Some(f.scopes[2].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "丙卡问题".into(),
            draft_revision: 0,
        },
    );
    let rejected = SingleChatService::default()
        .send(&mut f.database, &unregistered)
        .unwrap();
    assert_eq!(rejected.result.status, CommandResultStatus::Rejected);
    assert_eq!(rejected.result.code, "single_chat.scope_unregistered");
    let input = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: Default::default(),
            composer_scope: Some(f.scopes[1].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "乙卡问题".into(),
            draft_revision: 1,
        },
    );
    let sent = SingleChatService::default()
        .send(&mut f.database, &input)
        .unwrap();
    assert_eq!(sent.result.status, CommandResultStatus::Accepted);
    let run = sent.result.payload["agentRunId"].as_str().unwrap();
    let sources =
        crate::local_attachment_source::load_agent_run_source_attachments(&f.database, run, 0)
            .unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].id, beta);
    assert_eq!(read(&f, 1).draft.revision, 2);
    assert!(read(&f, 1).draft.attachments.is_empty());
    assert_eq!(read(&f, 0).draft.attachments[0].id, alpha);
    assert_eq!(
        SingleChatService::default()
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .draft
            .revision,
        default_revision
    );
    assert_eq!(
        SingleChatService::default()
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .draft
            .attachments
            .len(),
        1
    );
    let message = sent.result.payload["conversationMessageId"]
        .as_str()
        .unwrap()
        .to_owned();
    apply(
        &mut f,
        0,
        1,
        PrivateComposerAction::Quote {
            action: QuoteAction::Add {
                selection: QuoteSelection {
                    message_id: message,
                    body_at_selection: "乙卡问题".into(),
                    start_scalar: 0,
                    end_scalar: 4,
                    text: "乙卡问题".into(),
                    current_user_display_name: None,
                },
            },
        },
    );
    let quote = read(&f, 0).draft.quotes[0].clone();
    let mut queued = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: Default::default(),
            composer_scope: Some(f.scopes[0].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "".into(),
            draft_revision: 2,
        },
    );
    let rejected = SingleChatService::default()
        .send(&mut f.database, &queued)
        .unwrap();
    assert_eq!(rejected.result.status, CommandResultStatus::Rejected);
    assert_eq!(rejected.result.code, "quote.question_required");
    assert_eq!(read(&f, 0).draft.revision, 2);
    queued.payload.body = "甲卡补充".into();
    queued.command_id = Uuid::new_v4().to_string();
    let accepted = SingleChatService::default()
        .send(&mut f.database, &queued)
        .unwrap();
    assert_eq!(accepted.result.status, CommandResultStatus::Accepted);
    assert_eq!(accepted.result.code, "single_chat.pending_input_queued");
    let replay = SingleChatService::default()
        .send(&mut f.database, &queued)
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(
        serde_json::to_value(replay.result).unwrap(),
        serde_json::to_value(accepted.result).unwrap()
    );
    let snapshot = SingleChatService::default()
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.pending_inputs.items.len(), 1);
    assert_eq!(snapshot.pending_inputs.items[0].attachments[0].id, alpha);
    assert_eq!(
        snapshot.pending_inputs.items[0].quotes[0].quote_id,
        quote.quote_id
    );
    assert!(read(&f, 0).draft.attachments.is_empty());
    assert!(read(&f, 0).draft.quotes.is_empty());
    assert_eq!(snapshot.draft.revision, default_revision);
    assert_eq!(
        snapshot.agent_runs.len(),
        1,
        "scope cards do not create parallel execution lanes"
    );
    verify_application_routes(&mut f, &snapshot.pending_inputs.items[0]);
    verify_scoped_pending_edits(&mut f);
    verify_private_upload_bindings();
    verify_private_source_observations();
    assert_eq!(
        serde_json::to_value(&quote.model_projection())
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        3
    );
}

fn verify_scoped_pending_edits(f: &mut Fixture) {
    use crate::single_chat::{
        EditSingleChatPendingInputCommand, SingleChatPendingInputEditAction as Action,
    };
    let service = SingleChatService::default();
    let pending = service
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap()
        .pending_inputs
        .items[0]
        .clone();
    let beta_key = PrivateComposerKey::for_scope(Some(&f.scopes[1])).unwrap();
    let beta_token = service
        .snapshot_for_key(&f.database, &f.conversation, &beta_key)
        .unwrap()
        .unwrap()
        .pending_inputs
        .edit_session
        .unwrap()
        .edit_token;
    let mut edit = envelope(
        Some(&f.thread),
        EditSingleChatPendingInputCommand {
            draft_client: DraftClient::default(),
            composer_scope: Some(f.scopes[0].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            pending_input_id: pending.id.clone(),
            expected_revision: pending.revision,
            edit_token: None,
            action: Action::Begin,
        },
    );
    let mut legacy = edit.payload.clone();
    legacy.composer_scope = None;
    legacy.action = Action::ReturnToComposer {
        expected_draft_revision: 7,
        target_body: None,
    };
    assert_eq!(
        serde_json::to_value(legacy).unwrap(),
        json!({
            "threadId":f.thread,"conversationId":f.conversation,"pendingInputId":pending.id,
            "expectedRevision":pending.revision,"editToken":null,
            "action":{"type":"return_to_composer","expectedDraftRevision":7}
        })
    );
    macro_rules! apply_edit {
        ($action:expr) => {{
            edit.command_id = Uuid::new_v4().to_string();
            edit.payload.action = $action;
            service.edit_pending_input(&mut f.database, &edit).unwrap()
        }};
    }
    assert_eq!(
        apply_edit!(Action::Begin).result.code,
        "single_chat.pending_input_edit_open"
    );
    let alpha = apply_edit!(Action::Takeover);
    let alpha_token = alpha.result.payload["editToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(alpha_token, beta_token);
    verify_private_attachment_locator(
        f,
        json!({
            "owner":"single_chat_scoped_pending_edit", "threadId":f.thread,"conversationId":f.conversation,
            "composerScope":f.scopes[0],"pendingInputId":pending.id,"editToken":alpha_token,
            "attachmentRefId":pending.attachments[0].id
        }),
        &DraftClient::default(),
    );
    edit.payload.composer_scope = Some(f.scopes[1].clone());
    edit.payload.edit_token = Some(beta_token);
    assert_eq!(
        apply_edit!(Action::Save {
            body: "迟到旧位置".into()
        })
        .result
        .code,
        "single_chat.pending_input_edit_fenced"
    );
    edit.payload.draft_client = DraftClient::verified_web(&"6".repeat(64)).unwrap();
    edit.payload.composer_scope = Some(f.scopes[2].clone());
    edit.payload.edit_token = None;
    let web_takeover = apply_edit!(Action::Takeover);
    let web_token = web_takeover.result.payload["editToken"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(web_token, alpha_token);
    verify_private_attachment_locator(
        f,
        json!({
            "owner":"single_chat_scoped_pending_edit", "threadId":f.thread,"conversationId":f.conversation,
            "composerScope":f.scopes[2],"pendingInputId":pending.id,"editToken":web_token,
            "attachmentRefId":pending.attachments[0].id
        }),
        &DraftClient::verified_web(&"6".repeat(64)).unwrap(),
    );
    {
        use crate::local_attachment_source::{
            LocalAttachmentOwnerLocator, load_source_attachment_for_client,
        };
        let old: LocalAttachmentOwnerLocator=serde_json::from_value(json!({
            "owner":"single_chat_scoped_pending_edit", "threadId":f.thread,"conversationId":f.conversation,
            "composerScope":f.scopes[0],"pendingInputId":pending.id,"editToken":alpha_token,
            "attachmentRefId":pending.attachments[0].id
        })).unwrap();
        assert!(
            load_source_attachment_for_client(&f.database, &old, &DraftClient::default())
                .unwrap()
                .is_none()
        );
    }
    edit.payload.draft_client = DraftClient::default();
    edit.payload.composer_scope = Some(f.scopes[0].clone());
    edit.payload.edit_token = Some(alpha_token);
    assert_eq!(
        apply_edit!(Action::Save {
            body: "迟到另一编辑端".into()
        })
        .result
        .code,
        "single_chat.pending_input_edit_fenced"
    );
    edit.payload.draft_client = DraftClient::verified_web(&"6".repeat(64)).unwrap();
    edit.payload.composer_scope = Some(f.scopes[2].clone());
    edit.payload.edit_token = Some(web_token);
    assert_eq!(
        apply_edit!(Action::ReturnToComposer {
            expected_draft_revision: 0,
            target_body: Some(String::new())
        })
        .result
        .code,
        "single_chat.pending_input_edit_open"
    );
    assert_ne!(
        apply_edit!(Action::ReorderAttachments {
            attachment_ref_ids: pending.attachments.iter().map(|r| r.id.clone()).collect()
        })
        .result
        .status,
        CommandResultStatus::Rejected
    );
    assert_eq!(
        apply_edit!(Action::RemoveAttachment {
            attachment_ref_id: "other-scope-reference".into()
        })
        .result
        .code,
        "attachment_not_found"
    );
    let quote = pending.quotes[0].quote_id.clone();
    assert_ne!(
        apply_edit!(Action::Quote {
            action: QuoteAction::Remove {
                quote_id: quote.clone()
            }
        })
        .result
        .status,
        CommandResultStatus::Rejected
    );
    assert_ne!(
        apply_edit!(Action::Quote {
            action: QuoteAction::Restore {
                quote_id: quote.clone()
            }
        })
        .result
        .status,
        CommandResultStatus::Rejected
    );
    assert_ne!(
        apply_edit!(Action::Save {
            body: "已保存的排队问题".into()
        })
        .result
        .status,
        CommandResultStatus::Rejected
    );
    edit.payload.expected_revision += 1;
    edit.payload.draft_client = DraftClient::default();
    edit.payload.composer_scope = Some(f.scopes[1].clone());
    edit.payload.edit_token = None;
    let revision = read(f, 1).draft.revision;
    assert_eq!(
        apply_edit!(Action::ReturnToComposer {
            expected_draft_revision: revision,
            target_body: None
        })
        .result
        .code,
        "single_chat.capability_required"
    );
    assert_eq!(
        apply_edit!(Action::ReturnToComposer {
            expected_draft_revision: revision + 1,
            target_body: Some("保留当前正文".into())
        })
        .result
        .code,
        "single_chat.draft_changed"
    );
    edit.command_id = Uuid::new_v4().to_string();
    edit.payload.action = Action::ReturnToComposer {
        expected_draft_revision: revision,
        target_body: Some("保留当前正文".into()),
    };
    let retained_before: i64 = f
        .database
        .connection()
        .query_row("SELECT COUNT(*) FROM single_chat_retained_input", [], |r| {
            r.get(0)
        })
        .unwrap();
    f.database.connection().execute_batch("CREATE TEMP TRIGGER reject_pending_return_receipt BEFORE INSERT ON event_log WHEN NEW.command_type='single_chat.pending_input.edit' AND NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'return receipt rollback fixture'); END;").unwrap();
    assert!(service.edit_pending_input(&mut f.database, &edit).is_err());
    let state: String = f
        .database
        .connection()
        .query_row(
            "SELECT state FROM single_chat_pending_input WHERE id=?1",
            [&pending.id],
            |r| r.get(0),
        )
        .unwrap();
    let retained_after: i64 = f
        .database
        .connection()
        .query_row("SELECT COUNT(*) FROM single_chat_retained_input", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(state, "queued");
    assert_eq!(retained_before, retained_after);
    assert_eq!(read(f, 1).draft.revision, revision);
    f.database
        .connection()
        .execute_batch("DROP TRIGGER reject_pending_return_receipt")
        .unwrap();
    let returned = service.edit_pending_input(&mut f.database, &edit).unwrap();
    assert_eq!(returned.result.payload["placement"], "retained");
    assert_eq!(returned.result.payload["body"], "已保存的排队问题");
    assert_eq!(
        returned.result.payload["retainedInput"]["quotes"][0]["quoteId"],
        quote
    );
    assert_eq!(
        returned.result.payload["retainedInput"]["attachments"][0]["id"],
        pending.attachments[0].id
    );
    assert_eq!(read(f, 1).draft.revision, revision);
    let replay = service.edit_pending_input(&mut f.database, &edit).unwrap();
    assert!(replay.replayed);
    assert_eq!(
        serde_json::to_value(replay.result).unwrap(),
        serde_json::to_value(&returned.result).unwrap()
    );
    let saved = returned.result.payload["retainedInput"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    verify_private_attachment_locator(
        f,
        json!({
            "owner":"single_chat_retained", "threadId":f.thread,"conversationId":f.conversation,
            "composerScope":f.scopes[1],"retainedInputId":saved,
            "attachmentRefId":pending.attachments[0].id
        }),
        &DraftClient::default(),
    );
    let swapped = apply(
        f,
        1,
        revision,
        PrivateComposerAction::SwapRetained {
            retained_input_id: saved,
            expected_retained_revision: 1,
            current_body: "保留当前正文".into(),
        },
    );
    assert_eq!(swapped.payload["body"], "已保存的排队问题");
    assert_eq!(
        swapped.payload["draft"]["attachments"][0]["id"],
        pending.attachments[0].id
    );
    assert_eq!(swapped.payload["retainedInput"]["body"], "保留当前正文");
    let default_retained = Uuid::new_v4().to_string();
    let sources:String=f.database.connection().query_row("SELECT source_attachments_json FROM single_chat_composer_draft WHERE conversation_id=?1 AND client_id='desktop' AND scope_key=?2",
        params![f.conversation,f.scopes[1].storage_key().unwrap()],|row|row.get(0)).unwrap();
    f.database.connection().execute("INSERT INTO single_chat_retained_input(id,conversation_id,client_id,scope_key,body,source_attachments_json,created_at,updated_at) VALUES(?1,?2,'desktop','','默认保留输入',?3,'now','now')",
        params![default_retained,f.conversation,sources]).unwrap();
    verify_private_attachment_locator(
        f,
        json!({
            "owner":"single_chat_retained","threadId":f.thread,"conversationId":f.conversation,
            "composerScope":null,"retainedInputId":default_retained,"attachmentRefId":pending.attachments[0].id
        }),
        &DraftClient::default(),
    );
    let SingleChatComposerScope::Canvas { board_id, node_id } = &f.scopes[1];
    f.database
        .connection()
        .execute(
            "DELETE FROM canvas_node WHERE board_id=?1 AND id=?2",
            params![board_id, node_id],
        )
        .unwrap();
    verify_private_attachment_locator(
        f,
        json!({
            "owner":"single_chat_scoped_composer", "threadId":f.thread,"conversationId":f.conversation,
            "composerScope":f.scopes[1],"attachmentRefId":pending.attachments[0].id
        }),
        &DraftClient::default(),
    );
    assert!(
        service
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .pending_inputs
            .items
            .is_empty()
    );
}

fn upload_private_state(f: &Fixture) -> Vec<String> {
    let mut statement = f.database.connection().prepare(
        "SELECT 'draft:'||json_array(client_id,scope_key,revision,source_attachments_json,quotes_json,quote_trash_json) FROM single_chat_composer_draft WHERE conversation_id=?1
         UNION ALL SELECT 'working:'||json_array(client_id,scope_key,pending_input_id,edit_token,working_body,working_source_attachments_json,quotes_json,quote_trash_json) FROM single_chat_pending_input_edit_session WHERE conversation_id=?1
         UNION ALL SELECT 'scope:'||json_array(client_id,scope_key,board_id,node_id) FROM single_chat_composer_scope WHERE conversation_id=?1
         UNION ALL SELECT 'source:'||json_array(source_ref_id,observation_json) FROM single_chat_source_observation WHERE conversation_id=?1 ORDER BY 1"
    ).unwrap();
    statement
        .query_map([&f.conversation], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
}

fn assert_upload_business_rejection(
    f: &mut Fixture,
    client: &DraftClient,
    intent: crate::web_upload::UploadIntent,
    source: crate::local_attachment_source::LocalAttachmentSourceRef,
    code: &str,
) {
    let before = upload_private_state(f);
    let path = std::path::PathBuf::from(&source.source_path);
    let first = crate::web_upload::bind(
        &mut f.database,
        &path,
        client,
        intent.clone(),
        source.clone(),
    )
    .unwrap();
    assert_eq!(first.result.status, CommandResultStatus::Rejected);
    assert_eq!(first.result.code, code);
    assert_eq!(
        upload_private_state(f),
        before,
        "业务拒绝不能登记scope或改变正文/材料/源观察"
    );
    let recorded = crate::web_upload::reconcile(&f.database, client, intent.clone())
        .unwrap()
        .unwrap();
    assert!(recorded.replayed);
    assert_eq!(
        serde_json::to_value(&recorded.result).unwrap(),
        serde_json::to_value(&first.result).unwrap()
    );
    let replay = crate::web_upload::bind(&mut f.database, &path, client, intent, source).unwrap();
    assert!(replay.replayed);
    assert_eq!(
        serde_json::to_value(replay.result).unwrap(),
        serde_json::to_value(first.result).unwrap()
    );
    assert_eq!(upload_private_state(f), before);
}

fn verify_private_upload_bindings() {
    use crate::single_chat::{EditSingleChatPendingInputCommand, SingleChatPendingInputEditAction};
    use crate::web_upload::{self, UploadIntent, UploadTarget};
    use sha2::{Digest, Sha256};

    let mut f = fixture();
    let client = DraftClient::verified_web(&"7".repeat(64)).unwrap();
    let service = SingleChatService::for_client(client.clone());
    let file = f.database.directory().join("upload.txt");
    std::fs::write(&file, b"input").unwrap();
    let mut intent = UploadIntent {
        target: UploadTarget::SingleChat {
            conversation_id: f.conversation.clone(),
            composer_scope: Some(f.scopes[0].clone()),
        },
        command_id: Uuid::new_v4().to_string(),
        camp_id: f.thread.clone(),
        expected_revision: 0,
        display_name: "upload.txt".into(),
        byte_size: 5,
        sha256: format!("{:x}", Sha256::digest(b"input")),
        source_kind: crate::local_attachment_source::LocalAttachmentKind::File,
    };
    let mut source =
        observe_source_attachment(&file, &intent.display_name, Some("text/plain")).unwrap();
    source.id = intent.command_id.clone();
    let native_params = json!({
        "commandId":Uuid::new_v4().to_string(),"threadId":f.thread,"expectedRevision":0,
        "target":{"kind":"single_chat","conversationId":f.conversation},
        "sourcePath":file,"displayName":"upload.txt","mediaType":"text/plain"
    });
    assert!(
        web_upload::observe_native(
            &client,
            serde_json::from_value(native_params.clone()).unwrap()
        )
        .is_err()
    );
    let native = web_upload::observe_native(
        &DraftClient::default(),
        serde_json::from_value(native_params).unwrap(),
    )
    .unwrap();
    let native_intent: UploadIntent = serde_json::from_value(native["intent"].clone()).unwrap();
    let native_source = serde_json::from_value(native["source"].clone()).unwrap();
    assert_eq!(native_intent.sha256, intent.sha256);
    web_upload::bind(
        &mut f.database,
        &file,
        &DraftClient::default(),
        native_intent.clone(),
        native_source,
    )
    .unwrap();
    let mut public_native = native_intent;
    public_native.target = UploadTarget::Camp;
    public_native.command_id = Uuid::new_v4().to_string();
    assert!(web_upload::reconcile(&f.database, &DraftClient::default(), public_native).is_err());
    std::fs::write(&file, b"other").unwrap();
    assert!(
        web_upload::bind(
            &mut f.database,
            &file,
            &client,
            intent.clone(),
            source.clone()
        )
        .is_err()
    );
    assert!(
        web_upload::reconcile(&f.database, &client, intent.clone())
            .unwrap()
            .is_none()
    );
    std::fs::write(&file, b"input").unwrap();
    assert!(
        web_upload::reconcile(&f.database, &client, intent.clone())
            .unwrap()
            .is_none()
    );
    let first = web_upload::bind(
        &mut f.database,
        &file,
        &client,
        intent.clone(),
        source.clone(),
    )
    .unwrap();
    assert_eq!(first.result.status, CommandResultStatus::Applied);
    assert!(
        web_upload::bind(
            &mut f.database,
            &file,
            &DraftClient::default(),
            intent.clone(),
            source.clone()
        )
        .is_err()
    );
    let snapshot = web_upload::snapshot(&f.database, &file, &client, &intent).unwrap();
    assert_eq!(snapshot["draft"]["scopeVersion"], 1);
    assert_eq!(
        snapshot["draft"]["composerScope"],
        serde_json::to_value(&f.scopes[0]).unwrap()
    );
    assert_eq!(snapshot["draft"]["attachments"][0]["id"], intent.command_id);
    assert!(
        service
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .draft
            .attachments
            .is_empty()
    );
    assert!(
        read_draft(
            &f.database,
            &client,
            &f.thread,
            &f.conversation,
            Some(&f.scopes[1])
        )
        .unwrap()
        .draft
        .attachments
        .is_empty()
    );
    let original_intent = intent.clone();
    let original_source = source.clone();
    // 元数据重试已就绪时必须回滚，不能制造一次成功，也不能提前登记 scope。
    let mut ready = original_intent.clone();
    ready.command_id = Uuid::new_v4().to_string();
    ready.target = UploadTarget::SingleChat {
        conversation_id: f.conversation.clone(),
        composer_scope: Some(f.scopes[1].clone()),
    };
    let before = upload_private_state(&f);
    assert!(
        web_upload::retry_without_source(&mut f.database, &client, ready.clone())
            .unwrap()
            .is_none()
    );
    assert!(
        web_upload::reconcile(&f.database, &client, ready.clone())
            .unwrap()
            .is_none()
    );
    assert_eq!(before, upload_private_state(&f));
    let ended = web_upload::finish_preparation(&mut f.database, &client, ready.clone()).unwrap();
    assert_eq!(ended.result.status, CommandResultStatus::Rejected);
    assert_eq!(ended.result.code, "attachment.upload_preparation_ended");
    assert_eq!(before, upload_private_state(&f));
    let mut ended_source = original_source.clone();
    ended_source.id = ready.command_id.clone();
    let ended_replay =
        web_upload::bind(&mut f.database, &file, &client, ready.clone(), ended_source).unwrap();
    assert!(ended_replay.replayed);
    assert_eq!(
        ended_replay.result.code,
        "attachment.upload_preparation_ended"
    );
    assert_eq!(before, upload_private_state(&f));
    let known =
        web_upload::finish_preparation(&mut f.database, &client, original_intent.clone()).unwrap();
    assert!(known.replayed);
    assert_eq!(
        serde_json::to_value(&known.result).unwrap(),
        serde_json::to_value(&first.result).unwrap()
    );
    assert_eq!(before, upload_private_state(&f));
    let mut stale_retry = original_intent.clone();
    stale_retry.command_id = Uuid::new_v4().to_string();
    let stale = web_upload::retry_without_source(&mut f.database, &client, stale_retry.clone())
        .unwrap()
        .unwrap();
    assert_eq!(stale.result.status, CommandResultStatus::Rejected);
    assert_eq!(stale.result.code, "single_chat.draft_changed");
    assert_eq!(before, upload_private_state(&f));
    let foreign = DraftClient::verified_web(&"8".repeat(64)).unwrap();
    assert!(web_upload::finish_preparation(&mut f.database, &foreign, stale_retry).is_err());
    let mut public = ready;
    public.command_id = Uuid::new_v4().to_string();
    public.target = UploadTarget::Camp;
    assert!(web_upload::retry_without_source(&mut f.database, &client, public.clone()).is_err());
    assert!(web_upload::finish_preparation(&mut f.database, &client, public).is_err());
    let mut changed_target = intent.clone();
    changed_target.target = UploadTarget::SingleChat {
        conversation_id: f.conversation.clone(),
        composer_scope: Some(f.scopes[1].clone()),
    };
    // 继承 Gateway 的同编号首次结果规则；改载荷不把附件重新绑定到另一位置。
    let original_replay = web_upload::reconcile(&f.database, &client, changed_target)
        .unwrap()
        .unwrap();
    assert!(original_replay.replayed);
    assert_eq!(
        serde_json::to_value(&original_replay.result).unwrap(),
        serde_json::to_value(&first.result).unwrap()
    );
    assert!(
        read_draft(
            &f.database,
            &client,
            &f.thread,
            &f.conversation,
            Some(&f.scopes[1])
        )
        .unwrap()
        .draft
        .attachments
        .is_empty()
    );
    assert!(
        web_upload::reconcile(
            &f.database,
            &DraftClient::verified_web(&"8".repeat(64)).unwrap(),
            intent.clone()
        )
        .is_err()
    );
    let mut legacy = serde_json::to_value(&intent).unwrap();
    legacy["target"] = json!({"kind":"single_chat","conversationId":f.conversation});
    let parsed: UploadIntent = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
    legacy["target"]["scopeKey"] = json!("canvas:untrusted");
    assert!(serde_json::from_value::<UploadIntent>(legacy).is_err());
    let mut rejected_scope = original_intent.clone();
    rejected_scope.command_id = Uuid::new_v4().to_string();
    rejected_scope.expected_revision = 1;
    rejected_scope.target = UploadTarget::SingleChat {
        conversation_id: f.conversation.clone(),
        composer_scope: Some(f.scopes[1].clone()),
    };
    let mut rejected_source = source.clone();
    rejected_source.id = rejected_scope.command_id.clone();
    assert_upload_business_rejection(
        &mut f,
        &client,
        rejected_scope,
        rejected_source,
        "single_chat.draft_changed",
    );
    let failed_scope_count: i64 = f.database.connection().query_row(
        "SELECT COUNT(*) FROM single_chat_composer_scope WHERE conversation_id=?1 AND client_id=?2 AND scope_key=?3",
        params![f.conversation,client.id(),f.scopes[1].storage_key().unwrap()], |row| row.get(0),
    ).unwrap();
    assert_eq!(failed_scope_count, 0, "失败上传不留下首次位置登记");
    intent.command_id = Uuid::new_v4().to_string();
    source.id = intent.command_id.clone();
    assert_upload_business_rejection(
        &mut f,
        &client,
        intent.clone(),
        source.clone(),
        "single_chat.draft_changed",
    );

    for default_client in [DraftClient::default(), client.clone()] {
        let mut stale = original_intent.clone();
        stale.command_id = Uuid::new_v4().to_string();
        stale.target = UploadTarget::SingleChat {
            conversation_id: f.conversation.clone(),
            composer_scope: None,
        };
        stale.expected_revision = if default_client.is_desktop() { 0 } else { 1 };
        let mut unbound = original_source.clone();
        unbound.id = stale.command_id.clone();
        assert_upload_business_rejection(
            &mut f,
            &default_client,
            stale,
            unbound,
            "single_chat.draft_changed",
        );
    }
    let mut unavailable = original_intent.clone();
    unavailable.command_id = Uuid::new_v4().to_string();
    unavailable.target = UploadTarget::SingleChat { conversation_id: f.conversation.clone(), composer_scope: Some(serde_json::from_value(json!({
        "kind":"canvas","boardId":Uuid::new_v4().to_string(),"nodeId":Uuid::new_v4().to_string()
    })).unwrap()) };
    let mut unbound = original_source.clone();
    unbound.id = unavailable.command_id.clone();
    assert_upload_business_rejection(
        &mut f,
        &client,
        unavailable,
        unbound,
        "single_chat.scope_unavailable",
    );

    let mut send = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: client.clone(),
            composer_scope: Some(f.scopes[0].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "第一个问题".into(),
            draft_revision: 1,
        },
    );
    assert_eq!(
        service.send(&mut f.database, &send).unwrap().result.status,
        CommandResultStatus::Accepted
    );
    send.command_id = Uuid::new_v4().to_string();
    send.payload.body = "排队的问题".into();
    send.payload.draft_revision = 2;
    let queued = service.send(&mut f.database, &send).unwrap();
    assert_eq!(queued.result.code, "single_chat.pending_input_queued");
    let pending = service
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap()
        .pending_inputs
        .items[0]
        .clone();
    let mut edit = envelope(
        Some(&f.thread),
        EditSingleChatPendingInputCommand {
            draft_client: client.clone(),
            composer_scope: Some(f.scopes[0].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            pending_input_id: pending.id.clone(),
            expected_revision: pending.revision,
            edit_token: None,
            action: SingleChatPendingInputEditAction::Begin,
        },
    );
    let opened = service.edit_pending_input(&mut f.database, &edit).unwrap();
    let token = opened.result.payload["editToken"]
        .as_str()
        .unwrap()
        .to_owned();
    intent.command_id = Uuid::new_v4().to_string();
    intent.expected_revision = pending.revision;
    intent.target = UploadTarget::SingleChatPending {
        conversation_id: f.conversation.clone(),
        pending_input_id: pending.id.clone(),
        edit_token: token,
        composer_scope: Some(f.scopes[0].clone()),
    };
    source.id = intent.command_id.clone();
    web_upload::bind(
        &mut f.database,
        &file,
        &client,
        intent.clone(),
        source.clone(),
    )
    .unwrap();
    let snapshot = web_upload::snapshot(&f.database, &file, &client, &intent).unwrap();
    assert_eq!(
        snapshot["pendingInputs"]["editSession"]["workingAttachments"][0]["id"],
        intent.command_id
    );
    assert!(
        service
            .snapshot(&f.database, &f.conversation)
            .unwrap()
            .unwrap()
            .pending_inputs
            .edit_session
            .is_none()
    );
    let pending_original = intent.clone();
    if let UploadTarget::SingleChatPending { composer_scope, .. } = &mut intent.target {
        *composer_scope = Some(f.scopes[1].clone());
    }
    intent.command_id = Uuid::new_v4().to_string();
    source.id = intent.command_id.clone();
    assert_upload_business_rejection(
        &mut f,
        &client,
        intent.clone(),
        source.clone(),
        "single_chat.pending_input_edit_fenced",
    );
    edit.command_id = Uuid::new_v4().to_string();
    edit.payload.action = SingleChatPendingInputEditAction::Takeover;
    edit.payload.composer_scope = Some(f.scopes[1].clone());
    assert_eq!(
        service
            .edit_pending_input(&mut f.database, &edit)
            .unwrap()
            .result
            .code,
        "single_chat.pending_input_edit_started"
    );
    intent = pending_original;
    intent.command_id = Uuid::new_v4().to_string();
    source.id = intent.command_id.clone();
    assert_upload_business_rejection(
        &mut f,
        &client,
        intent,
        source,
        "single_chat.pending_input_edit_fenced",
    );

    // 回执存储失败仍是错误：就绪路径已写入的scope/材料/源观察全部回滚。
    f.database.connection().execute_batch("CREATE TEMP TRIGGER reject_upload_receipt BEFORE INSERT ON event_log WHEN NEW.command_type='camp.source_attachment.upload.bind' AND NEW.event_type='command.result' BEGIN SELECT RAISE(ABORT,'upload receipt rollback fixture'); END;").unwrap();
    let mut fault = original_intent.clone();
    fault.command_id = Uuid::new_v4().to_string();
    fault.target = UploadTarget::SingleChat {
        conversation_id: f.conversation.clone(),
        composer_scope: Some(f.scopes[2].clone()),
    };
    let mut fault_source = original_source.clone();
    fault_source.id = fault.command_id.clone();
    assert!(
        web_upload::bind(
            &mut f.database,
            &file,
            &client,
            fault.clone(),
            fault_source.clone()
        )
        .is_err()
    );
    assert!(
        web_upload::reconcile(&f.database, &client, fault.clone())
            .unwrap()
            .is_none()
    );
    assert!(
        read_draft(
            &f.database,
            &client,
            &f.thread,
            &f.conversation,
            Some(&f.scopes[2])
        )
        .unwrap()
        .draft
        .attachments
        .is_empty()
    );
    let observations:i64=f.database.connection().query_row("SELECT COUNT(*) FROM single_chat_source_observation WHERE conversation_id=?1 AND source_ref_id=?2",params![f.conversation,fault.command_id],|row|row.get(0)).unwrap();
    assert_eq!(observations, 0);
    let mut refused_fault = fault.clone();
    refused_fault.command_id = Uuid::new_v4().to_string();
    refused_fault.expected_revision = 1;
    let mut refused_source = fault_source.clone();
    refused_source.id = refused_fault.command_id.clone();
    assert!(
        web_upload::bind(
            &mut f.database,
            &file,
            &client,
            refused_fault.clone(),
            refused_source.clone()
        )
        .is_err()
    );
    assert!(
        web_upload::reconcile(&f.database, &client, refused_fault.clone())
            .unwrap()
            .is_none()
    );
    f.database
        .connection()
        .execute_batch("DROP TRIGGER reject_upload_receipt")
        .unwrap();
    assert_upload_business_rejection(
        &mut f,
        &client,
        refused_fault,
        refused_source,
        "single_chat.draft_changed",
    );
    assert_eq!(
        web_upload::bind(&mut f.database, &file, &client, fault, fault_source)
            .unwrap()
            .result
            .status,
        CommandResultStatus::Applied
    );

    let count: i64 = f
        .database
        .connection()
        .query_row("SELECT COUNT(*) FROM event_log", [], |row| row.get(0))
        .unwrap();
    std::fs::remove_file(&file).unwrap();
    let replay = web_upload::bind(
        &mut f.database,
        &file,
        &client,
        original_intent.clone(),
        original_source,
    )
    .unwrap();
    assert!(replay.replayed, "已存结果回放不重新读取已变化的源文件");
    assert_eq!(
        serde_json::to_value(replay.result).unwrap(),
        serde_json::to_value(first.result).unwrap()
    );
    assert!(
        web_upload::reconcile(&f.database, &client, original_intent)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        count,
        f.database
            .connection()
            .query_row("SELECT COUNT(*) FROM event_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap()
    );
}

fn verify_private_source_observations() {
    use crate::local_attachment_snapshot::observe_private_source;
    use crate::private_source_observation::{PreparationChanged, PreparedSources, changed_source};
    let mut f = fixture();
    add_default_source(&mut f, "observed.txt");
    let path = f.database.directory().join("observed.txt");
    let original = observe_private_source(&path).unwrap();
    assert_eq!(original, observe_private_source(&path).unwrap());
    apply(
        &mut f,
        0,
        0,
        PrivateComposerAction::AdoptLegacyMaterials {
            expected_source_revision: 1,
            target_body: "".into(),
        },
    );
    let send = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: Default::default(),
            composer_scope: Some(f.scopes[0].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "核对这份文件".into(),
            draft_revision: 1,
        },
    );
    let inputs = SingleChatService::send_source_inputs(&f.database, &send).unwrap();
    assert_eq!(inputs.len(), 1);
    let unprepared = SingleChatService::default()
        .with_prepared_sources(std::sync::Arc::new(PreparedSources::default()))
        .send(&mut f.database, &send)
        .unwrap_err();
    assert!(unprepared.is::<PreparationChanged>());
    assert!(
        DomainCommandGateway
            .replay_if_recorded(&f.database, &send)
            .unwrap()
            .is_none()
    );
    assert_eq!(read(&f, 0).draft.revision, 1);
    let prepared = PreparedSources::capture(inputs.clone()).unwrap();
    let mut foreign = inputs[0].clone();
    foreign.source_path.push_str("-another-source");
    {
        let tx = f.database.connection().unchecked_transaction().unwrap();
        let mismatch = crate::private_source_observation::capture_sources(
            &tx,
            &f.conversation,
            &[foreign],
            &prepared,
        )
        .unwrap_err();
        assert!(
            mismatch.is::<PreparationChanged>(),
            "same ref ID cannot borrow another path's observation"
        );
    }
    let mut mirror = inputs[0].clone();
    mirror.id = Uuid::new_v4().to_string();
    let ordered = PreparedSources::capture(vec![inputs[0].clone(), mirror.clone()]).unwrap();
    {
        let tx = f.database.connection().unchecked_transaction().unwrap();
        let reordered = crate::private_source_observation::capture_sources(
            &tx,
            &f.conversation,
            &[mirror, inputs[0].clone()],
            &ordered,
        )
        .unwrap_err();
        assert!(
            reordered.is::<PreparationChanged>(),
            "working materials changed during preparation must be re-read as one ordered input"
        );
    }
    std::fs::write(&path, vec![b'x'; "observed.txt".len()]).unwrap();
    let rejected = SingleChatService::default()
        .send(&mut f.database, &send)
        .unwrap();
    assert_eq!(
        rejected.result.code,
        "single_chat.attachment_source_changed"
    );
    assert_eq!(rejected.result.status, CommandResultStatus::Rejected);
    assert_eq!(read(&f, 0).draft.revision, 1);
    assert_eq!(read(&f, 0).draft.attachments.len(), 1);
    let snapshot = SingleChatService::default()
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap();
    assert!(snapshot.agent_runs.is_empty());
    assert!(snapshot.pending_inputs.items.is_empty());
    std::fs::write(&path, b"observed.txt").unwrap();
    let replay = SingleChatService::default()
        .with_prepared_sources(std::sync::Arc::new(PreparedSources::default()))
        .send(&mut f.database, &send)
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result.code, rejected.result.code);
    let saved = f.database.directory().join("observed-original.txt");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::write(&path, b"observed.txt").unwrap();
    let replacement = observe_private_source(&path).unwrap();
    assert_eq!(replacement.content_digest, original.content_digest);
    assert_ne!(replacement.identity_digest, original.identity_digest);

    let tree = f.database.directory().join("directory-source");
    std::fs::create_dir_all(tree.join("empty")).unwrap();
    std::fs::write(tree.join("b.txt"), b"bravo").unwrap();
    std::fs::write(tree.join("a.txt"), b"alpha").unwrap();
    let first = observe_private_source(&tree).unwrap();
    assert_eq!(first.file_count, 2);
    assert_eq!(first, observe_private_source(&tree).unwrap());
    let native = crate::web_upload::observe_native(&DraftClient::default(), serde_json::from_value(json!({
        "commandId":Uuid::new_v4().to_string(),"threadId":f.thread,"expectedRevision":0,
        "target":{"kind":"single_chat","conversationId":f.conversation,"composerScope":f.scopes[2]},
        "sourcePath":tree,"displayName":"selected-directory","mediaType":"application/octet-stream"
    })).unwrap()).unwrap();
    assert_eq!(native["intent"]["sourceKind"], "directory");
    assert_eq!(native["intent"]["byteSize"], first.byte_size);
    assert!(native["source"]["observedByteSize"].is_null());
    assert!(native["source"]["mediaType"].is_null());
    let native_intent: crate::web_upload::UploadIntent =
        serde_json::from_value(native["intent"].clone()).unwrap();
    let native_source: crate::local_attachment_source::LocalAttachmentSourceRef =
        serde_json::from_value(native["source"].clone()).unwrap();
    let web = DraftClient::verified_web(&"9".repeat(64)).unwrap();
    assert!(crate::web_upload::reconcile(&f.database, &web, native_intent.clone()).is_err());
    let mut wrong_size = native_intent.clone();
    wrong_size.byte_size += 1;
    assert!(
        crate::web_upload::bind(
            &mut f.database,
            &tree,
            &DraftClient::default(),
            wrong_size,
            native_source.clone()
        )
        .is_err()
    );
    assert!(
        crate::web_upload::reconcile(&f.database, &DraftClient::default(), native_intent.clone())
            .unwrap()
            .is_none()
    );
    assert!(
        read(&f, 2).draft.attachments.is_empty(),
        "目录观察错误与首次scope登记一起回滚"
    );
    crate::web_upload::bind(
        &mut f.database,
        &tree,
        &DraftClient::default(),
        native_intent.clone(),
        native_source,
    )
    .unwrap();
    assert_eq!(read(&f, 2).draft.attachments[0].kind, "directory");
    assert!(
        crate::web_upload::reconcile(&f.database, &DraftClient::default(), native_intent)
            .unwrap()
            .is_some()
    );
    let source = observe_source_attachment(&tree, "directory-source", None).unwrap();
    let revision = default_revision(&f);
    SingleChatService::default()
        .add_source_attachment(&mut f.database, &f.conversation, revision, source.clone())
        .unwrap();
    let check = |f: &Fixture| {
        changed_source(
            f.database.connection(),
            &f.conversation,
            std::slice::from_ref(&source),
            true,
            &PreparedSources::capture(vec![source.clone()]).unwrap(),
        )
        .unwrap()
    };
    assert!(check(&f).is_none());
    apply(&mut f, 1, 0, PrivateComposerAction::RegisterScope);
    let service = SingleChatService::default();
    let start = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: Default::default(),
            composer_scope: Some(f.scopes[1].clone()),
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "先执行的问题".into(),
            draft_revision: 0,
        },
    );
    assert_eq!(
        service.send(&mut f.database, &start).unwrap().result.status,
        CommandResultStatus::Accepted
    );
    let queued = envelope(
        Some(&f.thread),
        SendSingleChatMessageCommand {
            draft_client: Default::default(),
            composer_scope: None,
            camp_id: f.thread.clone(),
            conversation_id: f.conversation.clone(),
            body: "目录材料的问题".into(),
            draft_revision: default_revision(&f),
        },
    );
    assert_eq!(
        service.send(&mut f.database, &queued).unwrap().result.code,
        "single_chat.pending_input_queued"
    );
    std::fs::write(tree.join("a.txt"), b"other").unwrap();
    assert_eq!(check(&f), Some(source.id.clone()));
    f.database
        .connection()
        .execute(
            "UPDATE agent_run SET status='succeeded',ended_at=updated_at WHERE conversation_id=?1",
            [&f.conversation],
        )
        .unwrap();
    let mut ready = crate::single_chat::ready_pending_inputs(&f.database).unwrap();
    assert_eq!(ready.len(), 1);
    let publication = envelope(Some(&f.thread), ready.remove(0));
    let blocked = service
        .publish_pending_input(&mut f.database, &publication)
        .unwrap();
    assert_eq!(blocked.result.status, CommandResultStatus::Rejected);
    assert_eq!(blocked.result.code, "single_chat.attachment_source_changed");
    let retained = service
        .snapshot(&f.database, &f.conversation)
        .unwrap()
        .unwrap();
    assert_eq!(retained.pending_inputs.items[0].state, "needs_repair");
    assert_eq!(
        retained.pending_inputs.items[0].attachments[0].id,
        source.id
    );
    assert_eq!(retained.agent_runs.len(), 1, "目录变化不能启动第二个Run");
    assert!(
        crate::single_chat::ready_pending_inputs(&f.database)
            .unwrap()
            .is_empty(),
        "源失效队首进入待修复，不能形成自动重试循环"
    );
    // 旧对象保留在树外，验证不同现存对象的身份，不依赖时间精度或删除后的编号复用。
    std::fs::rename(tree.join("a.txt"), f.database.directory().join("old-a.txt")).unwrap();
    std::fs::write(tree.join("a.txt"), b"alpha").unwrap();
    let next = observe_private_source(&tree).unwrap();
    assert_ne!(
        first.content_digest, next.content_digest,
        "恢复相同字节不重置已改变的目录成员身份"
    );
    std::fs::rename(tree.join("empty"), tree.join("renamed-empty")).unwrap();
    assert_ne!(
        next.content_digest,
        observe_private_source(&tree).unwrap().content_digest
    );
    assert!(f.database.connection().execute("UPDATE single_chat_source_observation SET source_path='forged' WHERE conversation_id=?1",[&f.conversation]).is_err());
    let source_id = read(&f, 0).draft.attachments[0].id.clone();
    f.database.connection().execute("DELETE FROM single_chat_source_observation WHERE conversation_id=?1 AND source_ref_id=?2",params![f.conversation,source_id]).unwrap();
    let raw:String=f.database.connection().query_row("SELECT source_attachments_json FROM single_chat_composer_draft WHERE conversation_id=?1 AND client_id='desktop' AND scope_key=?2",params![f.conversation,f.scopes[0].storage_key().unwrap()],|row|row.get(0)).unwrap();
    let refs = parse_source_attachments(&raw).unwrap();
    let legacy_inputs = crate::private_source_observation::changed_source_inputs(
        f.database.connection(),
        &f.conversation,
        refs.clone(),
    )
    .unwrap();
    assert!(
        legacy_inputs.iter().all(|source| source.id != source_id),
        "legacy missing observations must not add content scans"
    );
    let legacy_prepared = PreparedSources::capture(legacy_inputs).unwrap();
    assert!(
        changed_source(
            f.database.connection(),
            &f.conversation,
            &refs,
            false,
            &legacy_prepared
        )
        .unwrap()
        .is_none(),
        "历史默认输入缺失旧摘要保持原兼容语义"
    );
    assert_eq!(
        changed_source(
            f.database.connection(),
            &f.conversation,
            &refs,
            true,
            &legacy_prepared
        )
        .unwrap(),
        Some(source_id)
    );
}

fn verify_private_attachment_locator(f: &Fixture, input: serde_json::Value, client: &DraftClient) {
    use crate::local_attachment_source::{
        LocalAttachmentOwnerLocator, load_source_attachment_for_client,
    };
    let locator: LocalAttachmentOwnerLocator = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(&locator).unwrap(), input);
    let legacy = json!({"owner":"single_chat_composer","threadId":f.thread,"conversationId":f.conversation,"attachmentRefId":input["attachmentRefId"]});
    assert_eq!(
        serde_json::to_value(
            serde_json::from_value::<LocalAttachmentOwnerLocator>(legacy.clone()).unwrap()
        )
        .unwrap(),
        legacy
    );
    let mut injected = legacy;
    injected["composerScope"] = input["composerScope"].clone();
    assert!(serde_json::from_value::<LocalAttachmentOwnerLocator>(injected).is_err());
    let before = f.database.connection().total_changes();
    let source = load_source_attachment_for_client(&f.database, &locator, client)
        .unwrap()
        .unwrap();
    assert_eq!(source.id, input["attachmentRefId"].as_str().unwrap());
    assert!(
        load_source_attachment_for_client(
            &f.database,
            &locator,
            &DraftClient::verified_web(&"9".repeat(64)).unwrap()
        )
        .unwrap()
        .is_none()
    );
    for field in [
        "threadId",
        "conversationId",
        "attachmentRefId",
        "retainedInputId",
        "pendingInputId",
        "editToken",
    ] {
        if input.get(field).is_none() {
            continue;
        }
        let mut changed = input.clone();
        changed[field] = json!(Uuid::new_v4().to_string());
        let changed: LocalAttachmentOwnerLocator = serde_json::from_value(changed).unwrap();
        assert!(
            load_source_attachment_for_client(&f.database, &changed, client)
                .unwrap()
                .is_none(),
            "{field}"
        );
    }
    let mut changed = input.clone();
    changed["composerScope"] = f
        .scopes
        .iter()
        .map(|scope| serde_json::to_value(scope).unwrap())
        .find(|scope| scope != &input["composerScope"])
        .unwrap();
    let changed: LocalAttachmentOwnerLocator = serde_json::from_value(changed).unwrap();
    assert!(
        load_source_attachment_for_client(&f.database, &changed, client)
            .unwrap()
            .is_none()
    );
    let mut changed = input.clone();
    changed["clientId"] = json!("desktop");
    assert!(serde_json::from_value::<LocalAttachmentOwnerLocator>(changed).is_err());
    assert_eq!(
        f.database.connection().total_changes(),
        before,
        "resource reads must not register or mutate"
    );
}

fn verify_application_routes(
    f: &mut Fixture,
    pending: &crate::single_chat::SingleChatPendingInputView,
) {
    use crate::application::private_composer::{handle, reconcile};
    use crate::single_chat::{EditSingleChatPendingInputCommand, SingleChatPendingInputEditAction};
    let client = DraftClient::default();
    SingleChatService::default()
        .edit_pending_input(
            &mut f.database,
            &envelope(
                Some(&f.thread),
                EditSingleChatPendingInputCommand {
                    composer_scope: None,
                    draft_client: client.clone(),
                    camp_id: f.thread.clone(),
                    conversation_id: f.conversation.clone(),
                    pending_input_id: pending.id.clone(),
                    expected_revision: pending.revision,
                    edit_token: None,
                    action: SingleChatPendingInputEditAction::Begin,
                },
            ),
        )
        .unwrap();
    f.database.connection().execute("UPDATE single_chat_pending_input_edit_session SET working_body='默认位置未保存正文' WHERE conversation_id=?1", [&f.conversation]).unwrap();
    let legacy = handle(
        &mut f.database,
        &client,
        "singleChat.get",
        json!({"conversationId":f.conversation}),
    )
    .unwrap();
    assert_eq!(legacy.result["draft"].as_object().unwrap().len(), 4);
    assert!(
        legacy.result["pendingInputs"]
            .get("editingElsewhere")
            .is_none()
    );
    let token = legacy.result["pendingInputs"]["editSession"]["editToken"]
        .as_str()
        .unwrap()
        .to_owned();
    let default_view = handle(
        &mut f.database,
        &client,
        "singleChat.get",
        json!({"conversationId":f.conversation,"composerScope":null}),
    )
    .unwrap();
    assert_eq!(default_view.result["draft"]["scopeVersion"], 1);
    assert_eq!(default_view.result["draft"]["scopeKey"], "");
    assert_eq!(
        default_view.result["pendingInputs"]["editingElsewhere"],
        false
    );
    let alpha = handle(
        &mut f.database,
        &client,
        "singleChat.get",
        json!({"conversationId":f.conversation,"composerScope":f.scopes[0]}),
    )
    .unwrap();
    assert!(alpha.result["pendingInputs"]["editSession"].is_null());
    assert_eq!(alpha.result["pendingInputs"]["editingElsewhere"], true);
    assert!(
        !serde_json::to_string(&alpha.result)
            .unwrap()
            .contains(&token)
    );
    assert!(
        !serde_json::to_string(&alpha.result)
            .unwrap()
            .contains("默认位置未保存正文")
    );
    assert!(
        alpha.result["draft"]["attachments"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let beta_key = PrivateComposerKey::for_scope(Some(&f.scopes[1])).unwrap();
    f.database.connection().execute("UPDATE single_chat_pending_input_edit_session SET scope_key=?2 WHERE conversation_id=?1", params![f.conversation,beta_key.sql_key()]).unwrap();
    let default_hidden = handle(
        &mut f.database,
        &client,
        "singleChat.get",
        json!({"conversationId":f.conversation}),
    )
    .unwrap();
    assert!(default_hidden.result["pendingInputs"]["editSession"].is_null());
    let beta = handle(
        &mut f.database,
        &client,
        "singleChat.get",
        json!({"conversationId":f.conversation,"composerScope":f.scopes[1]}),
    )
    .unwrap();
    assert_eq!(
        beta.result["pendingInputs"]["editSession"]["editToken"],
        token
    );
    assert_eq!(
        beta.result["pendingInputs"]["editSession"]["workingQuotes"][0]["quoteId"],
        pending.quotes[0].quote_id
    );
    assert_eq!(beta.result["pendingInputs"]["editingElsewhere"], false);
    let web = DraftClient::verified_web(&"6".repeat(64)).unwrap();
    let mutation = json!({"commandId":Uuid::new_v4().to_string(),"command":{
        "threadId":f.thread,"conversationId":f.conversation,"composerScope":f.scopes[2],
        "expectedDraftRevision":0,"action":{"type":"register_scope"}}});
    assert_eq!(
        reconcile(&f.database, &web, mutation.clone()).unwrap()["state"],
        "unknown"
    );
    let first = handle(
        &mut f.database,
        &web,
        "singleChat.composerDraft.mutate",
        mutation.clone(),
    )
    .unwrap();
    assert_eq!(first.result["status"], "applied");
    assert_eq!(
        first.changed,
        Some((f.thread.clone(), f.conversation.clone()))
    );
    let before: i64 = f
        .database
        .connection()
        .query_row("SELECT COUNT(*) FROM event_log", [], |row| row.get(0))
        .unwrap();
    let stored = reconcile(&f.database, &web, mutation.clone()).unwrap();
    assert_eq!(stored["state"], "recorded");
    assert_eq!(stored["result"], first.result);
    let again = handle(
        &mut f.database,
        &web,
        "singleChat.composerDraft.mutate",
        mutation.clone(),
    )
    .unwrap();
    assert_eq!(again.result, first.result);
    assert!(again.changed.is_none());
    assert!(reconcile(&f.database, &client, mutation.clone()).is_err());
    let after: i64 = f
        .database
        .connection()
        .query_row("SELECT COUNT(*) FROM event_log", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after);
    let recovery = handle(
        &mut f.database,
        &web,
        "singleChat.composerDraft.recovery",
        json!({"threadId":f.thread,"conversationId":f.conversation}),
    )
    .unwrap();
    assert_eq!(recovery.result["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        recovery.result["items"][0]["scope"]["composerScope"],
        serde_json::to_value(&f.scopes[2]).unwrap()
    );
    let mut spoof = mutation.clone();
    spoof["command"]["draftClient"] = json!({"clientId":"desktop"});
    assert!(
        handle(
            &mut f.database,
            &web,
            "singleChat.composerDraft.mutate",
            spoof.clone()
        )
        .is_err()
    );
    assert!(reconcile(&f.database, &web, spoof).is_err());
    assert!(
        handle(
            &mut f.database,
            &web,
            "singleChat.get",
            json!({"conversationId":f.conversation,"scopeKey":beta_key.sql_key()})
        )
        .is_err()
    );
    assert!(
        handle(
            &mut f.database,
            &web,
            "singleChat.composerDraft.recovery",
            json!({"threadId":f.thread,"conversationId":f.conversation,"clientId":"desktop"})
        )
        .is_err()
    );
    let missing = handle(
        &mut f.database,
        &web,
        "singleChat.get",
        json!({"conversationId":"missing","composerScope":null}),
    )
    .unwrap();
    assert!(missing.result.is_null());
}
