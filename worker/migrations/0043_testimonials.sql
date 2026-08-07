-- Roadmap #312 (2026-08-07): 1-click post-renewal review/testimonial
-- capture. Deliberately chained off a promoter-tier NPS score (>=9, see
-- roadmap #144/migration 0042) rather than its own separate quarterly
-- cadence -- asking for a quote right after someone has just told us
-- they'd recommend the product is exactly the "ask when they're already
-- glad" moment review-capture best practice targets, and avoids a second,
-- independent nag cadence stacked on top of the NPS one.
--
-- can_publish is the firm's own explicit opt-in to be quoted publicly --
-- nothing here is ever shown anywhere on the site automatically. A human
-- (Devin) reviews and manually decides what, if anything, to feature,
-- same posture as this codebase's existing "no fabricated testimonials"
-- rule (roadmap #32 was skipped outright for exactly that reason).
CREATE TABLE IF NOT EXISTS firm_testimonials (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    quote_text TEXT NOT NULL,
    can_publish INTEGER NOT NULL DEFAULT 0,
    submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_firm_testimonials_firm_id ON firm_testimonials (firm_id);
