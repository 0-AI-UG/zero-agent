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
import { generateDownloadUrl, generateUploadUrl, writeToS3, readBinaryFromS3 } from "@/lib/s3.ts";
import { generateId } from "@/db/index.ts";
import { searchFileContent } from "@/db/queries/search.ts";
import { events } from "@/lib/scheduling/events.ts";
import { embedAndStore, semanticSearch } from "@/lib/search/vectors.ts";
import { sha256Hex } from "@/lib/execution/workspace-sync.ts";
import { importUploadedFile } from "@/lib/uploads/import-event.ts";
import { updateFileHash } from "@/db/queries/files.ts";
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
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    const url = generateDownloadUrl(file.s3_key, file.filename);
    const thumbnailUrl = file.thumbnail_s3_key
      ? generateDownloadUrl(file.thumbnail_s3_key, `thumb_${file.filename}`)
      : undefined;
    return Response.json({ url, thumbnailUrl, file: formatFile(file) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUploadRequest(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const projectId = (getParams<{ projectId: string }>(request)).projectId;
    verifyProjectAccess(projectId, userId);

    const body = await validateBody(request, uploadRequestSchema);

    // Build S3 key: projects/{projectId}{folderPath}{uuid}_{filename}
    const uuid = generateId().slice(0, 8);
    const s3Key = `projects/${projectId}${body.folderPath}${uuid}_${body.filename}`;

    // Pre-create file metadata record
    const fileRow = insertFile(
      projectId,
      s3Key,
      body.filename,
      body.mimeType,
      body.sizeBytes,
      body.folderPath,
    );

    // Index filename for FTS search (content not available yet for presigned uploads)
    indexFileContent(fileRow.id, projectId, body.filename, "");

    // Generate presigned upload URL
    const url = generateUploadUrl(s3Key, body.mimeType);

    events.emit("file.created", { projectId, path: body.folderPath, filename: body.filename, mimeType: body.mimeType, sizeBytes: body.sizeBytes });

    return Response.json(
      {
        url,
        s3Key,
        file: formatFile(fileRow),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetUploadUrl(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, id } = getParams<{ projectId: string; id: string }>(request);
    verifyProjectAccess(projectId, userId);

    const file = getFileById(id);
    if (!file || file.project_id !== projectId) {
      throw new NotFoundError("File not found");
    }

    const url = generateUploadUrl(file.s3_key, file.mime_type);
    return Response.json({ url }, { headers: corsHeaders });
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

    const body = await request.json() as { textContent?: string; sizeBytes?: number };

    // Update file size if provided
    if (typeof body.sizeBytes === "number") {
      updateFileSize(id, body.sizeBytes);
    }

    // Index text content for FTS if provided (extracted by client from XLSX sheets)
    if (typeof body.textContent === "string") {
      indexFileContent(id, projectId, file.filename, body.textContent);
      embedAndStore(projectId, "file", id, body.textContent, { filename: file.filename }).catch(() => {});
    }

    events.emit("file.updated", { projectId, path: file.folder_path, filename: file.filename, mimeType: file.mime_type });

    // Compute hash from the freshly-uploaded blob and import into container.
    try {
      const buf = await readBinaryFromS3(file.s3_key);
      const hash = sha256Hex(buf);
      updateFileHash(id, hash);
      const workspacePath = `${file.folder_path}${file.filename}`.replace(/^\/+/, "");
      await importUploadedFile({ projectId, s3Key: file.s3_key, path: workspacePath, expectedHash: hash });
    } catch (err) {
      routeLog.warn("importUploadedFile failed (binary update)", { projectId, fileId: id, error: err instanceof Error ? err.message : String(err) });
    }

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
    await writeToS3(file.s3_key, buffer);
    const updated = updateFileSize(id, buffer.length);
    const hash = sha256Hex(buffer);
    updateFileHash(id, hash);
    const workspacePath = `${file.folder_path}${file.filename}`.replace(/^\/+/, "");
    await importUploadedFile({ projectId, s3Key: file.s3_key, path: workspacePath, expectedHash: hash });
    indexFileContent(id, projectId, file.filename, body.content);
    embedAndStore(projectId, "file", id, body.content, { filename: file.filename }).catch(() => {});
    events.emit("file.updated", { projectId, path: file.folder_path, filename: file.filename, mimeType: file.mime_type });

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

