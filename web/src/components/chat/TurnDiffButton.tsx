/**
 * Composer toolbar button that opens a popover with the latest turn's
 * file changes. A green dot appears only when the latest turn produced
 * non-empty changes.
 */
import { useState } from "react";
import { GitCompareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TurnDiffPanel } from "@/components/chat-ui/TurnDiffPanel";
import { useTurnDiffsStore } from "@/stores/turn-diffs";
import { useTurnDiff } from "@/hooks/use-turn-diff";

interface Props {
  chatId: string;
}

export function TurnDiffButton({ chatId }: Props) {
  const turnDiffs = useTurnDiffsStore((s) => s.byChatId[chatId]);
  const dismissed = useTurnDiffsStore((s) => s.dismissed);
  const latest =
    turnDiffs && turnDiffs.length > 0 ? turnDiffs[turnDiffs.length - 1] : null;
  const isVisible = !!latest && !dismissed[latest.postSnapshotId];

  const [open, setOpen] = useState(false);
  const { entries } = useTurnDiff(isVisible ? latest!.postSnapshotId : null);
  const hasChanges = !!entries && entries.length > 0;

  if (!isVisible || !latest) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative text-muted-foreground hover:text-foreground"
          aria-label="Changes this turn"
          title="Changes this turn"
        >
          <GitCompareIcon className="size-4" />
          {hasChanges && (
            <span
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-emerald-500"
              aria-hidden
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[28rem] p-0">
        <TurnDiffPanel snapshotId={latest.postSnapshotId} />
      </PopoverContent>
    </Popover>
  );
}
