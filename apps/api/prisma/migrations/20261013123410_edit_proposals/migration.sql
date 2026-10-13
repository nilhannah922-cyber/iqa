-- AlterTable
ALTER TABLE "edit_requests" ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "model" TEXT,
ADD COLUMN     "operations" JSONB,
ADD COLUMN     "sheet_version" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'proposed',
ADD COLUMN     "usage" JSONB,
ADD COLUMN     "warnings" JSONB;

-- CreateIndex
CREATE INDEX "edit_requests_test_run_id_created_at_idx" ON "edit_requests"("test_run_id", "created_at");
