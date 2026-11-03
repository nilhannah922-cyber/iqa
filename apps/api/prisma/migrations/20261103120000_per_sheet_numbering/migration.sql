-- Per-sheet test case numbering (TC-0001... in every run) and a monotonic
-- bug id counter.
--
-- 1. Backs up every affected row into _bak_20261103_* tables.
-- 2. Builds the old -> new number mapping per run (current order).
-- 3. Drops the old global keys, renumbers test_cases, test_run_results (incl.
--    screenshot storage keys), edit_requests history and current-case
--    markers, then adds the new per-run keys.
-- 4. Starts the bug id counter above the highest existing BUG-n id.
--
-- Screenshot FILES are renamed afterwards by `npm run renumber-screenshots`,
-- which reads _bak_20261103_case_number_map. Rollback: see
-- prisma/rollback/20261103_per_sheet_numbering.sql.

-- ------------------------------------------------------------------ backups
CREATE TABLE "_bak_20261103_test_cases" AS SELECT * FROM "test_cases";
CREATE TABLE "_bak_20261103_test_run_results" AS SELECT * FROM "test_run_results";
CREATE TABLE "_bak_20261103_edit_requests" AS SELECT * FROM "edit_requests";
CREATE TABLE "_bak_20261103_test_runs" AS
  SELECT "id", "execution_current_case" FROM "test_runs";

-- ------------------------------------------------------------------ mapping
CREATE TABLE "_bak_20261103_case_number_map" AS
SELECT
  d."test_run_id",
  d."test_case_number" AS "old_number",
  'TC-' || lpad(
    (row_number() OVER (
      PARTITION BY d."test_run_id"
      ORDER BY
        CASE WHEN d."test_case_number" ~ '^TC-[0-9]+$'
             THEN substring(d."test_case_number" FROM 4)::bigint END NULLS LAST,
        d."test_case_number"
    ))::text, 4, '0') AS "new_number"
FROM (SELECT DISTINCT "test_run_id", "test_case_number" FROM "test_cases") d;

-- Every case must belong to a run before test_run_id becomes required.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "test_cases" WHERE "test_run_id" IS NULL) THEN
    RAISE EXCEPTION 'test_cases rows without test_run_id exist; assign or delete them first';
  END IF;
END $$;

-- ------------------------------------------------------- drop the old keys
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_test_run_id_fkey";
ALTER TABLE "test_run_results" DROP CONSTRAINT "test_run_results_test_case_number_test_step_number_fkey";
DROP INDEX "test_cases_test_run_id_idx";
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_pkey";

-- ---------------------------------------- renumber (two phases: no clashes)
UPDATE "test_cases" c
SET "test_case_number" = 'RENUM:' || m."new_number"
FROM "_bak_20261103_case_number_map" m
WHERE m."test_run_id" = c."test_run_id" AND m."old_number" = c."test_case_number";

UPDATE "test_run_results" r
SET "test_case_number" = 'RENUM:' || m."new_number",
    "screenshot" = CASE
      WHEN r."screenshot" = 'execution/' || r."test_run_id" || '/' || m."old_number" || '.png'
      THEN 'execution/' || r."test_run_id" || '/' || m."new_number" || '.png'
      ELSE r."screenshot" END
FROM "_bak_20261103_case_number_map" m
WHERE m."test_run_id" = r."test_run_id" AND m."old_number" = r."test_case_number";

UPDATE "test_cases" SET "test_case_number" = substring("test_case_number" FROM 7)
WHERE "test_case_number" LIKE 'RENUM:%';
UPDATE "test_run_results" SET "test_case_number" = substring("test_case_number" FROM 7)
WHERE "test_case_number" LIKE 'RENUM:%';

UPDATE "test_runs" t
SET "execution_current_case" = m."new_number"
FROM "_bak_20261103_case_number_map" m
WHERE m."test_run_id" = t."id" AND m."old_number" = t."execution_current_case";

-- Edit history: rewrite case numbers inside the stored operations, diff and
-- warnings (whole-word matches, via a placeholder so numbers never chain).
DO $$
DECLARE
  m RECORD;
BEGIN
  FOR m IN SELECT * FROM "_bak_20261103_case_number_map" WHERE "old_number" <> "new_number" LOOP
    UPDATE "edit_requests" SET
      "operations" = regexp_replace("operations"::text, '\m' || m."old_number" || '\M', '@@RENUM:' || m."new_number" || '@@', 'g')::jsonb,
      "proposed_diff" = regexp_replace("proposed_diff"::text, '\m' || m."old_number" || '\M', '@@RENUM:' || m."new_number" || '@@', 'g')::jsonb,
      "warnings" = regexp_replace("warnings"::text, '\m' || m."old_number" || '\M', '@@RENUM:' || m."new_number" || '@@', 'g')::jsonb
    WHERE "test_run_id" = m."test_run_id";
  END LOOP;
  UPDATE "edit_requests" SET
    "operations" = regexp_replace("operations"::text, '@@RENUM:(TC-[0-9]+)@@', '\1', 'g')::jsonb,
    "proposed_diff" = regexp_replace("proposed_diff"::text, '@@RENUM:(TC-[0-9]+)@@', '\1', 'g')::jsonb,
    "warnings" = regexp_replace("warnings"::text, '@@RENUM:(TC-[0-9]+)@@', '\1', 'g')::jsonb;
END $$;

-- ---------------------------------------------------------- the new keys
ALTER TABLE "test_cases" ALTER COLUMN "test_run_id" SET NOT NULL,
ADD CONSTRAINT "test_cases_pkey" PRIMARY KEY ("test_run_id", "test_case_number", "test_step_number");

ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_test_run_id_test_case_number_test_step_nu_fkey" FOREIGN KEY ("test_run_id", "test_case_number", "test_step_number") REFERENCES "test_cases"("test_run_id", "test_case_number", "test_step_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------- bug id counter
CREATE TABLE "id_counters" (
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "id_counters_pkey" PRIMARY KEY ("name")
);

INSERT INTO "id_counters" ("name", "value")
SELECT 'bug', COALESCE(MAX(substring("bug_id" FROM 5)::int), 0)
FROM "test_run_results"
WHERE "bug_id" ~ '^BUG-[0-9]+$';
