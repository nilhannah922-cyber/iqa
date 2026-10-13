"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  AllCommunityModule,
  CellEditRequestEvent,
  ColDef,
  ModuleRegistry,
  RowClassRules,
  SpanRowsParams,
  colorSchemeDark,
  themeQuartz,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import EditRequestPanel from "./edit-request-panel";
import ExecutionPanel from "./execution-panel";
import {
  StepAction,
  TestCaseRow,
  TestCaseSheet as Sheet,
  TestStepEdit,
  approveTestCases,
  deleteTestCase,
  deleteTestStep,
  updateTestStep,
} from "@/lib/api";

ModuleRegistry.registerModules([AllCommunityModule]);

type EditableField = Exclude<keyof TestStepEdit, "step_action">;

/** Case-level fields: an edit on one row applies to every row of the case. */
const CASE_FIELDS: ReadonlySet<string> = new Set([
  "test_page_area",
  "test_scenario",
]);

const rowKey = (
  r: Pick<TestCaseRow, "test_case_number" | "test_step_number">,
) => `${r.test_case_number}#${r.test_step_number}`;

/** Merge cells of the same test case (community row spanning). */
const sameCase = ({ nodeA, nodeB }: SpanRowsParams<TestCaseRow>) =>
  !!nodeA?.data &&
  nodeA.data.test_case_number === nodeB?.data?.test_case_number;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function usePrefersDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(DARK_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
}

type Confirming = { kind: "step" | "case"; key: string } | null;

export default function TestCaseSheet({
  sheet,
  onSheetChange,
}: {
  sheet: Sheet;
  onSheetChange: (sheet: Sheet) => void;
}) {
  const runId = sheet.run_id;
  const rows = sheet.test_cases;
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Unsaved step_action edits, tied to the row and its stored action so the
  // panel falls back to the stored value after a save or a new selection.
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const dark = usePrefersDark();

  const theme = useMemo(
    () => (dark ? themeQuartz.withPart(colorSchemeDark) : themeQuartz),
    [dark],
  );
  const selected = rows.find((r) => rowKey(r) === selectedKey) ?? null;
  const storedAction = selected?.step_action
    ? JSON.stringify(selected.step_action, null, 2)
    : "";
  const draftKey = selected ? `${rowKey(selected)}|${storedAction}` : "";
  const actionText = draft?.key === draftKey ? draft.text : storedAction;
  const setActionText = (text: string) => setDraft({ key: draftKey, text });

  function select(key: string | null) {
    setSelectedKey(key);
    setActionError(null);
    setConfirming(null);
  }

  const caseIndex = useMemo(() => {
    const order = new Map<string, number>();
    for (const r of rows) {
      if (!order.has(r.test_case_number)) {
        order.set(r.test_case_number, order.size);
      }
    }
    return order;
  }, [rows]);
  const caseCount = caseIndex.size;

  const rowClassRules = useMemo<RowClassRules<TestCaseRow>>(
    () => ({
      "case-alt": (p) =>
        !!p.data && (caseIndex.get(p.data.test_case_number) ?? 0) % 2 === 1,
      "case-user-note": (p) => p.data?.source === "user_note",
    }),
    [caseIndex],
  );

  const columnDefs = useMemo<ColDef<TestCaseRow>[]>(() => {
    const text = (
      field: keyof TestCaseRow,
      headerName: string,
      extra: ColDef<TestCaseRow> = {},
    ): ColDef<TestCaseRow> => ({
      field,
      headerName,
      wrapText: true,
      autoHeight: true,
      ...extra,
    });
    // Text columns flex with a minimum width so all 12 columns fit on a
    // normal desktop screen; narrower screens scroll horizontally.
    return [
      {
        field: "test_case_number",
        headerName: "Test case #",
        width: 96,
        pinned: "left",
        spanRows: sameCase,
        cellClass: "cell-case",
      },
      text("test_page_area", "Page & area", {
        editable: true,
        spanRows: sameCase,
        flex: 1,
        minWidth: 110,
      }),
      text("test_scenario", "Scenario", {
        editable: true,
        spanRows: sameCase,
        flex: 1.4,
        minWidth: 140,
      }),
      { field: "test_step_number", headerName: "Step", width: 58 },
      text("step_details", "Step details", {
        editable: true,
        flex: 1.7,
        minWidth: 150,
      }),
      text("expected_output", "Expected output", {
        editable: true,
        flex: 1.6,
        minWidth: 140,
      }),
      text("test_data", "Test data", {
        editable: true,
        flex: 1.3,
        minWidth: 150,
      }),
      { field: "result", headerName: "Result", width: 128 },
      { field: "bug_id", headerName: "Bug ID", width: 72 },
      { field: "screenshot", headerName: "Screenshot", width: 96 },
      text("qa_comments", "QA comments", {
        editable: true,
        flex: 0.9,
        minWidth: 100,
      }),
      { field: "bug_severity", headerName: "Bug severity", width: 96 },
    ];
  }, []);

  const defaultColDef = useMemo<ColDef<TestCaseRow>>(
    () => ({ sortable: false, resizable: true, suppressMovable: true }),
    [],
  );

  /** Saves one cell optimistically; rolls back with a message on failure. */
  const onCellEditRequest = useCallback(
    async (event: CellEditRequestEvent<TestCaseRow>) => {
      const field = event.colDef.field as EditableField | undefined;
      if (!field || !event.data) return;
      const target = event.data;
      const raw = event.newValue;
      const value =
        raw === null || raw === undefined ? "" : String(raw).trimEnd();
      if ((target[field] ?? "") === value) return;

      const applies = (r: TestCaseRow) =>
        CASE_FIELDS.has(field)
          ? r.test_case_number === target.test_case_number
          : rowKey(r) === rowKey(target);
      const before = sheet;
      setError(null);
      onSheetChange({
        ...sheet,
        approved_at: null,
        test_cases: rows.map((r) =>
          applies(r) ? { ...r, [field]: value || null } : r,
        ),
      });
      try {
        onSheetChange(
          await updateTestStep(
            runId,
            target.test_case_number,
            target.test_step_number,
            { [field]: value },
          ),
        );
      } catch (err) {
        onSheetChange(before);
        setError(
          `Couldn't save ${target.test_case_number} step ${target.test_step_number}, so the change was undone. ${errorText(err)}`,
        );
      }
    },
    [onSheetChange, rows, runId, sheet],
  );

  async function saveStepAction() {
    if (!selected) return;
    let parsed: StepAction;
    try {
      parsed = JSON.parse(actionText) as StepAction;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("not an object");
      }
    } catch {
      setActionError(
        'This is not valid JSON. Expected something like {"action": "click", "selector": "..."}.',
      );
      return;
    }
    setSavingAction(true);
    setActionError(null);
    try {
      onSheetChange(
        await updateTestStep(
          runId,
          selected.test_case_number,
          selected.test_step_number,
          { step_action: parsed },
        ),
      );
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setSavingAction(false);
    }
  }

  async function confirmDelete() {
    if (!selected || !confirming) return;
    setBusy(true);
    setError(null);
    try {
      const next =
        confirming.kind === "step"
          ? await deleteTestStep(
              runId,
              selected.test_case_number,
              selected.test_step_number,
            )
          : await deleteTestCase(runId, selected.test_case_number);
      onSheetChange(next);
      select(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      onSheetChange(await approveTestCases(runId));
    } catch (err) {
      setError(`Couldn't approve the test cases. ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const approvedAt = sheet.approved_at ? new Date(sheet.approved_at) : null;

  return (
    <section className="sheet" aria-labelledby="sheet-heading">
      <div className="sheet-header">
        <div>
          <h2 id="sheet-heading">Test cases</h2>
          <p className="muted small">
            {caseCount} test cases, {rows.length} steps · double-click a cell to
            edit · highlighted cases come from your own notes
          </p>
        </div>
        <div className="approval">
          <span
            className={approvedAt ? "pill pill-ok" : "pill pill-warn"}
            role="status"
          >
            {approvedAt
              ? `Approved ${approvedAt.toLocaleString()}`
              : "Not approved"}
          </span>
          <button
            type="button"
            onClick={approve}
            disabled={busy || !!approvedAt || rows.length === 0}
          >
            Approve test cases
          </button>
        </div>
      </div>

      <EditRequestPanel runId={runId} onSheetChange={onSheetChange} />

      <div className="toolbar">
        <label htmlFor="sheet-filter" className="sr-only">
          Search test cases
        </label>
        <input
          id="sheet-filter"
          type="text"
          placeholder="Search test cases…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}

      <div className="grid-wrap">
        <AgGridReact<TestCaseRow>
          theme={theme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(p) => rowKey(p.data)}
          readOnlyEdit
          onCellEditRequest={onCellEditRequest}
          stopEditingWhenCellsLoseFocus
          enableCellSpan
          rowSelection={{
            mode: "singleRow",
            checkboxes: false,
            enableClickSelection: true,
          }}
          onSelectionChanged={(e) => {
            const row = e.api.getSelectedRows()[0];
            select(row ? rowKey(row) : null);
          }}
          rowClassRules={rowClassRules}
          quickFilterText={filter}
          domLayout="autoHeight"
        />
      </div>

      <aside className="step-panel" aria-label="Selected step">
        {!selected ? (
          <p className="muted">Select a row to see and edit its step action.</p>
        ) : (
          <>
            <h3>
              {selected.test_case_number} · step {selected.test_step_number}
            </h3>
            <p className="muted small">{selected.step_details}</p>
            <label htmlFor="step-action">Step action (JSON)</label>
            <textarea
              id="step-action"
              rows={6}
              spellCheck={false}
              value={actionText}
              onChange={(e) => setActionText(e.target.value)}
              disabled={savingAction}
            />
            {actionError && (
              <div className="alert" role="alert">
                {actionError}
              </div>
            )}
            <div className="panel-actions">
              <button
                type="button"
                onClick={saveStepAction}
                disabled={savingAction || actionText === storedAction}
              >
                {savingAction ? "Saving…" : "Save step action"}
              </button>
              {confirming ? (
                <span className="confirm">
                  {confirming.kind === "step"
                    ? `Delete step ${selected.test_step_number} of ${selected.test_case_number}?`
                    : `Delete all steps of ${selected.test_case_number}?`}
                  <button
                    type="button"
                    className="danger"
                    onClick={confirmDelete}
                    disabled={busy}
                  >
                    Yes, delete
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirming(null)}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setConfirming({ kind: "step", key: rowKey(selected) })
                    }
                  >
                    Delete step
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setConfirming({
                        kind: "case",
                        key: selected.test_case_number,
                      })
                    }
                  >
                    Delete test case
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </aside>

      <ExecutionPanel runId={runId} approved={!!approvedAt} />
    </section>
  );
}
