import type { BunRequest } from "bun";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { handleError, verifyProjectAccess } from "@/routes/utils.ts";
import { NotFoundError } from "@/lib/errors.ts";
import { getFileById, insertFile } from "@/db/queries/files.ts";
import { readFromS3, writeToS3, generateDownloadUrl, listS3Files, presignHandler } from "@/lib/s3.ts";
import { log } from "@/lib/logger.ts";

const slideLog = log.child({ module: "slides" });

export async function handleConvertSlides(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as { fileId: string };
    if (!body.fileId) {
      return Response.json({ error: "fileId is required" }, { status: 400, headers: corsHeaders });
    }

    const file = getFileById(body.fileId);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    if (!file.filename.endsWith(".slides")) {
      return Response.json({ error: "File must be a .slides file" }, { status: 400, headers: corsHeaders });
    }

    slideLog.info("converting slides to pptx", { projectId, fileId: body.fileId, filename: file.filename });

    const htmlContent = await readFromS3(file.s3_key);
    const { convertHtmlBuffers } = await import("@0-ai/slide-gen");

    const result = await convertHtmlBuffers({
      html: htmlContent,
      noPdf: true,
      noPng: true,
      noPptx: false,
      onProgress: (msg: string) => slideLog.debug(msg),
    });

    if (!result.pptxBuffer) {
      return Response.json({ error: "PPTX generation failed" }, { status: 500, headers: corsHeaders });
    }

    const pptxFilename = file.filename.replace(/\.slides$/, ".pptx");
    const pptxS3Key = file.s3_key.replace(/\.slides$/, ".pptx");

    await writeToS3(pptxS3Key, result.pptxBuffer);

    const pptxFileRow = insertFile(
      projectId,
      pptxS3Key,
      pptxFilename,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      result.pptxBuffer.byteLength,
      file.folder_path,
    );

    const pptxUrl = generateDownloadUrl(pptxS3Key, pptxFilename);

    slideLog.info("slides conversion complete", { projectId, pptxFileId: pptxFileRow.id });

    return Response.json(
      { pptxFileId: pptxFileRow.id, pptxUrl, pptxFilename },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleConvertSlidesPdf(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as { fileId: string };
    if (!body.fileId) {
      return Response.json({ error: "fileId is required" }, { status: 400, headers: corsHeaders });
    }

    const file = getFileById(body.fileId);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    if (!file.filename.endsWith(".slides")) {
      return Response.json({ error: "File must be a .slides file" }, { status: 400, headers: corsHeaders });
    }

    slideLog.info("converting slides to pdf", { projectId, fileId: body.fileId, filename: file.filename });

    const htmlContent = await readFromS3(file.s3_key);
    const { convertHtmlBuffers } = await import("@0-ai/slide-gen");

    const result = await convertHtmlBuffers({
      html: htmlContent,
      noPdf: false,
      noPng: true,
      noPptx: true,
      onProgress: (msg: string) => slideLog.debug(msg),
    });

    if (!result.pdfBuffer) {
      return Response.json({ error: "PDF generation failed" }, { status: 500, headers: corsHeaders });
    }

    const pdfFilename = file.filename.replace(/\.slides$/, ".pdf");
    const pdfS3Key = file.s3_key.replace(/\.slides$/, ".pdf");

    await writeToS3(pdfS3Key, result.pdfBuffer);

    const pdfFileRow = insertFile(
      projectId,
      pdfS3Key,
      pdfFilename,
      "application/pdf",
      result.pdfBuffer.byteLength,
      file.folder_path,
    );

    const pdfUrl = generateDownloadUrl(pdfS3Key, pdfFilename);

    slideLog.info("slides pdf conversion complete", { projectId, pdfFileId: pdfFileRow.id });

    return Response.json(
      { pdfFileId: pdfFileRow.id, pdfUrl, pdfFilename },
      { headers: corsHeaders },
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function handleSlidePreviews(request: BunRequest): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (request.params as { projectId: string }).projectId;
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as { fileId: string };
    if (!body.fileId) {
      return Response.json({ error: "fileId is required" }, { status: 400, headers: corsHeaders });
    }

    const file = getFileById(body.fileId);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    if (!file.filename.endsWith(".slides")) {
      return Response.json({ error: "File must be a .slides file" }, { status: 400, headers: corsHeaders });
    }

    const htmlContent = await readFromS3(file.s3_key);
    const contentHash = Bun.hash(htmlContent).toString(16);
    const s3Base = file.s3_key.replace(/\.slides$/, "");
    const previewPrefix = `${s3Base}_previews/${contentHash}/`;

    const cachedKeys = await listS3Files(previewPrefix);
    if (cachedKeys.length > 0) {
      const sortedKeys = cachedKeys.sort();
      const urls = sortedKeys.map((key) => presignHandler.presign(key, { expiresIn: 900 }));
      slideLog.info("serving cached slide previews", { projectId, fileId: body.fileId, slideCount: urls.length });
      return Response.json({ urls, slideCount: urls.length }, { headers: corsHeaders });
    }

    slideLog.info("generating slide previews", { projectId, fileId: body.fileId });

    const { convertHtmlBuffers } = await import("@0-ai/slide-gen");

    const result = await convertHtmlBuffers({
      html: htmlContent,
      noPdf: true,
      noPptx: true,
      noPng: false,
      onProgress: (msg: string) => slideLog.debug(msg),
    });

    if (result.pngBuffers.length === 0) {
      return Response.json({ urls: [], slideCount: 0 }, { headers: corsHeaders });
    }

    const urls: string[] = [];
    for (const [i, pngBuffer] of result.pngBuffers.entries()) {
      const s3Key = `${previewPrefix}slide-${i + 1}.png`;
      await writeToS3(s3Key, pngBuffer);
      urls.push(presignHandler.presign(s3Key, { expiresIn: 900 }));
    }

    slideLog.info("slide previews generated", { projectId, fileId: body.fileId, slideCount: urls.length });
    return Response.json({ urls, slideCount: urls.length }, { headers: corsHeaders });
  } catch (err) {
    return handleError(err);
  }
}
