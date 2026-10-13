"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  API_URL,
  AnalysisRun,
  ChecklistItem,
  TestCaseSheet as Sheet,
  addItem,
  createAnalysis,
  generateTestCases,
  getAnalysis,
  getTestCases,
  setItemApproval,
} from "@/lib/api";
import TestCaseSheet from "./test-case-sheet";

const TITLE_MAX = 200;

/** Turns a free-text note into a title (max 200 chars) plus optional description. */
function noteToItem(note: string): { title: string; description?: string } {
  const text = note.trim().replace(/\s+/g, " ");
  if (text.length <= TITLE_MAX) return { title: text };
  const cut = text.lastIndexOf(" ", TITLE_MAX - 1);
  const title = `${text.slice(0, cut > 80 ? cut : TITLE_MAX - 1)}…`;
  return { title, description: note.trim() };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function ChecklistApp() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [itemError, setItemError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genWarnings, setGenWarnings] = useState<string[]>([]);
  const [reopening, setReopening] = useState(false);

  const waiting = loading || generating;
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [waiting]);

  // Reopen an earlier run from ?run=<id> (no Claude calls).
  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId) return;
    let cancelled = false;
    (async () => {
      setReopening(true);
      setLoading(true);
      try {
        const [loaded, cases] = await Promise.all([
          getAnalysis(runId),
          getTestCases(runId),
        ]);
        if (cancelled) return;
        setRun(loaded);
        setItems(loaded.items);
        setUrl(loaded.url);
        setSheet(cases.test_cases.length ? cases : null);
      } catch (err) {
        if (!cancelled)
          setError(`Couldn't open run ${runId}. ${errorText(err)}`);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setReopening(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function analyze(e: FormEvent) {
    e.preventDefault();
    if (loading || !url.trim()) return;
    setLoading(true);
    setElapsed(0);
    setError(null);
    setItemError(null);
    setRun(null);
    setItems([]);
    setSheet(null);
    setGenError(null);
    setGenWarnings([]);
    try {
      const result = await createAnalysis(url.trim());
      setRun(result);
      setItems(result.items);
      window.history.replaceState(null, "", `?run=${result.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  async function generate() {
    if (!run || generating) return;
    setGenerating(true);
    setElapsed(0);
    setGenError(null);
    setGenWarnings([]);
    try {
      const result = await generateTestCases(run.id);
      setSheet(result);
      setGenWarnings(result.warnings);
    } catch (err) {
      setGenError(`Couldn't generate test cases. ${errorText(err)}`);
    } finally {
      setGenerating(false);
    }
  }

  function markPending(ids: string[], on: boolean) {
    setPending((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  /** Optimistically sets approval on the given items; rolls back failures. */
  async function applyApproval(targets: ChecklistItem[], approved: boolean) {
    if (!run || targets.length === 0) return;
    const ids = targets.map((t) => t.id);
    const previous = new Map(targets.map((t) => [t.id, t]));
    setItemError(null);
    markPending(ids, true);
    setItems((prev) =>
      prev.map((it) =>
        previous.has(it.id) ? { ...it, approved, rejected: !approved } : it,
      ),
    );

    const results = await Promise.allSettled(
      ids.map((id) => setItemApproval(run.id, id, approved)),
    );
    const failed = new Map<string, string>();
    results.forEach((r, i) => {
      if (r.status === "rejected") failed.set(ids[i], errorText(r.reason));
    });
    if (failed.size) {
      setItems((prev) =>
        prev.map((it) => (failed.has(it.id) ? previous.get(it.id)! : it)),
      );
      const first = failed.values().next().value;
      setItemError(
        failed.size === 1
          ? `Couldn't save your change, so it was undone. ${first}`
          : `Couldn't save ${failed.size} changes, so they were undone. ${first}`,
      );
    }
    markPending(ids, false);
  }

  async function submitNote(e: FormEvent) {
    e.preventDefault();
    if (!run || addingNote || !note.trim()) return;
    setAddingNote(true);
    setItemError(null);
    try {
      const created = await addItem(run.id, noteToItem(note));
      setItems((prev) => [...prev, created]);
      setNote("");
      // Items you add yourself start approved.
      await applyApproval([created], true);
    } catch (err) {
      setItemError(`Couldn't add your item. ${errorText(err)}`);
    } finally {
      setAddingNote(false);
    }
  }

  const selected = items.filter((it) => it.approved).length;
  const busy = pending.size > 0;

  return (
    <main>
      <div className="container">
        <header>
          <h1>iQA</h1>
          <p className="muted">
            Analyze a web page and review its functionality checklist.
          </p>
        </header>

        <form className="url-form" onSubmit={analyze}>
          <label htmlFor="url" className="sr-only">
            Page URL
          </label>
          <input
            id="url"
            type="text"
            inputMode="url"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
            autoComplete="url"
          />
          <button type="submit" disabled={loading || !url.trim()}>
            {loading ? "Analyzing…" : "Analyze page"}
          </button>
        </form>

        {loading && (
          <div className="status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>
              {reopening
                ? "Opening the saved run…"
                : "Examining the page, this takes up to a minute"}
              {elapsed > 0 && <span className="muted"> ({elapsed}s)</span>}
            </span>
          </div>
        )}

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        {run && (
          <section className="checklist" aria-labelledby="checklist-heading">
            <div className="checklist-header">
              <div>
                <h2 id="checklist-heading">Functionality checklist</h2>
                <p className="muted small">
                  {run.url} · check the items to keep, uncheck to reject
                </p>
              </div>
              <p className="counter" aria-live="polite">
                <strong>{selected}</strong> of {items.length} selected
              </p>
            </div>

            <div className="toolbar">
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() =>
                  applyApproval(
                    items.filter((it) => !it.approved),
                    true,
                  )
                }
              >
                Select all
              </button>
              <span className="muted">/</span>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() =>
                  applyApproval(
                    items.filter((it) => !it.rejected),
                    false,
                  )
                }
              >
                Select none
              </button>
            </div>

            {itemError && (
              <div className="alert" role="alert">
                {itemError}
              </div>
            )}

            <ul className="items">
              {items.map((it) => (
                <li key={it.id} className={it.approved ? "item on" : "item"}>
                  <label>
                    <input
                      type="checkbox"
                      checked={it.approved}
                      disabled={pending.has(it.id)}
                      onChange={(e) => applyApproval([it], e.target.checked)}
                    />
                    <span>
                      <span className="item-title">
                        {it.title}
                        {it.added_by_user && (
                          <span className="badge">added by you</span>
                        )}
                      </span>
                      {it.description && (
                        <span className="item-desc">{it.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            <form className="note-form" onSubmit={submitNote}>
              <label htmlFor="note">
                Anything missing? Describe a function to add
              </label>
              <textarea
                id="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Check that a confirmation popup appears after submitting"
                disabled={addingNote}
                maxLength={2000}
              />
              <button type="submit" disabled={addingNote || !note.trim()}>
                {addingNote ? "Adding…" : "Add to checklist"}
              </button>
            </form>

            <div className="next-step">
              <button
                type="button"
                onClick={generate}
                disabled={generating || busy || selected === 0}
              >
                {generating
                  ? "Generating…"
                  : sheet
                    ? "Regenerate test cases"
                    : "Generate test cases"}
              </button>
              <span className="muted small">
                {selected === 0
                  ? "Approve at least one checklist item first."
                  : sheet
                    ? "Regenerating replaces the cases below and clears their approval."
                    : `From the ${selected} approved item${selected === 1 ? "" : "s"}.`}
              </span>
            </div>

            {generating && (
              <div className="status" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>
                  Writing test cases, this takes 30 to 60 seconds
                  {elapsed > 0 && <span className="muted"> ({elapsed}s)</span>}
                </span>
              </div>
            )}
            {genError && (
              <div className="alert" role="alert">
                {genError}
              </div>
            )}
            {genWarnings.length > 0 && (
              <div className="notice" role="status">
                <strong>
                  {genWarnings.length} generated step
                  {genWarnings.length === 1
                    ? " or case was"
                    : "s or cases were"}{" "}
                  dropped by validation:
                </strong>
                <ul>
                  {genWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>

      {sheet && (
        <div className="wide">
          <TestCaseSheet sheet={sheet} onSheetChange={setSheet} />
        </div>
      )}

      <footer className="container muted small">API: {API_URL}</footer>
    </main>
  );
}
