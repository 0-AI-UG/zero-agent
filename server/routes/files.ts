import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { getParams } from "@/lib/request.ts";
import { validateBody, uploadRequestSchema, folderPathSchema, createFolderSchema, moveFileSchema, moveFolderSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { ValidationError, NotFoundError } from "@/lib/errors.ts";
import {
  insertFile,
  getFilesByFolder,
  getFileById,
  getFilesByFolderPath,
  deleteFilesByFolderPath,
  deleteFile as deleteFileRecord,
  updateFileFolderPath,
  updateFileSize,
} from "@/db/queries/files.ts";
import { indexFileContent, removeFileIndex } from "@/db/queries/search.ts";
import {
  createFolder,
  getFoldersByParent,
  getFolderByPath,
  getFolderById,
  deleteFoldersByPathPrefix,
  updateFolderPath,
  updateFolderChildPaths,
} from "@/db/queries/folders.ts";
import { generateDownloadUrl, generateUploadUrl, deleteFromS3, writeToS3, readBinaryFromS3 } from "@/lib/s3.ts";
import { generateId } from "@/db/index.ts";
import { searchFileContent } from "@/db/queries/search.ts";
import { events } from "@/lib/events.ts";
import { embedAndStore, deleteVectorsBySource, semanticSearch } from "@/lib/vectors.ts";
import { reconcileToContainer, sha256Hex } from "@/lib/execution/workspace-sync.ts";
import { updateFileHash } from "@/db/queries/files.ts";
import { log } from "@/lib/logger.ts";

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

    // Compute hash from the freshly-uploaded blob and reconcile container.
    try {
      const buf = await readBinaryFromS3(file.s3_key);
      updateFileHash(id, sha256Hex(buf));
    } catch {
      // Best-effort
    }
    await reconcileToContainer(projectId);

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

    // Delete from S3
    await deleteFromS3(file.s3_key);
    if (file.thumbnail_s3_key) {
      await deleteFromS3(file.thumbnail_s3_key).catch(() => {});
    }

    // Delete metadata, FTS index, and vector embeddings
    removeFileIndex(id);
    deleteVectorsBySource(projectId, "file", id);
    deleteFileRecord(id);
    await reconcileToContainer(projectId);
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
    updateFileHash(id, sha256Hex(buffer));
    await reconcileToContainer(projectId);
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

    const oldPath = file.folder_path;
    const updated = updateFileFolderPath(id, body.destinationPath);

    await reconcileToContainer(projectId);

    events.emit("file.moved", { projectId, fromPath: oldPath, toPath: body.destinationPath, filename: file.filename });
    return Response.json({ file: formatFile(updated) }, { headers: corsHeaders });
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

    // Update the folder itself
    const updated = updateFolderPath(id, newPath, folder.name);

    // Update all child folders and files
    updateFolderChildPaths(projectId, oldPath, newPath);

    await reconcileToContainer(projectId);

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

    // Delete all files under this folder path from S3 (including thumbnails)
    const files = getFilesByFolderPath(projectId, folder.path);
    await Promise.all(
      files.flatMap((f) => {
        const ops = [deleteFromS3(f.s3_key)];
        if (f.thumbnail_s3_key) {
          ops.push(deleteFromS3(f.thumbnail_s3_key).catch(() => {}));
        }
        return ops;
      })
    );

    // Delete file records from DB
    deleteFilesByFolderPath(projectId, folder.path);

    // Delete this folder and all child folders
    deleteFoldersByPathPrefix(projectId, folder.path);

    await reconcileToContainer(projectId);
    events.emit("folder.deleted", { projectId, path: folder.path });

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

