# iQA — AI-Assisted Web Page Functional Test Automation Platform

Version: 1.0
Date: 2026-08-14
Status: Draft — for development reference

---

## 1. Purpose

A web application that lets a QA user point at a live website page URL and, with AI assistance, generate, validate, execute, and report on functional test cases for that page. Combines browser automation (Playwright) for reliable execution with an LLM (Claude API) for analysis and test authoring assistance. Human review/approval is required at every stage before anything is finalized or executed.

---

## 2. Core Principles (apply to all features)

- **Human-in-the-loop**: nothing (checklist item, test case, edit) is applied without explicit user approval.
- **Deterministic execution**: once approved, test cases run as fixed Playwright steps — no live AI improvisation during execution.
- **AI scope**: used for analysis/authoring (checklist generation, test case generation, cross-check comparison, screenshot-based verification) — never for live runtime decision-making during execution.
- **One shared schema**: all three modes (see Section 4) read/write the same test case structure.
- **All AI-suggested edits are shown as a diff and require confirmation before saving.**

---

## 3. Tech Stack

| Layer | Choice |
|---|---|
| Automation/Testing | Playwright + TypeScript, Playwright Test runner |
| AI | Claude API (Sonnet model) |
| Backend | Node.js + NestJS |
| Job Queue | BullMQ + Redis (async execution, progress streaming) |
| Database | PostgreSQL |
| Frontend | Next.js |
| Test sheet UI | AG Grid (editable spreadsheet-style grid) |
| File storage | Local filesystem in dev; abstracted behind interface for later S3 swap |
| Reporting | Playwright HTML Reporter as base; custom views for Cross Check / Recheck diffs |
| Deployment | Not fixed yet |

---

## 4. System Modes

### 4.1 Mode 1 — Full Check
Input: URL only.
Flow: analyze page → propose functionality checklist → user reviews/edits/adds notes → approve → generate test cases → user reviews/edits → approve → execute → report.

Report: total executed, passed, failed (by severity: minor/major/critical), not executed.

### 4.2 Mode 2 — Cross Check
Input: URL + uploaded existing test case file.
Flow: analyze page → compare uploaded test cases against live page structure → flag missing / outdated / newly-suggested test cases → user reviews diff, edits, approves → execute → report.

Report: missing test cases, newly added test cases (must be visually highlighted, distinct color, in UI/export), outdated test cases, plus standard pass/fail/severity/not-executed breakdown.

### 4.3 Mode 3 — Recheck (Regression)
Input: previously executed test cases (typically failed ones) with prior result + test date, + URL.
Flow: re-execute uploaded test cases against current page state → compare previous result vs new result.

Report categories: Fixed (Fail→Pass), Still Failing (Fail→Fail), Regressed (Pass→Fail), Not Re-tested.

---

## 5. Shared Test Case Schema

All test cases — regardless of which mode created them — use this exact column structure. This must be the canonical schema in the database and in all import/export (CSV/XLSX) operations.

| # | Column | Type/Notes |
|---|---|---|
| 1 | test_case_number | string, **persistent/stable ID** — must not be regenerated per run; reused across Cross Check and Recheck so results are comparable over time |
| 2 | test_page_area | string, e.g. "Checkout > Payment Section" |
| 3 | test_scenario | string, high-level description |
| 4 | test_step_number | integer, sequence within scenario |
| 5 | step_details | string, exact action to perform |
| 6 | expected_output | string |
| 7 | test_data | string, nullable |
| 8 | result | enum: `pass` \| `fail` \| `not_executed` |
| 9 | bug_id | string, nullable, external bug tracker reference |
| 10 | screenshot | string (file path/URL), nullable, populated at execution |
| 11 | qa_comments | string, nullable |
| 12 | bug_severity | enum: `minor` \| `major` \| `critical`, nullable — populated only when result = fail |

**Open field recommended but not yet finalized**: `bug_status` (enum: open/fixed/verified/closed) — separate from bug_severity. Needed if Recheck should report on bug lifecycle, not just pass/fail state. Flag for decision before building Recheck reporting.

---

## 6. Data Model Notes

- `test_cases` table: canonical current version of each test case (keyed by persistent `test_case_number`).
- `test_runs` table: one row per execution run, linked to mode (full_check / cross_check / recheck), URL, timestamp, status.
- `test_run_results` table: one row per (test_run_id, test_case_number) — stores result, screenshot ref, comments, severity for that specific run. This is what enables Recheck's previous-vs-new comparison.
- `checklist_items` table: functionality checklist entries per analysis, with approved/rejected/added-by-user flags.
- `edit_requests` / `notes_log` table: log of user free-text notes/instructions and the resulting AI-proposed diff, for audit trail.
- Screenshots stored by reference (path/URL), not inline blobs.

---

## 7. Interactive Review Features

### 7.1 Checklist notes/chat
After checklist generation, user can submit free-text notes (e.g. "also check the popup after 5s"). System re-sends note + current checklist to LLM, returns updated checklist for re-approval. Start with single-turn (note + current state → new state), not full multi-turn memory, for v1.

### 7.2 Test case editing
Two paths, both must be supported:
- Manual: direct cell edit in AG Grid.
- Instruction-based: free-text request → LLM proposes modified test case(s) → shown as diff → user confirms before save.

---

## 8. Reporting Requirements Summary

| Mode | Must report |
|---|---|
| Full Check | Executed count, Passed, Failed (by severity), Not Executed |
| Cross Check | Missing test cases, New test cases (highlighted), Outdated test cases, standard pass/fail breakdown |
| Recheck | Fixed / Still Failing / Regressed / Not Re-tested, bug status delta if tracked |

---

## 9. Non-Functional Requirements

- Test execution must run asynchronously (job queue) — UI must not block during multi-minute runs; provide progress updates.
- Every AI-generated or AI-modified artifact (checklist item, test case) must be traceable to what triggered it (initial scan vs. user note vs. cross-check).
- `test_case_number` stability is a hard requirement — do not treat it as a run-scoped sequential ID.
- Storage layer must be abstracted (interface) so local filesystem can be swapped for S3-compatible storage later without touching business logic.

---

## 10. Explicitly Out of Scope (v1)

- Scheduled/CI-triggered runs.
- Multi-page or full-site crawling.
- External bug tracker integration (e.g., Jira sync).
- Trend/flaky-test dashboards across many runs.
- Fully autonomous, non-deterministic AI-driven execution as the default mode (may exist later as an opt-in exploratory mode, separate from the regression suite).

---

## 11. Design Decisions (Resolved)

1. **bug_status field**: Added as a separate field from bug_severity.
   - `bug_status` — enum: `open` | `fixed` | `verified` | `closed`, nullable, populated when result = fail.
   - `bug_severity` — enum: `minor` | `major` | `critical`, nullable, populated when result = fail.
   - Rationale: severity describes impact, status describes lifecycle. Recheck mode
     needs status transitions (e.g. open → fixed → verified) to report bug resolution
     over time, not just pass/fail per run.

2. **Chat/edit conversational memory**: Single-turn for v1.
   - Each checklist note or test case edit instruction is sent with the current
     state (checklist or test case) and processed independently.
   - No persistent multi-turn conversation history is stored per editing session in v1.
   - Multi-turn memory may be added later without requiring a schema change —
     this is a context-passing decision, not a data model decision.

3. **Pass/fail determination**: AI-assisted with mandatory user confirmation.
   - After execution, the system uses vision-based comparison (screenshot vs.
     expected_output) to propose a pass/fail result per test case.
   - The proposed result is never final on its own — the user reviews and
     confirms or overrides each result before it is recorded as final in
     test_run_results.
   - Rationale: keeps a human as final authority, consistent with the
     human-in-the-loop principle in Section 2.

4. **Deployment/hosting target**: Still open — not required before building
   and testing the application locally. Revisit once the core flow (Full Check
   mode, end to end) works on a local machine.