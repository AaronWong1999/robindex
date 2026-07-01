-- Auditable, bounded persona evaluation.
-- Store the exact answer, sources and judge output so a release decision can be reproduced.
ALTER TABLE eval_results ADD COLUMN case_question TEXT;
ALTER TABLE eval_results ADD COLUMN answer_text TEXT;
ALTER TABLE eval_results ADD COLUMN citations_json TEXT;
ALTER TABLE eval_results ADD COLUMN judge_json TEXT;
ALTER TABLE eval_results ADD COLUMN input_chars INTEGER;

