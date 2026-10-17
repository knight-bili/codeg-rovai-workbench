//! 私聊草稿的卡片归属；编辑端认证继续由 DraftClient 和可信 Host 负责。
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SingleChatComposerScope {
    Canvas {
        #[serde(deserialize_with = "deserialize_canvas_id")]
        board_id: String,
        #[serde(deserialize_with = "deserialize_canvas_id")]
        node_id: String,
    },
}

fn canonical_canvas_id(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn deserialize_canvas_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if canonical_canvas_id(&value) {
        Ok(value)
    } else {
        Err(D::Error::custom("invalid canvas identity"))
    }
}

impl SingleChatComposerScope {
    /// 仅供 Core 存储。空串预留给旧默认草稿，网络不能直接传入 key。
    pub fn storage_key(&self) -> Result<String> {
        let Self::Canvas { board_id, node_id } = self;
        ensure!(
            canonical_canvas_id(board_id) && canonical_canvas_id(node_id),
            "invalid canvas identity"
        );
        Ok(format!("canvas:{board_id}:{node_id}"))
    }

    /// 首次登记时在调用方写事务中核对真实 pin；不读取或分配草稿。
    /// 这不是用户/编辑端认证。已登记的孤立输入不能因此被清理或重新绑定。
    pub fn matches_current_pin(
        &self,
        connection: &Connection,
        thread_id: &str,
        conversation_id: &str,
    ) -> Result<bool> {
        self.storage_key()?;
        let Self::Canvas { board_id, node_id } = self;
        Ok(connection.query_row(
            CURRENT_PIN_SQL,
            params![board_id, node_id, thread_id, conversation_id],
            |row| row.get(0),
        )?)
    }
}

/// 由描述派生的闭合 Core key；不是网络参数或权限凭据。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrivateComposerKey(String);

impl PrivateComposerKey {
    pub fn for_scope(scope: Option<&SingleChatComposerScope>) -> Result<Self> {
        scope.map_or_else(
            || Ok(Self::default()),
            |scope| scope.storage_key().map(Self),
        )
    }

    pub(crate) fn sql_key(&self) -> &str {
        &self.0
    }
}

const CURRENT_PIN_SQL: &str = "SELECT EXISTS(
    SELECT 1 FROM canvas_node AS node
    JOIN canvas_board AS board ON board.id=node.board_id
    JOIN conversation ON conversation.id=node.conversation_id
    JOIN camp ON camp.id=conversation.camp_id
    WHERE node.board_id=?1 AND node.id=?2 AND node.kind='conversation'
      AND node.thread_id=?3 AND node.conversation_id=?4
      AND conversation.camp_id=?3 AND conversation.kind='single_chat'
      AND conversation.ended_at IS NULL
      AND camp.activation_state='active' AND camp.deletion_operation_id IS NULL
      AND board.deleted_at IS NULL
)";

/// get 的省略与显式 null 必须区分：只有后者申请 scopeVersion 回显。
/// send 等命令另用 Option<SingleChatComposerScope> 并省略 None，保持旧摘要。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SingleChatComposerScopeRequest {
    #[default]
    Legacy,
    Explicit(Option<SingleChatComposerScope>),
}

impl SingleChatComposerScopeRequest {
    pub fn is_legacy(&self) -> bool {
        matches!(self, Self::Legacy)
    }

    pub fn scope(&self) -> Option<&SingleChatComposerScope> {
        match self {
            Self::Legacy => None,
            Self::Explicit(scope) => scope.as_ref(),
        }
    }
}

impl Serialize for SingleChatComposerScopeRequest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.scope().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SingleChatComposerScopeRequest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<SingleChatComposerScope>::deserialize(deserializer).map(Self::Explicit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BOARD: &str = "11111111-1111-4111-8111-111111111111";
    const PIN: &str = "22222222-2222-4222-8222-222222222222";
    const MIRROR: &str = "33333333-3333-4333-8333-333333333333";

    fn scope() -> SingleChatComposerScope {
        SingleChatComposerScope::Canvas {
            board_id: BOARD.to_owned(),
            node_id: PIN.to_owned(),
        }
    }

    #[test]
    fn scope_codec_preserves_legacy_omission_and_requires_explicit_closed_identity() {
        #[derive(Debug, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Input {
            conversation_id: String,
            #[serde(
                default,
                skip_serializing_if = "SingleChatComposerScopeRequest::is_legacy"
            )]
            composer_scope: SingleChatComposerScopeRequest,
        }
        let legacy = json!({"conversationId":"private"});
        let decoded: Input = serde_json::from_value(legacy.clone()).unwrap();
        assert!(decoded.composer_scope.is_legacy());
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
        let explicit = json!({"conversationId":"private","composerScope":null});
        let decoded: Input = serde_json::from_value(explicit.clone()).unwrap();
        assert_eq!(
            decoded.composer_scope,
            SingleChatComposerScopeRequest::Explicit(None)
        );
        assert_eq!(serde_json::to_value(decoded).unwrap(), explicit);
        let expected = json!({"kind":"canvas","boardId":BOARD,"nodeId":PIN});
        let decoded: SingleChatComposerScope = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(decoded, scope());
        assert_eq!(serde_json::to_value(&decoded).unwrap(), expected);
        assert_eq!(
            decoded.storage_key().unwrap(),
            format!("canvas:{BOARD}:{PIN}")
        );
        let mirror = SingleChatComposerScope::Canvas {
            board_id: BOARD.into(),
            node_id: MIRROR.into(),
        };
        assert_ne!(
            decoded.storage_key().unwrap(),
            mirror.storage_key().unwrap()
        );
        for invalid in [
            json!({"kind":"default"}),
            json!({"kind":"canvas","boardId":BOARD}),
            json!({"kind":"canvas","boardId":"","nodeId":PIN}),
            json!({"kind":"canvas","boardId":BOARD,"nodeId":"pin' OR 1=1"}),
            json!({"kind":"canvas","boardId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","nodeId":PIN}),
            json!({"kind":"canvas","boardId":BOARD.replace('-', ""),"nodeId":PIN}),
            json!({"kind":"canvas","boardId":BOARD,"nodeId":null}),
            json!({"kind":"canvas","boardId":BOARD,"nodeId":42}),
            json!({"kind":"canvas","boardId":BOARD,"nodeId":PIN,"scopeKey":""}),
            json!({"kind":"canvas","boardId":BOARD,"nodeId":PIN,"draftClient":"desktop"}),
            json!({"kind":"canvas","boardId":BOARD,"nodeId":PIN,"kindExtra":"canvas"}),
        ] {
            assert!(serde_json::from_value::<SingleChatComposerScope>(invalid).is_err());
        }
        let constructed = SingleChatComposerScope::Canvas {
            board_id: BOARD.into(),
            node_id: "bad".into(),
        };
        assert!(constructed.storage_key().is_err());
    }

    #[test]
    fn pin_binding_requires_the_exact_live_private_reference_without_writing() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE canvas_board(id TEXT PRIMARY KEY,deleted_at TEXT);
            CREATE TABLE canvas_node(id TEXT PRIMARY KEY,board_id TEXT,kind TEXT,thread_id TEXT,conversation_id TEXT);
            CREATE TABLE camp(id TEXT PRIMARY KEY,activation_state TEXT,deletion_operation_id TEXT);
            CREATE TABLE conversation(id TEXT PRIMARY KEY,camp_id TEXT,kind TEXT,ended_at TEXT);
            INSERT INTO camp VALUES('thread','active',NULL);
            INSERT INTO conversation VALUES('private','thread','single_chat',NULL);").unwrap();
        db.execute("INSERT INTO canvas_board VALUES(?1,NULL)", [BOARD])
            .unwrap();
        db.execute(
            "INSERT INTO canvas_node VALUES(?1,?2,'conversation','thread','private')",
            params![PIN, BOARD],
        )
        .unwrap();
        let changes = db.total_changes();
        assert!(
            scope()
                .matches_current_pin(&db, "thread", "private")
                .unwrap()
        );
        assert!(
            !scope()
                .matches_current_pin(&db, "foreign", "private")
                .unwrap()
        );
        assert!(
            !scope()
                .matches_current_pin(&db, "thread", "other-private")
                .unwrap()
        );
        let mirror = SingleChatComposerScope::Canvas {
            board_id: BOARD.into(),
            node_id: MIRROR.into(),
        };
        assert!(
            !mirror
                .matches_current_pin(&db, "thread", "private")
                .unwrap()
        );
        assert_eq!(db.total_changes(), changes);
        for (mutate, restore) in [
            (
                "UPDATE canvas_board SET deleted_at='deleted'",
                "UPDATE canvas_board SET deleted_at=NULL",
            ),
            (
                "UPDATE canvas_node SET kind='note'",
                "UPDATE canvas_node SET kind='conversation'",
            ),
            (
                "UPDATE canvas_node SET conversation_id=NULL",
                "UPDATE canvas_node SET conversation_id='private'",
            ),
            (
                "UPDATE conversation SET camp_id='foreign'",
                "UPDATE conversation SET camp_id='thread'",
            ),
            (
                "UPDATE conversation SET kind='shared'",
                "UPDATE conversation SET kind='single_chat'",
            ),
            (
                "UPDATE conversation SET ended_at='ended'",
                "UPDATE conversation SET ended_at=NULL",
            ),
            (
                "UPDATE camp SET activation_state='pending'",
                "UPDATE camp SET activation_state='active'",
            ),
            (
                "UPDATE camp SET deletion_operation_id='deleting'",
                "UPDATE camp SET deletion_operation_id=NULL",
            ),
        ] {
            db.execute_batch(mutate).unwrap();
            let changes = db.total_changes();
            assert!(
                !scope()
                    .matches_current_pin(&db, "thread", "private")
                    .unwrap(),
                "{mutate}"
            );
            assert_eq!(db.total_changes(), changes);
            db.execute_batch(restore).unwrap();
        }
        db.execute("DELETE FROM canvas_node WHERE id=?1", [PIN])
            .unwrap();
        assert!(
            !scope()
                .matches_current_pin(&db, "thread", "private")
                .unwrap()
        );
    }
}
