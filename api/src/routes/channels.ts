import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest } from "@/lib/auth.ts";
import { validateBody, createChannelSchema, updateChannelSchema } from "@/lib/validation.ts";
import { handleError, verifyProjectAccess, toUTC } from "@/routes/utils.ts";
import { NotFoundError } from "@/lib/errors.ts";
import {
  insertChannel,
  getChannelsByProject,
  getChannelById,
  updateChannel,
  deleteChannel,
} from "@/db/queries/channels.ts";
import { channelManager } from "@/lib/channels/manager.ts";
import { log } from "@/lib/logger.ts";
import type { ChannelRow } from "@/db/types.ts";
import type { ChannelPlatform } from "@/lib/channels/types.ts";

const channelLog = log.child({ module: "routes:channels" });

function formatChannel(row: ChannelRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    platform: row.platform,
    name: row.name,
    allowedSenders: JSON.parse(row.allowed_senders || "[]"),
    enabled: row.enabled === 1,
    lastMessageAt: row.last_message_at ? toUTC(row.last_message_at) : null,
    createdAt: toUTC(row.created_at),
    updatedAt: toUTC(row.updated_at),
    // Never expose credentials in list responses
  };
}

export async function handleListChannels(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);
    const rows = getChannelsByProject(projectId);
    return Response.json(
      { channels: rows.map(formatChannel) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateChannel(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId } = (request as Request & { params: { projectId: string } }).params;
    verifyProjectAccess(projectId, userId);
    const data = await validateBody(request, createChannelSchema);

    const row = insertChannel(projectId, {
      platform: data.platform,
      name: data.name,
      credentials: JSON.stringify(data.credentials),
      allowedSenders: JSON.stringify(data.allowedSenders),
    });

    channelLog.info("channel created", { userId, projectId, platform: data.platform });

    return Response.json(
      { channel: formatChannel(row) },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateChannel(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, channelId } = (request as Request & { params: { projectId: string; channelId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const channel = getChannelById(channelId);
    if (!channel || channel.project_id !== projectId) throw new NotFoundError("Channel not found");

    const data = await validateBody(request, updateChannelSchema);

    const updated = updateChannel(channelId, {
      name: data.name,
      credentials: data.credentials ? JSON.stringify(data.credentials) : undefined,
      allowedSenders: data.allowedSenders ? JSON.stringify(data.allowedSenders) : undefined,
      enabled: data.enabled,
    });

    channelLog.info("channel updated", { userId, projectId, channelId });

    return Response.json(
      { channel: formatChannel(updated) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteChannel(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, channelId } = (request as Request & { params: { projectId: string; channelId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const channel = getChannelById(channelId);
    if (!channel || channel.project_id !== projectId) throw new NotFoundError("Channel not found");

    // Stop adapter if running
    await channelManager.stopChannel(channelId);
    deleteChannel(channelId);

    channelLog.info("channel deleted", { userId, projectId, channelId });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleStartChannel(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, channelId } = (request as Request & { params: { projectId: string; channelId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const channel = getChannelById(channelId);
    if (!channel || channel.project_id !== projectId) throw new NotFoundError("Channel not found");

    // Enable in DB
    updateChannel(channelId, { enabled: true });

    // Start the adapter
    await channelManager.startChannel({
      id: channel.id,
      projectId: channel.project_id,
      platform: channel.platform as ChannelPlatform,
      name: channel.name,
      credentials: JSON.parse(channel.credentials || "{}"),
      allowedSenders: JSON.parse(channel.allowed_senders || "[]"),
      enabled: true,
    });

    channelLog.info("channel started", { userId, projectId, channelId });

    return Response.json(
      { success: true, status: channelManager.getStatus(channelId) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleStopChannel(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, channelId } = (request as Request & { params: { projectId: string; channelId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const channel = getChannelById(channelId);
    if (!channel || channel.project_id !== projectId) throw new NotFoundError("Channel not found");

    // Disable in DB
    updateChannel(channelId, { enabled: false });

    // Stop the adapter
    await channelManager.stopChannel(channelId);

    channelLog.info("channel stopped", { userId, projectId, channelId });

    return Response.json(
      { success: true },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleChannelStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const { projectId, channelId } = (request as Request & { params: { projectId: string; channelId: string } }).params;
    verifyProjectAccess(projectId, userId);

    const channel = getChannelById(channelId);
    if (!channel || channel.project_id !== projectId) throw new NotFoundError("Channel not found");

    const status = channelManager.getStatus(channelId);
    const qrCode = channelManager.getQrCode(channelId);

    return Response.json(
      { status, qrCode },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
