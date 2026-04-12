import {
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import { cn } from "@/lib/utils";

export interface RichTextareaHandle {
  /** Insert a file chip at the current cursor position */
  insertFileChip: (fileId: string, filename: string) => void;
  focus: () => void;
}

interface RichTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
}

/** Serialise contentEditable innerHTML → plain text, turning chip spans into [file: name] */
function serialise(el: HTMLElement): string {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      if (node.dataset.fileChip) {
        text += `[file: ${node.dataset.filename}]`;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else {
        // Recurse for any wrapper divs contentEditable may create
        text += serialise(node);
        // Block-level elements get a trailing newline
        if (node.tagName === "DIV" || node.tagName === "P") {
          text += "\n";
        }
      }
    }
  }
  return text;
}

/** Build a non-editable chip span */
function createChipElement(fileId: string, filename: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.fileChip = fileId;
  chip.dataset.filename = filename;
  chip.className =
    "inline-flex items-center gap-0.5 rounded bg-primary/10 text-primary px-1.5 py-px text-[13px] font-medium mx-0.5 align-baseline select-all cursor-default";
  chip.textContent = filename;
  return chip;
}

export const RichTextarea = forwardRef<RichTextareaHandle, RichTextareaProps>(
  ({ value, onChange, onSubmit, placeholder, className }, ref) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);
    // Track whether we're syncing to avoid loops
    const isSyncing = useRef(false);
    // Save cursor position so we can restore it after blur (e.g. clicking a button)
    const savedRange = useRef<Range | null>(null);

    const saveCursor = useCallback(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
        savedRange.current = sel.getRangeAt(0).cloneRange();
      }
    }, []);

    useImperativeHandle(ref, () => ({
      insertFileChip(fileId: string, filename: string) {
        const el = editorRef.current;
        if (!el) return;

        const sel = window.getSelection();
        if (!sel) return;

        // Restore saved cursor position first, then focus.
        // focus() alone would reset cursor to start.
        if (savedRange.current) {
          sel.removeAllRanges();
          sel.addRange(savedRange.current);
        }
        el.focus();

        const chip = createChipElement(fileId, filename);
        const space = document.createTextNode("\u00A0");

        if (sel.rangeCount === 0) {
          // No cursor - append at end
          el.appendChild(chip);
          el.appendChild(space);
        } else {
          const range = sel.getRangeAt(0);
          range.collapse(false);
          range.insertNode(chip);
          chip.after(space);
          // Move cursor after the space
          range.setStartAfter(space);
          range.setEndAfter(space);
          sel.removeAllRanges();
          sel.addRange(range);
        }

        // Update saved range to new position
        savedRange.current = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

        // Sync
        isSyncing.current = true;
        onChange(serialise(el));
        isSyncing.current = false;
      },
      focus() {
        editorRef.current?.focus();
      },
    }));

    // Sync external value → DOM only when value is cleared (e.g. after submit)
    useEffect(() => {
      if (isSyncing.current) return;
      const el = editorRef.current;
      if (!el) return;
      if (value === "" && el.innerHTML !== "") {
        el.innerHTML = "";
      }
    }, [value]);

    const handleInput = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      isSyncing.current = true;
      onChange(serialise(el));
      isSyncing.current = false;
    }, [onChange]);

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !isComposing.current) {
          e.preventDefault();
          onSubmit?.();
        }
      },
      [onSubmit],
    );

    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLDivElement>) => {
        // Only allow plain text paste
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      },
      [],
    );

    const isEmpty = value === "";

    return (
      <div className="relative w-full">
        <div
          ref={editorRef}
          contentEditable
          role="textbox"
          aria-multiline
          aria-placeholder={placeholder}
          data-slot="input-group-control"
          className={cn(
            "field-sizing-content max-h-48 min-h-16 w-full flex-1 resize-none rounded-none border-0 bg-transparent py-3 px-3 text-sm shadow-none outline-none focus-visible:ring-0 dark:bg-transparent overflow-y-auto whitespace-pre-wrap break-words",
            className,
          )}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={saveCursor}
          onMouseUp={saveCursor}
          onBlur={saveCursor}
          onPaste={handlePaste}
          onCompositionStart={() => {
            isComposing.current = true;
          }}
          onCompositionEnd={() => {
            isComposing.current = false;
          }}
          suppressContentEditableWarning
        />
        {isEmpty && placeholder && (
          <div className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">
            {placeholder}
          </div>
        )}
      </div>
    );
  },
);

RichTextarea.displayName = "RichTextarea";
