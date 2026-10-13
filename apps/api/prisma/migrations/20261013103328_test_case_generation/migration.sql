-- AlterTable
ALTER TABLE "test_cases" ADD COLUMN     "checklist_item_id" TEXT,
ADD COLUMN     "source" "artifact_source",
ADD COLUMN     "step_action" JSONB,
ADD COLUMN     "test_run_id" TEXT;

-- CreateIndex
CREATE INDEX "test_cases_test_run_id_idx" ON "test_cases"("test_run_id");

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_checklist_item_id_fkey" FOREIGN KEY ("checklist_item_id") REFERENCES "checklist_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
