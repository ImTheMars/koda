/**
 * Slack channel — collaborative business transport with workspace/project scopes.
 */

import { createMemoryState } from "@chat-adapter/state-memory";
import { createSlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { Chat, type Attachment, type Message, type Thread } from "chat";
import type { Config, Tier } from "../config.js";
import type { StreamAgentResult } from "../agent.js";
import { splitOnDelimiter } from "../agent.js";
import { messages as dbMessages, userProfiles, chatMembers } from "../db.js";
import { log, logError, logWarn } from "../log.js";
import { basename } from "path";

export interface SlackDeps {
  streamAgent: (input: {
    content: string;
    senderId: string;
    chatId: string;
    channel: string;
    attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
    sessionKey: string;
    workspaceScopeId?: string;
    projectScopeId?: string;
    source?: string;
    tierOverride?: Tier;
    onAck?: (text: string) => void;
    onTypingStart?: () => void;
    onTypingStop?: () => void;
    senderDisplayName?: string;
    chatType?: "private" | "group";
  }) => Promise<StreamAgentResult>;
  config: Config;
}

export interface SlackResult {
  stop: () => Promise<void>;
  sendDirect: (chatId: string, text: string) => Promise<void>;
  handleWebhook: (req: Request) => Promise<Response>;
  notifyAdmins: (text: string) => Promise<void>;
}

type SlackThread = Thread<Record<string, unknown>, SlackEvent>;
type SlackChatMessage = Message<SlackEvent>;

const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024;
const MAX_DOCUMENT_TEXT = 30_000;

export function getSlackWorkspaceScopeId(teamId: string): string {
  return `slack:${teamId}`;
}

export function getSlackProjectScopeId(teamId: string, channelId: string): string {
  return `slack:${teamId}:channel:${channelId}`;
}

export function shouldRespondInSlackConversation(input: {
  isDirectMessage?: boolean;
  isMention?: boolean;
  isSubscribedThread?: boolean;
}): boolean {
  return Boolean(input.isDirectMessage || input.isMention || input.isSubscribedThread);
}

async function attachmentToBuffer(attachment: Attachment): Promise<Buffer> {
  if (attachment.fetchData) return attachment.fetchData();
  if (attachment.data instanceof Buffer) return attachment.data;
  if (attachment.data instanceof Blob) return Buffer.from(await attachment.data.arrayBuffer());
  if (attachment.data instanceof ArrayBuffer) return Buffer.from(attachment.data);
  throw new Error("Attachment data unavailable");
}

export async function startSlack(deps: SlackDeps): Promise<SlackResult> {
  const { config } = deps;
  const botToken = config.slack.botToken!;
  const state = createMemoryState();
  const slack = createSlackAdapter({
    botToken,
    signingSecret: config.slack.signingSecret,
    botUserId: config.slack.botUserId,
    userName: "koda",
  });
  const chat = new Chat({
    userName: "koda",
    adapters: { slack },
    state,
    logger: "warn",
  });

  let pdfParseFn: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
  const getPdfParse = async (): Promise<(buf: Buffer) => Promise<{ text: string }>> => {
    // @ts-expect-error - pdf-parse has no bundled types.
    if (!pdfParseFn) pdfParseFn = (await import("pdf-parse")).default;
    return pdfParseFn!;
  };

  const extractDocumentText = async (buffer: Buffer, mimeType: string, fileName: string): Promise<string | null> => {
    const textTypes = [
      "text/plain", "text/markdown", "text/csv", "text/html", "text/xml",
      "application/json", "application/xml",
    ];
    const textExtensions = [".txt", ".md", ".csv", ".json", ".html", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".log"];

    if (mimeType === "application/pdf") {
      if (buffer.length > MAX_DOCUMENT_SIZE) return null;
      try {
        const pdfParse = await getPdfParse();
        const result = await pdfParse(buffer);
        return result.text;
      } catch (err) {
        logError("slack", "PDF parse error", err);
        return null;
      }
    }

    if (textTypes.some((type) => mimeType.startsWith(type)) || textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext))) {
      return buffer.toString("utf-8");
    }

    return null;
  };

  const parseScopes = (thread: SlackThread, message: SlackChatMessage) => {
    const raw = message.raw;
    const decoded = slack.decodeThreadId(thread.id);
    const teamId = raw.team_id ?? raw.team ?? config.slack.teamId ?? "default";
    const workspaceScopeId = getSlackWorkspaceScopeId(teamId);
    const projectScopeId = slack.isDM(thread.id) ? undefined : getSlackProjectScopeId(teamId, decoded.channel);
    return {
      channelId: decoded.channel,
      isDirectMessage: slack.isDM(thread.id),
      projectScopeId,
      teamId,
      workspaceScopeId,
    };
  };

  const trackUserPresence = (message: SlackChatMessage, projectScopeId?: string) => {
    const displayName = message.author.fullName || message.author.userName || message.author.userId;
    const role = config.slack.adminIds.includes(message.author.userId) ? "admin" as const : "member" as const;
    try {
      userProfiles.upsert({
        userId: message.author.userId,
        displayName,
        username: message.author.userName,
        role,
      });
      if (projectScopeId) chatMembers.upsert(projectScopeId, message.author.userId);
    } catch {
      // DB may not be migrated yet.
    }
  };

  const sendSlackText = async (chatId: string, text: string) => {
    const segments = splitOnDelimiter(text);
    if (chatId.startsWith("slack:")) {
      for (const segment of segments) await slack.postMessage(chatId, { markdown: segment });
      return;
    }
    if (/^[CDG]/.test(chatId)) {
      for (const segment of segments) await slack.postChannelMessage(chatId, { markdown: segment });
      return;
    }
    const dmThreadId = await slack.openDM?.(chatId);
    if (!dmThreadId) throw new Error(`Unable to open Slack DM for ${chatId}`);
    for (const segment of segments) await slack.postMessage(dmThreadId, { markdown: segment });
  };

  const notifyAdmins = async (text: string) => {
    for (const adminId of config.slack.adminIds) {
      await sendSlackText(adminId, text).catch(() => {});
    }
  };

  const sendPendingFiles = async (thread: SlackThread, files: Array<{ path: string; caption?: string }>) => {
    for (const file of files) {
      try {
        const data = await Bun.file(file.path).arrayBuffer();
        await thread.post({
          raw: file.caption ?? basename(file.path),
          files: [{ data, filename: basename(file.path) }],
        });
      } catch (err) {
        logError("slack", `Failed to send file ${file.path}`, err);
      }
    }
  };

  const runAgentForMessage = async (input: {
    thread: SlackThread;
    message: SlackChatMessage;
    content: string;
    attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
    tierOverride?: Tier;
  }) => {
    const { thread, message, content, attachments, tierOverride } = input;
    const { isDirectMessage, projectScopeId, workspaceScopeId } = parseScopes(thread, message);
    const displayName = message.author.fullName || message.author.userName || message.author.userId;
    const streamResult = await deps.streamAgent({
      content,
      attachments,
      senderId: message.author.userId,
      chatId: thread.id,
      channel: "slack",
      sessionKey: thread.id,
      workspaceScopeId,
      projectScopeId,
      tierOverride,
      senderDisplayName: displayName,
      chatType: isDirectMessage ? "private" : "group",
      onAck: (text) => {
        void thread.post({ markdown: text }).catch(() => {});
      },
      onTypingStart: () => {
        void thread.startTyping("thinking").catch(() => {});
      },
    });

    try {
      await thread.post(streamResult.fullStream);
      const result = await streamResult.finishedPromise;
      if (result.files?.length) await sendPendingFiles(thread, result.files);
    } catch (err) {
      logError("slack", "Agent failed", err);
      await thread.post("i hit an issue handling that. try me again?").catch(() => {});
    }
  };

  const handleIncomingMessage = async (thread: SlackThread, message: SlackChatMessage) => {
    const { channelId, isDirectMessage, projectScopeId } = parseScopes(thread, message);
    trackUserPresence(message, projectScopeId);

    let content = message.text ?? "";
    const displayName = message.author.fullName || message.author.userName || message.author.userId;
    if (!content && message.attachments.length === 0) return;
    if (!isDirectMessage) content = `[${displayName}]: ${content}`.trim();

    const imageAttachment = message.attachments.find((attachment) => attachment.type === "image");
    if (imageAttachment) {
      try {
        const buffer = await attachmentToBuffer(imageAttachment);
        await runAgentForMessage({
          thread,
          message,
          content: content || `[${displayName}]: What's in this image?`,
          attachments: [{
            type: "image",
            mimeType: imageAttachment.mimeType ?? "image/jpeg",
            data: buffer.toString("base64"),
          }],
        });
      } catch (err) {
        logError("slack", "Image download failed", err);
      }
      return;
    }

    const fileAttachment = message.attachments.find((attachment) => attachment.type === "file");
    if (fileAttachment) {
      try {
        const buffer = await attachmentToBuffer(fileAttachment);
        const fileName = fileAttachment.name ?? "document";
        const mimeType = fileAttachment.mimeType ?? "application/octet-stream";
        if (buffer.length > MAX_DOCUMENT_SIZE) {
          await thread.post("that file is too large for me to read right now.").catch(() => {});
          return;
        }
        const extractedText = await extractDocumentText(buffer, mimeType, fileName);
        if (!extractedText) {
          await thread.post("i can read pdfs and text-based docs here, but not that file type yet.").catch(() => {});
          return;
        }
        const truncatedText = extractedText.slice(0, MAX_DOCUMENT_TEXT);
        const documentContent = `${content}\n\n[document: ${fileName}]\n\n${truncatedText}`.trim();
        await runAgentForMessage({ thread, message, content: documentContent });
      } catch (err) {
        logError("slack", "Document processing failed", err);
      }
      return;
    }

    await runAgentForMessage({ thread, message, content });

    if (!isDirectMessage && config.group.passiveListening && projectScopeId) {
      dbMessages.append(`slack_channel_${channelId}`, "user", `[${displayName}]: ${message.text ?? ""}`);
    }
  };

  chat.onNewMention(async (thread, message) => {
    await (thread as SlackThread).subscribe();
    await handleIncomingMessage(thread as SlackThread, message as SlackChatMessage);
  });

  chat.onSubscribedMessage(async (thread, message) => {
    await handleIncomingMessage(thread as SlackThread, message as SlackChatMessage);
  });

  chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
    const slackThread = thread as SlackThread;
    const slackMessage = message as SlackChatMessage;
    const { isDirectMessage, projectScopeId, channelId } = parseScopes(slackThread, slackMessage);
    trackUserPresence(slackMessage, projectScopeId);
    if (!config.group.passiveListening || isDirectMessage || slackMessage.isMention) return;
    const displayName = slackMessage.author.fullName || slackMessage.author.userName || slackMessage.author.userId;
    dbMessages.append(`slack_channel_${channelId}`, "user", `[${displayName}]: ${slackMessage.text ?? ""}`);
  });

  await chat.initialize();
  log("slack", "Slack adapter initialized");

  return {
    stop: async () => {},
    sendDirect: (chatId, text) => sendSlackText(chatId, text),
    handleWebhook: (req) => chat.webhooks.slack(req),
    notifyAdmins,
  };
}
