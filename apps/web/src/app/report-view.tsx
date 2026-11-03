"use client";

import { useEffect, useState } from "react";
import {
  FullCheckReport,
  getReport,
  reportXlsxUrl,
  screenshotUrl,
} from "@/lib/api";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Card({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className={`report-card${tone ? ` tone-${tone}` : ""}`}>
      <span className="report-card-value">{value}</span>
      <span className="report-card-label">{label}</span>
    </div>
  );
}

/** Step 12: the Full Check report (screen and print). */
export default function ReportView({ runId }: { runId: string }) {
  const [report, setReport] = useState<FullCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [embed, setEmbed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getReport(runId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((err) => {
        if (!cancelled) setError(`Couldn't load the report. ${errorText(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  }
  if (!report) return <p className="muted">Loading the report…</p>;

  const s = report.summary;
  const date = new Date(report.run.executed_at ?? report.run.created_at);

  return (
    <section className="report-view" aria-labelledby="report-heading">
      <header className="report-header">
        <div>
          <h2 id="report-heading">Full Check report</h2>
          <p className="muted small">
            <a href={report.run.url}>{report.run.url}</a> · executed{" "}
            {date.toLocaleString()} · run {report.run.id}
          </p>
        </div>
        <div className="report-actions no-print">
          <label className="report-embed">
            <input
              type="checkbox"
              checked={embed}
              onChange={(e) => setEmbed(e.target.checked)}
            />{" "}
            Include screenshots
          </label>
          <a className="button-link" href={reportXlsxUrl(runId, embed)}>
            Download Excel report
          </a>
          <button
            type="button"
            className="secondary"
            onClick={() => window.print()}
          >
            Print / save as PDF
          </button>
        </div>
      </header>

      {!s.fully_reviewed && (
        <div className="notice report-unreviewed" role="status">
          {s.awaiting_confirmation === 1
            ? "1 case is not confirmed yet. It is counted as awaiting confirmation, not as passed or failed."
            : `${s.awaiting_confirmation} cases are not confirmed yet. They are counted as awaiting confirmation, not as passed or failed.`}
        </div>
      )}

      <div className="report-cards">
        <Card label="Executed" value={s.executed} />
        <Card label="Passed" value={s.passed} tone="pass" />
        <Card label="Failed" value={s.failed} tone="fail" />
        <Card
          label="Critical"
          value={s.failed_by_severity.critical}
          tone="critical"
        />
        <Card label="Major" value={s.failed_by_severity.major} tone="major" />
        <Card label="Minor" value={s.failed_by_severity.minor} tone="minor" />
        <Card label="Not executed" value={s.not_executed} tone="none" />
        <Card
          label="Awaiting confirmation"
          value={s.awaiting_confirmation}
          tone={s.awaiting_confirmation ? "warn" : undefined}
        />
      </div>
      <p className="muted small">
        {s.total} test cases in total
        {s.not_run > 0 &&
          ` · ${s.not_run} added after the execution and not run yet (counted as not executed)`}
        {s.test_case_problems > 0 &&
          ` · ${s.test_case_problems} flagged as test case problem${s.test_case_problems === 1 ? "" : "s"}`}
        {report.run.reviewed_at &&
          ` · reviewed ${new Date(report.run.reviewed_at).toLocaleString()}`}
      </p>

      <h3>Failed cases</h3>
      {report.failed_cases.length === 0 ? (
        <p className="muted">No confirmed failures.</p>
      ) : (
        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Scenario</th>
                <th scope="col">Bug</th>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col">Failing step</th>
                <th scope="col">QA comments</th>
                <th scope="col">Screenshot</th>
              </tr>
            </thead>
            <tbody>
              {report.failed_cases.map((c) => (
                <tr key={c.test_case_number}>
                  <td>
                    <strong>{c.test_case_number}</strong>
                    {c.test_case_problem && (
                      <span className="pill pill-problem">
                        Test case problem
                      </span>
                    )}
                  </td>
                  <td>{c.test_scenario}</td>
                  <td>{c.bug_id ?? "–"}</td>
                  <td>
                    {c.bug_severity && (
                      <span className={`sev sev-${c.bug_severity}`}>
                        {c.bug_severity}
                      </span>
                    )}
                  </td>
                  <td>{c.bug_status ?? "–"}</td>
                  <td>
                    {c.failing_step ? (
                      <>
                        Step {c.failing_step.test_step_number}:{" "}
                        {c.failing_step.step_details}
                        <span className="exec-reason">
                          {c.failing_step.reason}
                        </span>
                      </>
                    ) : (
                      <span className="muted">
                        All steps passed; confirmed as fail by the reviewer.
                      </span>
                    )}
                  </td>
                  <td>{c.qa_comments ?? ""}</td>
                  <td>
                    {c.screenshot && (
                      <a
                        href={screenshotUrl(runId, c.test_case_number)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {/* Served by the API; next/image is not needed. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          className="report-thumb"
                          src={screenshotUrl(runId, c.test_case_number)}
                          alt={`Screenshot of ${c.test_case_number}`}
                        />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
