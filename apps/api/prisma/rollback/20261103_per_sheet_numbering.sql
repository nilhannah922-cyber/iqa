-- Rollback of migration 20261103120000_per_sheet_numbering.
--
-- Restores test_cases, test_run_results, edit_requests and the current-case
-- markers from the _bak_20261103_* tables and puts back the old global keys.
-- Rows created AFTER the migration are discarded (they would not fit the old
-- global numbering). Steps, in order:
--   1. Stop the API.
--   2. npm run renumber-screenshots -- --reverse   (moves the files back)
--   3. Run this file:  docker exec -i iqa-postgres-1 psql -U postgres -d iqa < prisma/rollback/20261103_per_sheet_numbering.sql
--   4. Check out the code from before the migration and run npm run build.

BEGIN;

ALTER TABLE "test_run_results" DROP CONSTRAINT IF EXISTS "test_run_results_test_run_id_test_case_number_test_step_nu_fkey";
ALTER TABLE "test_cases" DROP CONSTRAINT IF EXISTS "test_cases_test_run_id_fkey";
ALTER TABLE "test_cases" DROP CONSTRAINT IF EXISTS "test_cases_pkey";

DELETE FROM "test_run_results";
DELETE FROM "test_cases";
INSERT INTO "test_cases" SELECT * FROM "_bak_20261103_test_cases";
INSERT INTO "test_run_results" SELECT * FROM "_bak_20261103_test_run_results";

UPDATE "edit_requests" e SET
  "operations" = b."operations",
  "proposed_diff" = b."proposed_diff",
  "warnings" = b."warnings"
FROM "_bak_20261103_edit_requests" b
WHERE b."id" = e."id";

UPDATE "test_runs" t SET "execution_current_case" = b."execution_current_case"
FROM "_bak_20261103_test_runs" b
WHERE b."id" = t."id";

ALTER TABLE "test_cases" ALTER COLUMN "test_run_id" DROP NOT NULL,
ADD CONSTRAINT "test_cases_pkey" PRIMARY KEY ("test_case_number", "test_step_number");
CREATE INDEX "test_cases_test_run_id_idx" ON "test_cases"("test_run_id");
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_test_case_number_test_step_number_fkey" FOREIGN KEY ("test_case_number", "test_step_number") REFERENCES "test_cases"("test_case_number", "test_step_number") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE IF EXISTS "id_counters";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103120000_per_sheet_numbering';

COMMIT;
-- The _bak_20261103_* tables are kept; drop them by hand once you are sure.
