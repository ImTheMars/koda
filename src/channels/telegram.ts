/**
 * Telegram channel — Chat SDK transport with Koda-specific commands,
 * attachment handling, session continuity, and admin helpers.
 */

import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createTelegramAdapter,
  type TelegramMessage,
  type TelegramRawMessage,
  type TelegramWebhookInfo,
} from "@chat-adapter/telegram";
import { Chat, type Attachment, type Message, type Thread } from "chat";
import type { Config, Tier } from "../config.js";
import { persistConfig } from "../config.js";
import { messages as dbMessages, usage as dbUsage, tasks as dbTasks, userProfiles, chatMembers } from "../db.js";
import type { StreamAgentResult } from "../agent.js";
import { isLlmCircuitOpen, splitOnDelimiter } from "../agent.js";
import { VERSION } from "../version.js";
import { log, logWarn, logError } from "../log.js";
import { getNamedSession } from "../tools/subagent.js";
import { basename } from "path";

export interface TelegramDeps {
  streamAgent: (input: {
    content: string; senderId: string; chatId: string; channel: string;
    attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
    sessionKey: string; source?: string;
    tierOverride?: Tier;
    onAck?: (text: string) => void;
    onTypingStart?: () => void;
    onTypingStop?: () => void;
    senderDisplayName?: string;
    chatType?: "private" | "group";
  }) => Promise<StreamAgentResult>;
  config: Config;
  /** If provided, startup message includes "deployed in Xs" */
  deployDurationMs?: number;
}

export interface TelegramResult {
  stop: (signal?: "SIGTERM" | "SIGINT") => Promise<void>;
  sendDirect: (chatId: string, text: string) => Promise<void>;
  handleWebhook?: (req: Request) => Promise<Response>;
  notifyAdmins: (text: string) => Promise<void>;
}

type TelegramThread = Thread<Record<string, unknown>, TelegramRawMessage>;
type TelegramChatMessage = Message<TelegramRawMessage>;

interface TelegramRawMessageExtra extends TelegramMessage {
  forward_from?: { first_name?: string };
  forward_from_chat?: { title?: string };
  reply_to_message?: { text?: string; from?: { id: number } };
  new_chat_members?: Array<{ id: number }>;
  video_note?: { file_id: string; duration?: number };
}

const NAMED_AGENT_RE = /^@([A-Za-z][A-Za-z0-9_-]*)(?::|\s|$)\s*/;
const COMMAND_RE = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;
const TYPING_TIMEOUT_MS = 120_000;
const RATE_LIMIT_CLEANUP_MS = 5 * 60_000;
const SEGMENT_DELAY_MS = 400;
const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DOCUMENT_TEXT = 30_000; // chars

/** Transcribe audio via the dedicated OpenRouter transcription model. */
async function transcribeAudio(audioBuffer: Buffer, config: Config): Promise<string | null> {
  const base64 = audioBuffer.toString("base64");
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openrouter.transcriptionModel,
        messages: [{
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: base64, format: "ogg" } },
            { type: "text", text: "Transcribe this audio exactly as spoken. Return ONLY the transcription, nothing else." },
          ],
        }],
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

export function isGroupChat(chatType: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

export function getDisplayName(from: { first_name?: string; last_name?: string; username?: string } | undefined): string {
  if (!from) return "Unknown";
  const parts = [from.first_name, from.last_name].filter(Boolean);
  return parts.join(" ") || from.username || "Unknown";
}

function toAgentLabel(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getNamedAgentHeader(text: string): string | null {
  const match = text.trim().match(NAMED_AGENT_RE);
  if (!match) return null;
  const agentName = match[1]!;
  const namedSession = getNamedSession(agentName);
  if (!namedSession) return null;
  return `----- 🤖 From ${toAgentLabel(agentName)} Agent -----`;
}

export function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.trim().match(COMMAND_RE);
  if (!match) return null;
  return {
    command: match[1]!.toLowerCase(),
    args: (match[2] ?? "").trim(),
  };
}

export function shouldRespondInTelegramGroup(input: {
  botNameTriggers: string[];
  botUserId?: string;
  caption?: string;
  isMention?: boolean;
  newChatMemberIds?: string[];
  replyToMessageFromId?: string;
  text?: string;
}): boolean {
  if (input.isMention) return true;
  if (input.replyToMessageFromId && input.botUserId && input.replyToMessageFromId === input.botUserId) {
    return true;
  }

  const lower = (input.text ?? input.caption ?? "").toLowerCase();
  for (const trigger of input.botNameTriggers) {
    const re = new RegExp(`\\b${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return true;
  }

  if (input.botUserId && input.newChatMemberIds?.some((id) => id === input.botUserId)) {
    return true;
  }

  return false;
}

function enrichContent(text: string, message: {
  forward_from?: { first_name?: string };
  forward_from_chat?: { title?: string };
  reply_to_message?: { text?: string };
}): string {
  let content = text;

  if (message.forward_from) {
    content = `[forwarded from ${message.forward_from.first_name}]\n\n${content}`;
  } else if (message.forward_from_chat) {
    content = `[forwarded from ${message.forward_from_chat.title ?? "unknown channel"}]\n\n${content}`;
  }

  if (message.reply_to_message?.text) {
    content = `[replying to: "${message.reply_to_message.text.slice(0, 500)}"]\n\n${content}`;
  }

  return content;
}

function isLikelyModelId(value: string): boolean {
  return /^[^\s/]+\/[^\s]+$/.test(value);
}

function formatTelegramModels(config: Config): string {
  return (
    `chat:\n` +
    `fast: ${config.openrouter.fastModel}\n` +
    `deep: ${config.openrouter.deepModel}\n` +
    `image: ${config.openrouter.imageModel}\n\n` +
    `specialists:\n` +
    `transcription: ${config.openrouter.transcriptionModel}\n` +
    `summary: ${config.openrouter.summaryModel}\n` +
    `memory: ${config.openrouter.memoryModel}`
  );
}

async function attachmentToBuffer(attachment: Attachment): Promise<Buffer> {
  if (attachment.fetchData) return attachment.fetchData();
  if (attachment.data instanceof Buffer) return attachment.data;
  if (attachment.data instanceof Blob) return Buffer.from(await attachment.data.arrayBuffer());
  if (attachment.data instanceof ArrayBuffer) return Buffer.from(attachment.data);
  throw new Error("Attachment data unavailable");
}

export async function startTelegram(deps: TelegramDeps): Promise<TelegramResult> {
  const { config } = deps;
  const token = config.telegram.token!;
  const apiBaseUrl = process.env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org";
  const state = createMemoryState();
  const telegram = createTelegramAdapter({
    botToken: token,
    secretToken: config.telegram.webhookSecret,
    mode: config.telegram.useWebhook ? "webhook" : "polling",
    longPolling: {
      timeout: 30,
      retryDelayMs: 1000,
      deleteWebhook: true,
      dropPendingUpdates: false,
    },
  });
  const chat = new Chat({
    userName: process.env.TELEGRAM_BOT_USERNAME ?? "koda",
    adapters: { telegram },
    state,
    logger: "warn",
  });

  const allowFrom = new Set(config.telegram.allowFrom);
  const rateCounts = new Map<string, { count: number; resetAt: number }>();
  const tierOverrides = new Map<string, Tier>();
  const pendingClears = new Set<string>();
  const typingRefCounts = new Map<string, number>();
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const kodaEnv = process.env.KODA_ENV ?? (config.telegram.useWebhook ? "production" : "development");
  const bootTime = new Date();
  const rateLimit = {
    maxRequests: config.telegram.rateLimitMax ?? 10,
    windowMs: config.telegram.rateLimitWindowMs ?? 60_000,
  };

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of rateCounts) {
      if (now > entry.resetAt) rateCounts.delete(chatId);
    }
  }, RATE_LIMIT_CLEANUP_MS);

  const telegramFetch = async <T>(method: string, payload?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${apiBaseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    if (!response.ok) {
      throw new Error(`${method} failed with ${response.status}`);
    }
    const data = await response.json() as { ok: boolean; result?: T; description?: string };
    if (!data.ok || data.result === undefined) {
      throw new Error(data.description ?? `${method} failed`);
    }
    return data.result;
  };

  const downloadTelegramFile = async (fileId: string): Promise<Buffer> => {
    const file = await telegramFetch<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram file path missing");
    const response = await fetch(`${apiBaseUrl}/file/bot${token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  };

  const isAllowed = (userId: string) => allowFrom.size === 0 || allowFrom.has(userId);
  const isAdmin = (userId: string) => config.telegram.adminIds.includes(userId);
  const sessionKeyForChat = (chatId: string) => `telegram_${chatId}`;
  const decodeThread = (threadId: string) => telegram.decodeThreadId(threadId);

  const isRateLimited = (chatId: string): boolean => {
    const now = Date.now();
    let entry = rateCounts.get(chatId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + rateLimit.windowMs };
      rateCounts.set(chatId, entry);
    }
    entry.count++;
    return entry.count > rateLimit.maxRequests;
  };

  const startTyping = (thread: TelegramThread) => {
    const key = thread.id;
    const nextCount = (typingRefCounts.get(key) ?? 0) + 1;
    typingRefCounts.set(key, nextCount);
    if (nextCount > 1) return;
    const send = () => thread.startTyping().catch(() => {});
    send();
    typingIntervals.set(key, setInterval(send, 4000));
    typingTimeouts.set(key, setTimeout(() => {
      typingRefCounts.set(key, 0);
      stopTyping(thread.id);
    }, TYPING_TIMEOUT_MS));
  };

  const stopTyping = (threadId: string) => {
    const current = typingRefCounts.get(threadId) ?? 0;
    if (current > 1) {
      typingRefCounts.set(threadId, current - 1);
      return;
    }
    typingRefCounts.delete(threadId);
    const interval = typingIntervals.get(threadId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(threadId);
    }
    const timeout = typingTimeouts.get(threadId);
    if (timeout) {
      clearTimeout(timeout);
      typingTimeouts.delete(threadId);
    }
  };

  const sendSegment = async (thread: TelegramThread, text: string) => {
    if (!text.trim()) return;
    await thread.post({ markdown: text });
  };

  const sendDirectChannelMessage = async (chatId: string, text: string) => {
    const segments = splitOnDelimiter(text);
    for (let i = 0; i < segments.length; i++) {
      await telegram.postChannelMessage(chatId, { markdown: segments[i]! });
      if (i < segments.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SEGMENT_DELAY_MS + Math.random() * 200));
      }
    }
  };

  const sendStreamReply = async (input: {
    thread: TelegramThread;
    stream: AsyncIterable<string>;
    onStop: () => void;
    header?: string;
  }) => {
    const { thread, stream, onStop, header } = input;
    let buffer = "";
    let headerAdded = false;

    const withHeader = (text: string): string => {
      if (!header || headerAdded) return text;
      headerAdded = true;
      return `${header}\n${text}`;
    };

    try {
      for await (const chunk of stream) {
        buffer += chunk;
        const fenceCount = (buffer.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) continue;
        const segments = splitOnDelimiter(buffer);
        if (segments.length > 1) {
          for (let i = 0; i < segments.length - 1; i++) {
            await sendSegment(thread, withHeader(segments[i]!));
            await new Promise((resolve) => setTimeout(resolve, SEGMENT_DELAY_MS + Math.random() * 200));
          }
          buffer = segments[segments.length - 1] ?? "";
        }
      }

      const remaining = buffer.trim();
      if (remaining) await sendSegment(thread, withHeader(remaining));
    } finally {
      onStop();
    }
  };

  const sendPendingFiles = async (thread: TelegramThread, files: Array<{ path: string; caption?: string }>) => {
    for (const file of files) {
      try {
        const data = await Bun.file(file.path).arrayBuffer();
        await thread.post({
          raw: file.caption ?? "",
          files: [{ data, filename: basename(file.path) }],
        });
      } catch (err) {
        logError("telegram", `Failed to send file ${file.path}`, err);
      }
    }
  };

  const consumeTierOverride = (chatId: string): Tier | undefined => {
    const override = tierOverrides.get(chatId);
    if (override) tierOverrides.delete(chatId);
    return override;
  };

  const requireAdmin = async (thread: TelegramThread, senderId: string): Promise<boolean> => {
    if (isAdmin(senderId)) return true;
    await thread.post("admin only.").catch(() => {});
    return false;
  };

  const trackUserPresence = (
    senderId: string,
    chatId: string,
    from: { first_name?: string; last_name?: string; username?: string } | undefined,
    chatType: string,
  ) => {
    try {
      const displayName = getDisplayName(from);
      const role = isAdmin(senderId) ? "admin" as const : "member" as const;
      userProfiles.upsert({ userId: senderId, displayName, username: from?.username, role });
      if (isGroupChat(chatType)) chatMembers.upsert(chatId, senderId);
    } catch {
      // DB may not be migrated yet.
    }
  };

  const shouldRespondInGroup = (raw: TelegramRawMessageExtra, message: TelegramChatMessage): boolean => {
    return shouldRespondInTelegramGroup({
      text: message.text,
      caption: raw.caption,
      isMention: message.isMention,
      replyToMessageFromId: raw.reply_to_message?.from ? String(raw.reply_to_message.from.id) : undefined,
      botUserId: telegram.botUserId,
      botNameTriggers: config.group.botNameTriggers,
      newChatMemberIds: raw.new_chat_members?.map((member) => String(member.id)),
    });
  };

  let pdfParseFn: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
  const getPdfParse = async (): Promise<(buf: Buffer) => Promise<{ text: string }>> => {
    // @ts-ignore - pdf-parse has no bundled types.
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
      if (buffer.length > MAX_DOCUMENT_SIZE) {
        logWarn("telegram", `PDF too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_DOCUMENT_SIZE / 1024 / 1024}MB)`);
        return null;
      }
      try {
        const pdfParse = await getPdfParse();
        const result = await pdfParse(buffer);
        return result.text;
      } catch (err) {
        logError("telegram", "PDF parse error", err);
        return null;
      }
    }

    if (textTypes.some((type) => mimeType.startsWith(type)) || textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext))) {
      return buffer.toString("utf-8");
    }

    return null;
  };

  const notifyAdmins = async (text: string) => {
    for (const adminId of config.telegram.adminIds) {
      await sendDirectChannelMessage(adminId, text).catch(() => {});
    }
  };

  const handleModelCommand = async (thread: TelegramThread, senderId: string, args: string, inGroup: boolean) => {
    if (inGroup && !(await requireAdmin(thread, senderId))) return;

    const verifyChatModel = async (modelId: string): Promise<string | null> => {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content: "Reply with OK only." }],
            max_tokens: 4,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) return `warning: OpenRouter validation returned ${res.status}; model was saved anyway.`;

        const data = await res.json() as { model?: string };
        const resolvedModel = typeof data.model === "string" ? data.model : null;
        if (resolvedModel && resolvedModel !== modelId) {
          const isAliasMatch = resolvedModel.startsWith(`${modelId}-`) || modelId.startsWith(`${resolvedModel}-`);
          if (isAliasMatch) return `note: OpenRouter resolved alias to ${resolvedModel}.`;
          return `warning: OpenRouter responded with ${resolvedModel}; saved ${modelId} anyway.`;
        }

        return null;
      } catch (err) {
        return `warning: model validation unavailable (${(err as Error).message}); model was saved anyway.`;
      }
    };

    const usageText =
      "usage:\n" +
      "/model - show current models\n" +
      "/model <model-id> - set primary chat models (fast + deep)\n" +
      "/model fast <model-id>\n" +
      "/model deep <model-id>\n" +
      "/model image <model-id>\n" +
      "/model all <model-id> - set fast + deep\n" +
      "/model primary <model-id> - same as all\n\n" +
      "note: transcription, summary, and memory models are configured separately.";

    const showCurrentModels = async () => {
      await thread.post(`${formatTelegramModels(config)}\n\n${usageText}`);
    };

    if (!args || args === "show" || args === "list") {
      await showCurrentModels();
      return;
    }

    let target: "fast" | "deep" | "image" | "all";
    let modelId: string;
    const parts = args.split(/\s+/).filter(Boolean);

    if (parts.length === 1 && isLikelyModelId(parts[0]!)) {
      target = "all";
      modelId = parts[0]!;
    } else {
      const [targetArg, ...modelParts] = parts;
      const normalizedTarget = (targetArg ?? "").toLowerCase();
      modelId = modelParts.join(" ").trim();

      if (normalizedTarget === "primary" || normalizedTarget === "chat") {
        target = "all";
      } else if (normalizedTarget === "fast" || normalizedTarget === "deep" || normalizedTarget === "image" || normalizedTarget === "all") {
        target = normalizedTarget;
      } else {
        await thread.post(usageText);
        return;
      }
    }

    if (!isLikelyModelId(modelId)) {
      await thread.post("invalid model id. expected something like provider/model-name");
      return;
    }

    const verificationNote = target !== "image" ? await verifyChatModel(modelId) : null;

    if (target === "all") {
      config.openrouter.fastModel = modelId;
      config.openrouter.deepModel = modelId;
    } else if (target === "image") {
      config.openrouter.imageModel = modelId;
    } else if (target === "fast") {
      config.openrouter.fastModel = modelId;
    } else {
      config.openrouter.deepModel = modelId;
    }

    const successText = target === "all"
      ? `primary chat models changed to ${modelId}`
      : target === "fast"
      ? `fast model changed to ${modelId}`
      : `${target} model changed to ${modelId}`;

    try {
      await persistConfig(config);
      await thread.post(verificationNote ? `${successText}\n${verificationNote}` : successText);
    } catch (err) {
      await thread.post(`${successText} (config save failed: ${(err as Error).message})${verificationNote ? `\n${verificationNote}` : ""}`);
    }
  };

  const handleCommand = async (thread: TelegramThread, message: TelegramChatMessage, raw: TelegramRawMessageExtra, senderId: string, chatId: string, inGroup: boolean): Promise<boolean> => {
    const parsed = parseCommand(message.text);
    if (!parsed) return false;

    switch (parsed.command) {
      case "start":
        await thread.post(isAllowed(senderId) ? "hey. send me a message to get started." : "Access denied.");
        return true;
      case "help": {
        if (!isAllowed(senderId)) return true;
        const helpText = "commands:\n" +
          "/help - this message\n" +
          "/clear - reset conversation\n" +
          "/usage - see token usage and costs\n" +
          "/status - system health summary\n" +
          "/deep - force next message to use deep tier\n" +
          "/fast - force next message to use fast tier\n" +
          "/recap - summarize recent conversation\n" +
          "/memories - list or delete stored memories\n" +
          "/model - view or change models (quick set: /model <id>)\n" +
          "/adduser <id> - add a user (admin)\n" +
          "/removeuser <id> - remove a user (admin)\n\n" +
          "i can also search the web, remember things, run code, set reminders, manage files, generate images, and load skills.\n" +
          "send me voice messages — i'll transcribe and respond.\n" +
          "send me PDFs and text files — i'll read them. reply to messages for context.";
        if (inGroup) {
          await thread.post(`${helpText}\n\nin groups, mention me (@${telegram.userName}) or reply to my messages to get a response.`);
        } else {
          await thread.post(helpText);
        }
        return true;
      }
      case "clear":
        if (!isAllowed(senderId)) return true;
        if (inGroup && !(await requireAdmin(thread, senderId))) return true;
        if (pendingClears.has(chatId)) {
          pendingClears.delete(chatId);
          dbMessages.clear(sessionKeyForChat(chatId));
          await thread.post("Conversation cleared.");
        } else {
          pendingClears.add(chatId);
          setTimeout(() => pendingClears.delete(chatId), 30_000);
          await thread.post("Clear conversation history? Send /clear again to confirm.");
        }
        return true;
      case "usage": {
        if (!isAllowed(senderId)) return true;
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const [today, month, allTime] = [
          dbUsage.getSummary(senderId, todayStart),
          dbUsage.getSummary(senderId, monthStart),
          dbUsage.getSummary(senderId),
        ];
        const fmt = (cost: number) => `$${cost.toFixed(4)}`;
        await thread.post(
          `usage summary:\n\ntoday: ${today.totalRequests} requests, ${fmt(today.totalCost)}\nthis month: ${month.totalRequests} requests, ${fmt(month.totalCost)}\nall time: ${allTime.totalRequests} requests, ${fmt(allTime.totalCost)}`,
        );
        return true;
      }
      case "status": {
        if (!isAllowed(senderId)) return true;
        const uptimeSecs = Math.floor(process.uptime());
        const uptimeStr = uptimeSecs < 60
          ? `${uptimeSecs}s`
          : uptimeSecs < 3600
          ? `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s`
          : `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`;
        const mem = process.memoryUsage();
        const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
        const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const todayUsage = dbUsage.getSummary(senderId, todayStart);
        const allReady = dbTasks.getReady(new Date("2099-01-01").toISOString());
        const nextTask = allReady.length > 0 ? allReady[0] : null;
        const llmStatus = isLlmCircuitOpen() ? "degraded" : "healthy";
        let status = `koda v${VERSION}\n`;
        status += `uptime: ${uptimeStr}\n`;
        status += `memory: ${heapMb}MB heap / ${rssMb}MB rss\n`;
        status += `llm: ${llmStatus}\n`;
        status += `today: ${todayUsage.totalRequests} requests, $${todayUsage.totalCost.toFixed(4)}\n`;
        status += `chat: fast=${config.openrouter.fastModel}, deep=${config.openrouter.deepModel}\n`;
        status += `specialists: voice=${config.openrouter.transcriptionModel}, summary=${config.openrouter.summaryModel}, memory=${config.openrouter.memoryModel}\n`;
        if (nextTask) {
          status += `next task: ${nextTask.description} (${nextTask.nextRunAt})`;
        } else {
          status += `tasks: ${allReady.length} active`;
        }
        await thread.post(status);
        return true;
      }
      case "deep":
        if (!isAllowed(senderId)) return true;
        tierOverrides.set(chatId, "deep");
        await thread.post("next message will use deep tier.");
        return true;
      case "fast":
        if (!isAllowed(senderId)) return true;
        tierOverrides.set(chatId, "fast");
        await thread.post("next message will use fast tier.");
        return true;
      case "recap": {
        if (!isAllowed(senderId)) return true;
        startTyping(thread);
        try {
          const result = await deps.streamAgent({
            content: "give me a brief recap of our recent conversation — key topics, decisions, and any open items.",
            senderId,
            chatId,
            channel: "telegram",
            sessionKey: sessionKeyForChat(chatId),
            source: "command",
          });
          await sendStreamReply({
            thread,
            stream: result.fullStream,
            onStop: () => stopTyping(thread.id),
          });
          await result.finishedPromise.catch((err) => logError("telegram", "agent promise failed", err));
        } catch (err) {
          stopTyping(thread.id);
          logError("telegram", "Recap error", err);
          await thread.post("ran into an issue generating the recap.").catch(() => {});
        }
        return true;
      }
      case "memories": {
        if (!isAllowed(senderId)) return true;
        startTyping(thread);
        try {
          const prompt = parsed.args.startsWith("delete ")
            ? `Delete the memory matching: "${parsed.args.slice(7).trim()}". Use the deleteMemory tool. Confirm what was deleted.`
            : "List my 10 most recent memories using the recall tool with a broad query. Number each one clearly.";
          const result = await deps.streamAgent({
            content: prompt,
            senderId,
            chatId,
            channel: "telegram",
            sessionKey: sessionKeyForChat(chatId),
            source: "command",
          });
          await sendStreamReply({
            thread,
            stream: result.fullStream,
            onStop: () => stopTyping(thread.id),
          });
          await result.finishedPromise.catch((err) => logError("telegram", "agent promise failed", err));
        } catch (err) {
          stopTyping(thread.id);
          logError("telegram", "Memories error", err);
          await thread.post("ran into an issue with memories.").catch(() => {});
        }
        return true;
      }
      case "model":
        if (!isAllowed(senderId)) return true;
        await handleModelCommand(thread, senderId, parsed.args, inGroup);
        return true;
      case "debug": {
        if (!isAdmin(senderId)) {
          await thread.post("admin only.");
          return true;
        }
        const uptimeSecs = Math.floor(process.uptime());
        const uptimeStr = uptimeSecs < 3600
          ? `${Math.floor(uptimeSecs / 60)}m ${uptimeSecs % 60}s`
          : `${Math.floor(uptimeSecs / 3600)}h ${Math.floor((uptimeSecs % 3600) / 60)}m`;
        const mem = process.memoryUsage();
        const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
        const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const todayUsage = dbUsage.getSummary(senderId, todayStart);
        const monthUsage = dbUsage.getSummary(senderId, monthStart);
        const allUsage = dbUsage.getSummary(senderId);
        const allTasks = dbTasks.getReady(new Date("2099-01-01").toISOString());
        const llmStatus = isLlmCircuitOpen() ? "DEGRADED" : "healthy";
        let msg = `--- koda debug ---\n`;
        msg += `version: v${VERSION}\n`;
        msg += `env: ${kodaEnv}\n`;
        msg += `mode: ${config.telegram.useWebhook ? "webhook" : "polling"}\n`;
        msg += `uptime: ${uptimeStr}\n`;
        msg += `booted: ${bootTime.toISOString()}\n`;
        msg += `heap: ${heapMb}MB / rss: ${rssMb}MB\n`;
        msg += `llm: ${llmStatus}\n`;
        msg += `models:\n  fast: ${config.openrouter.fastModel}\n  deep: ${config.openrouter.deepModel}\n  image: ${config.openrouter.imageModel}\n`;
        msg += `specialists:\n  transcription: ${config.openrouter.transcriptionModel}\n  summary: ${config.openrouter.summaryModel}\n  memory: ${config.openrouter.memoryModel}\n`;
        msg += `---\n`;
        msg += `today: ${todayUsage.totalRequests} req, $${todayUsage.totalCost.toFixed(4)}\n`;
        msg += `month: ${monthUsage.totalRequests} req, $${monthUsage.totalCost.toFixed(4)}\n`;
        msg += `all-time: ${allUsage.totalRequests} req, $${allUsage.totalCost.toFixed(4)}\n`;
        msg += `tasks: ${allTasks.length} active\n`;
        msg += `node: ${process.version}\n`;
        msg += `platform: ${process.platform}/${process.arch}`;
        await thread.post(msg);
        return true;
      }
      case "adduser":
        if (!isAllowed(senderId)) return true;
        if (!(await requireAdmin(thread, senderId))) return true;
        if (!parsed.args || !/^\d+$/.test(parsed.args)) {
          await thread.post("usage: /adduser <telegram_user_id>");
          return true;
        }
        allowFrom.add(parsed.args);
        try {
          userProfiles.upsert({ userId: parsed.args, displayName: `User ${parsed.args}`, role: "member" });
        } catch {}
        await thread.post(`user ${parsed.args} added.`);
        log("telegram", `admin ${senderId} added user ${parsed.args}`);
        return true;
      case "removeuser":
        if (!isAllowed(senderId)) return true;
        if (!(await requireAdmin(thread, senderId))) return true;
        if (!parsed.args || !/^\d+$/.test(parsed.args)) {
          await thread.post("usage: /removeuser <telegram_user_id>");
          return true;
        }
        if (parsed.args === senderId) {
          await thread.post("can't remove yourself.");
          return true;
        }
        if (isAdmin(parsed.args)) {
          await thread.post("can't remove an admin.");
          return true;
        }
        allowFrom.delete(parsed.args);
        await thread.post(`user ${parsed.args} removed.`);
        log("telegram", `admin ${senderId} removed user ${parsed.args}`);
        return true;
      default:
        return false;
    }
  };

  const runAgentForMessage = async (input: {
    thread: TelegramThread;
    content: string;
    senderId: string;
    chatId: string;
    displayName: string;
    inGroup: boolean;
    header?: string | null;
    attachments?: Array<{ type: "image"; mimeType: string; data: string }>;
    tierOverride?: Tier;
    source?: string;
  }) => {
    const { thread, content, senderId, chatId, displayName, inGroup, header, attachments, tierOverride, source } = input;
    const t0 = Date.now();
    startTyping(thread);
    try {
      const streamResult = await deps.streamAgent({
        content,
        attachments,
        senderId,
        chatId,
        channel: "telegram",
        sessionKey: sessionKeyForChat(chatId),
        tierOverride,
        source,
        senderDisplayName: displayName,
        chatType: inGroup ? "group" : "private",
        onAck: (text) => {
          void thread.post({ markdown: text }).catch(() => {});
        },
      });

      await sendStreamReply({
        thread,
        stream: streamResult.fullStream,
        onStop: () => stopTyping(thread.id),
        ...(header ? { header } : {}),
      });

      const agentResult = await streamResult.finishedPromise.catch((err) => {
        logError("telegram", "agent promise failed", err);
        return null;
      });

      const elapsed = Date.now() - t0;
      log("msg", `OUT to=${chatId} len=${agentResult?.text?.length ?? 0} tier=${agentResult?.tier ?? "?"} tools=[${agentResult?.toolsUsed?.join(",") ?? ""}] ${elapsed}ms`);
      if (agentResult?.files?.length) {
        await sendPendingFiles(thread, agentResult.files);
      }
    } catch (err) {
      stopTyping(thread.id);
      logError("msg", `message from=${senderId} chat=${chatId} ${Date.now() - t0}ms`, err);
      await thread.post("ran into an issue, try again?").catch(() => {});
    }
  };

  const handleIncomingMessage = async (thread: TelegramThread, message: TelegramChatMessage) => {
    const raw = message.raw as TelegramRawMessageExtra;
    const chatId = String(raw.chat.id);
    const senderId = message.author.userId;
    const displayName = getDisplayName(raw.from) || message.author.fullName || "Unknown";
    const inGroup = isGroupChat(raw.chat.type);
    const namedAgentHeader = getNamedAgentHeader(message.text ?? raw.caption ?? "");

    if (!isAllowed(senderId)) {
      log("msg", `BLOCKED message from=${senderId} reason=not_allowed`);
      return;
    }

    trackUserPresence(senderId, chatId, raw.from, raw.chat.type);

    if (!message.metadata.edited && await handleCommand(thread, message, raw, senderId, chatId, inGroup)) {
      return;
    }

    if (inGroup && config.group.passiveListening && !shouldRespondInGroup(raw, message)) {
      if (raw.photo?.length) {
        dbMessages.append(sessionKeyForChat(chatId), "user", `[${displayName}]: [photo] ${raw.caption ?? ""}`);
      } else if (raw.document) {
        dbMessages.append(sessionKeyForChat(chatId), "user", `[${displayName}]: [document: ${raw.document.file_name ?? "file"}] ${raw.caption ?? ""}`);
      } else if (raw.voice) {
        dbMessages.append(sessionKeyForChat(chatId), "user", `[${displayName}]: [voice message]`);
      } else if (raw.video_note) {
        dbMessages.append(sessionKeyForChat(chatId), "user", `[${displayName}]: [video note]`);
      } else if (message.text) {
        dbMessages.append(sessionKeyForChat(chatId), "user", `[${displayName}]: ${message.text}`);
      }
      log("msg", `PASSIVE message from=${senderId} chat=${chatId}`);
      return;
    }

    if (isRateLimited(chatId)) {
      await thread.post(inGroup ? "slow down!" : "slow down! you're sending messages too fast.").catch(() => {});
      return;
    }

    if (message.metadata.edited && message.text) {
      let content = `[edited] ${message.text}`;
      if (inGroup) content = `[${displayName}]: ${content}`;
      await runAgentForMessage({
        thread,
        content,
        senderId,
        chatId,
        displayName,
        inGroup,
        header: namedAgentHeader,
      });
      return;
    }

    const imageAttachment = message.attachments.find((attachment) => attachment.type === "image");
    if (imageAttachment) {
      try {
        const buffer = await attachmentToBuffer(imageAttachment);
        let content = message.text || raw.caption || "What's in this image?";
        content = enrichContent(content, raw);
        if (inGroup) content = `[${displayName}]: ${content}`;
        await runAgentForMessage({
          thread,
          content,
          senderId,
          chatId,
          displayName,
          inGroup,
          header: namedAgentHeader,
          attachments: [{
            type: "image",
            mimeType: imageAttachment.mimeType ?? "image/jpeg",
            data: buffer.toString("base64"),
          }],
          tierOverride: consumeTierOverride(chatId),
        });
      } catch (err) {
        logError("telegram", "Image download failed", err);
        await thread.post("I couldn't read that image.").catch(() => {});
      }
      return;
    }

    if (raw.document) {
      try {
        const documentAttachment = message.attachments.find((attachment) => attachment.type === "file");
        const buffer = documentAttachment
          ? await attachmentToBuffer(documentAttachment)
          : await downloadTelegramFile(raw.document.file_id);
        const fileName = raw.document.file_name ?? "document";
        const mimeType = raw.document.mime_type ?? "application/octet-stream";
        const fileSize = raw.document.file_size ?? buffer.length;
        if (fileSize > MAX_DOCUMENT_SIZE) {
          await thread.post("That file is too large (max 20MB).").catch(() => {});
          return;
        }
        const extractedText = await extractDocumentText(buffer, mimeType, fileName);
        if (extractedText === null) {
          await thread.post("I can read PDFs and text files (.txt, .md, .csv, .json, .html, .xml). This format isn't supported yet.").catch(() => {});
          return;
        }
        const truncatedText = extractedText.slice(0, MAX_DOCUMENT_TEXT);
        let content = `[document: ${fileName}]\n\n${truncatedText}`;
        if (truncatedText.length < extractedText.length) {
          content += `\n\n[truncated — showing ${MAX_DOCUMENT_TEXT} of ${extractedText.length} characters]`;
        }
        if (raw.caption) content = `${raw.caption}\n\n${content}`;
        content = enrichContent(content, raw);
        if (inGroup) content = `[${displayName}]: ${content}`;
        await runAgentForMessage({
          thread,
          content,
          senderId,
          chatId,
          displayName,
          inGroup,
          header: namedAgentHeader,
        });
      } catch (err) {
        logError("telegram", "Document processing failed", err);
        await thread.post("ran into an issue processing that file.").catch(() => {});
      }
      return;
    }

    if (raw.voice || raw.video_note) {
      try {
        const buffer = raw.voice
          ? await attachmentToBuffer(message.attachments.find((attachment) => attachment.type === "audio")!)
          : await downloadTelegramFile(raw.video_note!.file_id);
        const transcription = await transcribeAudio(buffer, config);
        if (!transcription) {
          await thread.post(raw.voice
            ? "I couldn't transcribe that voice message. Try again or send it as text."
            : "I couldn't transcribe that video note. Try again or send it as text.",
          ).catch(() => {});
          return;
        }
        let content = `[voice message] ${transcription}`;
        content = enrichContent(content, raw);
        if (inGroup) content = `[${displayName}]: ${content}`;
        await runAgentForMessage({
          thread,
          content,
          senderId,
          chatId,
          displayName,
          inGroup,
          header: namedAgentHeader,
          tierOverride: consumeTierOverride(chatId),
        });
      } catch (err) {
        logError("telegram", "Audio transcription failed", err);
        await thread.post("ran into an issue, try again?").catch(() => {});
      }
      return;
    }

    if (!message.text) return;

    let content = enrichContent(message.text, raw);
    if (inGroup) content = `[${displayName}]: ${content}`;
    await runAgentForMessage({
      thread,
      content,
      senderId,
      chatId,
      displayName,
      inGroup,
      header: namedAgentHeader,
      tierOverride: consumeTierOverride(chatId),
    });
  };

  chat.onNewMention(async (thread, message) => {
    await handleIncomingMessage(thread as TelegramThread, message as TelegramChatMessage);
  });

  chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
    await handleIncomingMessage(thread as TelegramThread, message as TelegramChatMessage);
  });

  await chat.initialize();
  log("telegram", `Bot initialized: @${telegram.userName}`);

  if (config.telegram.useWebhook && config.telegram.webhookUrl) {
    const setWebhookWithRetry = async (retries = 5, delay = 3000) => {
      for (let i = 0; i < retries; i++) {
        try {
          await telegramFetch("setWebhook", {
            url: config.telegram.webhookUrl,
            secret_token: config.telegram.webhookSecret,
          });
          const info = await telegramFetch<TelegramWebhookInfo>("getWebhookInfo");
          if (info.url === config.telegram.webhookUrl) {
            log("telegram", `Webhook set: ${config.telegram.webhookUrl}`);
            return;
          }
          logWarn("telegram", `Webhook URL mismatch after set (got "${info.url}"), retrying...`);
        } catch (err) {
          logWarn("telegram", `setWebhook attempt ${i + 1}/${retries} failed: ${(err as Error).message}`);
        }
        if (i < retries - 1) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      logError("telegram", "Failed to set webhook after all retries!");
    };

    await setWebhookWithRetry();

    setTimeout(async () => {
      try {
        const info = await telegramFetch<TelegramWebhookInfo>("getWebhookInfo");
        if (info.url !== config.telegram.webhookUrl) {
          logWarn("telegram", "Webhook was cleared (deploy race), re-registering...");
          await telegramFetch("setWebhook", {
            url: config.telegram.webhookUrl,
            secret_token: config.telegram.webhookSecret,
          });
          log("telegram", "Webhook re-registered successfully");
        }
      } catch (err) {
        logError("telegram", "Webhook re-check failed", err);
      }
    }, 10_000);

    if (kodaEnv === "production") {
      const durationSuffix = deps.deployDurationMs
        ? ` — deployed in ${Math.round(deps.deployDurationMs / 1000)}s`
        : "";
      await notifyAdmins(`koda v${VERSION} is online. [${kodaEnv}]${durationSuffix}`);
    }
  }

  return {
    notifyAdmins,
    async sendDirect(chatId: string, text: string) {
      await sendDirectChannelMessage(chatId, text);
    },
    async stop(signal: "SIGTERM" | "SIGINT" = "SIGTERM") {
      for (const threadId of typingIntervals.keys()) stopTyping(threadId);
      clearInterval(cleanupTimer);
      if (kodaEnv === "production") {
        const msg = signal === "SIGTERM"
          ? `deploying now, switching over... [${kodaEnv}]`
          : `restarting unexpectedly... [${kodaEnv}]`;
        await notifyAdmins(msg);
      }
      await chat.shutdown().catch((err) => logWarn("telegram", `shutdown warning: ${(err as Error).message}`));
    },
    async handleWebhook(req: Request): Promise<Response> {
      try {
        const clone = req.clone();
        const update = await clone.json() as { update_id?: number; message?: { from?: { id?: number }; text?: string }; edited_message?: { from?: { id?: number }; text?: string } };
        const raw = update as unknown as Record<string, unknown>;
        const updateType = Object.keys(raw).filter((key) => key !== "update_id").join(",") || "unknown";
        const fromId = update.message?.from?.id ?? update.edited_message?.from?.id ?? "?";
        const preview = (update.message?.text ?? update.edited_message?.text ?? "").slice(0, 60);
        log("webhook", `id=${update.update_id ?? "?"} type=${updateType} from=${fromId}${preview ? ` "${preview}"` : ""}`);
      } catch {
        // Ignore logging parse errors and pass original request through.
      }
      return chat.webhooks.telegram(req);
    },
  };
}
