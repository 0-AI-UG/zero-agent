import { useEffect, useRef } from "react";

/**
 * AsciiBackground — Space Theme
 * Large Saturn with detailed rings, atmospheric bands, moons,
 * a distant planet, twinkling starfield, and nebula wisps.
 */

/* ── helpers ─────────────────────────────────────────────────────── */

function hash32(x: number): number {
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const r = (ix: number, iy: number) =>
    (hash32(ix * 374761393 ^ iy * 668265263) & 0xffff) / 0xffff;
  const a = r(xi, yi), b = r(xi + 1, yi), c = r(xi, yi + 1), d = r(xi + 1, yi + 1);
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number): number {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 5; i++) {
    v += amp * vnoise(x * f, y * f);
    f *= 2;
    amp *= 0.5;
  }
  return v;
}

// ASCII density ramp (sparse → dense)
const RAMP = " .'`^\":;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

function densityChar(d: number): string {
  const i = Math.floor(d * (RAMP.length - 1));
  return RAMP[Math.max(0, Math.min(RAMP.length - 1, i))]!;
}

const STAR_CHARS = ".*+·'`";

/* ── component ───────────────────────────────────────────────────── */

export function AsciiBackground({ className = "" }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const pre = preRef.current;
    if (!host || !pre) return;

    let cols = 0, rows = 0;
    let cellW = 8, cellH = 14;
    let aspect = 1.75;
    let raf = 0;
    const t0 = performance.now();
    let lastFrame = 0;

    const measure = () => {
      const isSm = window.innerWidth < 900;
      const fs = isSm ? 10 : 14;
      const lh = isSm ? 10 : 14;
      pre.style.fontSize = `${fs}px`;
      pre.style.lineHeight = `${lh}px`;
      const probe = document.createElement("span");
      probe.textContent = "M".repeat(50);
      probe.style.visibility = "hidden";
      probe.style.position = "absolute";
      probe.style.font = getComputedStyle(pre).font;
      pre.appendChild(probe);
      cellW = probe.getBoundingClientRect().width / 50;
      cellH = lh;
      pre.removeChild(probe);
      aspect = cellH / cellW;
      const rect = host.getBoundingClientRect();
      cols = Math.max(8, Math.floor(rect.width / cellW));
      rows = Math.max(8, Math.floor(rect.height / cellH));
    };

    const render = (now: number) => {
      raf = requestAnimationFrame(render);
      if (now - lastFrame < 1000 / 30) return;
      lastFrame = now;
      const t = (now - t0) / 1000;

      // ── Saturn — HUGE, lower-left of center ───────────────────
      const pcx = cols * 0.32;
      const pcy = rows * 0.55;
      const shortDim = Math.min(cols, rows * aspect);
      const planetR = shortDim * 0.32;

      // Ring geometry — detailed multi-band ring system
      const ringInner = planetR * 1.25;
      const ringGap1 = planetR * 1.55;  // Cassini division start
      const ringGap2 = planetR * 1.62;  // Cassini division end
      const ringOuter = planetR * 2.8;
      const ringTilt = 0.38 + 0.10 * Math.sin(t * 0.09);
      const ringAngle = -0.10 + 0.05 * Math.sin(t * 0.035);
      const cosRA = Math.cos(ringAngle);
      const sinRA = Math.sin(ringAngle);

      // Light direction (upper-left)
      const lightX = -0.55;
      const lightY = -0.83;

      // Planet shadow on ring (approximate)
      const shadowAngle = Math.atan2(-lightY, -lightX);
      const shadowCos = Math.cos(shadowAngle);
      const shadowSin = Math.sin(shadowAngle);

      // ── Moon 1 — orbiting ─────────────────────────────────────
      const moon1Orbit = planetR * 3.6;
      const moon1Angle = t * 0.14;
      const moon1Cx = pcx + Math.cos(moon1Angle) * moon1Orbit;
      const moon1Cy = pcy + Math.sin(moon1Angle) * (moon1Orbit * 0.45) / aspect;
      const moon1R = Math.max(1.5, planetR * 0.10);

      // ── Moon 2 — smaller, faster ─────────────────────────────
      const moon2Orbit = planetR * 2.0;
      const moon2Angle = t * 0.28 + 2.0;
      const moon2Cx = pcx + Math.cos(moon2Angle) * moon2Orbit;
      const moon2Cy = pcy + Math.sin(moon2Angle) * (moon2Orbit * 0.35) / aspect;
      const moon2R = Math.max(0.8, planetR * 0.05);

      // ── Distant planet (top-right) ────────────────────────────
      const p2cx = cols * 0.82;
      const p2cy = rows * 0.18;
      const p2R = Math.max(1.5, planetR * 0.22);

      // ── Build frame ───────────────────────────────────────────
      let out = "";

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {

          // Aspect-corrected deltas from Saturn centre
          const dx = x - pcx;
          const dy = (y - pcy) * aspect;
          const dist = Math.sqrt(dx * dx + dy * dy);

          // Rotated coords for ring ellipse
          const rx = dx * cosRA - dy * sinRA;
          const ry = dx * sinRA + dy * cosRA;
          const ringDist = Math.sqrt(rx * rx + (ry / ringTilt) * (ry / ringTilt));
          const inCassini = ringDist >= ringGap1 && ringDist <= ringGap2;
          const onRing = ringDist >= ringInner && ringDist <= ringOuter && !inCassini;
          const ringInFront = ry > 0;

          const onPlanet = dist <= planetR;

          // Moons
          const m1dx = x - moon1Cx;
          const m1dy = (y - moon1Cy) * aspect;
          const moon1Dist = Math.sqrt(m1dx * m1dx + m1dy * m1dy);
          const onMoon1 = moon1Dist <= moon1R;

          const m2dx = x - moon2Cx;
          const m2dy = (y - moon2Cy) * aspect;
          const moon2Dist = Math.sqrt(m2dx * m2dx + m2dy * m2dy);
          const onMoon2 = moon2Dist <= moon2R;

          // Distant planet
          const d2x = x - p2cx;
          const d2y = (y - p2cy) * aspect;
          const dist2 = Math.sqrt(d2x * d2x + d2y * d2y);
          const onPlanet2 = dist2 <= p2R;

          // ── priority: ring-front > moons > planet > ring-back > planet2 > star > nebula ──

          // Ring in front of planet
          if (onRing && ringInFront && !onMoon1 && !onMoon2) {
            out += ringChar(ringDist, ringInner, ringOuter, rx, ry, planetR, pcx, pcy, x, y, aspect, shadowCos, shadowSin, true);
            continue;
          }

          // Moon 1
          if (onMoon1) {
            const nd = moon1Dist / moon1R;
            const mnx = m1dx / (moon1Dist || 1);
            const mny = m1dy / (moon1Dist || 1);
            const light = mnx * lightX + mny * lightY;
            const tex = vnoise(m1dx * 2 + 20, m1dy * 2 + 20) * 0.08;
            out += densityChar(Math.max(0.06, (1 - nd * 0.4) * (0.30 + 0.35 * light) + tex));
            continue;
          }

          // Moon 2
          if (onMoon2) {
            const nd = moon2Dist / moon2R;
            out += densityChar(Math.max(0.05, (1 - nd * 0.5) * 0.35));
            continue;
          }

          // Planet body
          if (onPlanet) {
            out += planetChar(dx, dy, dist, planetR, lightX, lightY, t);
            continue;
          }

          // Ring behind planet
          if (onRing && !ringInFront) {
            out += ringChar(ringDist, ringInner, ringOuter, rx, ry, planetR, pcx, pcy, x, y, aspect, shadowCos, shadowSin, false);
            continue;
          }

          // Cassini division — show as empty or faint
          if (inCassini && ringDist >= ringInner && ringDist <= ringOuter) {
            const faint = vnoise(rx * 0.5, ry * 0.5);
            if (faint > 0.7) {
              out += densityChar(0.04);
              continue;
            }
          }

          // Distant planet
          if (onPlanet2) {
            const nd2 = dist2 / p2R;
            const nx2 = d2x / (dist2 || 1);
            const ny2 = d2y / (dist2 || 1);
            const light2 = nx2 * lightX + ny2 * lightY;
            const tex2 = vnoise(d2x / p2R * 4, d2y / p2R * 4) * 0.1;
            out += densityChar(Math.max(0.05, (1 - nd2 * 0.3) * (0.22 + 0.32 * light2) + tex2));
            continue;
          }

          // Stars
          const sh = hash32(x * 15485863 ^ y * 32452843);
          if ((sh & 0x3ff) < 14) {
            const phase = (sh >>> 10 & 0x3ff) / 163;
            const twinkle = Math.sin(t * 1.1 + phase);
            if (twinkle > -0.35) {
              out += STAR_CHARS[sh % STAR_CHARS.length];
              continue;
            }
          }

          // Subtle nebula wisps
          const neb = fbm(x * 0.015 + t * 0.003, y * 0.022 - t * 0.002);
          if (neb > 0.55) {
            out += densityChar(Math.min(0.10, (neb - 0.55) * 0.7));
            continue;
          }

          out += " ";
        }
        out += "\n";
      }

      pre.textContent = out;
    };

    measure();
    raf = requestAnimationFrame(render);

    const ro = new ResizeObserver(() => measure());
    ro.observe(host);

    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else { lastFrame = 0; raf = requestAnimationFrame(render); }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div ref={hostRef} aria-hidden="true" className={`ascii-embed ${className}`}>
      <pre ref={preRef} className="ascii-pre" />
    </div>
  );
}

/* ── planet shading helper ───────────────────────────────────────── */

function planetChar(
  dx: number, dy: number, dist: number, radius: number,
  lightX: number, lightY: number, t: number,
): string {
  const nd = dist / radius;
  const nx = dx / (dist || 1);
  const ny = dy / (dist || 1);
  const light = nx * lightX + ny * lightY;

  // Multiple atmospheric band frequencies for detail
  const band1 = Math.sin(dy / radius * 12) * 0.06;
  const band2 = Math.sin(dy / radius * 22 + 0.5) * 0.03;
  const band3 = Math.sin(dy / radius * 6 + 1.2) * 0.04;

  // Surface noise — more octaves for detail
  const texU = dx / radius;
  const texV = dy / radius;
  const tex1 = vnoise(texU * 4 + 10, texV * 4 + 10) * 0.08;
  const tex2 = vnoise(texU * 8 + 5, texV * 8 + 5) * 0.04;

  // Storm feature (like Jupiter's red spot)
  const stormX = 0.3, stormY = 0.15;
  const stormDist = Math.sqrt((texU - stormX) ** 2 + (texV - stormY) ** 2);
  const storm = stormDist < 0.2 ? (0.2 - stormDist) * 0.4 : 0;

  // Limb darkening — stronger for more 3D effect
  const limb = 1 - nd * nd * 0.5;

  // Terminator sharpening
  const shade = 0.25 + 0.40 * light;

  const d = limb * shade + band1 + band2 + band3 + tex1 + tex2 + storm;
  return densityChar(Math.max(0.04, Math.min(0.78, d)));
}

/* ── ring shading helper ─────────────────────────────────────────── */

function ringChar(
  ringDist: number, ringInner: number, ringOuter: number,
  rx: number, ry: number,
  planetR: number, pcx: number, pcy: number,
  x: number, y: number, aspect: number,
  shadowCos: number, shadowSin: number,
  isFront: boolean,
): string {
  const bandPos = (ringDist - ringInner) / (ringOuter - ringInner);

  // Multiple ring bands with varying density
  const band1 = Math.sin(bandPos * Math.PI * 14) * 0.5;
  const band2 = Math.sin(bandPos * Math.PI * 28 + 1.0) * 0.2;
  const band3 = Math.sin(bandPos * Math.PI * 5) * 0.3;

  // Ring texture variation along the circumference
  const circumTex = vnoise(rx * 0.15 + 30, ry * 0.15 + 30) * 0.12;

  const combined = band1 + band2 + band3 + circumTex;

  if (combined < 0.05) {
    return " "; // gap in ring
  }

  // Brightness based on front/back
  const baseBright = isFront ? 0.14 : 0.08;
  const bandBright = isFront ? 0.28 : 0.18;

  // Fade at ring edges
  const edgeFade = bandPos < 0.08 ? bandPos / 0.08
    : bandPos > 0.92 ? (1 - bandPos) / 0.08
    : 1;

  const d = (baseBright + combined * bandBright) * edgeFade;
  return densityChar(Math.max(0.03, Math.min(0.45, d)));
}

export default AsciiBackground;
