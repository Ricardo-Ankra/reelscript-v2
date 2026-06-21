-- Jobs monitor (Phase 8): a distinct terminal status for an operator-cancelled
-- run, so the UI reads honestly ("Cancelled" vs "Failed"). On Postgres 15 ADD
-- VALUE is allowed inside the apply script's transaction as long as the value is
-- not USED in the same transaction (it isn't here).
alter type job_status add value if not exists 'cancelled';
