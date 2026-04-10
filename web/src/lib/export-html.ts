import { toPng } from "html-to-image";
import { injectVizDesignSystem } from "./viz-design-system";

export async function exportAsPng(html: string, filename: string) {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-9999px";
  iframe.style.width = "1920px";
  iframe.style.height = "1080px";
  iframe.style.border = "none";
  iframe.srcdoc = injectVizDesignSystem(html, { isDark: false });
  document.body.appendChild(iframe);

  await new Promise((resolve) => (iframe.onload = resolve));
  // Give scripts time to render (charts, D3, etc.)
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    const body = iframe.contentDocument?.body;
    if (!body) throw new Error("Could not access iframe content");

    const dataUrl = await toPng(body, {
      width: 1920,
      height: 1080,
      backgroundColor: "#ffffff",
      pixelRatio: 2,
    });

    const link = document.createElement("a");
    link.download = filename.replace(/\.\w+$/, ".png");
    link.href = dataUrl;
    link.click();
  } finally {
    document.body.removeChild(iframe);
  }
}

export function exportAsPdf(html: string, filename: string) {
  const withDesignSystem = injectVizDesignSystem(html, { isDark: false });
  const styledHtml = withDesignSystem.replace(
    /<\/head>/i,
    `<style>
      @media print {
        @page { size: landscape; margin: 0.5cm; }
        body { margin: 0; }
      }
    </style></head>`,
  );

  const blob = new Blob([styledHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");

  if (win) {
    win.addEventListener("load", () => {
      setTimeout(() => {
        win.print();
        URL.revokeObjectURL(url);
      }, 800);
    });
  }
}
