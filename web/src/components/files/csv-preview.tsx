import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import {
  SaveIcon,
  UndoIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import { usePreviewActions } from "./preview-actions-context";
import { SpreadsheetTable } from "./spreadsheet-table";
import type { FileItem } from "@/hooks/use-files";

interface CsvPreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

function parseCSV(content: string) {
  const result = Papa.parse<string[]>(content, {
    header: false,
    skipEmptyLines: true,
  });
  const data = result.data;
  return { headers: data[0] ?? [], rows: data.slice(1) };
}

function serializeCSV(headers: string[], rows: string[][]): string {
  return Papa.unparse([headers, ...rows]);
}

export function CsvPreview({ file, content, projectId }: CsvPreviewProps) {
  const initial = useMemo(() => parseCSV(content), [content]);
  const [headers, setHeaders] = useState<string[]>(initial.headers);
  const [rows, setRows] = useState<string[][]>(initial.rows);
  const updateFile = useUpdateFileContent(projectId);
  const { setActions } = usePreviewActions();

  const prevContent = useRef(content);
  if (content !== prevContent.current) {
    prevContent.current = content;
    const parsed = parseCSV(content);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
  }

  const isDirty = useMemo(
    () =>
      serializeCSV(headers, rows) !==
      serializeCSV(initial.headers, initial.rows),
    [headers, rows, initial],
  );

  const handleSave = () => {
    const csv = serializeCSV(headers, rows);
    updateFile.mutate(
      { fileId: file.id, content: csv },
      {
        onSuccess: () => toast.success("File saved"),
        onError: () => toast.error("Failed to save file"),
      },
    );
  };

  const handleReset = useCallback(() => {
    setHeaders(initial.headers);
    setRows(initial.rows);
  }, [initial]);

  const handleExportXlsx = useCallback(async () => {
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      const data = rows.map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
          obj[h || `Column ${i + 1}`] = row[i] ?? "";
        });
        return obj;
      });
      const ws = XLSX.utils.json_to_sheet(data);
      const cols = headers.map((h, i) => ({
        wch: Math.max(
          (h || `Column ${i + 1}`).length,
          ...rows.slice(0, 100).map((r) => (r[i] ?? "").length),
        ) + 2,
      }));
      ws["!cols"] = cols;
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, file.filename.replace(/\.csv$/i, ".xlsx"));
      toast.success("Exported as Excel");
    } catch {
      toast.error("Failed to export as Excel");
    }
  }, [headers, rows, file.filename]);

  const handleDownloadCsv = useCallback(() => {
    const csv = serializeCSV(headers, rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [headers, rows, file.filename]);

  // Editing callbacks
  const handleCellChange = useCallback(
    (rowIdx: number, colIdx: number, value: string) => {
      setRows((prev) => {
        const next = prev.map((r) => [...r]);
        next[rowIdx]![colIdx] = value;
        return next;
      });
    },
    [],
  );

  const handleHeaderChange = useCallback((colIdx: number, value: string) => {
    setHeaders((prev) => {
      const next = [...prev];
      next[colIdx] = value;
      return next;
    });
  }, []);

  const handleAddRow = useCallback(() => {
    setRows((prev) => [...prev, Array(headers.length).fill("")]);
  }, [headers.length]);

  const handleAddColumn = useCallback(() => {
    setHeaders((prev) => [...prev, ""]);
    setRows((prev) => prev.map((r) => [...r, ""]));
  }, []);

  const handleDeleteRow = useCallback((rowIdx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== rowIdx));
  }, []);

  const handleDeleteColumn = useCallback((colIdx: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== colIdx));
    setRows((prev) => prev.map((r) => r.filter((_, i) => i !== colIdx)));
  }, []);

  // Preview header actions
  useEffect(() => {
    setActions(
      <div className="flex items-center gap-1.5">
        {isDirty && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleReset}
            title="Reset changes"
          >
            <UndoIcon className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || updateFile.isPending}
        >
          <SaveIcon className="h-3.5 w-3.5 mr-1" />
          {updateFile.isPending ? "Saving..." : "Save"}
        </Button>
      </div>,
    );
    return () => setActions(null);
  }, [isDirty, updateFile.isPending]);

  return (
    <SpreadsheetTable
      headers={headers}
      rows={rows}
      editable
      onCellChange={handleCellChange}
      onHeaderChange={handleHeaderChange}
      onAddRow={handleAddRow}
      onAddColumn={handleAddColumn}
      onDeleteRow={handleDeleteRow}
      onDeleteColumn={handleDeleteColumn}
      toolbarActions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleDownloadCsv}
            title="Download CSV"
            className="h-7 w-7"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleExportXlsx}
            title="Export as Excel"
            className="h-7 w-7"
          >
            <FileSpreadsheetIcon className="h-3.5 w-3.5" />
          </Button>
        </>
      }
    />
  );
}
