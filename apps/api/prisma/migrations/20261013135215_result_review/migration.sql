-- AlterTable
ALTER TABLE "test_run_results" ADD COLUMN     "ai_bug_title" TEXT,
ADD COLUMN     "ai_reason" TEXT,
ADD COLUMN     "ai_suggested_severity" "bug_severity";

-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "reviewed_at" TIMESTAMP(3);
