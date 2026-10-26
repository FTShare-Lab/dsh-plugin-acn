//! 用公开协议类型导出基准报文，并读回跨语言生成的 YAML。
use agent_claim_network::{
    auth::{sha256_hex, AuthEnvelope, AuthRequest},
    claim::*,
    config::{DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT},
    memory::{
        apply_ops_to_texts, snapshot_texts, MemoryApplyReport, MemoryOp, MemorySnapshot,
        MemoryUsage,
    },
    router::{AgentQuery, RouterQueryResult, ScopesOverviewSnapshot},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, error::Error, fs, path::Path};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

// 这些持久化类型不是公开 API；字段与序列化属性逐项对照当前源代码。
#[derive(Serialize, Deserialize)]
struct Consolidation {
    before: Claim,
    retired: Claim,
    carriers: Vec<Claim>,
}
#[derive(Serialize, Deserialize, Default)]
struct Uploads {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    consolidations: Vec<Consolidation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    acknowledgements: Vec<Claim>,
    #[serde(default)]
    claims: Vec<Claim>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    durable_claim_ids: std::collections::BTreeSet<ClaimId>,
    #[serde(default)]
    disputes: Vec<Dispute>,
}
#[derive(Serialize, Deserialize)]
struct PendingEdit {
    expected_revision: String,
    target: Claim,
}
#[derive(Serialize, Deserialize)]
struct ReportedRecord {
    first_dispute_id: DisputeId,
    #[serde(with = "agent_claim_network::time::serde_utc")]
    reported_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, Deserialize, Default)]
struct ReportedSets {
    #[serde(default)]
    reported_claim_sets: BTreeMap<String, ReportedRecord>,
}

// 整理记录是私有类型镜像：参考 dream、dream_plan、dream_execution、dream_review。
#[derive(Serialize, Deserialize)]
struct DreamState {
    last_success_at: Option<chrono::DateTime<chrono::Utc>>,
    last_input_snapshot_at: Option<chrono::DateTime<chrono::Utc>>,
    known_versions: BTreeMap<ClaimId, String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamUpdate {
    id: ClaimId,
    name: String,
    statement: String,
    scope: String,
    confidence: Confidence,
    status: ClaimStatus,
    source_claim_ids: Vec<SourceId>,
    evidence_summary: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamCoverage {
    input_id: ClaimId,
    output_ids: Vec<ClaimId>,
    note: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamBasis {
    claim_id: ClaimId,
    removed_or_changed: String,
    added: String,
    justification: String,
    evidence_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamGroup {
    kind: DreamKind,
    reason: String,
    evidence_ids: Vec<String>,
    coverage: Vec<DreamCoverage>,
    #[serde(default)]
    change_basis: Vec<DreamBasis>,
    updates: Vec<DreamUpdate>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DreamKind {
    Quality,
    Evidence,
    Consolidation,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamReview {
    quality: String,
    evidence: String,
    consolidation: String,
}
#[derive(Serialize, Deserialize)]
struct DreamPlan {
    review: DreamReview,
    groups: Vec<DreamGroup>,
}
#[derive(Serialize, Deserialize)]
struct DreamPrepared {
    before: Vec<Claim>,
    after: Vec<Claim>,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    skipped: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamClaimReview {
    claim_id: ClaimId,
    #[serde(default)]
    final_name: String,
    #[serde(default)]
    name_reason: String,
    information_preserved: String,
    removal_or_correction: String,
    factual_correction: bool,
    output_ids: Vec<ClaimId>,
    evidence_ids: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamSemantic {
    claims: Vec<DreamClaimReview>,
    scope_and_certainty: String,
}
#[derive(Serialize, Deserialize)]
struct DreamExecution {
    job_id: String,
    group_id: String,
    validation_id: String,
    review: DreamSemantic,
    hard_validation_passed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamQuote {
    claim_id: ClaimId,
    field: String,
    quote: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamEvidenceQuote {
    evidence_id: String,
    quote: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DreamDisposition {
    Preserved,
    Episodic,
    Corrected,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamPreservation {
    before: DreamQuote,
    after: Vec<DreamQuote>,
    disposition: DreamDisposition,
    reason: String,
    evidence: Vec<DreamEvidenceQuote>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamSupport {
    after: DreamQuote,
    before: Vec<DreamQuote>,
    evidence: Vec<DreamEvidenceQuote>,
    reason: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DreamSelfReview {
    group_id: String,
    validation_id: String,
    preservation: Vec<DreamPreservation>,
    support: Vec<DreamSupport>,
    scope_and_certainty: String,
}
#[derive(Serialize, Deserialize)]
struct DreamValidation {
    validation_id: String,
    input: Value,
}
#[derive(Serialize, Deserialize)]
struct DreamReviewRecord {
    validation: DreamValidation,
    review: DreamSelfReview,
}
#[derive(Serialize, Deserialize)]
struct DreamCheckpoint {
    snapshot_at: chrono::DateTime<chrono::Utc>,
    input_versions: BTreeMap<ClaimId, String>,
    coverage: Value,
    plan: DreamPlan,
    receipts: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exploration_receipts: Option<usize>,
    groups: Vec<DreamPrepared>,
    #[serde(default)]
    safety_reviews: Vec<Value>,
    #[serde(default)]
    self_reviews: Vec<DreamReviewRecord>,
    trace_id: TraceId,
    #[serde(default)]
    applied: bool,
    #[serde(default)]
    success_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    self_versions: BTreeMap<ClaimId, String>,
    #[serde(default)]
    operation: Option<DreamExecution>,
}

fn emit<T: Serialize + DeserializeOwned>(
    out: &Path,
    verify: bool,
    name: &str,
    kind: &str,
    input: Value,
    manifest: &mut Vec<Value>,
) -> Result<()> {
    let value: T = serde_json::from_value(input)?;
    let canonical = serde_json::to_string(&value)?;
    if verify {
        let back: T =
            serde_yaml_ng::from_str(&fs::read_to_string(out.join(format!("{name}.yaml")))?)?;
        if serde_json::to_string(&back)? != canonical {
            return Err(format!("YAML readback differs: {name}").into());
        }
    } else {
        fs::write(out.join(format!("{name}.json")), &canonical)?;
        fs::write(
            out.join(format!("{name}.yaml")),
            serde_yaml_ng::to_string(&value)?,
        )?;
    }
    let mut item = json!({"name": name, "kind": kind});
    if kind == "claim" {
        item["revision"] = json!(format!("sha256-v1:{}", sha256_hex(&canonical)));
    }
    manifest.push(item);
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let verify = args.get(1).is_some_and(|arg| arg == "verify");
    let out = Path::new(
        args.get(2)
            .ok_or("expected export|verify and output directory")?,
    );
    fs::create_dir_all(out)?;
    let mut manifest = Vec::new();
    emit::<Vec<MemoryOp>>(
        out,
        verify,
        "memory-ops",
        "memory-ops",
        json!([
            {"op":"add","target":"memory","entry":"Example stable environment."},
            {"op":"replace","target":"user","old_text":"old preference","new_text":"Concise 中文 😀 explanations."},
            {"op":"remove","target":"memory","old_text":"obsolete"}
        ]),
        &mut manifest,
    )?;
    emit::<MemorySnapshot>(
        out,
        verify,
        "memory-snapshot",
        "memory-snapshot",
        serde_json::to_value(snapshot_texts(
            "One\n§\nTwo",
            "中文 😀",
            DEFAULT_MEMORY_CHAR_LIMIT,
            DEFAULT_USER_CHAR_LIMIT,
        ))?,
        &mut manifest,
    )?;
    emit::<MemorySnapshot>(
        out,
        verify,
        "memory-snapshot-empty",
        "memory-snapshot",
        serde_json::to_value(snapshot_texts(
            "",
            "",
            DEFAULT_MEMORY_CHAR_LIMIT,
            DEFAULT_USER_CHAR_LIMIT,
        ))?,
        &mut manifest,
    )?;
    emit::<MemoryUsage>(
        out,
        verify,
        "memory-usage",
        "memory-usage",
        json!({"chars":7,"cap_chars":10,"percent":70,"entry_count":1}),
        &mut manifest,
    )?;
    let ops: Vec<MemoryOp> =
        serde_json::from_value(json!([{"op":"add","target":"memory","entry":"中文 😀"}]))?;
    let (_, _, memory_report) = apply_ops_to_texts(
        String::new(),
        String::new(),
        DEFAULT_MEMORY_CHAR_LIMIT,
        DEFAULT_USER_CHAR_LIMIT,
        &ops,
    )?;
    emit::<MemoryApplyReport>(
        out,
        verify,
        "memory-report",
        "memory-report",
        serde_json::to_value(memory_report)?,
        &mut manifest,
    )?;
    emit::<MemoryApplyReport>(
        out,
        verify,
        "memory-report-legacy",
        "memory-report",
        json!({"memory_chars":0,"memory_cap_chars":DEFAULT_MEMORY_CHAR_LIMIT,"memory_percent":0,"memory_entry_count":0,"user_chars":0,"user_cap_chars":DEFAULT_USER_CHAR_LIMIT,"user_percent":0,"user_entry_count":0}),
        &mut manifest,
    )?;
    let claim = json!({"id":"claim_00000001","name":"example","statement":"中文 😀 / \\ \" \n\t\u{0000}\u{0001}\u{0008}\u{000c}\r","scope":"example / scope","holder":"agent-a","confidence":"high","status":"active","created_at":"2026-10-21T00:00:00Z","source_claim_ids":[],"evidence_summary":"example evidence"});
    for (name, at) in [
        ("claim-seconds", "2026-10-21T00:00:00Z"),
        ("claim-ms", "2026-10-21T00:00:00.250Z"),
        ("claim-micro", "2026-10-21T00:00:00.123456Z"),
        ("claim-nanos", "2026-10-21T00:00:00.123456789Z"),
        ("claim-offset", "2026-10-21T08:00:00.1234+08:00"),
        ("claim-leap", "2016-12-31T23:59:60.123Z"),
        ("claim-long-fraction", "2026-10-21T00:00:00.123456789123Z"),
    ] {
        let mut item = claim.clone();
        item["created_at"] = json!(at);
        emit::<Claim>(out, verify, name, "claim", item, &mut manifest)?;
    }
    // 参考格式化器能写扩展年份，但自身读取器拒绝；固定这个已知边界。
    for at in ["9999-12-31T23:00:00-02:00", "0000-01-01T00:00:00+01:00"] {
        let mut input = claim.clone();
        input["created_at"] = json!(at);
        let parsed: Claim = serde_json::from_value(input)?;
        let encoded = serde_json::to_string(&parsed)?;
        if serde_json::from_str::<Claim>(&encoded).is_ok() {
            return Err(
                "Reference timestamp boundary changed; review the UTC year constraint".into(),
            );
        }
    }
    let mut updated = claim.clone();
    updated["updated_at"] = json!("2026-10-21T00:01:00.123456789Z");
    updated["source_claim_ids"] = json!(["claim_00000002", "policy_00000001"]);
    updated["status"] = json!("stale");
    updated["confidence"] = json!("medium");
    emit::<Claim>(
        out,
        verify,
        "claim-updated",
        "claim",
        updated.clone(),
        &mut manifest,
    )?;
    let legacy_claim = json!({"id":"claim_00000002","name":"legacy","statement":"legacy","scope":"example","holder":"agent-a","confidence":"low","status":"deprecated","created_at":"2026-10-21T00:00:00Z","updated_at":null,"evidence_summary":"example"});
    emit::<Claim>(
        out,
        verify,
        "claim-legacy",
        "claim",
        legacy_claim,
        &mut manifest,
    )?;
    let trace = json!({"id":"trace_00000001","name":"example task","task":"task\n第二行","agent":"agent-a","input_claims":["claim_00000001","policy_00000001"],"output_claims":["claim_00000002"],"created_at":"2026-10-21T00:00:00.123456789Z"});
    emit::<Trace>(out, verify, "trace", "trace", trace.clone(), &mut manifest)?;
    let mut empty_trace = trace.clone();
    empty_trace
        .as_object_mut()
        .ok_or("trace object")?
        .remove("input_claims");
    empty_trace
        .as_object_mut()
        .ok_or("trace object")?
        .remove("output_claims");
    emit::<Trace>(
        out,
        verify,
        "trace-empty",
        "trace",
        empty_trace,
        &mut manifest,
    )?;
    let dispute = json!({"id":"dispute_00000001","name":"example conflict","reporter_agent_id":"agent-a","claims":["claim_00000001","claim_00000002"],"summary":"example conflict","status":"open","created_at":"2026-10-21T00:00:00Z"});
    emit::<Dispute>(
        out,
        verify,
        "dispute-open",
        "dispute",
        dispute.clone(),
        &mut manifest,
    )?;
    let mut resolved = dispute.clone();
    resolved["status"] = json!("resolved");
    resolved["resolved_at"] = json!("2026-10-21T01:00:00Z");
    emit::<Dispute>(
        out,
        verify,
        "dispute-resolved",
        "dispute",
        resolved,
        &mut manifest,
    )?;
    let mut legacy_dispute = dispute.clone();
    legacy_dispute
        .as_object_mut()
        .ok_or("dispute object")?
        .remove("reporter_agent_id");
    legacy_dispute["claims"] = json!(["claim_00000001"]);
    emit::<Dispute>(
        out,
        verify,
        "dispute-legacy",
        "dispute",
        legacy_dispute,
        &mut manifest,
    )?;
    let policy = json!({"id":"policy_00000001","name":"example policy","statement":"example instruction","scope":"example","status":"active","created_at":"2026-10-21T00:00:00Z"});
    emit::<Policy>(
        out,
        verify,
        "policy-broadcast",
        "policy",
        policy.clone(),
        &mut manifest,
    )?;
    let mut targeted = policy.clone();
    targeted["message_type"] = json!("claim_attribute_update");
    targeted["target_agents"] = json!(["agent-a", "agent-b"]);
    targeted["updated_at"] = json!("2026-10-21T01:00:00Z");
    targeted["status"] = json!("deprecated");
    emit::<Policy>(
        out,
        verify,
        "policy-targeted",
        "policy",
        targeted.clone(),
        &mut manifest,
    )?;
    let resolution = json!({"dispute_id":"dispute_00000001","resolution_id":"resolution_00000001","resolved_by":"human","resolved_at":"2026-10-21T01:00:00Z","resolution_type":"coexist","resolution_basis":"evidence","conclusion":"example conclusion","claim_assessments":[{"claim_id":"claim_00000001","recommended_status":"stale","assessment":"example","recommended_scope":"example / revised","recommended_statement":"example revised","reason":"example reason"}],"context_snapshot_hash":"example-hash","dispute_snapshot":dispute,"direct_claim_snapshots":[claim.clone(),updated.clone()],"snapshot_source_resolution_id":"resolution_00000002"});
    emit::<ArbitrationResolutionContext>(
        out,
        verify,
        "arbitration",
        "arbitration",
        resolution.clone(),
        &mut manifest,
    )?;
    let mut legacy_resolution = resolution.clone();
    let obj = legacy_resolution
        .as_object_mut()
        .ok_or("resolution object")?;
    for (old, new) in [
        ("resolution_id", "decision_id"),
        ("resolved_by", "decided_by"),
        ("resolved_at", "decided_at"),
        (
            "snapshot_source_resolution_id",
            "snapshot_source_decision_id",
        ),
    ] {
        if let Some(value) = obj.remove(old) {
            obj.insert(new.into(), value);
        }
    }
    legacy_resolution["decision_id"] = json!("arbitration_00000001");
    emit::<ArbitrationResolutionContext>(
        out,
        verify,
        "arbitration-legacy",
        "arbitration",
        legacy_resolution,
        &mut manifest,
    )?;
    let inbox =
        json!({"id":"inbox_00000001","message_type":"policy_update","policy":policy.clone()});
    emit::<InboxMessage>(
        out,
        verify,
        "inbox-policy",
        "inbox",
        inbox.clone(),
        &mut manifest,
    )?;
    let mut attribute = inbox.clone();
    attribute["message_type"] = json!("claim_attribute_update");
    attribute["policy"] = targeted.clone();
    emit::<InboxMessage>(
        out,
        verify,
        "inbox-attribute",
        "inbox",
        attribute.clone(),
        &mut manifest,
    )?;
    attribute["arbitration_decision"] = resolution.clone();
    attribute["handled_at"] = json!("2026-10-21T02:00:00Z");
    emit::<InboxMessage>(
        out,
        verify,
        "inbox-resolution",
        "inbox",
        attribute.clone(),
        &mut manifest,
    )?;
    let router = json!({"candidate_claims":[{ "id":"claim_00000001","name":"example","statement":"example","scope":"example","holder":"agent-a","confidence":"high","status":"active","created_at":"2026-10-21T00:00:00Z","evidence_summary":"example","open_dispute_ids":["dispute_00000001"],"resolved_dispute_ids":[]}],"disputes":[{"id":"dispute_00000001","name":"example","claim_ids":["claim_00000001","claim_00000002"],"summary":"example","status":"open"}],"retrieval_debug":{"mode":"lexical","failed_paths":[],"error_summaries":[],"lexical_hits":1,"vector_hits":0,"rerank_fallback":false,"candidates":[{"claim_id":"claim_00000001","hit_sources":"lexical","vector_status":"disabled"}]}});
    emit::<RouterQueryResult>(out, verify, "router", "router", router, &mut manifest)?;
    emit::<RouterQueryResult>(
        out,
        verify,
        "router-empty",
        "router",
        json!({"candidate_claims":[],"disputes":[]}),
        &mut manifest,
    )?;
    emit::<ScopesOverviewSnapshot>(
        out,
        verify,
        "overview",
        "overview",
        json!({"scopes":[{"scope":"example","active_claims":1,"stale_claims":0,"open_disputes":1,"resolved_disputes":0,"latest_claim_created_at":"2026-10-21T00:00:00.123456789Z"}]}),
        &mut manifest,
    )?;
    emit::<ScopesOverviewSnapshot>(
        out,
        verify,
        "overview-empty",
        "overview",
        json!({}),
        &mut manifest,
    )?;
    emit::<AuthRequest<AgentQuery>>(
        out,
        verify,
        "auth-query",
        "auth-query",
        json!({"auth":{"agent_id":"agent-a","acn_key":""},"data":{"scope":"example"}}),
        &mut manifest,
    )?;
    emit::<AuthEnvelope>(
        out,
        verify,
        "auth",
        "auth",
        json!({"agent_id":"agent-a","acn_key":""}),
        &mut manifest,
    )?;
    emit::<InboxAckRequest>(
        out,
        verify,
        "inbox-ack",
        "inbox-ack",
        json!({"agent_id":"agent-a","inbox_ids":["inbox_00000001"]}),
        &mut manifest,
    )?;
    let mut retired = updated.clone();
    retired["status"] = json!("deprecated");
    let mut carrier = claim.clone();
    carrier["id"] = json!("claim_00000003");
    carrier["source_claim_ids"] = json!(["claim_00000001"]);
    emit::<Uploads>(
        out,
        verify,
        "uploads",
        "uploads",
        json!({"consolidations":[{"before":claim.clone(),"retired":retired.clone(),"carriers":[carrier.clone()]}],"acknowledgements":[carrier.clone()],"claims":[retired,carrier],"durable_claim_ids":["claim_00000003","claim_00000001"],"disputes":[dispute.clone()]}),
        &mut manifest,
    )?;
    emit::<Uploads>(
        out,
        verify,
        "uploads-empty",
        "uploads",
        json!({}),
        &mut manifest,
    )?;
    let claim_text = serde_json::to_string(&serde_json::from_value::<Claim>(claim.clone())?)?;
    emit::<PendingEdit>(
        out,
        verify,
        "pending-edit",
        "pending-edit",
        json!({"expected_revision":format!("sha256-v1:{}",sha256_hex(&claim_text)),"target":updated.clone()}),
        &mut manifest,
    )?;
    emit::<ReportedSets>(
        out,
        verify,
        "reported-sets",
        "reported-sets",
        json!({"reported_claim_sets":{"claim_00000001 | claim_00000002":{"first_dispute_id":"dispute_00000001","reported_at":"2026-10-21T00:00:00Z"}}}),
        &mut manifest,
    )?;
    emit::<DreamState>(
        out,
        verify,
        "dream-state-empty",
        "dream-state",
        json!({"last_success_at":null,"last_input_snapshot_at":null,"known_versions":{}}),
        &mut manifest,
    )?;
    emit::<DreamState>(
        out,
        verify,
        "dream-state",
        "dream-state",
        json!({"last_success_at":"2026-10-21T01:00:00Z","last_input_snapshot_at":"2026-10-21T00:00:00Z","known_versions":{"claim_00000001":sha256_hex(&claim_text)}}),
        &mut manifest,
    )?;
    emit::<std::path::PathBuf>(
        out,
        verify,
        "dream-pending",
        "dream-pending",
        json!("dream/job-example/executions/example.yaml"),
        &mut manifest,
    )?;
    let summary = json!({"quality":"Check one-time material.","evidence":"Not available in this stage.","consolidation":"Preserve information destinations."});
    let legacy = json!({"snapshot_at":"2026-10-21T00:00:00Z","input_versions":{},"coverage":{"total":0,"included":0},"plan":{"review":summary,"groups":[],"retired_field":true},"receipts":{},"groups":[],"trace_id":"trace_00000001"});
    emit::<DreamCheckpoint>(
        out,
        verify,
        "dream-checkpoint-legacy",
        "dream-checkpoint",
        legacy.clone(),
        &mut manifest,
    )?;
    let mut retired = updated.clone();
    retired["status"] = json!("deprecated");
    let mut update = retired.clone();
    for field in ["holder", "created_at", "updated_at"] {
        update.as_object_mut().ok_or("claim object")?.remove(field);
    }
    let basis = json!([{"claim_id":"claim_00000001","removed_or_changed":"Remove episodic test material.","added":"","justification":"Historical body remains.","evidence_ids":[]}]);
    let group = json!({"kind":"quality","reason":"  Review synthetic one-time material.  ","evidence_ids":[],"coverage":[],"change_basis":basis,"updates":[update.clone()]});
    let validation_input = json!({"group_id":"group-example","kind":"quality","reason":"  Review synthetic one-time material.  ","before":[updated.clone()],"after":[update],"changes":[{"id":"claim_00000001","action":"deprecate","changes":{}}],"coverage":[],"change_basis":basis,"unversioned_evidence_omitted":[],"evidence":{}});
    let validation_id = sha256_hex(&serde_json::to_string(&validation_input)?);
    let validation = json!({"validation_id":validation_id,"input":validation_input});
    emit::<DreamValidation>(
        out,
        verify,
        "dream-validation",
        "dream-validation",
        validation.clone(),
        &mut manifest,
    )?;
    let semantic = json!({"claims":[{"claim_id":"claim_00000001","final_name":"example","name_reason":" Retired history retains its name. ","information_preserved":"Historical body remains.","removal_or_correction":"Only one-time test material is retired.","factual_correction":false,"output_ids":[],"evidence_ids":[]}],"scope_and_certainty":"No new facts or certainty increase."});
    let mut checkpoint = legacy.clone();
    checkpoint["plan"] = json!({"review":summary,"groups":[group]});
    checkpoint["groups"] =
        json!([{"before":[updated.clone()],"after":[retired],"completed":false,"skipped":false}]);
    checkpoint["self_reviews"] = json!([{"validation":validation,"review":{"group_id":"group-example","validation_id":validation_id,"preservation":[],"support":[],"scope_and_certainty":"Serialized review record; no semantic guarantee."}}]);
    checkpoint["operation"] = json!({"job_id":"job-example","group_id":"group-example","validation_id":validation_id,"review":semantic,"hard_validation_passed":true});
    emit::<DreamCheckpoint>(
        out,
        verify,
        "dream-checkpoint-operation",
        "dream-checkpoint",
        checkpoint.clone(),
        &mut manifest,
    )?;
    // 已保存旧组缺少新增解释字段时仍可读取；模型新提案仍受当前硬校验约束。
    checkpoint["plan"]["groups"][0]
        .as_object_mut()
        .ok_or("group object")?
        .remove("change_basis");
    checkpoint["operation"]["review"]["claims"][0]
        .as_object_mut()
        .ok_or("review object")?
        .remove("final_name");
    checkpoint["operation"]["review"]["claims"][0]
        .as_object_mut()
        .ok_or("review object")?
        .remove("name_reason");
    emit::<DreamCheckpoint>(
        out,
        verify,
        "dream-checkpoint-legacy-group",
        "dream-checkpoint",
        checkpoint,
        &mut manifest,
    )?;
    let body = "The verified rule applies only to read operations.";
    let receipts = json!({"file-example":{"tool":"file_read","input":{"path":"/workspace/example.txt","claim_ids":["claim_00000001"],"show_linenos":false},"output":{"content":body,"page":{"returned_start":1,"returned_end":1},"file_version":{"path":"/workspace/example.txt","revision":{"sha256":sha256_hex(body),"byte_len":body.len()}}}}});
    let mut evidence_before = updated.clone();
    evidence_before["confidence"] = json!("low");
    let mut evidence_after = evidence_before.clone();
    evidence_after["confidence"] = json!("medium");
    evidence_after["statement"] = json!(body);
    evidence_after["evidence_summary"] =
        json!("A new versioned file limits the rule to read operations.");
    let mut evidence_update = evidence_after.clone();
    for field in ["holder", "created_at", "updated_at"] {
        evidence_update
            .as_object_mut()
            .ok_or("claim object")?
            .remove(field);
    }
    let evidence_basis = json!([{"claim_id":"claim_00000001","removed_or_changed":"Correct the broad scope.","added":body,"justification":"The direct material states the limitation.","evidence_ids":["file-example"]}]);
    let evidence_input = json!({"group_id":"group-evidence","kind":"evidence","reason":"Check direct versioned material.","before":[evidence_before.clone()],"after":[evidence_update.clone()],"changes":[{"id":"claim_00000001","action":"update","changes":{"statement":body,"confidence":"medium","evidence_summary":"A new versioned file limits the rule to read operations."}}],"coverage":[],"change_basis":evidence_basis,"unversioned_evidence_omitted":[],"evidence":receipts});
    let evidence_hash = sha256_hex(&serde_json::to_string(&evidence_input)?);
    let evidence_validation = json!({"validation_id":evidence_hash,"input":evidence_input});
    emit::<DreamValidation>(
        out,
        verify,
        "dream-validation-evidence",
        "dream-validation",
        evidence_validation.clone(),
        &mut manifest,
    )?;
    let mut evidence_checkpoint = legacy;
    evidence_checkpoint["plan"] = json!({"review":summary,"groups":[{"kind":"evidence","reason":"Check direct versioned material.","evidence_ids":["file-example"],"coverage":[],"change_basis":evidence_basis,"updates":[evidence_update]}]});
    evidence_checkpoint["receipts"] = receipts;
    evidence_checkpoint["exploration_receipts"] = json!(1);
    evidence_checkpoint["groups"] = json!([{"before":[evidence_before],"after":[evidence_after],"completed":false,"skipped":false}]);
    evidence_checkpoint["self_reviews"] = json!([{"validation":evidence_validation,"review":{"group_id":"group-evidence","validation_id":evidence_hash,"preservation":[],"support":[],"scope_and_certainty":"Serialized versioned evidence review; no semantic guarantee."}}]);
    emit::<DreamCheckpoint>(
        out,
        verify,
        "dream-checkpoint-evidence",
        "dream-checkpoint",
        evidence_checkpoint,
        &mut manifest,
    )?;
    if !verify {
        // 适配后的知识模板由同一参考引擎渲染，供跨引擎逐字快照比较。
        let plugin_root = std::path::PathBuf::from(std::env::var("ACN_PLUGIN_FIXTURE_ROOT")?);
        let prompts =
            agent_claim_network::prompt::PromptRegistry::new(plugin_root.join("prompts"))?;
        let snapshots = out.parent().ok_or("fixture parent")?.join("prompts");
        fs::create_dir_all(&snapshots)?;
        for (name, context, filename) in [
            (
                "knowledge",
                json!({"agent_id":"agent-a","team":false}),
                "knowledge-solo",
            ),
            (
                "knowledge",
                json!({"agent_id":"agent-a","team":true}),
                "knowledge-team",
            ),
            (
                "session_recap",
                json!({"memory_enabled":false}),
                "session-recap",
            ),
            ("what_is_claim", json!({}), "what_is_claim"),
            ("what_is_dispute", json!({}), "what_is_dispute"),
            ("what_is_policy", json!({}), "what_is_policy"),
            (
                "inbox_policy_update_internalize",
                json!({}),
                "inbox-policy-update",
            ),
            (
                "inbox_claim_attribute_update_internalize",
                json!({}),
                "inbox-claim-attribute-update",
            ),
            ("claim_dream", json!({}), "claim-dream"),
            ("dream_evidence", json!({}), "dream-evidence"),
            ("dream_compaction", json!({}), "dream-compaction"),
            ("what_is_memory", json!({}), "what_is_memory"),
            (
                "memory",
                json!({"memory_md":"Example frozen private notes.","user_md":"Example frozen user preference."}),
                "memory",
            ),
            (
                "memory_review_system",
                json!({"agent_id":"agent-a"}),
                "memory-review-system",
            ),
            ("memory_review", json!({}), "memory-review"),
        ] {
            fs::write(
                snapshots.join(format!("{filename}.txt")),
                prompts.render(name, context)?,
            )?;
        }
        fs::write(
            out.join("manifest.json"),
            serde_json::to_string_pretty(
                &json!({"schema_version":1,"acn_version":"0.3.3","source_commit":std::env::var("ACN_FIXTURE_SOURCE_COMMIT")?,"mirrored_private_formats":["uploads","pending-edit","reported-sets","dream-state","dream-checkpoint","dream-validation","dream-pending"],"fixtures":manifest}),
            )?,
        )?;
        let home = out.parent().ok_or("fixture parent")?.join("acn-home");
        for (directory, id, value) in [
            (
                "claims",
                "claim_00000001",
                serde_yaml_ng::to_string(&serde_json::from_value::<Claim>(claim)?)?,
            ),
            (
                "traces",
                "trace_00000001",
                serde_yaml_ng::to_string(&serde_json::from_value::<Trace>(trace)?)?,
            ),
            (
                "disputes",
                "dispute_00000001",
                serde_yaml_ng::to_string(&serde_json::from_value::<Dispute>(dispute)?)?,
            ),
            (
                "inbox",
                "inbox_00000001",
                serde_yaml_ng::to_string(&serde_json::from_value::<InboxMessage>(inbox)?)?,
            ),
        ] {
            fs::create_dir_all(home.join(directory))?;
            fs::write(home.join(directory).join(format!("{id}.yaml")), value)?;
        }
        fs::create_dir_all(home.join("memories"))?;
        fs::write(
            home.join("memories/MEMORY.md"),
            "Example private experience.\n",
        )?;
        fs::write(home.join("memories/USER.md"), "Example user preference.\n")?;
        fs::create_dir_all(home.join("maintainer_uploads"))?;
        fs::copy(
            out.join("uploads.yaml"),
            home.join("maintainer_uploads/pending.yaml"),
        )?;
        fs::copy(
            out.join("reported-sets.yaml"),
            home.join("disputes/reported_claim_sets.yaml"),
        )?;
        fs::copy(
            out.join("pending-edit.yaml"),
            home.join("claim_edit_pending.yaml"),
        )?;
    }
    println!(
        "{} protocol fixtures {}",
        manifest.len(),
        if verify {
            "read back successfully"
        } else {
            "exported"
        }
    );
    Ok(())
}
