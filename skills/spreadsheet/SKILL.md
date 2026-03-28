---
name: spreadsheet
description: >-
  Work with spreadsheet data — analyze, transform, create, merge, and convert
  CSV and Excel files. Use when the user wants to process tabular data,
  generate reports, clean datasets, pivot data, or convert between CSV and XLSX.
metadata:
  version: "3.0.0"
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

## Mandatory Workflow

Every spreadsheet task MUST follow these steps in order. Do not skip ahead to writing code.

### Step 1: Understand the Data

Before writing any code, read the source file(s) with `readFile` and study the data:

- **Column names** — list every column
- **Data types** — numbers, dates, strings, booleans, mixed?
- **Row count** — how many records?
- **Sample values** — show 3–5 representative rows
- **Quality issues** — empty cells, inconsistent formatting, duplicates?

Tell the user what you found. Example:

> "This CSV has 1,240 rows and 8 columns: name (string), email (string), revenue (numeric, some with $ prefix), region (4 unique values: West, East, North, South), signup_date (mixed formats: MM/DD/YYYY and YYYY-MM-DD), …"

For **create** tasks (no source file), skip to Step 2 — but still describe the structure you plan to build.

### Step 2: Plan

Tell the user what you'll do before writing code:

- What transformation/analysis you'll perform
- What the output will look like (columns, format, filename)
- Any assumptions or decisions (e.g. "I'll parse the $ prefix from revenue and treat as float")

### Step 3: Execute

Write scripts and dependencies to a temporary folder, run them, and output results to `spreadsheets/`.

**Tmp folder convention:**
- Create a folder: `tmp/<short-task-name>/` (e.g. `tmp/filter-revenue/`, `tmp/merge-leads/`)
- Write your `requirements.txt` and `main.py` inside this folder
- Run with `runCode({ entrypoint: "tmp/<task-name>/main.py" })`
- Output files go to `spreadsheets/` (not the tmp folder)

### Step 4: Clean Up

After successful execution, delete the tmp folder:

```
deleteFile("tmp/<task-name>/")
```

This keeps the project clean — only the output files in `spreadsheets/` remain.

## Architecture Rules

- **Output folder**: Always write output files to `spreadsheets/`
- **Script folder**: Always write scripts and requirements.txt to `tmp/<task-name>/`
- **Prefer CSV** as the default output format — it gets inline preview with editing, sorting, filtering, and search in the UI
- **Use XLSX only** when the user explicitly requests Excel, or when formatting matters (multi-sheet workbooks, column widths, styled headers)
- **Never use `writeFile` for XLSX** — it only accepts text content. Always generate XLSX files inside `runCode` where the binary file flows through the changedFiles pipeline
- **Always use `runCode`** for any data processing — install packages inline, process data, write output
- **Packages**: Use `pandas` for data processing, `openpyxl` for Excel read/write
- **Language**: Always use Python (`.py` files)

## How to Decide What to Build

Route on **intent**, not keywords.

### Analyze — "What does this data show?"
The user has data and wants insights, summaries, or statistics.
- **Step 1**: Read the file, describe structure and quality
- **Step 2**: Propose which stats/insights to compute
- **Step 3**: Process in `runCode` with pandas
- Respond with: key stats, distributions, anomalies, top/bottom values
- Suggest loading the **visualizer** skill if charts would help

### Transform — "Clean this up" / "Filter rows" / "Pivot this"
The user wants to reshape, clean, or restructure existing data.
- **Step 1**: Read source file, describe current structure and issues
- **Step 2**: Propose the transformation plan
- **Step 3**: Transform in `runCode`, write CSV result to `spreadsheets/`
- Common operations: filter rows, rename columns, deduplicate, pivot, unpivot, type conversion, string cleanup

### Create — "Make a spreadsheet of..."
The user wants a new dataset generated from scratch or from research.
- **Step 2**: Describe the structure you'll build (columns, expected row count)
- **Step 3**: Build data in `runCode`, output as CSV (default) or XLSX (if requested)
- For research-based data: use `searchWeb` first, then structure findings

### Merge — "Combine these files"
The user has multiple data sources to join.
- **Step 1**: Read ALL source files, describe structure of each, identify join columns
- **Step 2**: Propose join strategy (inner/outer, which columns, mismatch handling)
- **Step 3**: Join in a single `runCode` call, output merged CSV

### Convert — "Save as Excel" / "Convert to CSV"
The user wants format conversion.
- CSV → XLSX: Read CSV with pandas, write to Excel with openpyxl, auto-fit column widths
- XLSX → CSV: Read workbook with pandas, export each sheet as separate CSV (or ask which sheet)

## Code Patterns

### CSV Processing

```python
# tmp/filter-active/main.py
import pandas as pd

df = pd.read_csv("source.csv")

# Transform data
filtered = df[df["status"] == "active"].copy()
filtered["revenue"] = filtered["revenue"].astype(float).round(2)

# Write output to spreadsheets/
import os
os.makedirs("spreadsheets", exist_ok=True)
filtered.to_csv("spreadsheets/filtered-data.csv", index=False)
print(f"Processed {len(df)} → {len(filtered)} rows, {len(df.columns)} columns")
print(f"Columns: {', '.join(df.columns)}")
```

### Excel Generation

```python
# tmp/create-report/main.py
import pandas as pd

data = [
    {"Name": "Alice", "Revenue": 150000, "Region": "West"},
    {"Name": "Bob", "Revenue": 230000, "Region": "East"},
]

df = pd.DataFrame(data)

import os
os.makedirs("spreadsheets", exist_ok=True)
df.to_excel("spreadsheets/report.xlsx", index=False, sheet_name="Report")
print(f"Created workbook with {len(df)} rows")
```

### Multi-Sheet Workbook

```python
# tmp/multi-sheet/main.py
import pandas as pd

import os
os.makedirs("spreadsheets", exist_ok=True)

with pd.ExcelWriter("spreadsheets/multi-sheet-report.xlsx") as writer:
    # Sheet 1: Summary
    summary = pd.DataFrame([{"Metric": "Total Revenue", "Value": "$1.2M"}])
    summary.to_excel(writer, sheet_name="Summary", index=False)

    # Sheet 2: Details
    details = pd.DataFrame([{"Name": "Alice", "Amount": 150000}])
    details.to_excel(writer, sheet_name="Details", index=False)
```

### Reading Excel Files

When users upload or have existing XLSX files, read them inside `runCode` — never with `readFile` (which returns garbled binary text for XLSX):

```python
# tmp/read-excel/main.py
import pandas as pd

# List sheets
xl = pd.ExcelFile("uploaded-file.xlsx")
print("Sheets:", ", ".join(xl.sheet_names))

# Read first sheet
df = pd.read_excel("uploaded-file.xlsx")
print(f"{len(df)} rows, columns: {', '.join(df.columns)}")
```

### CSV to Excel Conversion

```python
# tmp/csv-to-excel/main.py
import pandas as pd

df = pd.read_csv("source.csv")

import os
os.makedirs("spreadsheets", exist_ok=True)
df.to_excel("spreadsheets/converted.xlsx", index=False, sheet_name="Data")
print(f"Converted {len(df)} rows to Excel")
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
- All project files are available in the `runCode` workspace via the file manifest — use standard file I/O to access them directly.
