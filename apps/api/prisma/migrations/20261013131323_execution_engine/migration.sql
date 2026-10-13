-- AlterTable
ALTER TABLE "test_run_results" ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "execution_error" TEXT;

-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "execution_current_case" TEXT,
ADD COLUMN     "execution_error" TEXT,
ADD COLUMN     "execution_finished_at" TIMESTAMP(3),
ADD COLUMN     "execution_job_id" TEXT,
ADD COLUMN     "execution_queued_at" TIMESTAMP(3),
ADD COLUMN     "execution_started_at" TIMESTAMP(3),
ADD COLUMN     "execution_status" TEXT;
