-- =============================================================================
-- user-management — case-insensitive patient search that indexes can serve under RLS.
--
-- lower() is not LEAKPROOF, so with RLS
-- active a predicate on lower(last_name) is evaluated AFTER the policy and can never be an index
-- condition. The expression index patients_last_name_search_idx was therefore never used: with
-- 20,000 patients per clinic, GET /patients?q= read every row of the tenant (13.8 ms) and the plain
-- list sorted all of them (23.4 ms).
--
-- Fix (same pattern as appointments.starts_at, scheduler V4): stored generated columns hold the
-- lowercase names, maintained by the engine (they cannot diverge), and the query compares plain
-- columns. LIKE 'prefix%' is served through the leakproof operators ~>=~ / ~<~ of text_pattern_ops;
-- ORDER BY / keyset use the default collation, so the user-facing alphabetical order is unchanged.
-- =============================================================================

ALTER TABLE patients
    ADD COLUMN search_last_name  text GENERATED ALWAYS AS (lower(last_name))  STORED,
    ADD COLUMN search_first_name text GENERATED ALWAYS AS (lower(first_name)) STORED;

COMMENT ON COLUMN patients.search_last_name IS
    'lower(last_name), generated and stored: lets GET /patients?q= and its ordering use indexes under RLS (lower() is not LEAKPROOF).';
COMMENT ON COLUMN patients.search_first_name IS
    'lower(first_name), generated and stored (see search_last_name).';

DROP INDEX patients_last_name_search_idx;

CREATE INDEX patients_last_name_search_idx ON patients (tenant_id, search_last_name text_pattern_ops);
COMMENT ON INDEX patients_last_name_search_idx IS 'GET /patients?q= prefix search by last name (LIKE ''x%'' via ~>=~/~<~, leakproof).';

CREATE INDEX patients_first_name_search_idx ON patients (tenant_id, search_first_name text_pattern_ops);
COMMENT ON INDEX patients_first_name_search_idx IS 'GET /patients?q= prefix search by first name.';

CREATE INDEX patients_listing_idx ON patients (tenant_id, search_last_name, id);
COMMENT ON INDEX patients_listing_idx IS 'GET /patients ordering and keyset pagination (search_last_name, id), default collation.';
