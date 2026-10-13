/*
  Warnings:

  - Added the required column `related_selectors` to the `checklist_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `checklist_items` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "checklist_items" ADD COLUMN     "related_selectors" JSONB NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "error" TEXT,
ADD COLUMN     "page_json_path" TEXT,
ADD COLUMN     "screenshot_path" TEXT;
