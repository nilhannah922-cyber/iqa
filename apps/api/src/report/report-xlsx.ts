/**
 * Step 12: Excel export of a Full Check report (exceljs).
 *
 * Sheets:
 *  - Summary
 *  - Test cases: one row per step; case-level cells (case number, page and
 *    area, scenario, bug fields, screenshot, confirmed result) shown once per
 *    case and merged vertically, with a thicker line between cases.
 *  - Flat data: the same rows with case-level values repeated on every row,
 *    frozen header and autofilter, for sorting and filtering.
 *  - Failed cases
 *  - Screenshots (optional, ?embed=true)
 */
import ExcelJS from 'exceljs';
import type { CaseOutcome, ReportSummary, SheetRow } from './report-builder';
import { SHEET_COLUMNS } from './report-builder';

export interface XlsxReportInput {
  runId: string;
  url: string;
  createdAt: Date;
  finishedAt: Date | null;
  reviewedAt: Date | null;
  summary: ReportSummary;
  rows: SheetRow[];
  cases: CaseOutcome[];
  /** Public URL of a case screenshot. */
  screenshotUrl: (caseNumber: string) => string;
  /** PNG bytes per case, only when screenshots are embedded. */
  images?: Map<string, Buffer>;
}

const COLORS = {
  header: 'FF1F3864',
  headerFont: 'FFFFFFFF',
  pass: { fill: 'FFC6EFCE', font: 'FF006100' },
  fail: { fill: 'FFFFC7CE', font: 'FF9C0006' },
  not_executed: { fill: 'FFD9D9D9', font: 'FF3F3F3F' },
  critical: { fill: 'FF8B0000', font: 'FFFFFFFF' },
  major: { fill: 'FFF4B183', font: 'FF5A2700' },
  minor: { fill: 'FFFFEB9C', font: 'FF6B5800' },
  link: 'FF0563C1',
  caseLine: 'FF404040',
} as const;

const RESULT_TEXT: Record<string, string> = {
  pass: 'Pass',
  fail: 'Fail',
  not_executed: 'Not executed',
};

/** Column keys whose value belongs to the whole case. */
const CASE_LEVEL_KEYS = [
  'test_case_number',
  'test_page_area',
  'test_scenario',
  'bug_id',
  'screenshot',
  'qa_comments',
  'bug_severity',
  'confirmed_case_result',
];

const WIDTHS: Record<string, number> = {
  test_case_number: 14,
  test_page_area: 24,
  test_scenario: 36,
  test_step_number: 8,
  step_details: 40,
  expected_output: 36,
  actual_output: 40,
  test_data: 22,
  result: 14,
  bug_id: 12,
  screenshot: 14,
  qa_comments: 30,
  bug_severity: 12,
  confirmed_case_result: 18,
};

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function paint(cell: ExcelJS.Cell, colors: { fill: string; font: string }) {
  cell.fill = fill(colors.fill);
  cell.font = {
    ...(cell.font ?? {}),
    color: { argb: colors.font },
    bold: true,
  };
}

function styleHeader(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = fill(COLORS.header);
    cell.font = { bold: true, color: { argb: COLORS.headerFont } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 30;
}

function paintResult(cell: ExcelJS.Cell, result: string | null) {
  if (result === 'pass' || result === 'fail' || result === 'not_executed') {
    paint(cell, COLORS[result]);
  }
}

function paintSeverity(cell: ExcelJS.Cell, severity: string | null) {
  if (severity === 'critical' || severity === 'major' || severity === 'minor') {
    paint(cell, COLORS[severity]);
  }
}

function link(cell: ExcelJS.Cell, url: string, text = 'Screenshot') {
  cell.value = { text, hyperlink: url, tooltip: url };
  cell.font = { color: { argb: COLORS.link }, underline: true };
}

function dateTime(d: Date | null): string {
  return d ? d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-';
}

/** Width and height of a PNG from its IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const sheetColumns = () => [
  ...SHEET_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: WIDTHS[c.key],
  })),
  // Not one of the sheet columns: the confirmed verdict of the whole case.
  {
    header: 'Confirmed case result',
    key: 'confirmed_case_result',
    width: WIDTHS.confirmed_case_result,
  },
];

/** Cell values of one step row; case-level values come from the case. */
function rowValues(r: SheetRow, c: CaseOutcome | undefined) {
  return {
    ...r,
    actual_output: r.actual_output ?? '',
    test_data: r.test_data ?? '',
    result: RESULT_TEXT[r.result],
    bug_id: c?.bug_id ?? '',
    screenshot: '',
    qa_comments: c?.qa_comments ?? '',
    bug_severity: c?.bug_severity ?? '',
    confirmed_case_result: r.not_run
      ? 'Not run in this execution'
      : r.confirmed_case_result
        ? RESULT_TEXT[r.confirmed_case_result]
        : 'Awaiting confirmation',
  };
}

function styleStepRow(
  row: ExcelJS.Row,
  r: SheetRow,
  c: CaseOutcome | undefined,
  screenshotUrl: (n: string) => string,
) {
  row.alignment = { vertical: 'top', wrapText: true };
  paintResult(row.getCell('result'), r.result);
  paintSeverity(row.getCell('bug_severity'), c?.bug_severity ?? null);
  paintResult(
    row.getCell('confirmed_case_result'),
    r.not_run ? 'not_executed' : r.confirmed_case_result,
  );
  if (c?.screenshot) {
    link(row.getCell('screenshot'), screenshotUrl(r.test_case_number));
  }
}

export async function buildReportXlsx(input: XlsxReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'iQA';
  wb.created = input.createdAt;
  wb.title = `iQA Full Check report ${input.runId}`;
  const caseOf = new Map(input.cases.map((c) => [c.test_case_number, c]));

  // ---------------------------------------------------------------- Summary
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Item', key: 'item', width: 36 },
    { header: 'Value', key: 'value', width: 64 },
  ];
  styleHeader(summary.getRow(1));
  const s = input.summary;
  const reviewStatus = s.fully_reviewed
    ? `Fully reviewed${input.reviewedAt ? ` (${dateTime(input.reviewedAt)})` : ''}`
    : `Not fully reviewed: ${s.awaiting_confirmation} of ${s.total} cases are not confirmed yet`;
  const lines: [string, string | number][] = [
    ['Mode', 'Full Check'],
    ['Page URL', input.url],
    ['Run created', dateTime(input.createdAt)],
    ['Executed', dateTime(input.finishedAt)],
    ['Review status', reviewStatus],
    ['Total cases', s.total],
    ['Executed (confirmed pass or fail)', s.executed],
    ['Passed', s.passed],
    ['Failed', s.failed],
    ['Failed: critical', s.failed_by_severity.critical],
    ['Failed: major', s.failed_by_severity.major],
    ['Failed: minor', s.failed_by_severity.minor],
    ['Not executed', s.not_executed],
    ['  of which not run in this execution', s.not_run],
    ['Awaiting confirmation', s.awaiting_confirmation],
    ['Test case problems (flagged by Claude)', s.test_case_problems],
  ];
  for (const [item, value] of lines) {
    const row = summary.addRow({ item, value });
    row.getCell('item').font = { bold: true };
    row.getCell('value').alignment = { wrapText: true, horizontal: 'left' };
    if (item === 'Page URL') link(row.getCell('value'), input.url, input.url);
    if (item === 'Passed' && s.passed) paint(row.getCell('value'), COLORS.pass);
    if (item === 'Failed' && s.failed) paint(row.getCell('value'), COLORS.fail);
    if (item === 'Failed: critical' && s.failed_by_severity.critical) {
      paint(row.getCell('value'), COLORS.critical);
    }
    if (item === 'Failed: major' && s.failed_by_severity.major) {
      paint(row.getCell('value'), COLORS.major);
    }
    if (item === 'Failed: minor' && s.failed_by_severity.minor) {
      paint(row.getCell('value'), COLORS.minor);
    }
    if (item === 'Review status' && !s.fully_reviewed) {
      paint(row.getCell('value'), COLORS.minor);
    }
  }

  // ---------------------------------------------- Test cases (merged view)
  const columns = sheetColumns();
  const keys = columns.map((c) => c.key);
  const caseLevelCols = CASE_LEVEL_KEYS.map((k) => keys.indexOf(k) + 1).filter(
    (n) => n > 0,
  );
  const line: Partial<ExcelJS.Border> = {
    style: 'medium',
    color: { argb: COLORS.caseLine },
  };
  const sheet = wb.addWorksheet('Test cases', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = columns;
  styleHeader(sheet.getRow(1));
  for (let i = 0; i < input.rows.length;) {
    let j = i;
    while (
      j < input.rows.length &&
      input.rows[j].test_case_number === input.rows[i].test_case_number
    ) {
      j++;
    }
    const c = caseOf.get(input.rows[i].test_case_number);
    const firstRow = sheet.rowCount + 1;
    input.rows.slice(i, j).forEach((r, k) => {
      const values: Record<string, unknown> = rowValues(r, c);
      if (k > 0) for (const key of CASE_LEVEL_KEYS) values[key] = null;
      const row = sheet.addRow(values);
      if (k === 0) {
        styleStepRow(row, r, c, input.screenshotUrl);
      } else {
        // Later rows: only per-step cells are styled (case cells are merged).
        row.alignment = { vertical: 'top', wrapText: true };
        paintResult(row.getCell('result'), r.result);
      }
    });
    const lastRow = sheet.rowCount;
    if (lastRow > firstRow) {
      for (const col of caseLevelCols) {
        sheet.mergeCells(firstRow, col, lastRow, col);
      }
    }
    for (const col of caseLevelCols) {
      sheet.getCell(firstRow, col).alignment = {
        vertical: 'top',
        wrapText: true,
      };
    }
    // Thicker line under each case.
    for (let col = 1; col <= keys.length; col++) {
      const cell = sheet.getCell(lastRow, col);
      cell.border = { ...(cell.border ?? {}), bottom: line };
    }
    i = j;
  }

  // ---------------------------------------- Flat data (repeated, filterable)
  const flat = wb.addWorksheet('Flat data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  flat.columns = sheetColumns();
  styleHeader(flat.getRow(1));
  for (const r of input.rows) {
    const c = caseOf.get(r.test_case_number);
    const row = flat.addRow(rowValues(r, c));
    styleStepRow(row, r, c, input.screenshotUrl);
  }
  flat.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, input.rows.length + 1), column: keys.length },
  };

  // ----------------------------------------------------------- Failed cases
  const failed = wb.addWorksheet('Failed cases', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  failed.columns = [
    { header: 'Test case number', key: 'case', width: 14 },
    { header: 'Test scenario', key: 'scenario', width: 40 },
    { header: 'Bug ID', key: 'bug_id', width: 12 },
    { header: 'Bug severity', key: 'severity', width: 12 },
    { header: 'Bug status', key: 'status', width: 12 },
    { header: 'Failing step', key: 'step', width: 30 },
    { header: 'Actual output', key: 'actual', width: 60 },
    { header: 'QA comments', key: 'comments', width: 36 },
    { header: 'Screenshot', key: 'screenshot', width: 14 },
  ];
  styleHeader(failed.getRow(1));
  const failedCases = input.cases.filter((c) => c.confirmed === 'fail');
  for (const c of failedCases) {
    const row = failed.addRow({
      case: c.test_case_number,
      scenario: c.test_scenario,
      bug_id: c.bug_id ?? '',
      severity: c.bug_severity ?? '',
      status: c.bug_status ?? '',
      step: c.failing_step
        ? `${c.failing_step.test_step_number}. ${c.failing_step.step_details}`
        : 'All steps passed',
      actual: c.actual_output ?? '',
      comments: c.qa_comments ?? '',
      screenshot: '',
    });
    row.alignment = { vertical: 'top', wrapText: true };
    paintSeverity(row.getCell('severity'), c.bug_severity);
    if (c.screenshot) {
      link(row.getCell('screenshot'), input.screenshotUrl(c.test_case_number));
    }
  }
  if (failedCases.length === 0) failed.addRow({ case: 'No failed cases' });

  // ------------------------------------------------- Screenshots (optional)
  if (input.images) {
    const shots = wb.addWorksheet('Screenshots');
    shots.getColumn(1).width = 120;
    let rowIndex = 1;
    const ROW_PX = 20; // default row height in pixels
    for (const c of input.cases) {
      const png = input.images.get(c.test_case_number);
      if (!png) continue;
      const title = shots.getCell(rowIndex, 1);
      title.value = `${c.test_case_number}: ${c.test_scenario}`;
      title.font = { bold: true, size: 12 };
      const size = pngSize(png) ?? { width: 1366, height: 900 };
      const width = Math.min(800, size.width);
      const height = Math.round((size.height * width) / size.width);
      const imageId = wb.addImage({ buffer: png as never, extension: 'png' });
      shots.addImage(imageId, {
        tl: { col: 0, row: rowIndex },
        ext: { width, height },
      });
      rowIndex += Math.ceil(height / ROW_PX) + 3;
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
