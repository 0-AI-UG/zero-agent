import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import {
  SaveIcon,
  UndoIcon,
  DownloadIcon,
  FileTextIcon,
  FilesIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Loader } from "@/components/chat-ui/Loader";
import { toast } from "sonner";
import { usePreviewActions } from "./preview-actions-context";
import { SpreadsheetTable } from "./spreadsheet-table";
import { apiFetch } from "@/api/client";
import { useCreateFile } from "@/hooks/use-create-file";
import type { FileItem } from "@/hooks/use-files";

interface XlsxPreviewProps {
  file: FileItem;
  url: string;
  projectId: string;
}

interface SheetData {
  name: string;
  headers: string[];
  rows: string[][];
}

export function XlsxPreview({ file, url, projectId }: XlsxPreviewProps) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [initialSheets, setInitialSheets] = useState<SheetData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSheet, setActiveSheet] = useState<string>("");
  const { setActions } = usePreviewActions();
  const createFile = useCreateFile(projectId);
  const workbookRef = useRef<any>(null);

  // Load and parse the Excel file
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const XLSX = await import("xlsx");
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });

        if (cancelled) return;

        workbookRef.current = wb;

        const parsed: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]!;
          const raw = XLSX.utils.sheet_to_json<string[]>(ws, {
            header: 1,
            defval: "",
          });
          const headers = (raw[0] ?? []).map((h) => String(h));
          const rows = raw.slice(1).map((r) => r.map((c) => String(c)));
          return { name, headers, rows };
        });

        setSheets(parsed);
        setInitialSheets(parsed.map((s) => ({
          name: s.name,
          headers: [...s.headers],
          rows: s.rows.map((r) => [...r]),
        })));
        if (parsed.length > 0) setActiveSheet(parsed[0]!.name);
      } catch {
        if (!cancelled) setError("Failed to parse Excel file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [url]);

  // Check dirty state
  const isDirty = useMemo(() => {
    if (!sheets || !initialSheets) return false;
    return JSON.stringify(sheets) !== JSON.stringify(initialSheets);
  }, [sheets, initialSheets]);

  // Save edited workbook back to S3
  const handleSave = useCallback(async () => {
    if (!sheets) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      for (const sheet of sheets) {
        const data = [sheet.headers, ...sheet.rows];
        const ws = XLSX.utils.aoa_to_sheet(data);
        const cols = sheet.headers.map((h, i) => ({
          wch: Math.max(
            (h || "Column").length,
            ...sheet.rows.slice(0, 100).map((r) => (r[i] ?? "").length),
          ) + 2,
        }));
        ws["!cols"] = cols;
        XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      }
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      // Re-upload to the same presigned URL pattern
      const urlRes = await apiFetch<{ url: string }>(
        `/projects/${projectId}/files/${file.id}/upload-url`,
        { method: "POST" },
      );
      const uploadRes = await fetch(urlRes.url, {
        method: "PUT",
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        body: blob,
      });

      if (!uploadRes.ok) throw new Error("Upload failed");

      // Index text content for FTS and update file size
      const textContent = sheets
        .map((s) => [s.name, ...s.headers, ...s.rows.flat()].join(" "))
        .join("\n");
      await apiFetch(`/projects/${projectId}/files/${file.id}/binary`, {
        method: "POST",
        body: JSON.stringify({ textContent, sizeBytes: buf.byteLength }),
      }).catch(() => {});

      // Update initial state to reflect save
      setInitialSheets(sheets.map((s) => ({
        name: s.name,
        headers: [...s.headers],
        rows: s.rows.map((r) => [...r]),
      })));
      toast.success("File saved");
    } catch {
      toast.error("Failed to save file");
    }
  }, [sheets, projectId, file.id]);

  const handleReset = useCallback(() => {
    if (!initialSheets) return;
    setSheets(initialSheets.map((s) => ({
      name: s.name,
      headers: [...s.headers],
      rows: s.rows.map((r) => [...r]),
    })));
  }, [initialSheets]);

  // Import a single sheet as CSV
  const handleImportSheetAsCsv = useCallback(
    (sheet: SheetData) => {
      const csv = Papa.unparse([sheet.headers, ...sheet.rows]);
      const baseName = file.filename.replace(/\.(xlsx|xls)$/i, "");
      const sheetSuffix = sheets && sheets.length > 1 ? `_${sheet.name}` : "";
      const filename = `${baseName}${sheetSuffix}.csv`;

      createFile.mutate(
        {
          filename,
          content: csv,
          mimeType: "text/csv",
          folderPath: file.folderPath ?? "/",
        },
        {
          onSuccess: () => toast.success(`Imported "${sheet.name}" as ${filename}`),
          onError: () => toast.error(`Failed to import "${sheet.name}"`),
        },
      );
    },
    [file.filename, file.folderPath, sheets, createFile],
  );

  // Import all sheets as CSVs
  const handleImportAllAsCsv = useCallback(() => {
    if (!sheets) return;
    for (const sheet of sheets) {
      handleImportSheetAsCsv(sheet);
    }
  }, [sheets, handleImportSheetAsCsv]);

  // Editing callbacks that update specific sheet data
  const updateSheet = useCallback(
    (sheetName: string, updater: (s: SheetData) => SheetData) => {
      setSheets((prev) =>
        prev?.map((s) => (s.name === sheetName ? updater(s) : s)) ?? null,
      );
    },
    [],
  );

  const makeCellChange = useCallback(
    (sheetName: string) => (rowIdx: number, colIdx: number, value: string) => {
      updateSheet(sheetName, (s) => ({
        ...s,
        rows: s.rows.map((r, i) =>
          i === rowIdx
            ? r.map((c, j) => (j === colIdx ? value : c))
            : r,
        ),
      }));
    },
    [updateSheet],
  );

  const makeHeaderChange = useCallback(
    (sheetName: string) => (colIdx: number, value: string) => {
      updateSheet(sheetName, (s) => ({
        ...s,
        headers: s.headers.map((h, i) => (i === colIdx ? value : h)),
      }));
    },
    [updateSheet],
  );

  const makeAddRow = useCallback(
    (sheetName: string) => () => {
      updateSheet(sheetName, (s) => ({
        ...s,
        rows: [...s.rows, Array(s.headers.length).fill("")],
      }));
    },
    [updateSheet],
  );

  const makeAddColumn = useCallback(
    (sheetName: string) => () => {
      updateSheet(sheetName, (s) => ({
        ...s,
        headers: [...s.headers, ""],
        rows: s.rows.map((r) => [...r, ""]),
      }));
    },
    [updateSheet],
  );

  const makeDeleteRow = useCallback(
    (sheetName: string) => (rowIdx: number) => {
      updateSheet(sheetName, (s) => ({
        ...s,
        rows: s.rows.filter((_, i) => i !== rowIdx),
      }));
    },
    [updateSheet],
  );

  const makeDeleteColumn = useCallback(
    (sheetName: string) => (colIdx: number) => {
      updateSheet(sheetName, (s) => ({
        ...s,
        headers: s.headers.filter((_, i) => i !== colIdx),
        rows: s.rows.map((r) => r.filter((_, i) => i !== colIdx)),
      }));
    },
    [updateSheet],
  );

  // Preview header actions
  useEffect(() => {
    setActions(
      <div className="flex items-center gap-1">
        {isDirty && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleReset}
            title="Discard changes"
            className="text-muted-foreground"
          >
            <UndoIcon className="size-4" />
          </Button>
        )}
        {isDirty && (
          <Button variant="default" size="sm" onClick={handleSave}>
            <SaveIcon className="size-3.5" />
            Save
          </Button>
        )}
        {!isDirty && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" asChild>
            <a href={url} download={file.filename}>
              <DownloadIcon className="size-3.5" />
              Download
            </a>
          </Button>
        )}
      </div>,
    );
    return () => setActions(null);
  }, [url, file.filename, isDirty, handleSave, handleReset]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Loader size={24} />
      </div>
    );
  }

  if (error || !sheets) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        {error ?? "No data"}
      </div>
    );
  }

  const activeSheetData = sheets.find((s) => s.name === activeSheet) ?? sheets[0]!;

  const sheetToolbarActions = (sheet: SheetData) => (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handleImportSheetAsCsv(sheet)}
        disabled={createFile.isPending}
        title="Import this sheet as a CSV file"
        className="h-7 text-xs gap-1 text-muted-foreground"
      >
        <FileTextIcon className="size-3.5" />
        CSV
      </Button>
      {sheets.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleImportAllAsCsv}
          disabled={createFile.isPending}
          title="Import all sheets as separate CSV files"
          className="h-7 text-xs gap-1 text-muted-foreground"
        >
          <FilesIcon className="size-3.5" />
          All CSV
        </Button>
      )}
    </>
  );

  if (sheets.length === 1) {
    return (
      <SpreadsheetTable
        headers={activeSheetData.headers}
        rows={activeSheetData.rows}
        editable
        onCellChange={makeCellChange(activeSheetData.name)}
        onHeaderChange={makeHeaderChange(activeSheetData.name)}
        onAddRow={makeAddRow(activeSheetData.name)}
        onAddColumn={makeAddColumn(activeSheetData.name)}
        onDeleteRow={makeDeleteRow(activeSheetData.name)}
        onDeleteColumn={makeDeleteColumn(activeSheetData.name)}
        toolbarActions={sheetToolbarActions(activeSheetData)}
      />
    );
  }

  return (
    <Tabs value={activeSheet} onValueChange={setActiveSheet} className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {sheets.map((sheet) => (
          <TabsContent
            key={sheet.name}
            value={sheet.name}
            className="h-full m-0"
          >
            <SpreadsheetTable
              headers={sheet.headers}
              rows={sheet.rows}
              editable
              onCellChange={makeCellChange(sheet.name)}
              onHeaderChange={makeHeaderChange(sheet.name)}
              onAddRow={makeAddRow(sheet.name)}
              onAddColumn={makeAddColumn(sheet.name)}
              onDeleteRow={makeDeleteRow(sheet.name)}
              onDeleteColumn={makeDeleteColumn(sheet.name)}
              toolbarActions={sheetToolbarActions(sheet)}
            />
          </TabsContent>
        ))}
      </div>
      <div className="border-t px-2 py-1 bg-muted/30">
        <TabsList variant="line" className="h-7">
          {sheets.map((sheet) => (
            <TabsTrigger key={sheet.name} value={sheet.name} className="text-xs px-3 py-1">
              {sheet.name}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}
