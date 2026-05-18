import { useRef, useEffect, useState, useCallback, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Item = { text: string; icon?: ReactNode; description?: string };

interface PromptMarqueeProps {
  items: Item[];
  onSelect: (text: string) => void;
  className?: string;
}

export function PromptMarquee({ items, onSelect, className }: PromptMarqueeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ active: false, startX: 0, startScroll: 0, moved: false });
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    let last = performance.now();
    let pos = el.scrollLeft;
    const SPEED = 0.04; // px per ms (~40px/s)
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      if (!paused && !dragState.current.active) {
        const half = el.scrollWidth / 2;
        if (half > 0) {
          // Resync if something else moved the scroll (drag, wheel).
          if (Math.abs(pos - el.scrollLeft) > 1) pos = el.scrollLeft;
          pos += dt * SPEED;
          if (pos >= half) pos -= half;
          el.scrollLeft = pos;
        }
      } else {
        pos = el.scrollLeft;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused, items.length]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    dragState.current = {
      active: true,
      startX: e.clientX,
      startScroll: el.scrollLeft,
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.active) return;
    const el = scrollRef.current;
    if (!el) return;
    const dx = e.clientX - dragState.current.startX;
    if (Math.abs(dx) > 3) dragState.current.moved = true;
    let next = dragState.current.startScroll - dx;
    const half = el.scrollWidth / 2;
    if (half > 0) {
      while (next < 0) next += half;
      while (next >= half) next -= half;
    }
    el.scrollLeft = next;
  }, []);

  const endDrag = useCallback((e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // Defer clearing so the trailing click can read `moved` and bail.
    requestAnimationFrame(() => {
      dragState.current.active = false;
    });
  }, []);

  // Translate vertical wheel into horizontal scroll, with wrap.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      const half = el.scrollWidth / 2;
      let next = el.scrollLeft + delta;
      if (half > 0) {
        while (next < 0) next += half;
        while (next >= half) next -= half;
      }
      el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [items.length]);

  if (items.length === 0) return null;

  const looped = [...items, ...items];

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden",
        "[mask-image:linear-gradient(to_right,transparent,black_4%,black_96%,transparent)]",
        className,
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        ref={scrollRef}
        className={cn(
          "flex items-center gap-2 overflow-x-auto select-none py-1 px-2",
          "cursor-grab active:cursor-grabbing",
          "[&::-webkit-scrollbar]:hidden",
        )}
        style={{ scrollbarWidth: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {looped.map((item, i) => (
          <button
            key={`${item.text}-${i}`}
            type="button"
            onClick={(e) => {
              if (dragState.current.moved) {
                e.preventDefault();
                return;
              }
              onSelect(item.text);
            }}
            title={item.description}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 hover:bg-muted/60 px-3 py-1.5 text-xs text-foreground/85 whitespace-nowrap transition-colors"
          >
            {item.icon && <span className="text-muted-foreground">{item.icon}</span>}
            <span>{item.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
