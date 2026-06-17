-- 0005: native quoted/retweeted-tweet capture.
--
-- GetXAPI returns a `quoted_tweet` object ({id, text, user:{name, screen_name}}) for quote-tweets —
-- qinbafrank quote-tweets heavily, so most rows have one. We previously dropped it at ingest. Store it
-- as JSON so the UI can render the nested original (like themarketbrew does).
--
-- Shape of `quoted`: {"id","text","handle","name","url"}  (null/empty when not a quote-tweet)

ALTER TABLE tweets ADD COLUMN quoted TEXT;
