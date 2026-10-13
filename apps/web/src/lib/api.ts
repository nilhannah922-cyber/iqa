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
    case 422:
      return `We couldn't open that page. ${detail ?? ""}`.trim();
    case 502:
      return `The AI service couldn't produce a checklist. ${detail ?? ""}`.trim();
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
    throw new ApiError(
      `Could not reach the API at ${API_URL}. Is it running?`,
    );
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
