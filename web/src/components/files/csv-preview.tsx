import { useState, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import { SaveIcon, PlusIcon, XIcon, Trash2Icon, UndoIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
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

  const handleReset = useCallback(() => {
    setHeaders(initial.headers);
    setRows(initial.rows);
  }, [initial]);

  const handleSave = () => {
    const csv = serializeCSV(headers, rows);
    updateFile.mutate(
      { fileId: file.id, content: csv },
      {
        onSuccess: () => toast("File saved"),
        onError: () => toast.error("Failed to save file"),
      },
    );
  };

  if (headers.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No data found in CSV file.
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold">{file.filename}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {rows.length} row{rows.length !== 1 ? "s" : ""} ·{" "}
            {headers.length} column{headers.length !== 1 ? "s" : ""}
          </span>
          {isDirty && (
            <Button variant="ghost" size="icon-sm" onClick={handleReset} title="Reset changes">
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
        </div>
      </div>
      <div className="rounded-md border overflow-auto max-h-[70vh]">
        <Table>
          <TableHeader className="sticky top-0 bg-muted z-10">
            <TableRow>
              <TableHead className="w-8 p-0" />
              {headers.map((header, i) => (
                <TableHead key={i} className="p-0 group/col relative min-w-[150px]">
                  <input
                    className="w-full bg-transparent px-2 py-1.5 text-xs font-medium outline-none focus:ring-1 focus:ring-ring rounded-sm"
                    value={header}
                    onChange={(e) => handleHeaderChange(i, e.target.value)}
                  />
                  {headers.length > 1 && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          className="absolute -top-0.5 right-0.5 opacity-0 group-hover/col:opacity-100 transition-opacity p-0.5 rounded-full bg-muted-foreground/10 hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                          title="Delete column"
                        >
                          <Trash2Icon className="h-2.5 w-2.5" />
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent size="sm">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete column</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete the column "{header || `Column ${i + 1}`}"? This will remove the column and all its data.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => handleDeleteColumn(i)}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </TableHead>
              ))}
              <TableHead className="w-8 p-0">
                <button
                  type="button"
                  className="flex items-center justify-center w-full h-full p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={handleAddColumn}
                  title="Add column"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIdx) => (
              <TableRow key={rowIdx} className="group/row">
                <TableCell className="p-0 w-8">
                  <button
                    type="button"
                    className="flex items-center justify-center w-full p-1.5 opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    onClick={() => handleDeleteRow(rowIdx)}
                    title="Delete row"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </TableCell>
                {headers.map((_, colIdx) => (
                  <TableCell key={colIdx} className="p-0 min-w-[150px]">
                    <input
                      className="w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring rounded-sm"
                      value={row[colIdx] ?? ""}
                      onChange={(e) =>
                        handleCellChange(rowIdx, colIdx, e.target.value)
                      }
                    />
                  </TableCell>
                ))}
                <TableCell className="w-8 p-0" />
              </TableRow>
            ))}
            {/* Add row */}
            <TableRow>
              <TableCell className="p-0" colSpan={headers.length + 2}>
                <button
                  type="button"
                  className="flex items-center justify-center w-full py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  onClick={handleAddRow}
                  title="Add row"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
