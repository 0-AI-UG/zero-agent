/**
 * Full pipeline: HTML slides → PDF + PPTX (all TypeScript)
 *
 * 1. Renders HTML slides with Playwright
 * 2. Exports PDF (pixel-perfect reference)
 * 3. Extracts slide data directly from DOM (text, shapes, positions, fonts)
 * 4. Builds native PPTX using PptxGenJS
 */
import { chromium } from "playwright";
import { resolve } from "path";
import { $ } from "bun";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";

const htmlPath = resolve(import.meta.dir, "slide.html");
const outputDir = resolve(import.meta.dir, "output");
const pdfPath = resolve(outputDir, "presentation.pdf");
const pptxPath = resolve(outputDir, "presentation.pptx");
const slideDataPath = resolve(outputDir, "slide-data.json");

interface TextElement {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  letterSpacing: number;
  textTransform: string;
  textAlign: string;
  rotation: number;
  parentWidth: number;
  parentHeight: number;
  wrap: boolean;
}

interface RectElement {
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor: string;
}

interface SlideData {
  width: number;
  height: number;
  backgroundColor: string;
  rects: RectElement[];
  texts: TextElement[];
}

// --- Font embedding ---

interface FontToEmbed {
  typeface: string;       // Font family name as used in PPTX
  style: "regular" | "bold" | "italic" | "boldItalic";
  data: Uint8Array;       // Raw TTF data
}

/** Generate a random GUID like {3F2504E0-4F89-11D3-9A0C-0305E82C3301} */
function generateGuid(): string {
  const hex = () => Math.random().toString(16).substring(2, 6);
  return `{${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}}`.toUpperCase();
}

/** OOXML font obfuscation: XOR first 32 bytes with GUID bytes */
function obfuscateFont(fontData: Uint8Array, guid: string): Uint8Array {
  const result = new Uint8Array(fontData);
  // Extract 16 hex byte values from the GUID (strip braces and dashes)
  const hexStr = guid.replace(/[{}\-]/g, "");
  const guidBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    guidBytes[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16);
  }
  // XOR first 32 bytes with the 16-byte GUID key (repeated once)
  for (let i = 0; i < 32; i++) {
    // OOXML spec: bytes are XOR'd in reverse GUID byte order
    result[i] ^= guidBytes[15 - (i % 16)];
  }
  return result;
}

async function downloadTTF(url: string): Promise<Uint8Array> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Failed to download font: ${url} (${resp.status})`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function embedFontsInPptx(pptxPath: string, fonts: FontToEmbed[]): Promise<void> {
  const pptxData = await Bun.file(pptxPath).arrayBuffer();
  const zip = await JSZip.loadAsync(pptxData);

  // Group fonts by typeface
  const byTypeface = new Map<string, FontToEmbed[]>();
  for (const f of fonts) {
    const list = byTypeface.get(f.typeface) || [];
    list.push(f);
    byTypeface.set(f.typeface, list);
  }

  // Track new relationships
  const newRels: { id: string; target: string }[] = [];
  const fontFiles: { path: string; data: Uint8Array }[] = [];
  let rIdCounter = 20; // Start high to avoid conflicts

  // Build embeddedFontLst XML
  let embeddedFontXml = "";

  for (const [typeface, variants] of byTypeface) {
    let fontEntries = "";
    for (const variant of variants) {
      const guid = generateGuid();
      const rId = `rId${rIdCounter++}`;
      const fileName = guid.replace(/[{}]/g, "") + ".fntdata";
      const fontPath = `ppt/fonts/${fileName}`;

      // Obfuscate font data per OOXML spec
      console.log(`  → Embedding ${typeface} ${variant.style} (${variant.data.length} bytes)`);
      const obfuscated = obfuscateFont(variant.data, guid);

      fontFiles.push({ path: fontPath, data: obfuscated });
      newRels.push({ id: rId, target: `fonts/${fileName}` });

      // Map style to XML element name
      const styleTag = variant.style === "regular" ? "p:regular"
        : variant.style === "bold" ? "p:bold"
        : variant.style === "italic" ? "p:italic"
        : "p:boldItalic";

      fontEntries += `<${styleTag} r:id="${rId}"/>`;
    }

    embeddedFontXml += `<p:embeddedFont><p:font typeface="${typeface}"/>${fontEntries}</p:embeddedFont>`;
  }

  // 1. Add font files to ZIP
  for (const { path, data } of fontFiles) {
    zip.file(path, data);
  }

  // 2. Update [Content_Types].xml — add fntdata extension
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  if (!contentTypes.includes('Extension="fntdata"')) {
    contentTypes = contentTypes.replace(
      "</Types>",
      '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>'
    );
    zip.file("[Content_Types].xml", contentTypes);
  }

  // 3. Update ppt/_rels/presentation.xml.rels — add font relationships
  let presRels = await zip.file("ppt/_rels/presentation.xml.rels")!.async("string");
  const newRelEntries = newRels.map(
    (r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${r.target}"/>`
  ).join("");
  presRels = presRels.replace("</Relationships>", newRelEntries + "</Relationships>");
  zip.file("ppt/_rels/presentation.xml.rels", presRels);

  // 4. Update ppt/presentation.xml — add embeddedFontLst after sldMasterIdLst
  let presXml = await zip.file("ppt/presentation.xml")!.async("string");
  const embeddedFontLstXml = `<p:embeddedFontLst>${embeddedFontXml}</p:embeddedFontLst>`;

  // Insert after </p:notesMasterIdLst> (before <p:sldSz>)
  presXml = presXml.replace(
    "</p:notesMasterIdLst>",
    `</p:notesMasterIdLst>${embeddedFontLstXml}`
  );
  zip.file("ppt/presentation.xml", presXml);

  // 5. Write back
  const output = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await Bun.write(pptxPath, output);
}

// --- Conversion helpers ---

const SLIDE_W_IN = 13.333;
const SLIDE_H_IN = 7.5;

function parseCssColor(colorStr: string): string | null {
  if (!colorStr) return null;

  // rgb(r, g, b) or rgba(r, g, b, a)
  const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    // Check alpha
    const alphaMatch = colorStr.match(/,\s*([\d.]+)\s*\)/);
    if (alphaMatch && parseFloat(alphaMatch[1]) < 0.01) return null;

    const r = parseInt(m[1]).toString(16).padStart(2, "0");
    const g = parseInt(m[2]).toString(16).padStart(2, "0");
    const b = parseInt(m[3]).toString(16).padStart(2, "0");
    return `${r}${g}${b}`.toUpperCase();
  }

  // #rrggbb
  const hex = colorStr.match(/#([0-9a-fA-F]{6})/);
  if (hex) return hex[1].toUpperCase();

  return null;
}

function parseCssAlpha(colorStr: string): number {
  if (!colorStr) return 1;
  const alphaMatch = colorStr.match(/rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)/);
  if (alphaMatch) return parseFloat(alphaMatch[1]);
  return 1;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 1920, height: 1080 });

  // 1. Generate PDF
  await page.pdf({
    path: pdfPath,
    width: "1920px",
    height: "1080px",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  console.log("✓ PDF generated");

  // 2. Extract full slide data from DOM
  const slideData: SlideData[] = await page.evaluate(() => {
    const slides = document.querySelectorAll(".slide");
    const result: any[] = [];

    // Helper: extract rotation degrees from CSS transform
    function getRotation(computed: CSSStyleDeclaration): number {
      const transform = computed.transform;
      if (!transform || transform === "none") return 0;
      // matrix(a, b, c, d, tx, ty) — rotation = atan2(b, a)
      const m = transform.match(/matrix\(([^)]+)\)/);
      if (m) {
        const vals = m[1].split(",").map((v) => parseFloat(v.trim()));
        const angle = Math.atan2(vals[1], vals[0]) * (180 / Math.PI);
        return Math.round(angle * 100) / 100;
      }
      return 0;
    }

    // Helper: extract pseudo-element as a rect if it has dimensions and background
    function extractPseudo(
      el: Element,
      pseudo: "::before" | "::after",
      slideRect: DOMRect
    ): any | null {
      const computed = getComputedStyle(el, pseudo);
      const content = computed.content;
      if (!content || content === "none" || content === "normal") return null;

      const bg = computed.backgroundColor;
      if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") return null;

      // Pseudo-elements don't have getBoundingClientRect, so compute from parent + CSS
      const parentRect = el.getBoundingClientRect();
      const parentComputed = getComputedStyle(el);
      const position = computed.position;

      let x: number, y: number, w: number, h: number;

      w = parseFloat(computed.width) || 0;
      h = parseFloat(computed.height) || 0;
      if (w < 1 || h < 1) return null;

      if (position === "absolute") {
        const top = parseFloat(computed.top);
        const left = parseFloat(computed.left);
        const right = parseFloat(computed.right);
        const bottom = parseFloat(computed.bottom);

        // Resolve x
        if (!isNaN(left)) {
          x = parentRect.left - slideRect.left + left;
        } else if (!isNaN(right)) {
          x = parentRect.right - slideRect.left - right - w;
        } else {
          x = parentRect.left - slideRect.left;
        }

        // Resolve y
        if (!isNaN(top)) {
          y = parentRect.top - slideRect.top + top;
        } else if (!isNaN(bottom)) {
          y = parentRect.bottom - slideRect.top - bottom - h;
        } else {
          y = parentRect.top - slideRect.top;
        }
      } else {
        x = parentRect.left - slideRect.left;
        y = parentRect.top - slideRect.top;
      }

      return { x, y, width: w, height: h, backgroundColor: bg };
    }

    slides.forEach((slide) => {
      const slideRect = slide.getBoundingClientRect();
      const slideComputed = getComputedStyle(slide);
      const data = {
        width: slideRect.width,
        height: slideRect.height,
        backgroundColor: slideComputed.backgroundColor,
        rects: [] as any[],
        texts: [] as any[],
      };

      // Extract background rectangles from all elements
      const allElements = slide.querySelectorAll("*");
      allElements.forEach((el) => {
        const computed = getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        const x = rect.left - slideRect.left;
        const y = rect.top - slideRect.top;
        const w = rect.width;
        const h = rect.height;

        if (w < 1 || h < 1) return;

        // Check for background color
        const bg = computed.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          data.rects.push({ x, y, width: w, height: h, backgroundColor: bg });
        }

        // Extract pseudo-elements
        const before = extractPseudo(el, "::before", slideRect);
        if (before) data.rects.push(before);
        const after = extractPseudo(el, "::after", slideRect);
        if (after) data.rects.push(after);
      });

      // Extract text with computed styles
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        const text = (textNode.textContent || "").trim();
        if (!text) continue;

        const el = textNode.parentElement;
        if (!el) continue;

        const range = document.createRange();
        range.selectNodeContents(textNode);
        const rangeRect = range.getBoundingClientRect();

        if (rangeRect.width < 1 || rangeRect.height < 1) continue;

        const computed = getComputedStyle(el);

        const fontFamily = computed.fontFamily
          .split(",")[0]
          .trim()
          .replace(/['"]/g, "");

        const letterSpacing = parseFloat(computed.letterSpacing) || 0;
        const rotation = getRotation(computed);

        // Get the parent element's bounding box for wrapping width
        const elRect = el.getBoundingClientRect();
        const parentWidth = elRect.width;
        const parentHeight = elRect.height;

        // Determine if text should wrap by checking if browser already wrapped it
        // (text range height > ~1.5x the font's line height means multiple lines)
        // But skip this check for rotated text (rotation makes bounding rect tall)
        const fontSize = parseFloat(computed.fontSize);
        const lineHeight = fontSize * 1.5;
        const rot = getRotation(computed);
        const isRotated = Math.abs(rot) > 0.5;
        const isMultiLine = !isRotated && rangeRect.height > lineHeight * 1.3;
        const shouldWrap = isMultiLine;

        data.texts.push({
          text,
          x: rangeRect.left - slideRect.left,
          y: rangeRect.top - slideRect.top,
          width: rangeRect.width,
          height: rangeRect.height,
          fontSize: parseFloat(computed.fontSize),
          fontFamily,
          fontWeight: computed.fontWeight,
          fontStyle: computed.fontStyle,
          color: computed.color,
          letterSpacing,
          textTransform: computed.textTransform,
          textAlign: computed.textAlign,
          rotation,
          parentWidth,
          parentHeight,
          wrap: shouldWrap,
        });
      }

      result.push(data);
    });

    return result;
  });

  console.log(`✓ Extracted ${slideData.length} slides from DOM`);

  // 3. Generate slide PNGs for preview
  const slides = await page.$$(".slide");
  for (let i = 0; i < slides.length; i++) {
    await slides[i].screenshot({
      path: resolve(outputDir, `slide-${i + 1}.png`),
    });
  }
  console.log(`✓ ${slides.length} slide PNGs generated`);

  await browser.close();

  // 4. Save slide data for debugging
  await Bun.write(slideDataPath, JSON.stringify(slideData, null, 2));
  console.log("✓ Slide data saved");

  // 5. Build PPTX with PptxGenJS
  const htmlW = slideData[0].width;
  const htmlH = slideData[0].height;
  const sx = SLIDE_W_IN / htmlW;
  const sy = SLIDE_H_IN / htmlH;

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "CUSTOM", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pptx.layout = "CUSTOM";

  for (let slideIdx = 0; slideIdx < slideData.length; slideIdx++) {
    const sd = slideData[slideIdx];

    // Slide background
    const bgColor = parseCssColor(sd.backgroundColor);
    const pptxSlide = pptx.addSlide();
    if (bgColor) {
      pptxSlide.background = { color: bgColor };
    }

    // Rectangles (backgrounds, shapes)
    for (const rect of sd.rects) {
      const color = parseCssColor(rect.backgroundColor);
      if (!color) continue;

      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const w = rect.width;
      const h = rect.height;
      if (w < 1 || h < 1) continue;

      const alpha = parseCssAlpha(rect.backgroundColor);
      const transparency = Math.round((1 - alpha) * 100);

      pptxSlide.addShape("rect", {
        x: x * sx,
        y: y * sy,
        w: w * sx,
        h: h * sy,
        fill: { color, transparency },
        line: { color: "FFFFFF", width: 0, type: "none" },
      });
    }

    // Text elements
    for (const t of sd.texts) {
      const text = t.text.trim();
      if (!text) continue;

      const x = Math.max(0, t.x);
      const y = Math.max(0, t.y);
      const w = t.width;
      const h = t.height;
      if (w < 1 || h < 1) continue;

      // CSS px to PowerPoint pt: at 96dpi, 1px = 0.75pt
      // 1920px at 96dpi = 20 inches. We map to 13.333". Scale = 13.333/20 = 0.6667
      const scale = SLIDE_W_IN / (htmlW / 96);
      const fontSizePt = t.fontSize * 0.75 * scale;
      const clampedFontSize = Math.max(4, Math.min(400, fontSizePt));

      // Apply text transform
      let displayText = text;
      if (t.textTransform === "uppercase") displayText = text.toUpperCase();
      else if (t.textTransform === "lowercase") displayText = text.toLowerCase();
      else if (t.textTransform === "capitalize") {
        displayText = text.replace(/\b\w/g, (c) => c.toUpperCase());
      }

      const color = parseCssColor(t.color);
      const isBold =
        parseInt(t.fontWeight) >= 600 ||
        t.fontWeight === "bold" ||
        t.fontWeight === "bolder";

      // Letter spacing: CSS px → pt, then scale
      const charSpacing =
        Math.abs(t.letterSpacing) > 0.1
          ? t.letterSpacing * 0.75 * (sx + sy) / 2
          : undefined;

      // Map CSS textAlign to PptxGenJS align
      let align: "left" | "right" | "center" | "justify" | undefined;
      if (t.textAlign === "right") align = "right";
      else if (t.textAlign === "center") align = "center";
      else if (t.textAlign === "justify") align = "justify";

      // Determine wrapping and dimensions
      const shouldWrap = t.wrap;
      let wIn: number, hIn: number;

      if (shouldWrap) {
        // Use parent element's width for wrapping, constrained to slide
        wIn = Math.min(t.parentWidth, htmlW - x) * sx;
        hIn = Math.max(t.parentHeight * sy, h * sy);
      } else {
        // Non-wrapping: use text width with extra padding
        wIn = w * 1.1 * sx;
        const minH = (clampedFontSize / 72) * 1.4;
        hIn = Math.max(h * sy, minH);
      }

      // Handle text color alpha (for faint/ghost text like "ROI" background)
      const textAlpha = parseCssAlpha(t.color);
      const textTransparency = textAlpha < 0.99 ? Math.round((1 - textAlpha) * 100) : undefined;

      // Handle rotation
      let finalX = x * sx;
      let finalY = y * sy;
      let finalW = wIn;
      let finalH = hIn;
      let rotate: number | undefined;

      if (Math.abs(t.rotation) > 0.5) {
        // CSS rotation angle maps directly to PptxGenJS clockwise degrees
        // CSS rotate(-90deg) → atan2 gives -90 → normalize to 270° clockwise
        rotate = ((t.rotation % 360) + 360) % 360;
        // The bounding rect from the browser is post-rotation.
        // For -90° rotation: browser rect width ≈ line height, height ≈ text length
        // Pre-rotation: wide text box, single line height
        finalW = h * sx;  // text's original horizontal extent
        finalH = 0.5;     // generous line height to prevent wrapping
        // Reposition so center matches the browser bounding rect center
        const cx = x + w / 2;
        const cy = y + h / 2;
        finalX = cx * sx - finalW / 2;
        finalY = cy * sy - finalH / 2;
      }

      pptxSlide.addText(
        [
          {
            text: displayText,
            options: {
              fontSize: clampedFontSize,
              fontFace: t.fontFamily || undefined,
              color: color || "000000",
              bold: isBold || undefined,
              italic: t.fontStyle === "italic" || undefined,
              charSpacing: charSpacing,
              transparency: textTransparency,
            },
          },
        ],
        {
          x: finalX,
          y: finalY,
          w: finalW,
          h: finalH,
          margin: 0,
          wrap: rotate ? false : shouldWrap,
          valign: "top",
          align: align,
          rotate: rotate,
          paraSpaceBefore: 0,
          paraSpaceAfter: 0,
        }
      );
    }

    console.log(`✓ slide ${slideIdx + 1}`);
  }

  // Write PPTX file
  await pptx.writeFile({ fileName: pptxPath });
  console.log("✓ PPTX generated");

  // 6. Embed fonts into PPTX
  console.log("Embedding fonts...");

  // Google Fonts GitHub raw TTF URLs
  const FONT_URLS = {
    // DM Sans is a variable font — single file covers all weights
    dmSansRegular: "https://github.com/google/fonts/raw/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf",
    dmSerifRegular: "https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf",
    dmSerifItalic: "https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/DMSerifDisplay-Italic.ttf",
  };

  const [dmSansData, dmSerifRegData, dmSerifItalicData] = await Promise.all([
    downloadTTF(FONT_URLS.dmSansRegular),
    downloadTTF(FONT_URLS.dmSerifRegular),
    downloadTTF(FONT_URLS.dmSerifItalic),
  ]);
  console.log(`  ↓ DM Sans (${dmSansData.length} bytes), DM Serif Regular (${dmSerifRegData.length} bytes), Italic (${dmSerifItalicData.length} bytes)`);

  const fontsToEmbed: FontToEmbed[] = [
    { typeface: "DM Sans", style: "regular", data: dmSansData },
    { typeface: "DM Serif Display", style: "regular", data: dmSerifRegData },
    { typeface: "DM Serif Display", style: "italic", data: dmSerifItalicData },
  ];

  await embedFontsInPptx(pptxPath, fontsToEmbed);
  console.log(`✓ ${fontsToEmbed.length} font variants embedded`);

  // 7. Render PPTX → PNGs for visual comparison
  const renderDir = resolve(outputDir, "pptx-render");
  await $`mkdir -p ${renderDir}`;
  await $`soffice --headless --convert-to pdf --outdir ${renderDir} ${pptxPath}`.quiet();
  await $`gs -dNOPAUSE -dBATCH -sDEVICE=png16m -r150 -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -sOutputFile=${renderDir}/slide-%d.png ${renderDir}/presentation.pdf`.quiet();
  console.log("✓ PPTX rendered to PNGs");

  console.log(`\n✓ Done!\n  PDF:  ${pdfPath}\n  PPTX: ${pptxPath}\n  Render: ${renderDir}/`);
}

main().catch(console.error);
