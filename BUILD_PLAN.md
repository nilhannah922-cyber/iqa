# iQA Build Plan

Read `PROJECT_SPEC.md` first. It defines what we are building. This file defines the order and tracks progress.

## Rules for every agent (Claude Code, Codex, Antigravity)
- Work on one task at a time, on its own branch (`feature/<name>`). Never commit straight to `main`.
- Finish Mode 1 (Full Check) completely before starting Mode 2 or Mode 3.
- Do not change the schema in `PROJECT_SPEC.md` Section 5 without asking the owner.
- When a task is merged, tick its box below and commit that change.
- Never commit `.env`, `node_modules/`, `dist/`, `.next/` or `storage/`.

## Phase 0: Setup
- [x] Project folder, git, GitHub repo
- [x] `PROJECT_SPEC.md` written, design decisions resolved (Section 11)

## Phase 1: Foundation
- [x] NestJS API scaffold (`apps/api`)
- [x] Next.js web scaffold (`apps/web`)
- [x] Prisma schema (step-level `test_cases`, `test_run_results`, `source` fields), PR #1 merged
- [x] Docker Compose: PostgreSQL + Redis running
- [x] Initial migration applied (`init`)
- [x] Both apps start locally
- [x] Pin ports (API 4000, web 3000) and enable CORS
- [x] Commit `.gitignore` and the `prisma/migrations` folder

## Phase 2: Mode 1, Full Check (build and test fully before Phase 3)
- [x] 5. URL analysis script: Playwright loads a URL, saves a screenshot and `page.json` of interactive elements
- [x] 6. Checklist generation: send page data to the Claude API, return a functionality checklist
- [x] 7a. API endpoints and database storage for the checklist
- [x] 7b. Checklist UI: checkboxes plus a notes input (single-turn)
- [ ] 7c. Notes revise the checklist via Claude (diff + confirm)
- [x] 8. Test case generation: approved checklist to test cases matching the 12-column schema
- [x] 9a. Review grid: AG Grid, manual edits, approval
- [ ] 9b. Instruction-based edit with diff + confirm
- [ ] 10. Execution engine: BullMQ worker runs approved cases in Playwright, one screenshot per case
- [ ] 11. Pass/fail confirmation UI: AI proposes, user confirms or overrides
- [ ] 12. Report view: executed, passed, failed by severity, not executed

**Milestone: Mode 1 works end to end on at least 3 real websites.**

## Phase 3: Mode 2, Cross Check
- [ ] 13. Upload an existing test case file (CSV or XLSX)
- [ ] 14. Compare uploaded cases against the live page scan
- [ ] 15. Diff UI: missing, new (highlighted), outdated
- [ ] 16. Reuse the execution engine and report, add Cross Check report fields

## Phase 4: Mode 3, Recheck
- [ ] 17. Upload previously tested cases with results and test date
- [ ] 18. Re-execute against the current page
- [ ] 19. Compare previous vs new result per test case
- [ ] 20. Recheck report: Fixed, Still Failing, Regressed, Not Re-tested

## Phase 5: Polish
- [ ] 21. Error handling: broken URLs, load failures, timeouts
- [ ] 22. Export reports (PDF and Excel)
- [ ] 23. Decide hosting and deploy

## Known limitations (v1)
- Form submissions can only be verified by URL (e.g. that the browser navigated to the form's action), because the response page is not analyzed in v1.

## Current focus
Phase 2, step 9b: Instruction-based edit with diff + confirm.
