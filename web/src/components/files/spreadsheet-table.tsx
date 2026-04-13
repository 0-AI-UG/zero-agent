import { useState, useMemo, useCallback, useRef, useEffect, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  PlusIcon,
  Trash2Icon,
  ArrowUpIcon,
  ArrowDownIcon,
  FilterIcon,
  SearchIcon,
  XIcon,
  ChevronsUpDownIcon,
  ColumnsIcon,
  RowsIcon,
} from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const ROW_HEIGHT = 34;

type SortDir = "asc" | "desc" | null;

interface ColumnFilter {
  text: string;
  mode: "contains" | "starts" | "exact";
}

export interface SpreadsheetTableProps {
  headers: string[];
  rows: string[][];
  editable?: boolean;
  onCellChange?: (rowIdx: number, colIdx: number, value: string) => void;
  onHeaderChange?: (colIdx: number, value: string) => void;
  onAddRow?: () => void;
  onAddColumn?: () => void;
  onDeleteRow?: (rowIdx: number) => void;
  onDeleteColumn?: (colIdx: number) => void;
  toolbarActions?: ReactNode;
}

function isNumericColumn(rows: string[][], colIdx: number): boolean {
  if (rows.length === 0) return false;
  let numericCount = 0;
  const sample = rows.slice(0, 100);
  for (const row of sample) {
    const val = row[colIdx]?.trim();
    if (val && !isNaN(parseFloat(val))) numericCount++;
  }
  return numericCount / sample.length > 0.5;
}

function compareValues(a: string, b: string, numeric: boolean): number {
  if (numeric) return (parseFloat(a) || 0) - (parseFloat(b) || 0);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function matchesFilter(value: string, filter: ColumnFilter): boolean {
  if (!filter.text) return true;
  const v = value.toLowerCase();
  const f = filter.text.toLowerCase();
  switch (filter.mode) {
    case "contains":
      return v.includes(f);
    case "starts":
      return v.startsWith(f);
    case "exact":
      return v === f;
  }
}

export function SpreadsheetTable({
  headers,
  rows,
  editable = false,
  onCellChange,
  onHeaderChange,
  onAddRow,
  onAddColumn,
  onDeleteRow,
  onDeleteColumn,
  toolbarActions,
}: SpreadsheetTableProps) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filters, setFilters] = useState<Record<number, ColumnFilter>>({});
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const resizeRef = useRef<{ col: number; startX: number; startW: number } | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedCol, setSelectedCol] = useState<number | null>(null);

  const numericCols = useMemo(
    () => headers.map((_, i) => isNumericColumn(rows, i)),
    [headers, rows],
  );

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((f) => f.text.length > 0).length,
    [filters],
  );

  const processedRows = useMemo(() => {
    let indexed = rows.map((row, i) => ({ row, originalIdx: i }));

    for (const [colStr, filter] of Object.entries(filters)) {
      const col = parseInt(colStr);
      if (filter.text) {
        indexed = indexed.filter((r) =>
          matchesFilter(r.row[col] ?? "", filter),
        );
      }
    }

    if (search) {
      const s = search.toLowerCase();
      indexed = indexed.filter((r) =>
        r.row.some((cell) => cell.toLowerCase().includes(s)),
      );
    }

    if (sortCol !== null && sortDir) {
      const col = sortCol;
      const numeric = numericCols[col] ?? false;
      const dir = sortDir === "asc" ? 1 : -1;
      indexed = [...indexed].sort(
        (a, b) =>
          dir * compareValues(a.row[col] ?? "", b.row[col] ?? "", numeric),
      );
    }

    return indexed;
  }, [rows, filters, search, sortCol, sortDir, numericCols]);

  const searchMatchCount = useMemo(() => {
    if (!search) return 0;
    const s = search.toLowerCase();
    let count = 0;
    for (const { row } of processedRows) {
      for (const cell of row) {
        if (cell.toLowerCase().includes(s)) count++;
      }
    }
    return count;
  }, [search, processedRows]);

  const rowVirtualizer = useVirtualizer({
    count: processedRows.length + (editable ? 1 : 0),
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const handleSort = useCallback(
    (colIdx: number) => {
      if (sortCol === colIdx) {
        if (sortDir === "asc") setSortDir("desc");
        else {
          setSortCol(null);
          setSortDir(null);
        }
      } else {
        setSortCol(colIdx);
        setSortDir("asc");
      }
    },
    [sortCol, sortDir],
  );

  const handleFilterChange = useCallback(
    (colIdx: number, text: string) => {
      setFilters((prev) => ({
        ...prev,
        [colIdx]: { text, mode: prev[colIdx]?.mode ?? "contains" },
      }));
    },
    [],
  );

  const handleFilterModeChange = useCallback(
    (colIdx: number, mode: ColumnFilter["mode"]) => {
      setFilters((prev) => ({
        ...prev,
        [colIdx]: { text: prev[colIdx]?.text ?? "", mode },
      }));
    },
    [],
  );

  const clearAllFilters = useCallback(() => {
    setFilters({});
    setSearch("");
  }, []);

  const handleDeleteColumnWrapped = useCallback(
    (colIdx: number) => {
      onDeleteColumn?.(colIdx);
      setFilters((prev) => {
        const next = { ...prev };
        delete next[colIdx];
        return next;
      });
      if (sortCol === colIdx) {
        setSortCol(null);
        setSortDir(null);
      }
    },
    [sortCol, onDeleteColumn],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, colIdx: number) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidths[colIdx] ?? 150;
      resizeRef.current = { col: colIdx, startX, startW };

      const handleMouseMove = (e: MouseEvent) => {
        if (!resizeRef.current) return;
        const diff = e.clientX - resizeRef.current.startX;
        const newWidth = Math.max(60, resizeRef.current.startW + diff);
        setColWidths((prev) => ({ ...prev, [resizeRef.current!.col]: newWidth }));
      };

      const handleMouseUp = () => {
        resizeRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [colWidths],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  if (headers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-2 text-sm text-muted-foreground">
        <ColumnsIcon className="size-8 opacity-30" />
        {editable ? "No data found. Add columns to get started." : "Empty sheet"}
      </div>
    );
  }

  const extraCols = editable ? 2 : 1;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-muted/20">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            placeholder={editable ? "Search (⌘F)" : "Search..."}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-7 pl-8 pr-16 text-xs bg-background border border-border/60 rounded-md outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/60"
          />
          {search && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {searchMatchCount}
              </span>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                onClick={() => setSearch("")}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )}
        </div>

        {/* Active filters badge */}
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAllFilters}
            className="h-7 text-xs gap-1.5 text-muted-foreground"
          >
            <FilterIcon className="size-3" />
            {activeFilterCount}
            <XIcon className="size-3" />
          </Button>
        )}

        <div className="flex-1" />

        {/* Stats */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
          <span className="flex items-center gap-1">
            <RowsIcon className="size-3 opacity-50" />
            {processedRows.length !== rows.length
              ? `${processedRows.length}/${rows.length}`
              : rows.length}
          </span>
          <span className="flex items-center gap-1">
            <ColumnsIcon className="size-3 opacity-50" />
            {headers.length}
          </span>
        </div>

        {/* Custom actions slot */}
        {toolbarActions && (
          <div className="flex items-center gap-1 border-l border-border/60 pl-2 ml-1">
            {toolbarActions}
          </div>
        )}
      </div>

      {/* Table */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto">
        <table className="text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-border/60">
              {/* Row number header */}
              <th className="w-12 min-w-12 px-2 py-1.5 text-[10px] font-medium text-muted-foreground/70 text-right border-r border-border/40 bg-muted/60 sticky left-0 z-20 select-none">
                #
              </th>
              {/* Data columns */}
              {headers.map((header, i) => {
                const width = colWidths[i] ?? 150;
                const hasFilter = filters[i]?.text;
                const isSorted = sortCol === i;
                return (
                  <th
                    key={i}
                    className="relative p-0 border-r border-border/40 bg-muted/60 group/col select-none"
                    style={{ width, minWidth: width }}
                  >
                    <div className="flex items-center h-8">
                      {/* Sort button / header label */}
                      <button
                        type="button"
                        className="flex-1 flex items-center gap-1 px-2.5 h-full text-left text-xs font-medium text-foreground/80 hover:text-foreground hover:bg-muted/80 cursor-pointer truncate"
                        onClick={() => handleSort(i)}
                      >
                        {editable ? (
                          <input
                            className="flex-1 bg-transparent text-xs font-medium outline-none min-w-0 text-foreground"
                            value={header}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => onHeaderChange?.(i, e.target.value)}
                            placeholder={`Column ${i + 1}`}
                          />
                        ) : (
                          <span className="flex-1 truncate">{header || `Column ${i + 1}`}</span>
                        )}
                        {isSorted && sortDir === "asc" && (
                          <ArrowUpIcon className="size-3 shrink-0 text-primary" />
                        )}
                        {isSorted && sortDir === "desc" && (
                          <ArrowDownIcon className="size-3 shrink-0 text-primary" />
                        )}
                        {!isSorted && (
                          <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground/30 group-hover/col:text-muted-foreground/60" />
                        )}
                      </button>

                      {/* Filter popover */}
                      <Popover
                        open={openFilter === i}
                        onOpenChange={(open) => setOpenFilter(open ? i : null)}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className={`shrink-0 p-1 mr-0.5 rounded hover:bg-muted-foreground/10 ${
                              hasFilter
                                ? "text-primary"
                                : "text-muted-foreground/40 opacity-0 group-hover/col:opacity-100"
                            }`}
                          >
                            <FilterIcon className="size-3" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-56 p-3" align="start" sideOffset={4}>
                          <div className="space-y-2">
                            <p className="text-xs font-medium">
                              Filter: {header || `Column ${i + 1}`}
                            </p>
                            <div className="flex gap-1">
                              {(["contains", "starts", "exact"] as const).map((mode) => (
                                <button
                                  key={mode}
                                  type="button"
                                  className={`px-2 py-0.5 text-[10px] rounded border ${
                                    (filters[i]?.mode ?? "contains") === mode
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-background border-border text-muted-foreground hover:text-foreground"
                                  }`}
                                  onClick={() => handleFilterModeChange(i, mode)}
                                >
                                  {mode === "contains"
                                    ? "Contains"
                                    : mode === "starts"
                                      ? "Starts with"
                                      : "Exact"}
                                </button>
                              ))}
                            </div>
                            <Input
                              placeholder="Filter value..."
                              className="h-7 text-xs"
                              value={filters[i]?.text ?? ""}
                              onChange={(e) => handleFilterChange(i, e.target.value)}
                              autoFocus
                            />
                            {filters[i]?.text && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full h-6 text-xs"
                                onClick={() => handleFilterChange(i, "")}
                              >
                                Clear
                              </Button>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>

                      {/* Delete column */}
                      {editable && headers.length > 1 && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 p-1 mr-0.5 rounded opacity-0 group-hover/col:opacity-100 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10"
                              title="Delete column"
                            >
                              <Trash2Icon className="size-3" />
                            </button>
                          </AlertDialogTrigger>
                          <AlertDialogContent size="sm">
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete column</AlertDialogTitle>
                              <AlertDialogDescription>
                                Delete "{header || `Column ${i + 1}`}" and all its data?
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                onClick={() => handleDeleteColumnWrapped(i)}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>

                    {/* Resize handle */}
                    <div
                      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/40 active:bg-primary/60 z-10"
                      onMouseDown={(e) => handleResizeStart(e, i)}
                      onDoubleClick={() => {
                        const maxLen = Math.max(
                          (header || "Column").length,
                          ...rows.slice(0, 200).map((r) => (r[i] ?? "").length),
                        );
                        setColWidths((prev) => ({
                          ...prev,
                          [i]: Math.max(60, Math.min(400, maxLen * 8 + 32)),
                        }));
                      }}
                    />
                  </th>
                );
              })}
              {/* Add column */}
              {editable && (
                <th className="w-9 min-w-9 p-0 bg-muted/60">
                  <button
                    type="button"
                    className="flex items-center justify-center w-full h-8 text-muted-foreground/50 hover:text-foreground hover:bg-muted/80"
                    onClick={onAddColumn}
                    title="Add column"
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {processedRows.length === 0 && (
              <tr>
                <td
                  colSpan={headers.length + extraCols}
                  className="text-center py-12 text-sm text-muted-foreground"
                >
                  {search || activeFilterCount > 0
                    ? "No matching rows"
                    : "No data"}
                </td>
              </tr>
            )}
            {processedRows.length > 0 && (
              <>
                {/* Top spacer */}
                {(() => {
                  const firstItem = rowVirtualizer.getVirtualItems()[0];
                  return firstItem && firstItem.start > 0 ? (
                    <tr>
                      <td
                        colSpan={headers.length + extraCols}
                        style={{ height: firstItem.start, padding: 0, border: "none" }}
                      />
                    </tr>
                  ) : null;
                })()}
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  if (editable && virtualRow.index === processedRows.length) {
                    return (
                      <tr key="add-row" data-index={virtualRow.index}>
                        <td className="p-0 sticky left-0 z-[2] bg-background" />
                        <td className="p-0" colSpan={headers.length + 1}>
                          <button
                            type="button"
                            className="flex items-center justify-center w-full py-2 text-muted-foreground/50 hover:text-foreground hover:bg-muted/30 gap-1.5 text-xs"
                            onClick={onAddRow}
                          >
                            <PlusIcon className="size-3.5" />
                            Add row
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  const item = processedRows[virtualRow.index];
                  if (!item) return null;
                  const { row, originalIdx } = item;
                  const isSelected = selectedRow === originalIdx;
                  const isEven = virtualRow.index % 2 === 0;

                  return (
                    <tr
                      key={originalIdx}
                      data-index={virtualRow.index}
                      className={`border-b border-border/20 group/row ${
                        isSelected
                          ? "bg-primary/5"
                          : isEven
                            ? "bg-transparent"
                            : "bg-muted/15"
                      } ${!isSelected ? "hover:bg-muted/30" : ""}`}
                      style={{ height: ROW_HEIGHT }}
                      onClick={() => setSelectedRow(isSelected ? null : originalIdx)}
                    >
                      {/* Row number */}
                      <td className="w-12 min-w-12 px-2 py-0 text-[10px] text-muted-foreground/60 text-right border-r border-border/40 sticky left-0 z-[2] tabular-nums select-none bg-background">

                        <div className="flex items-center justify-end gap-1">
                          {editable && (
                            <button
                              type="button"
                              className="opacity-0 group-hover/row:opacity-100 p-0.5 -ml-1 rounded text-muted-foreground/50 hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteRow?.(originalIdx);
                              }}
                              title="Delete row"
                            >
                              <Trash2Icon className="size-2.5" />
                            </button>
                          )}
                          <span>{originalIdx + 1}</span>
                        </div>
                      </td>
                      {/* Cells */}
                      {headers.map((_, colIdx) => {
                        const width = colWidths[colIdx] ?? 150;
                        const cellValue = row[colIdx] ?? "";
                        const isMatch =
                          search &&
                          cellValue.toLowerCase().includes(search.toLowerCase());
                        const isCellSelected = isSelected && selectedCol === colIdx;
                        return editable ? (
                          <td
                            key={colIdx}
                            className={`p-0 border-r border-border/20 ${
                              isMatch ? "bg-yellow-500/10" : ""
                            } ${isCellSelected ? "ring-1 ring-inset ring-primary/50" : ""}`}
                            style={{ width, minWidth: width }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRow(originalIdx);
                              setSelectedCol(colIdx);
                            }}
                          >
                            <input
                              className="w-full bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                              value={cellValue}
                              onChange={(e) =>
                                onCellChange?.(originalIdx, colIdx, e.target.value)
                              }
                            />
                          </td>
                        ) : (
                          <td
                            key={colIdx}
                            className={`px-2.5 py-1.5 border-r border-border/20 text-sm truncate ${
                              isMatch ? "bg-yellow-500/10" : ""
                            } ${numericCols[colIdx] ? "text-right font-mono tabular-nums" : ""}`}
                            style={{ width, minWidth: width, maxWidth: width }}
                          >
                            {cellValue}
                          </td>
                        );
                      })}
                      {editable && <td className="w-9 p-0" />}
                    </tr>
                  );
                })}
                {/* Bottom spacer */}
                {(() => {
                  const items = rowVirtualizer.getVirtualItems();
                  const lastItem = items[items.length - 1];
                  if (!lastItem) return null;
                  const bottomSpace = rowVirtualizer.getTotalSize() - lastItem.end;
                  return bottomSpace > 0 ? (
                    <tr>
                      <td
                        colSpan={headers.length + extraCols}
                        style={{ height: bottomSpace, padding: 0, border: "none" }}
                      />
                    </tr>
                  ) : null;
                })()}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
