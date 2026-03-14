import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { FileTypeIcon } from "@/components/files/file-type-icon";
import { useFiles, type FileItem } from "@/hooks/use-files";
import { FolderIcon, PaperclipIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FilePickerButtonProps {
  projectId: string;
  onSelect: (file: FileItem) => void;
}

export function FilePickerButton({ projectId, onSelect }: FilePickerButtonProps) {
  const [open, setOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("/");
  const { data, isLoading } = useFiles(projectId, folderPath);

  const handleSelect = useCallback(
    (file: FileItem) => {
      onSelect(file);
      setOpen(false);
      setFolderPath("/");
    },
    [onSelect],
  );

  const handleFolderClick = useCallback((path: string) => {
    setFolderPath(path);
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setFolderPath("/");
  }, []);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <PaperclipIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-72 p-0"
      >
        <Command shouldFilter>
          <CommandInput placeholder="Search files..." />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading..." : "No files found."}
            </CommandEmpty>

            {folderPath !== "/" && (
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    const parent = folderPath.replace(/\/[^/]+\/?$/, "") || "/";
                    handleFolderClick(parent);
                  }}
                  className="gap-2 text-muted-foreground"
                >
                  <FolderIcon className="size-4" />
                  <span>..</span>
                </CommandItem>
              </CommandGroup>
            )}

            {data?.folders && data.folders.length > 0 && (
              <CommandGroup heading="Folders">
                {data.folders.map((folder) => (
                  <CommandItem
                    key={folder.id}
                    value={folder.name}
                    onSelect={() => handleFolderClick(folder.path)}
                    className="gap-2"
                  >
                    <FolderIcon className="size-4 text-muted-foreground" />
                    <span className="truncate">{folder.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {data?.files && data.files.length > 0 && (
              <CommandGroup heading="Files">
                {data.files.map((file) => (
                  <CommandItem
                    key={file.id}
                    value={file.filename}
                    onSelect={() => handleSelect(file)}
                    className="gap-2"
                  >
                    <FileTypeIcon
                      mimeType={file.mimeType}
                      filename={file.filename}
                      className="size-4"
                    />
                    <span className="flex-1 truncate">{file.filename}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatSize(file.sizeBytes)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
