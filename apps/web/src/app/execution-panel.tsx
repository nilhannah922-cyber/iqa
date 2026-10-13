"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ExecutionState,
  getExecution,
  screenshotUrl,
  startExecution,
} from "@/lib/api";

const POLL_MS = 2_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isActive = (s: ExecutionState | null) =>
  s?.status === "queued" || s?.status === "running";

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Minimal execution UI for step 10: run, progress, per-case summary. */
export default function ExecutionPanel({
  runId,
  approved,
  onActiveChange,
}: {
  runId: string;
  approved: boolean;
  /** Lets the sheet know execution is queued/running (edits are refused). */
  onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await getExecution(runId));
    } catch (err) {
      setError(`Couldn't load the execution status. ${errorText(err)}`);
    }
  }, [runId]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    getExecution(runId)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const active = isActive(state);
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Poll every 2 seconds while queued or running.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function run() {
    setStarting(true);
    setError(null);
    try {
      setState(await startExecution(runId));
    } catch (err) {
      setError(`Couldn't start the tests. ${errorText(err)}`);
    } finally {
      setStarting(false);
    }
  }

  const p = state?.progress;
  const done = state?.status === "completed" || state?.status === "failed";
  const totals = state?.cases.reduce(
    (t, c) => {
      if (c.result === "pass") t.pass++;
      else if (c.result === "fail") t.fail++;
      else t.not++;
      return t;
    },
    { pass: 0, fail: 0, not: 0 },
  );
  const elapsed =
    state?.started_at && state.finished_at
      ? new Date(state.finished_at).getTime() -
        new Date(state.started_at).getTime()
      : null;

  return (
    <section className="execution" aria-labelledby="execution-heading">
      <div className="execution-head">
        <h3 id="execution-heading">Execution</h3>
        <button
          type="button"
          onClick={run}
          disabled={!approved || active || starting}
        >
          {active ? "Running…" : done ? "Run tests again" : "Run tests"}
        </button>
        <span className="muted small">
          {!approved
            ? "Approve the test cases to run them."
            : done
              ? "Running again replaces these results."
              : "Runs every case in a fresh headless browser."}
        </span>
      </div>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      {active && p && (
        <div className="status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>
            {state?.status === "queued"
              ? "Queued, waiting for the worker…"
              : `Running ${p.current_case ?? ""} · ${p.cases_done} of ${p.cases_total} cases done`}
          </span>
          <progress max={p.cases_total || 1} value={p.cases_done} />
        </div>
      )}

      {state?.status === "failed" && state.error && (
        <div className="alert" role="alert">
          {state.error}
        </div>
      )}

      {done && totals && (
        <>
          <p className="execution-totals">
            <strong>{totals.pass}</strong> passed ·{" "}
            <strong>{totals.fail}</strong> failed ·{" "}
            <strong>{totals.not}</strong> not executed
            {elapsed !== null && (
              <span className="muted"> · took {seconds(elapsed)}</span>
            )}
          </p>
          <ul className="execution-cases">
            {state.cases.map((c) => (
              <li
                key={c.test_case_number}
                className={`exec-${c.result ?? "none"}`}
              >
                <span className={`pill pill-${c.result ?? "none"}`}>
                  {c.result === "pass"
                    ? "Pass"
                    : c.result === "fail"
                      ? "Fail"
                      : "Not executed"}
                </span>
                <strong>{c.test_case_number}</strong>
                <span className="exec-scenario">{c.test_scenario}</span>
                <span className="muted small">
                  {c.passed} pass · {c.failed} fail · {c.not_executed} not
                  executed · {seconds(c.duration_ms)}
                </span>
                {c.screenshot && (
                  <a
                    href={screenshotUrl(runId, c.test_case_number)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Screenshot
                  </a>
                )}
                {c.failure?.reason && (
                  <span className="exec-reason">
                    Step {c.failure.step}: {c.failure.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
