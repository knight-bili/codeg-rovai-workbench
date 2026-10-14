use serde_json::{Value, json};

pub const NATIVE_SESSION_BOOTSTRAP_CONTRACT_VERSION: &str = "native_session_bootstrap_v5";
pub const BOOTSTRAP_FORMATTER_VERSION: i64 = 5;
pub const SESSION_CHARTER_REVISION: i64 = 22;
const NATIVE_BINDING_CHARTER_COMPATIBILITY_REVISION: i64 = 16;
pub const AGENT_RUN_CONTEXT_FORMATTER_VERSION: i64 = 29;
pub const CONTEXT_MANIFEST_VERSION: i64 = 29;
pub const PUBLIC_CAMP_BATCH_CONTEXT_FORMATTER_VERSION: i64 = 34;
pub const PUBLIC_CAMP_BATCH_CONTEXT_MANIFEST_VERSION: i64 = 34;

pub(crate) const PACK_CONTEXT_MANIFEST_VERSION: i64 = 29;
pub(crate) const PACK_PUBLIC_CONTEXT_MANIFEST_VERSION: i64 = 34;

/// Numeric version 29 belongs to two different frozen contracts. Callers must
/// retain the invocation/profile/facts tuple instead of classifying by number.
pub(crate) fn skill_pack_context_format(
    invocation_kind: &str,
    manifest_version: i64,
    profile_version: i64,
    facts_version: i64,
) -> anyhow::Result<bool> {
    let batch = invocation_kind == "batch";
    anyhow::ensure!(
        batch
            || matches!(
                invocation_kind,
                "direct" | "a2a" | "single_chat" | "gather_completion"
            ),
        "Unknown Context invocation kind"
    );
    match (batch, manifest_version, profile_version, facts_version) {
        (true, PACK_PUBLIC_CONTEXT_MANIFEST_VERSION, 10, 9)
        | (false, PACK_CONTEXT_MANIFEST_VERSION, 7, 6) => Ok(true),
        (true, 29, 9, 7)
        | (true, 30, 10, 7)
        | (true, 31, 10, 8)
        | (true, 32 | 33, 10, 9)
        | (false, 26, 6, 5)
        | (false, 27, 7, 5)
        | (false, 28, 7, 6) => Ok(false),
        _ => anyhow::bail!("Context format/profile/Run Facts pairing is invalid"),
    }
}

#[cfg(test)]
pub(crate) fn native_binding_context_contract() -> Value {
    json!({
        "nativeSessionBootstrap": NATIVE_SESSION_BOOTSTRAP_CONTRACT_VERSION,
        "bootstrapFormatterVersion": BOOTSTRAP_FORMATTER_VERSION,
        "sessionCharterRevision": SESSION_CHARTER_REVISION,
        "agentRunContextFormatterVersion": AGENT_RUN_CONTEXT_FORMATTER_VERSION,
        "contextManifestVersion": CONTEXT_MANIFEST_VERSION,
    })
}

/// Compatible naming and wording changes preserve existing Native Sessions. New bindings use
/// the current Charter; existing bindings keep their frozen Bootstrap evidence.
pub(crate) fn native_binding_compatibility_context_contract() -> Value {
    json!({
        "nativeSessionBootstrap": "native_session_bootstrap_v4",
        "bootstrapFormatterVersion": 4,
        "sessionCharterRevision": NATIVE_BINDING_CHARTER_COMPATIBILITY_REVISION,
        "agentRunContextFormatterVersion": 26,
        "contextManifestVersion": 26,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/agent-run-context-v26.json"
        ))
        .expect("shared AgentRun context fixture must be valid JSON")
    }

    #[test]
    fn binding_contract_rotates_existing_sessions_for_new_charter() {
        let fixture = shared_fixture();
        let legacy = json!({
            "nativeSessionBootstrap": fixture["nativeSessionBootstrap"],
            "bootstrapFormatterVersion": fixture["bootstrapFormatterVersion"],
            "sessionCharterRevision": 4,
            "agentRunContextFormatterVersion": fixture["agentRunContextFormatterVersion"],
            "contextManifestVersion": fixture["contextManifestVersion"],
        });
        let current = native_binding_context_contract();
        let compatibility = native_binding_compatibility_context_contract();
        assert_eq!(SESSION_CHARTER_REVISION, 22);
        assert_eq!(compatibility["sessionCharterRevision"], json!(16));
        assert_eq!(PUBLIC_CAMP_BATCH_CONTEXT_FORMATTER_VERSION, 34);
        assert_eq!(PUBLIC_CAMP_BATCH_CONTEXT_MANIFEST_VERSION, 34);
        for (kind, manifest, profile, facts, packs) in [
            ("batch", 29, 9, 7, false),
            ("batch", 33, 10, 9, false),
            ("batch", 34, 10, 9, true),
            ("direct", 28, 7, 6, false),
            ("direct", 29, 7, 6, true),
            ("a2a", 29, 7, 6, true),
            ("single_chat", 29, 7, 6, true),
            ("gather_completion", 29, 7, 6, true),
        ] {
            assert_eq!(
                skill_pack_context_format(kind, manifest, profile, facts).unwrap(),
                packs
            );
        }
        for (kind, manifest, profile, facts) in [
            ("batch", 29, 7, 6),
            ("single_chat", 29, 9, 7),
            ("batch", 34, 9, 7),
            ("direct", 29, 7, 5),
            ("batch", 35, 10, 9),
            ("unknown", 29, 7, 6),
        ] {
            assert!(skill_pack_context_format(kind, manifest, profile, facts).is_err());
        }
        assert_eq!(
            current,
            json!({
                "nativeSessionBootstrap": "native_session_bootstrap_v5",
                "bootstrapFormatterVersion": 5,
                "sessionCharterRevision": SESSION_CHARTER_REVISION,
                "agentRunContextFormatterVersion": 29,
                "contextManifestVersion": 29,
            })
        );
        assert_eq!(
            compatibility,
            json!({
                "nativeSessionBootstrap": fixture["nativeSessionBootstrap"],
                "bootstrapFormatterVersion": fixture["bootstrapFormatterVersion"],
                "sessionCharterRevision": NATIVE_BINDING_CHARTER_COMPATIBILITY_REVISION,
                "agentRunContextFormatterVersion": fixture["agentRunContextFormatterVersion"],
                "contextManifestVersion": fixture["contextManifestVersion"],
            })
        );
        let mut unversioned_charter = legacy.clone();
        unversioned_charter
            .as_object_mut()
            .unwrap()
            .remove("sessionCharterRevision");
        let previous_compatible_charter = json!({
            "nativeSessionBootstrap": fixture["nativeSessionBootstrap"],
            "bootstrapFormatterVersion": fixture["bootstrapFormatterVersion"],
            "sessionCharterRevision": 13,
            "agentRunContextFormatterVersion": fixture["agentRunContextFormatterVersion"],
            "contextManifestVersion": fixture["contextManifestVersion"],
        });
        let mut previous_new_charter = compatibility.clone();
        previous_new_charter["sessionCharterRevision"] = json!(14);
        let mut previous_reply_stop_charter = compatibility.clone();
        previous_reply_stop_charter["sessionCharterRevision"] = json!(15);
        for old_contract in [
            legacy,
            unversioned_charter,
            previous_compatible_charter,
            previous_new_charter,
            previous_reply_stop_charter,
        ] {
            assert_ne!(
                crate::command::canonical_json_digest(&compatibility).unwrap(),
                crate::command::canonical_json_digest(&old_contract).unwrap(),
                "incompatible Charter contracts must rotate Adapter Binding compatibility digests"
            );
        }
    }
}
