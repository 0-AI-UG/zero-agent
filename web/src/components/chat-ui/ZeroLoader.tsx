import { memo } from "react";
import { cn } from "@/lib/utils";

interface ZeroLoaderProps {
  className?: string;
}

const ZERO_PATH =
  "M16 5.5C12.2 5.5 9.5 9.8 9.5 16c0 6.2 2.7 10.5 6.5 10.5s6.5-4.3 6.5-10.5c0-6.2-2.7-10.5-6.5-10.5z";
const ORBIT_PATH = "M 3 16 a 13 5.5 0 1 0 26 0 a 13 5.5 0 1 0 -26 0";
const ORBIT_TILT = "rotate(-30 16 16)";

/**
 * Branded loading indicator: chasing arcs sweep around the "0" glyph and
 * its tilted orbital ring, with a dot orbiting along the ring.
 */
export const ZeroLoader = memo(function ZeroLoader({ className }: ZeroLoaderProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn("size-7 text-muted-foreground", className)}
      role="status"
      aria-label="Thinking"
    >
      <defs>
        <path
          id="zero-loader-orbit"
          d={ORBIT_PATH}
          transform={ORBIT_TILT}
        />
      </defs>

      {/* Tilted orbital ring */}
      <g transform={ORBIT_TILT}>
        <path
          d={ORBIT_PATH}
          stroke="currentColor"
          strokeWidth="1.2"
          opacity="0.2"
        />
        <path
          d={ORBIT_PATH}
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeDasharray="14 56"
          pathLength="70"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="70"
            to="0"
            dur="2.2s"
            repeatCount="indefinite"
          />
        </path>
      </g>

      {/* The 0 */}
      <path
        d={ZERO_PATH}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.2"
      />
      <path
        d={ZERO_PATH}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="14 56"
        pathLength="70"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="70"
          to="0"
          dur="1.4s"
          repeatCount="indefinite"
        />
      </path>

      {/* Central dot — matches the logo */}
      <circle cx="16" cy="16" r="2.5" fill="currentColor" opacity="0.9" />

      {/* Orbiting dot on the tilted ring */}
      <circle r="1.5" fill="currentColor">
        <animateMotion dur="2.2s" repeatCount="indefinite" rotate="auto">
          <mpath href="#zero-loader-orbit" />
        </animateMotion>
      </circle>
    </svg>
  );
});
