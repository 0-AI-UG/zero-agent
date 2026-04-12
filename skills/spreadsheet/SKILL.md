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

Before writing any processing code, explore the source file(s) using a quick Python/pandas script via `bash`. **Never use `readFile`** — it fails on Excel files (binary) and chokes on large CSVs.

Write a small exploration script to `tmp/explore/main.py` via `writeFile`, then run it. It should print:

- **Column names** — list every column
- **Data types** — dtypes from pandas
- **Row count** — how many records?
- **Sample values** — first 5 rows
- **Quality issues** — null counts, duplicates

Example exploration script:

```python
# tmp/explore/main.py
import pandas as pd

# Use read_excel for .xlsx/.xls, read_csv for .csv
df = pd.read_csv("source.csv")  # or pd.read_excel("source.xlsx")
print(f"Shape: {df.shape[0]} rows, {df.shape[1]} columns")
print(f"\nColumns & types:\n{df.dtypes}")
print(f"\nFirst 5 rows:\n{df.head().to_string()}")
print(f"\nNull counts:\n{df.isnull().sum()}")
print(f"\nDuplicates: {df.duplicated().sum()}")
```

Tell the user what you found. Example:

> "This CSV has 1,240 rows and 8 columns: name (string), email (string), revenue (numeric, some with $ prefix), region (4 unique values: West, East, North, South), signup_date (mixed formats: MM/DD/YYYY and YYYY-MM-DD), …"

For **create** tasks (no source file), skip to Step 2 — but still describe the structure you plan to build.

### Step 2: Plan

Tell the user what you'll do before writing code:

- What transformation/analysis you'll perform
- Whether the result is a **text answer** (stats, insights, a yes/no) or a **file output** (new/modified spreadsheet)
- If producing a file: what it will look like (columns, format, filename) and where it will be saved
- Any assumptions or decisions (e.g. "I'll parse the $ prefix from revenue and treat as float")

### Step 3: Execute

Write scripts to a temporary folder via `writeFile`, install dependencies, and run via `bash`.

**Tmp folder convention:**
- Create a folder: `tmp/<short-task-name>/` (e.g. `tmp/filter-revenue/`, `tmp/merge-leads/`)
- Write your `main.py` inside this folder via `writeFile`
- Install dependencies: `bash: uv pip install pandas openpyxl`
- Run: `bash: uv run tmp/<task-name>/main.py`
- If the task produces an output file, write it to a sensible location — next to the source file, or `spreadsheets/`, or wherever the user specifies
- If the task is analysis/question-answering, just `print()` the results — no output file needed

### Step 4: Clean Up

After successful execution, delete the tmp folder:

```
deleteFile("tmp/<task-name>/")
```

## Context Window Safety

**Never print or return entire files or large dataframes.** The agent's context window is limited — dumping thousands of rows will break it.

- **Exploration**: Use `df.head(n)` and `df.dtypes` — never `print(df)` or `df.to_string()` on the full dataframe. **Maximum 20 rows** in any single print
- **Verification**: After processing, print row/column counts and a small sample (`df.head(10)`)
- **Analysis results**: Print only aggregated stats (sums, means, counts), never raw row data beyond a few examples
- **Large outputs**: Write results to a file and print a summary — do not print the data itself
- **Forbidden patterns**: `print(df)`, `print(df.to_string())`, `print(df.to_markdown())` on full dataframes — always slice first with `.head(n)` where n ≤ 20

## Architecture Rules

- **Script folder**: Always write scripts and requirements.txt to `tmp/<task-name>/`
- **Output files**: Only produce an output file when the task requires one (create, transform, merge, convert). For analysis or question-answering, just print results — no file needed
- **Output location**: Place output files next to the source file by default, or wherever the user specifies. Use `spreadsheets/` only when creating files from scratch with no obvious location
- **Prefer CSV** as the default output format — it gets inline preview with editing, sorting, filtering, and search in the UI
- **Use XLSX only** when the user explicitly requests Excel, or when formatting matters (multi-sheet workbooks, column widths, styled headers)
- **Never use `writeFile` for XLSX** — it only accepts text content. Always generate XLSX files inside `bash` where the binary file flows through the changedFiles pipeline
- **Always use `bash`** for any data processing — install packages with `uv pip install`, run scripts with `uv run`
- **Packages**: Use `pandas` for data processing, `openpyxl` for Excel read/write. Install via `uv pip install pandas openpyxl`
- **Language**: Always use Python (`.py` files), run via `uv run`

## How to Decide What to Build

Route on **intent**, not keywords.

### Analyze — "What does this data show?"
The user has data and wants insights, summaries, or statistics.
- **Step 1**: Explore the file with pandas, describe structure and quality
- **Step 2**: Propose which stats/insights to compute
- **Step 3**: Process via `bash` with pandas, print results — no output file needed
- Respond with: key stats, distributions, anomalies, top/bottom values
- Suggest creating a chart if visual analysis would help

### Transform — "Clean this up" / "Filter rows" / "Pivot this"
The user wants to reshape, clean, or restructure existing data.
- **Step 1**: Explore source file with pandas, describe current structure and issues
- **Step 2**: Propose the transformation plan
- **Step 3**: Transform via `bash`, write result next to the source file (or where the user specifies)
- Common operations: filter rows, rename columns, deduplicate, pivot, unpivot, type conversion, string cleanup

### Create — "Make a spreadsheet of..."
The user wants a new dataset generated from scratch or from research.
- **Step 2**: Describe the structure you'll build (columns, expected row count)
- **Step 3**: Build data via `bash`, output as CSV (default) or XLSX (if requested)
- For research-based data: use `searchWeb` first, then structure findings

### Merge — "Combine these files"
The user has multiple data sources to join.
- **Step 1**: Explore ALL source files with pandas, describe structure of each, identify join columns
- **Step 2**: Propose join strategy (inner/outer, which columns, mismatch handling)
- **Step 3**: Join in a single `bash` call, write merged result next to the source files (or where the user specifies)

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

Always read XLSX files via `bash` with pandas:

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
5. **Next steps**: Suggest follow-up actions ("Want me to export this as Excel?" or "I can filter/pivot this data")

**Never dump an entire dataset into chat** — this will overflow the agent's context window and break the conversation. The user can browse full data in the inline preview. Only show samples (up to 20 rows max) via markdown tables.

## Limits

- The changedFiles pipeline supports files up to ~10MB. For very large datasets (>100k rows), prefer CSV over XLSX.
- All project files are available in the workspace via the file manifest — use standard file I/O to access them directly.
