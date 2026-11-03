"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BugStatus,
  ConfirmedResult,
  ResultCase,
  ResultsSheet,
  ReviewResponse,
  Severity,
  confirmAllAsProposed,
  confirmResult,
  getResults,
  reviewResults,
  screenshotUrl,
} from "@/lib/api";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const RESULT_LABELS: Record<ConfirmedResult, string> = {
  pass: "Pass",
  fail: "Fail",
  not_executed: "Not executed",
};

/** Same rule as the API: agreement, not yet decided, fails need a severity. */
const autoConfirmable = (c: ResultCase) =>
  c.ai !== null &&
  c.confirmed_result === null &&
  c.ai.result === c.deterministic &&
  (c.ai.result === "pass" || c.ai.suggested_severity !== null);

interface Draft {
  result: ConfirmedResult | null;
  severity: Severity | "";
  bugId: string;
  bugStatus: BugStatus;
  comments: string;
}

function draftFor(c: ResultCase): Draft {
  return {
    result: c.confirmed_result,
    severity: c.bug_severity ?? c.ai?.suggested_severity ?? "",
    bugId: c.bug_id ?? "",
    bugStatus: c.bug_status ?? "open",
    comments: c.qa_comments ?? "",
  };
}

function CaseCard({
  runId,
  c,
  onSaved,
}: {
  runId: string;
  c: ResultCase;
  onSaved: () => Promise<void>;
}) {
  // Local edits; reset to the stored values whenever they change.
  const stored = JSON.stringify(draftFor(c));
  const [draftState, setDraftState] = useState<{ key: string; draft: Draft }>({
    key: stored,
    draft: draftFor(c),
  });
  const draft = draftState.key === stored ? draftState.draft : draftFor(c);
  const setDraft = (patch: Partial<Draft>) =>
    setDraftState({ key: stored, draft: { ...draft, ...patch } });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== stored;

  async function save(override?: Partial<Draft>) {
    const d = { ...draft, ...override };
    setSaving(true);
    setError(null);
    try {
      await confirmResult(runId, c.test_case_number, {
        user_confirmed_result: d.result,
        qa_comments: d.comments.trim() || null,
        ...(d.result === "fail" && {
          bug_severity: d.severity || null,
          bug_id: d.bugId.trim() || null,
          bug_status: d.bugStatus,
        }),
      });
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const disagree =
    c.ai !== null &&
    c.deterministic !== "not_executed" &&
    c.ai.result !== c.deterministic;

  return (
    <li
      className={`review-case${c.needs_attention ? " attention" : ""}${c.confirmed_result ? " confirmed" : ""}`}
    >
      <div className="review-head">
        <strong>{c.test_case_number}</strong>
        <span className="review-scenario">{c.test_scenario}</span>
        {c.needs_attention && (
          <span className="pill pill-warn">Needs attention</span>
        )}
        {c.confirmed_result && (
          <span className={`pill pill-${c.confirmed_result}`}>
            Confirmed: {RESULT_LABELS[c.confirmed_result]}
          </span>
        )}
      </div>

      <div className="review-body">
        {c.screenshot ? (
          <a
            className="review-thumb"
            href={screenshotUrl(runId, c.test_case_number)}
            target="_blank"
            rel="noreferrer"
            title="Open the full screenshot"
          >
            {/* Screenshots are served by the API; next/image is not needed. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={screenshotUrl(runId, c.test_case_number)}
              alt={`Screenshot of ${c.test_case_number}`}
              loading="lazy"
            />
          </a>
        ) : (
          <div className="review-thumb review-thumb-empty">No screenshot</div>
        )}

        <div className="review-evidence">
          <p>
            <span className="muted">Execution:</span>{" "}
            <span className={`pill pill-${c.deterministic}`}>
              {RESULT_LABELS[c.deterministic]}
            </span>
            {c.failure && (
              <span className="exec-reason">
                {" "}
                Step {c.failure.step}: {c.failure.reason}
              </span>
            )}
          </p>
          <p>
            <span className="muted">Claude:</span>{" "}
            {c.ai ? (
              <>
                <span className={`pill pill-${c.ai.result}`}>
                  {RESULT_LABELS[c.ai.result]}
                </span>
                {c.ai.suggested_severity && (
                  <span className="muted small">
                    {" "}
                    · {c.ai.suggested_severity}
                  </span>
                )}{" "}
                {c.ai.reason}
                {c.ai.bug_title && (
                  <span className="muted small"> · “{c.ai.bug_title}”</span>
                )}
              </>
            ) : (
              <span className="muted">no proposal yet</span>
            )}
          </p>
          {disagree && !c.confirmed_result && (
            <p className="review-disagree">
              Claude and the execution disagree. Decide this case yourself.
            </p>
          )}

          <div
            className="review-controls"
            role="group"
            aria-label={`Result for ${c.test_case_number}`}
          >
            {(["pass", "fail", "not_executed"] as ConfirmedResult[]).map(
              (r) => (
                <button
                  key={r}
                  type="button"
                  className={draft.result === r ? "choice selected" : "choice"}
                  aria-pressed={draft.result === r}
                  onClick={() => setDraft({ result: r })}
                  disabled={saving}
                >
                  {RESULT_LABELS[r]}
                </button>
              ),
            )}
          </div>

          {draft.result === "fail" && (
            <div className="review-bug">
              <label>
                Severity
                <select
                  value={draft.severity}
                  onChange={(e) =>
                    setDraft({ severity: e.target.value as Severity | "" })
                  }
                  disabled={saving}
                >
                  <option value="">Choose…</option>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              <label>
                Bug ID
                <input
                  type="text"
                  value={draft.bugId}
                  placeholder="auto (BUG-0001…)"
                  maxLength={50}
                  onChange={(e) => setDraft({ bugId: e.target.value })}
                  disabled={saving}
                />
              </label>
              <label>
                Status
                <select
                  value={draft.bugStatus}
                  onChange={(e) =>
                    setDraft({ bugStatus: e.target.value as BugStatus })
                  }
                  disabled={saving}
                >
                  <option value="open">Open</option>
                  <option value="fixed">Fixed</option>
                  <option value="verified">Verified</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
            </div>
          )}

          <label className="review-comments">
            QA comments
            <textarea
              rows={2}
              maxLength={2000}
              value={draft.comments}
              onChange={(e) => setDraft({ comments: e.target.value })}
              disabled={saving}
            />
          </label>

          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}

          <div className="review-actions">
            <button
              type="button"
              onClick={() => save()}
              disabled={
                saving || !draft.result || (!dirty && !!c.confirmed_result)
              }
            >
              {saving
                ? "Saving…"
                : c.confirmed_result
                  ? "Save changes"
                  : "Confirm"}
            </button>
            {c.confirmed_result && (
              <button
                type="button"
                className="secondary"
                onClick={() => save({ result: null })}
                disabled={saving}
              >
                Unconfirm
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** Step 11: Claude proposes a verdict per case, the user confirms. */
export default function ResultsReview({ runId }: { runId: string }) {
  const [sheet, setSheet] = useState<ResultsSheet | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReview, setLastReview] = useState<ReviewResponse["review"] | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setSheet(await getResults(runId));
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    getResults(runId)
      .then((s) => {
        if (!cancelled) setSheet(s);
      })
      .catch((err) => {
        if (!cancelled)
          setError(`Couldn't load the results. ${errorText(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  async function review() {
    setReviewing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await reviewResults(runId);
      setLastReview(res.review);
      setSheet(res);
    } catch (err) {
      setError(`Couldn't get Claude's review. ${errorText(err)}`);
    } finally {
      setReviewing(false);
    }
  }

  async function confirmAll() {
    setConfirmingAll(true);
    setError(null);
    try {
      const res = await confirmAllAsProposed(runId);
      setSheet(res);
      setNotice(
        res.confirmed_now
          ? `Confirmed ${res.confirmed_now} case${res.confirmed_now === 1 ? "" : "s"} where Claude agrees with the execution.`
          : "No more cases to confirm automatically.",
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setConfirmingAll(false);
    }
  }

  if (!sheet) return error ? <div className="alert">{error}</div> : null;
  const s = sheet.summary;
  const agreeing = sheet.cases.filter(autoConfirmable).length;

  return (
    <section className="review" aria-labelledby="review-heading">
      <div className="review-top">
        <div>
          <h3 id="review-heading">Review results</h3>
          <p className="muted small" aria-live="polite">
            {s.confirmed} of {s.cases} confirmed
            {s.needs_attention > 0 && ` · ${s.needs_attention} need attention`}
            {sheet.reviewed_at &&
              ` · reviewed ${new Date(sheet.reviewed_at).toLocaleString()}`}
          </p>
        </div>
        <progress max={s.cases || 1} value={s.confirmed} />
      </div>

      <div className="review-buttons">
        <button type="button" onClick={review} disabled={reviewing}>
          {reviewing
            ? "Claude is reviewing…"
            : s.proposed
              ? "Ask Claude to review again"
              : "Ask Claude to review the results"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={confirmAll}
          disabled={confirmingAll || reviewing || agreeing === 0}
        >
          Confirm all as proposed ({agreeing})
        </button>
        <span className="muted small">
          {reviewing
            ? "Sending each case's steps and screenshot; this takes about 1 minute."
            : "Claude's verdicts are proposals; nothing is final until you confirm."}
        </span>
      </div>

      {reviewing && (
        <div className="status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Claude is reviewing the results, about 1 minute…</span>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {lastReview && lastReview.warnings.length > 0 && (
        <div className="notice" role="status">
          <strong>Review notes:</strong>
          <ul>
            {lastReview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <ul className="review-cases">
        {sheet.cases.map((c) => (
          <CaseCard
            key={c.test_case_number}
            runId={runId}
            c={c}
            onSaved={reload}
          />
        ))}
      </ul>
    </section>
  );
}
