import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest } from "@/lib/auth/auth.ts";
import { getParams } from "@/lib/http/request.ts";
import { validateBody, uploadRequestSchema, folderPathSchema, createFolderSchema, moveFileSchema, moveFolderSchema } from "@/lib/auth/validation.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { ValidationError, NotFoundError } from "@/lib/utils/errors.ts";
import {
  insertFile,
  getFilesByFolder,
  getFileById,
  updateFileSize,
  updateFileHash,
} from "@/db/queries/files.ts";
import { getLocalBackend } from "@/lib/execution/lifecycle.ts";
import { indexFileContent } from "@/db/queries/search.ts";
import {
  createFolder,
  getFoldersByParent,
  getFolderByPath,
  getFolderById,
  deleteFoldersByPathPrefix,
  updateFolderPath,
  updateFolderChildPaths,
} from "@/db/queries/folders.ts";
import { generateId } from "@/db/index.ts";
import { searchFileContent } from "@/db/queries/search.ts";
import { events } from "@/lib/scheduling/events.ts";
import { embedAndStore, semanticSearch } from "@/lib/search/vectors.ts";
import { sha256Hex } from "@/lib/execution/manifest-cache.ts";
import { importUploadedFile } from "@/lib/uploads/import-event.ts";
import { log } from "@/lib/utils/logger.ts";

const routeLog = log.child({ module: "routes:files" });

function formatFile(row: import("@/db/types.ts").FileRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    folderPath: row.folder_path,
    createdAt: toUTC(row.created_at),
  };
}

function formatFolder(row: import("@/db/types.ts").FolderRow) {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: toUTC(row.created_at),
  };
}

export async function handleListFiles(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const url = new URL(request.url);
    const folderPath = url.searchParams.get("folderPath") ?? undefined;

    if (folderPath) {
      const result = folderPathSchema.safeParse(folderPath);
      if (!result.success) {
        throw new ValidationError("Invalid folder path");
      }
    }

    const files = getFilesByFolder(projectId, folderPath).filter(
      (f) => f.filename !== ".gitignore",
    );
    const currentPath = folderPath ?? "/";
    const folders = getFoldersByParent(projectId, currentPath);

    return Response.json(
      {
        files: files.map(formatFile),
        folders: folders.map(formatFolder),
        currentPath,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetFileUrl(request: Request): Promise<Response> {
  try {
    // Support token via Authorization header OR ?token= query param (for <img src> / direct links).
    const reqUrl = new URL(request.url);
    const tokenParam = reqUrl.searchParams.get("token");
    const inline = reqUrl.searchParams.get("inline") === "1";

    let userId: string;
    if (tokenParam) {
      const { verifyToken } = await import("@/lib/auth/auth.ts");
      const payload = await verifyToken(tokenParam);
      userId = payload.userId;
    } else {
      const auth = await authenticateRequest(request);
      userId = auth.userId;
    }

    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    if (!inline && !tokenParam) {
      // Return a JSON response with a direct download URL that embeds the user's token.
      // The token is the same JWT the user already holds — this is safe because it's
      // scoped to the same session and only valid for 7 days (same as the session token).
      // The caller (usePresignedUrl) embeds this URL in <img src> or uses it for downloads.
      const authHeader = request.headers.get("Authorization") ?? "";
      const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const downloadUrl = sessionToken
        ? `/api/projects/${projectId}/files/${id}/url?token=${encodeURIComponent(sessionToken)}&inline=1`
        : `/api/projects/${projectId}/files/${id}/url?inline=1`;

      return Response.json(
        { url: downloadUrl, file: formatFile(file) },
        { headers: corsHeaders },
      );
    }

    // Stream the file content
    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }

    const trimmedFolder = file.folder_path.replace(/^\/+/, "").replace(/\/+$/, "");
    const workspacePath = trimmedFolder ? `${trimmedFolder}/${file.filename}` : file.filename;

    const result = await backend.readFileStream(projectId, workspacePath);
    if (!result) {
      throw new NotFoundError("File not found in container");
    }

    const headers: Record<string, string> = {
      "Content-Type": file.mime_type,
      "Cache-Control": "private, max-age=300",
    };
    if (result.size > 0) {
      headers["Content-Length"] = String(result.size);
    }

    return new Response(result.stream, { headers });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUploadRequest(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    // Accept metadata as query params or JSON header block; actual body is the file bytes.
    // The client sends: POST /files/upload?filename=...&mimeType=...&folderPath=...
    // Body: raw file bytes.
    const url = new URL(request.url);
    const filename = url.searchParams.get("filename") ?? "";
    const mimeType = url.searchParams.get("mimeType") ?? "application/octet-stream";
    const folderPath = url.searchParams.get("folderPath") ?? "/";

    if (!filename) {
      throw new ValidationError("filename query parameter is required");
    }

    // Validate with the same schema
    const parsed = uploadRequestSchema.safeParse({
      filename,
      mimeType,
      folderPath,
      sizeBytes: parseInt(request.headers.get("Content-Length") ?? "0", 10),
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid upload params");
    }

    const arrayBuf = await request.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }

    const trimmedFolder = folderPath.replace(/^\/+/, "").replace(/\/+$/, "");
    const workspacePath = trimmedFolder ? `${trimmedFolder}/${filename}` : filename;

    // Write to container
    await backend.writeFile(projectId, workspacePath, buffer);

    // Insert/upsert files row
    const hash = sha256Hex(buffer);
    const fileRow = insertFile(projectId, filename, mimeType, buffer.byteLength, folderPath, hash);
    indexFileContent(fileRow.id, projectId, filename, "");

    events.emit("file.created", { projectId, path: folderPath, filename, mimeType, sizeBytes: buffer.byteLength });

    return Response.json({ file: formatFile(fileRow) }, { status: 201, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateFileBinary(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    // Accept either:
    //   a) raw binary body (Content-Type: application/octet-stream or mime type) — new path
    //   b) JSON body with { textContent?, sizeBytes? } — legacy metadata-only path
    const contentType = request.headers.get("Content-Type") ?? "";
    const isJson = contentType.includes("application/json");

    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }

    if (!isJson) {
      // Binary body — write to container
      const arrayBuf = await request.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      const trimmedFolder = file.folder_path.replace(/^\/+/, "").replace(/\/+$/, "");
      const workspacePath = trimmedFolder ? `${trimmedFolder}/${file.filename}` : file.filename;

      await backend.writeFile(projectId, workspacePath, buffer);

      const hash = sha256Hex(buffer);
      updateFileSize(id, buffer.byteLength);
      updateFileHash(id, hash);

      events.emit("file.updated", { projectId, path: file.folder_path, filename: file.filename, mimeType: file.mime_type });
      return Response.json({ success: true }, { headers: corsHeaders });
    }

    // JSON metadata-only path (used by xlsx-preview for textContent + sizeBytes)
    const body = await request.json() as { textContent?: string; sizeBytes?: number };

    if (typeof body.sizeBytes === "number") {
      updateFileSize(id, body.sizeBytes);
    }

    if (typeof body.textContent === "string") {
      indexFileContent(id, projectId, file.filename, body.textContent);
      embedAndStore(projectId, "file", id, body.textContent, { filename: file.filename }).catch(() => {});
    }

    events.emit("file.updated", { projectId, path: file.folder_path, filename: file.filename, mimeType: file.mime_type });
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteFile(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    // Convert folder_path ("/" or "/foo/") + filename to workspace-relative path.
    const trimmedFolder = file.folder_path.replace(/^\/+/, "").replace(/\/+$/, "");
    const workspacePath = trimmedFolder ? `${trimmedFolder}/${file.filename}` : file.filename;

    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }
    await backend.deletePath!(projectId, workspacePath);

    // DB row, S3 object, FTS index, and vectors are cleaned up by the
    // mirror-receiver once the watcher emits a delete event.
    events.emit("file.deleted", { projectId, path: file.folder_path, filename: file.filename });

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateFolder(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, createFolderSchema);

    // Check if folder already exists
    const existing = getFolderByPath(projectId, body.path);
    if (existing) {
      throw new ValidationError("Folder already exists");
    }

    const folder = createFolder(projectId, body.path, body.name);
    events.emit("folder.created", { projectId, path: body.path });
    return Response.json(
      { folder: formatFolder(folder) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleSearchFiles(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
    if (!query) {
      throw new ValidationError("Search query parameter 'q' is required");
    }

    // Use hybrid search (dense + sparse via RRF fusion) with FTS fallback
    const vectorResults = await semanticSearch(projectId, "file", query, 10);

    if (vectorResults.length > 0) {
      return Response.json({
        results: vectorResults.map((r) => ({
          fileId: r.metadata.sourceId as string,
          filename: r.metadata.filename as string,
          snippet: r.content.slice(0, 300),
          score: r.score,
        })),
      }, { headers: corsHeaders });
    }

    // Fallback to FTS when no embeddings exist
    const results = searchFileContent(projectId, query);
    return Response.json({ results }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}


export async function handleUpdateFileContent(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const body = await request.json() as { content?: string };
    if (typeof body.content !== "string") {
      throw new ValidationError("content is required and must be a string");
    }

    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    // Only allow text-based files
    const isTextFile = file.mime_type.startsWith("text/") ||
      file.mime_type === "application/json" ||
      file.filename.endsWith(".md") ||
      file.filename.endsWith(".txt");
    if (!isTextFile) {
      throw new ValidationError("Only text-based files can be edited");
    }

    const buffer = Buffer.from(body.content, "utf-8");
    const updated = updateFileSize(id, buffer.length);
    const hash = sha256Hex(buffer);
    updateFileHash(id, hash);
    const workspacePath = `${file.folder_path}${file.filename}`.replace(/^\/+/, "");
    await importUploadedFile({ projectId, path: workspacePath, buffer });
    // Indexing, embedding, and file.updated emission happen via the watcher →
    // mirror-receiver once the imported file lands in /workspace.

    return Response.json({ success: true, file: formatFile(updated) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMoveFile(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, moveFileSchema);
    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    // Ensure destination folder exists (unless root)
    if (body.destinationPath !== "/") {
      const destFolder = getFolderByPath(projectId, body.destinationPath);
      if (!destFolder) {
        throw new ValidationError("Destination folder does not exist");
      }
    }

    const oldFolderPath = file.folder_path;
    // Convert folder_path ("/" or "/foo/") + filename to workspace-relative path.
    const toRel = (folderPath: string, filename: string) => {
      const trimmed = folderPath.replace(/^\/+/, "").replace(/\/+$/, "");
      return trimmed ? `${trimmed}/${filename}` : filename;
    };
    const oldPath = toRel(oldFolderPath, file.filename);
    const newPath = toRel(body.destinationPath, file.filename);

    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }
    await backend.movePath!(projectId, oldPath, newPath);

    events.emit("file.moved", { projectId, fromPath: oldFolderPath, toPath: body.destinationPath, filename: file.filename });
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMoveFolder(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, moveFolderSchema);
    const folder = getFolderById(id);
    if (!folder || folder.project_id !== projectId) {
      throw new NotFoundError("Folder not found");
    }

    // Prevent moving folder into itself
    if (body.destinationPath.startsWith(folder.path)) {
      throw new ValidationError("Cannot move a folder into itself");
    }

    // Ensure destination folder exists (unless root)
    if (body.destinationPath !== "/") {
      const destFolder = getFolderByPath(projectId, body.destinationPath);
      if (!destFolder) {
        throw new ValidationError("Destination folder does not exist");
      }
    }

    const oldPath = folder.path;
    const newPath = `${body.destinationPath}${folder.name}/`;

    // Check if target path already exists
    const existing = getFolderByPath(projectId, newPath);
    if (existing) {
      throw new ValidationError("A folder with this name already exists at the destination");
    }

    // Convert folder paths ("/foo/") to workspace-relative ("foo").
    const toRelFolder = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "");
    const oldRel = toRelFolder(oldPath);
    const newRel = toRelFolder(newPath);

    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }
    await backend.movePath!(projectId, oldRel, newRel);

    // Keep the folders table consistent. mirror-receiver handles files, but
    // does not create/update folder rows, so we update those here. The call
    // to updateFolderChildPaths also touches file rows under the old prefix;
    // that is harmless because the watcher's delete+upsert will converge to
    // the same final state.
    const updated = updateFolderPath(id, newPath, folder.name);
    updateFolderChildPaths(projectId, oldPath, newPath);

    return Response.json({ folder: formatFolder(updated) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteFolder(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const folder = getFolderById(id);
    if (!folder || folder.project_id !== projectId) {
      throw new NotFoundError("Folder not found");
    }

    // Convert folder.path ("/foo/bar/") to workspace-relative path ("foo/bar").
    const workspacePath = folder.path.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!workspacePath) {
      throw new ValidationError("Cannot delete root folder");
    }

    const backend = getLocalBackend();
    if (!backend) {
      throw new Error("Execution backend unavailable");
    }
    // `rm -rf` cascades to all children in the container; the watcher will
    // emit per-file delete events and the mirror-receiver handles DB+S3+vector
    // cleanup for files. The mirror-receiver does NOT touch the `folders`
    // table, so we still delete folder rows (including child folders) here.
    await backend.deletePath!(projectId, workspacePath);
    deleteFoldersByPathPrefix(projectId, folder.path);

    events.emit("folder.deleted", { projectId, path: folder.path });

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

