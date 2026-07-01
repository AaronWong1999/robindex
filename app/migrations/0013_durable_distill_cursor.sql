-- Keep the exact map/reduce/eval continuation point in D1 so cron can resume even
-- when the Worker invocation that completed ingestion is terminated before self-fetch.

ALTER TABLE kol_onboarding_jobs ADD COLUMN distill_phase TEXT;
ALTER TABLE kol_onboarding_jobs ADD COLUMN distill_group_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN distill_steps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN distill_updated_at TEXT;

UPDATE kol_onboarding_jobs
SET distill_phase = CASE WHEN phase='evaluating' THEN 'eval' ELSE 'map' END,
    distill_updated_at = datetime('now')
WHERE phase IN ('distilling','evaluating') AND distill_phase IS NULL;

CREATE INDEX IF NOT EXISTS idx_kol_onboarding_distill
ON kol_onboarding_jobs(phase, distill_updated_at);
