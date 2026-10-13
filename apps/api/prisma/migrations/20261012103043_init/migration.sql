-- CreateEnum
CREATE TYPE "test_result" AS ENUM ('pass', 'fail', 'not_executed');

-- CreateEnum
CREATE TYPE "bug_severity" AS ENUM ('minor', 'major', 'critical');

-- CreateEnum
CREATE TYPE "bug_status" AS ENUM ('open', 'fixed', 'verified', 'closed');

-- CreateEnum
CREATE TYPE "test_run_mode" AS ENUM ('full_check', 'cross_check', 'recheck');

-- CreateEnum
CREATE TYPE "artifact_source" AS ENUM ('scan', 'user_note', 'cross_check');

-- CreateTable
CREATE TABLE "test_cases" (
    "test_case_number" TEXT NOT NULL,
    "test_page_area" TEXT NOT NULL,
    "test_scenario" TEXT NOT NULL,
    "test_step_number" INTEGER NOT NULL,
    "step_details" TEXT NOT NULL,
    "expected_output" TEXT NOT NULL,
    "test_data" TEXT,
    "result" "test_result" NOT NULL,
    "bug_id" TEXT,
    "screenshot" TEXT,
    "qa_comments" TEXT,
    "bug_severity" "bug_severity",
    "bug_status" "bug_status",

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("test_case_number","test_step_number")
);

-- CreateTable
CREATE TABLE "test_runs" (
    "id" TEXT NOT NULL,
    "mode" "test_run_mode" NOT NULL,
    "url" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_run_results" (
    "id" TEXT NOT NULL,
    "test_run_id" TEXT NOT NULL,
    "test_case_number" TEXT NOT NULL,
    "test_step_number" INTEGER NOT NULL,
    "result" "test_result" NOT NULL,
    "ai_proposed_result" "test_result",
    "user_confirmed_result" "test_result",
    "bug_id" TEXT,
    "screenshot" TEXT,
    "qa_comments" TEXT,
    "bug_severity" "bug_severity",
    "bug_status" "bug_status",

    CONSTRAINT "test_run_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" TEXT NOT NULL,
    "test_run_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "rejected" BOOLEAN NOT NULL DEFAULT false,
    "added_by_user" BOOLEAN NOT NULL DEFAULT false,
    "source" "artifact_source" NOT NULL,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edit_requests" (
    "id" TEXT NOT NULL,
    "test_run_id" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "proposed_diff" JSONB NOT NULL,
    "source" "artifact_source" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "test_run_results_test_run_id_test_case_number_test_step_num_key" ON "test_run_results"("test_run_id", "test_case_number", "test_step_number");

-- AddForeignKey
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_test_case_number_test_step_number_fkey" FOREIGN KEY ("test_case_number", "test_step_number") REFERENCES "test_cases"("test_case_number", "test_step_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edit_requests" ADD CONSTRAINT "edit_requests_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
