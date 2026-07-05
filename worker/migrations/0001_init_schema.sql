-- DeadlineRadar D1 schema -- Phase 1 (capture + storage only, no sending).
--
-- Ported field-for-field from the Python reference implementation's record
-- shape in reminders/store.py (`add_pending()` / `rearm()` / `stop()` /
-- `confirm()` / `mark_reminder_sent()`). See that file for the full
-- lifecycle docstrings this schema is a direct port of:
--   pending_confirmation -> confirmed -> (stopped | re-arm-eligible)
--
-- This migration has NOT been applied to any real (non-local) D1 instance.
-- Local application only: `wrangler d1 migrations apply deadlineradar --local`.

CREATE TABLE IF NOT EXISTS subscribers (
    -- store.py: record["id"] -- a token, NOT an autoincrement int, to match
    -- the Python reference (`_new_token()`, 32 bytes url-safe CSPRNG).
    id TEXT PRIMARY KEY,

    -- store.py: record["email"] -- the actual stored/sent-to address.
    -- Deliberately NOT normalized/folded here (store.py never mutates the
    -- original address either) -- normalization/folding happens only at
    -- comparison time, mirrored in cooldown_key below.
    email TEXT NOT NULL,

    -- Computed at insert time from email, per store.py's `_cooldown_key()`:
    -- lowercase + strip, then Gmail-style dot-insensitivity and '+tag'
    -- sub-address folding on the local part. Used ONLY for cooldown/dedupe
    -- comparisons (store.within_signup_cooldown / find_active_or_pending),
    -- never as the delivery address -- see store.py's docstring for why
    -- this folding is deliberately MORE aggressive than plain normalization.
    cooldown_key TEXT NOT NULL,

    -- store.py: record["state_slug"]
    state_slug TEXT NOT NULL,

    -- store.py: record["deadline_fields"] (a small dict, e.g.
    -- {"license_type_id": "fl-individual-odd"} or
    -- {"birth_month": "3", "birth_year_parity": "odd"} or
    -- {"cohort_group": "Group 2"}). D1 has no native JSON column type, so
    -- this is stored as serialized JSON text, same as store.py's own
    -- subscribers.json does on disk.
    deadline_fields TEXT NOT NULL DEFAULT '{}',

    -- store.py: record["first_name"] -- optional, cosmetic only.
    first_name TEXT,

    -- store.py: record["status"] -- one of "pending_confirmation",
    -- "confirmed", "stopped" (store.STATUS_PENDING / STATUS_CONFIRMED /
    -- STATUS_STOPPED). Left as free TEXT rather than a CHECK constraint so
    -- this migration doesn't need to change if a future status is added;
    -- application code is the source of truth for valid values, matching
    -- store.py's own lack of an enum/validation on this field.
    status TEXT NOT NULL DEFAULT 'pending_confirmation',

    -- store.py: record["confirm_token"] / "unsubscribe_token" /
    -- "renewed_token" -- each independently UNIQUE, each a `_new_token()`
    -- (32 bytes url-safe CSPRNG), each looked up individually by
    -- find_by_confirm_token / find_by_unsubscribe_token / find_by_renewed_token.
    confirm_token TEXT NOT NULL UNIQUE,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    renewed_token TEXT NOT NULL UNIQUE,

    -- store.py: record["created_at"] / "confirmed_at" / "stopped_at" --
    -- ISO-8601 UTC strings (`_now_iso()`), stored as TEXT to match the
    -- Python reference's own string comparisons/parsing exactly.
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    stopped_at TEXT,

    -- store.py: record["stop_reason"] -- "renewed" | "unsubscribed" | NULL.
    stop_reason TEXT,

    -- store.py: record["reminders_sent"] -- list[int] of escalation
    -- thresholds (days-before-deadline) already sent this cycle. No native
    -- array/JSON column in D1 -- serialized JSON text, e.g. "[60,30,14]".
    reminders_sent TEXT NOT NULL DEFAULT '[]',

    -- store.py: record["cycle"] -- increments on each rearm().
    cycle INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subscribers_cooldown_key ON subscribers (cooldown_key);
CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers (email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers (status);

-- Ports sender.py's CIRCUIT_BREAKER_STATE_PATH JSON file ({<today>: <count>},
-- reset to hold only today's key each write). One row per UTC day; `count`
-- is the number of send attempts recorded so far that day against
-- sender.py's `daily_cap`. Phase 1 note: nothing in this Worker sends email
-- yet (see ../README.md), so this table is created now for schema parity
-- with the Python reference but will sit at zero rows until Phase 2 adds a
-- sender that increments it.
CREATE TABLE IF NOT EXISTS circuit_breaker (
    day TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
);
