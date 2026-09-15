# Codex rollout fixtures

These JSONL records are synthetic, sanitized source-derived shapes based on
the checked-out Codex protocol definitions and a metadata-only inspection of
Codex `0.154.0-alpha.6.2` rollout field names. They are not captured user
rollouts, are not a complete schema claim, and must never be read by
production code.

The reader validates the protocol `session_meta.payload.id` against the
catalog-qualified native session ID. Any separate `session_id` field is left
to catalog integration because current records may use it for another scope.

The output-before-request coverage is limited to pairs within one read batch.
The reader keeps a pending correlation in memory while parsing a file, but
does not persist arbitrary parser state for a pair split across batches; the
coordinator must validate that ordering against the supported protocol before
relying on it. First-install baseline coordination across multiple files is
also pending the catalog/coordinator slice.
