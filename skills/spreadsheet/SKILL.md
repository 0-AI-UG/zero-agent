---
name: spreadsheet
description: >-
  Work with spreadsheet data — analyze, transform, create, merge, and convert
  CSV and Excel files. Use when the user wants to process tabular data,
  generate reports, clean datasets, pivot data, or convert between CSV and XLSX.
metadata:
  version: "1.0.0"
  platform: spreadsheet
  login_required: false
  requires:
    env: []
    bins: []
  capabilities:
    - create
    - analyze
    - export
  tags:
    - csv
    - excel
    - xlsx
    - data
    - spreadsheet
    - table
    - report
---

# Spreadsheet

Work with tabular data — create, analyze, transform, merge, and export CSV and Excel files. This skill covers everything from simple CSV generation to multi-sheet Excel workbooks.

## Architecture Rules

- **Output folder**: Always write output files to `spreadsheets/`
- **Prefer CSV** as the default output format — it gets inline preview with editing, sorting, filtering, and search in the UI
- **Use XLSX only** when the user explicitly requests Excel, or when formatting matters (multi-sheet workbooks, column widths, styled headers)
- **Never use `writeFile` for XLSX** — it only accepts text content. Always generate XLSX files inside `runCode` where the binary file flows through the changedFiles pipeline
- **Always use `runCode`** for any data processing — install packages inline, process data, write output
- **Packages**: Use `papaparse` for CSV parsing/serialization, `xlsx` (SheetJS) for Excel read/write

## How to Decide What to Build

Route on **intent**, not keywords.

### Analyze — "What does this data show?"
The user has data and wants insights, summaries, or statistics.
- Read the file with `readFile` first to understand structure
- Process in `runCode` with papaparse for CSV (or xlsx for Excel files)
- Respond with: key stats, distributions, anomalies, top/bottom values
- Suggest loading the **visualizer** skill if charts would help

### Transform — "Clean this up" / "Filter rows" / "Pivot this"
The user wants to reshape, clean, or restructure existing data.
- Read source file, transform in `runCode`, write CSV result
- Common operations: filter rows, rename columns, deduplicate, pivot, unpivot, type conversion, string cleanup

### Create — "Make a spreadsheet of..."
The user wants a new dataset generated from scratch or from research.
- Build data in `runCode`, output as CSV (default) or XLSX (if requested)
- For research-based data: use `searchWeb` first, then structure findings

### Merge — "Combine these files"
The user has multiple data sources to join.
- Read all source files in a single `runCode` call
- Join on common columns, handle mismatches gracefully
- Output merged CSV

### Convert — "Save as Excel" / "Convert to CSV"
The user wants format conversion.
- CSV → XLSX: Read CSV, create workbook with `xlsx` package, auto-fit column widths
- XLSX → CSV: Read workbook in `runCode`, export each sheet as separate CSV (or ask which sheet)

## Code Patterns

### CSV Processing

```typescript
// Read, transform, and write CSV
import Papa from "papaparse";
import * as fs from "fs";

const raw = fs.readFileSync("source.csv", "utf-8");
const { data, meta } = Papa.parse(raw, { header: true, skipEmptyLines: true });

// Transform data
const processed = data
  .filter(row => row.status === "active")
  .map(row => ({
    ...row,
    revenue: parseFloat(row.revenue).toFixed(2),
  }));

// Write output
const output = Papa.unparse(processed);
fs.writeFileSync("spreadsheets/filtered-data.csv", output);
console.log(`Processed ${data.length} → ${processed.length} rows, ${meta.fields.length} columns`);
console.log(`Columns: ${meta.fields.join(", ")}`);
```

### Excel Generation

```typescript
// Create a formatted Excel workbook
import * as XLSX from "xlsx";

const data = [
  { Name: "Alice", Revenue: 150000, Region: "West" },
  { Name: "Bob", Revenue: 230000, Region: "East" },
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(data);

// Auto-fit column widths
const headers = Object.keys(data[0]);
ws["!cols"] = headers.map(h => ({
  wch: Math.max(h.length, ...data.map(r => String(r[h]).length)) + 2,
}));

XLSX.utils.book_append_sheet(wb, ws, "Report");
XLSX.writeFile(wb, "spreadsheets/report.xlsx");
console.log(`Created workbook with ${data.length} rows`);
```

### Multi-Sheet Workbook

```typescript
import * as XLSX from "xlsx";

const wb = XLSX.utils.book_new();

// Sheet 1: Summary
const summary = [{ Metric: "Total Revenue", Value: "$1.2M" }];
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");

// Sheet 2: Details
const details = [{ Name: "Alice", Amount: 150000 }];
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(details), "Details");

XLSX.writeFile(wb, "spreadsheets/multi-sheet-report.xlsx");
```

### Reading Excel Files

When users upload or have existing XLSX files, read them inside `runCode` — never with `readFile` (which returns garbled binary text for XLSX):

```typescript
import * as XLSX from "xlsx";
import * as fs from "fs";

const buf = fs.readFileSync("uploaded-file.xlsx");
const wb = XLSX.read(buf, { type: "buffer" });

// List sheets
console.log("Sheets:", wb.SheetNames.join(", "));

// Read first sheet as JSON
const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
console.log(`${data.length} rows, columns: ${Object.keys(data[0]).join(", ")}`);
```

### CSV to Excel Conversion

```typescript
import Papa from "papaparse";
import * as XLSX from "xlsx";
import * as fs from "fs";

const raw = fs.readFileSync("source.csv", "utf-8");
const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(data);
const headers = Object.keys(data[0]);
ws["!cols"] = headers.map(h => ({
  wch: Math.max(h.length, ...data.slice(0, 100).map(r => String(r[h] ?? "").length)) + 2,
}));

XLSX.utils.book_append_sheet(wb, ws, "Data");
XLSX.writeFile(wb, "spreadsheets/converted.xlsx");
console.log(`Converted ${data.length} rows to Excel`);
```

## Response Guidelines

After any spreadsheet operation, respond with:

1. **What was done**: "Created a CSV with 150 rows and 8 columns" or "Filtered 1,200 rows down to 340 matching records"
2. **Column summary**: List column names if the user hasn't seen them
3. **Sample data**: Show first 3–5 rows as a markdown table if the data is new or transformed
4. **Key stats** (for analysis): min, max, mean, distribution highlights
5. **Next steps**: Suggest follow-up actions ("I can visualize this data" or "Want me to export this as Excel?")

Never dump an entire dataset into chat. The user can browse it in the inline preview.

## Limits

- The `runCode` changedFiles pipeline supports files up to ~10MB. For very large datasets (>100k rows), prefer CSV over XLSX.
- All project files are available in the `runCode` workspace via the file manifest — use `fs.readFileSync()` to access them directly.
- The `xlsx` package (SheetJS Community Edition) covers all standard operations. No need for the Pro version.
