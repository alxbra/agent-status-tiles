# Codex rollout fixtures

These JSONL records are synthetic, sanitized source-derived shapes based on
the checked-out Codex protocol definitions and a metadata-only inspection of
Codex `0.154.0-alpha.6.2` rollout field names. They are not captured user
rollouts, are not a complete schema claim, and must never be read by
production code.

The reader validates the protocol `session_meta.payload.id` against the
catalog-qualified native session ID. Any separate `session_id` field is left
to catalog integration because current records may use it for another scope.
