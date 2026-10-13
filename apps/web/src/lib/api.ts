export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
).replace(/\/+$/, "");

/** POST /analysis waits for page analysis and Claude; allow up to 2 minutes. */
const ANALYSIS_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ChecklistItem {
  id: string;
  title: string;
  description: string;
  related_selectors: string[];
  approved: boolean;
  rejected: boolean;
  added_by_user: boolean;
  source: "scan" | "user_note" | "cross_check";
}

export interface AnalysisRun {
  id: string;
  mode: string;
  url: string;
  timestamp: string;
  status: string;
  screenshot_path: string | null;
  page_json_path: string | null;
  error: string | null;
  items: ChecklistItem[];
}

export class ApiError extends Error {}

interface ErrorBody {
  message?: string | string[];
}

function friendlyMessage(status: number, body: ErrorBody | null): string {
  const raw = body?.message;
  const detail = Array.isArray(raw) ? raw.join("; ") : raw;
  switch (status) {
    case 400:
      return detail ?? "The request was not valid.";
    case 404:
      return detail ?? "That analysis no longer exists.";
    case 409:
      return detail ?? "That change conflicts with the current state.";
    case 422:
      return `We couldn't open that page. ${detail ?? ""}`.trim();
    case 502:
      return `The AI service couldn't complete the request. ${detail ?? ""}`.trim();
    case 503:
      return detail ?? "The API is not configured yet.";
    default:
      return detail
        ? `Something went wrong (${status}): ${detail}`
        : `Something went wrong (${status}). Please try again.`;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: { "Content-Type": "application/json", ...rest.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(
        `The request took longer than ${timeoutMs / 1000}s and was stopped. Please try again.`,
      );
    }
    throw new ApiError(`Could not reach the API at ${API_URL}. Is it running?`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(friendlyMessage(res.status, body));
  }
  return (await res.json()) as T;
}

export function createAnalysis(url: string) {
  return request<AnalysisRun>("/analysis", {
    method: "POST",
    body: JSON.stringify({ url }),
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
}

export function setItemApproval(
  runId: string,
  itemId: string,
  approved: boolean,
) {
  return request<ChecklistItem>(`/analysis/${runId}/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(approved ? { approved: true } : { rejected: true }),
  });
}

export function addItem(
  runId: string,
  item: { title: string; description?: string },
) {
  return request<ChecklistItem>(`/analysis/${runId}/items`, {
    method: "POST",
    body: JSON.stringify(item),
  });
}

export function getAnalysis(runId: string) {
  return request<AnalysisRun>(`/analysis/${runId}`);
}

// ---- Test case sheet (step 9a) ----

/** step_action: the machine-readable step (see the API's STEP_ACTIONS). */
export interface StepAction {
  action: string;
  selector?: string;
  value?: string;
}

/** One step row: the 12 sheet columns plus traceability and step_action. */
export interface TestCaseRow {
  test_case_number: string;
  test_page_area: string;
  test_scenario: string;
  test_step_number: number;
  step_details: string;
  expected_output: string;
  test_data: string | null;
  result: "pass" | "fail" | "not_executed";
  bug_id: string | null;
  screenshot: string | null;
  qa_comments: string | null;
  bug_severity: "minor" | "major" | "critical" | null;
  bug_status: string | null;
  checklist_item_id: string | null;
  source: "scan" | "user_note" | "cross_check" | null;
  step_action: StepAction | null;
}

export interface TestCaseSheet {
  run_id: string;
  /** ISO time the sheet was approved, or null. */
  approved_at: string | null;
  test_cases: TestCaseRow[];
}

export interface GenerateTestCasesResult extends TestCaseSheet {
  warnings: string[];
  replaced: number;
  usage: { input_tokens: number; output_tokens: number };
}

/** Fields a reviewer can edit on one step row. */
export type TestStepEdit = Partial<
  Pick<
    TestCaseRow,
    | "test_page_area"
    | "test_scenario"
    | "step_details"
    | "expected_output"
    | "test_data"
    | "qa_comments"
  >
> & { step_action?: StepAction };

/** POST .../test-cases waits for Claude; allow up to 3 minutes. */
const GENERATION_TIMEOUT_MS = 180_000;

const stepPath = (runId: string, caseNumber: string, step?: number) =>
  `/analysis/${runId}/test-cases/${encodeURIComponent(caseNumber)}` +
  (step === undefined ? "" : `/steps/${step}`);

export function generateTestCases(runId: string) {
  return request<GenerateTestCasesResult>(`/analysis/${runId}/test-cases`, {
    method: "POST",
    timeoutMs: GENERATION_TIMEOUT_MS,
  });
}

export function getTestCases(runId: string) {
  return request<TestCaseSheet>(`/analysis/${runId}/test-cases`);
}

export function updateTestStep(
  runId: string,
  caseNumber: string,
  step: number,
  edit: TestStepEdit,
) {
  return request<TestCaseSheet>(stepPath(runId, caseNumber, step), {
    method: "PATCH",
    body: JSON.stringify(edit),
  });
}

export function deleteTestStep(
  runId: string,
  caseNumber: string,
  step: number,
) {
  return request<TestCaseSheet>(stepPath(runId, caseNumber, step), {
    method: "DELETE",
  });
}

export function deleteTestCase(runId: string, caseNumber: string) {
  return request<TestCaseSheet>(stepPath(runId, caseNumber), {
    method: "DELETE",
  });
}

export function approveTestCases(runId: string) {
  return request<TestCaseSheet>(`/analysis/${runId}/test-cases/approve`, {
    method: "POST",
  });
}

// ---- Instruction-based edits (step 9b) ----

export interface FieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface DiffStep {
  step_details: string;
  expected_output: string;
  test_data: string | null;
  qa_comments: string | null;
  step_action: StepAction;
}

export interface StepDiff {
  status: "added" | "removed" | "changed";
  step_before: number | null;
  step_after: number | null;
  step?: DiffStep;
  changes?: FieldChange[];
}

export interface CaseDiff {
  status: "added" | "removed" | "changed";
  test_case_number: string | null;
  label: string;
  test_page_area: string;
  test_scenario: string;
  checklist_item_id: string | null;
  fields: FieldChange[];
  steps: StepDiff[];
  reasons: string[];
}

export interface SheetDiff {
  cases: CaseDiff[];
  summary: {
    cases_added: number;
    cases_removed: number;
    cases_changed: number;
    steps_added: number;
    steps_removed: number;
    steps_changed: number;
  };
}

export interface EditProposal {
  id: string;
  run_id: string;
  instruction: string;
  status: "proposed" | "applied" | "discarded" | "empty";
  created_at: string;
  decided_at: string | null;
  diff: SheetDiff;
  warnings: string[];
  operation_count: number;
  model: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

/** Proposals wait for Claude; allow up to 2 minutes. */
const PROPOSAL_TIMEOUT_MS = 120_000;

const proposalsPath = (runId: string) =>
  `/analysis/${runId}/test-cases/edit-proposals`;

export function proposeEdit(runId: string, instruction: string) {
  return request<EditProposal>(proposalsPath(runId), {
    method: "POST",
    body: JSON.stringify({ instruction }),
    timeoutMs: PROPOSAL_TIMEOUT_MS,
  });
}

export function listEditProposals(runId: string) {
  return request<EditProposal[]>(proposalsPath(runId));
}

export function applyEditProposal(runId: string, proposalId: string) {
  return request<{ proposal: EditProposal; sheet: TestCaseSheet }>(
    `${proposalsPath(runId)}/${proposalId}/apply`,
    { method: "POST" },
  );
}

export function discardEditProposal(runId: string, proposalId: string) {
  return request<EditProposal>(
    `${proposalsPath(runId)}/${proposalId}/discard`,
    { method: "POST" },
  );
}
