"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  CaseDiff,
  DiffStep,
  EditProposal,
  FieldChange,
  TestCaseSheet,
  applyEditProposal,
  discardEditProposal,
  listEditProposals,
  proposeEdit,
} from "@/lib/api";

const FIELD_LABELS: Record<string, string> = {
  test_page_area: "Page & area",
  test_scenario: "Scenario",
  step_details: "Step details",
  expected_output: "Expected output",
  test_data: "Test data",
  qa_comments: "QA comments",
  step_action: "Step action",
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summaryText(p: EditProposal): string {
  const s = p.diff?.summary;
  if (!s) return "";
  const parts = [
    s.cases_added && `${plural(s.cases_added, "case")} added`,
    s.cases_removed && `${plural(s.cases_removed, "case")} removed`,
    s.cases_changed && `${plural(s.cases_changed, "case")} changed`,
    s.steps_added && `${plural(s.steps_added, "step")} added`,
    s.steps_removed && `${plural(s.steps_removed, "step")} removed`,
    s.steps_changed && `${plural(s.steps_changed, "step")} changed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

function Value({ value }: { value: string | null }) {
  return value ? <>{value}</> : <span className="muted">(empty)</span>;
}

function Change({ change }: { change: FieldChange }) {
  return (
    <div className="diff-change">
      <span className="diff-field">
        {FIELD_LABELS[change.field] ?? change.field}:
      </span>{" "}
      <del className="diff-old">
        <Value value={change.before} />
      </del>{" "}
      <span aria-hidden="true">→</span>{" "}
      <ins className="diff-new">
        <Value value={change.after} />
      </ins>
    </div>
  );
}

function StepBody({ step }: { step: DiffStep }) {
  return (
    <>
      <span>{step.step_details}</span>
      <span className="muted"> · expects: {step.expected_output}</span>
      {step.test_data && (
        <span className="muted"> · data: {step.test_data}</span>
      )}
      <code className="diff-action">{JSON.stringify(step.step_action)}</code>
    </>
  );
}

function CaseCard({ c }: { c: CaseDiff }) {
  const statusText = { added: "New", removed: "Removed", changed: "Changed" }[
    c.status
  ];
  return (
    <li className={`diff-case diff-case-${c.status}`}>
      <div className="diff-case-head">
        <span className={`badge-status badge-${c.status}`}>{statusText}</span>
        <strong>{c.label}</strong>
        <span className="muted">
          {" "}
          {c.test_page_area} · {c.test_scenario}
        </span>
      </div>
      {c.reasons.length > 0 && (
        <p className="muted small diff-reason">{c.reasons.join(" ")}</p>
      )}
      {c.fields.map((f) => (
        <Change key={f.field} change={f} />
      ))}
      {c.steps.length > 0 && (
        <ol className="diff-steps">
          {c.steps.map((s, i) => (
            <li key={i} className={`diff-step diff-step-${s.status}`}>
              <span className="diff-step-num">
                {s.status === "added"
                  ? `+ step ${s.step_after}`
                  : s.status === "removed"
                    ? `− step ${s.step_before}`
                    : `step ${s.step_before}${s.step_after !== s.step_before ? ` → ${s.step_after}` : ""}`}
              </span>
              <div className="diff-step-body">
                {s.status === "changed" ? (
                  s.changes?.map((ch) => <Change key={ch.field} change={ch} />)
                ) : s.step ? (
                  s.status === "removed" ? (
                    <del>
                      <StepBody step={s.step} />
                    </del>
                  ) : (
                    <StepBody step={s.step} />
                  )
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export default function EditRequestPanel({
  runId,
  onSheetChange,
}: {
  runId: string;
  onSheetChange: (sheet: TestCaseSheet) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [asking, setAsking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<EditProposal | null>(null);
  const [history, setHistory] = useState<EditProposal[]>([]);

  // Load the audit trail; reopen a proposal that is still waiting.
  useEffect(() => {
    let cancelled = false;
    listEditProposals(runId)
      .then((list) => {
        if (cancelled) return;
        setHistory(list);
        const open = list.find((p) => p.status === "proposed");
        if (open) setCurrent(open);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (!asking) return;
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [asking]);

  const remember = (p: EditProposal) =>
    setHistory((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (asking || !instruction.trim()) return;
    setAsking(true);
    setElapsed(0);
    setError(null);
    setCurrent(null);
    try {
      const proposal = await proposeEdit(runId, instruction.trim());
      setCurrent(proposal);
      remember(proposal);
      if (proposal.status === "proposed") setInstruction("");
    } catch (err) {
      setError(`Couldn't get a proposal. ${errorText(err)}`);
    } finally {
      setAsking(false);
    }
  }

  async function decide(kind: "apply" | "discard") {
    if (!current) return;
    setDeciding(true);
    setError(null);
    try {
      if (kind === "apply") {
        const { proposal, sheet } = await applyEditProposal(runId, current.id);
        onSheetChange(sheet);
        remember(proposal);
      } else {
        remember(await discardEditProposal(runId, current.id));
      }
      setCurrent(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDeciding(false);
    }
  }

  const decided = history.filter((p) => p.status !== "proposed");

  return (
    <div className="edit-request">
      <form className="edit-form" onSubmit={ask}>
        <label htmlFor="edit-instruction">Ask for a change</label>
        <textarea
          id="edit-instruction"
          rows={2}
          maxLength={2000}
          placeholder='e.g. "add a negative case for an empty telephone field" or "make the expected outputs more specific"'
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={asking}
        />
        <div className="edit-form-actions">
          <button type="submit" disabled={asking || !instruction.trim()}>
            {asking ? "Asking…" : "Propose change"}
          </button>
          <span className="muted small">
            You see the exact changes first; nothing is applied until you
            confirm.
          </span>
        </div>
      </form>

      {asking && (
        <div className="status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>
            Preparing the change, this takes 10 to 30 seconds
            {elapsed > 0 && <span className="muted"> ({elapsed}s)</span>}
          </span>
        </div>
      )}

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {current && (
        <section className="proposal" aria-label="Proposed change">
          <div className="proposal-head">
            <div>
              <h3>Proposed change</h3>
              <p className="muted small">“{current.instruction}”</p>
            </div>
            {current.status === "proposed" && (
              <p className="proposal-summary">{summaryText(current)}</p>
            )}
          </div>

          {current.status === "empty" ? (
            <p className="proposal-empty" role="status">
              No changes were proposed for this instruction, so there is nothing
              to apply. Try rephrasing it more specifically.
            </p>
          ) : (
            <ul className="diff-cases">
              {current.diff.cases.map((c, i) => (
                <CaseCard key={`${c.label}-${i}`} c={c} />
              ))}
            </ul>
          )}

          {current.warnings.length > 0 && (
            <div className="notice" role="status">
              <strong>Notes and skipped changes:</strong>
              <ul>
                {current.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="proposal-actions">
            {current.status === "proposed" ? (
              <>
                <button
                  type="button"
                  onClick={() => decide("apply")}
                  disabled={deciding}
                >
                  Apply changes
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => decide("discard")}
                  disabled={deciding}
                >
                  Discard
                </button>
              </>
            ) : (
              <button
                type="button"
                className="secondary"
                onClick={() => setCurrent(null)}
              >
                Close
              </button>
            )}
          </div>
        </section>
      )}

      {decided.length > 0 && (
        <details className="edit-history">
          <summary>Change history ({decided.length})</summary>
          <ul>
            {decided.map((p) => (
              <li key={p.id}>
                <span className={`pill pill-${p.status}`}>{p.status}</span>{" "}
                <span>“{p.instruction}”</span>{" "}
                <span className="muted small">
                  {new Date(p.decided_at ?? p.created_at).toLocaleString()}
                  {p.status !== "empty" && ` · ${summaryText(p)}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
