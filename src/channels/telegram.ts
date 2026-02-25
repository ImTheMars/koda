/**
 * Telegram channel — Grammy bot with streaming text, photo, document, and webhook support.
 *
 * Uses streamAgent for text/photo/document messages so segments send as they complete.
 */

import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import type { Config, Tier } from "../config.js";
import { persistConfig } from "../config.js";
import { messages as dbMessages, usage as dbUsage, tasks as dbTasks } from "../db.js";
import type { StreamAgentResult } from "../agent.js";
import { isLlmCircuitOpen, splitOnDelimiter } from "../agent.js";
import { VERSION } from "../version.js";
import { log } from "../log.js";
import { readFileSync } from "fs";
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
  }) => Promise<StreamAgentResult>;
  config: Config;
}

export interface TelegramResult {
  stop: () => Promise<void>;
  sendDirect: (chatId: string, text: string) => Promise<void>;
  handleWebhook?: (req: Request) => Promise<Response>;
  notifyAdmins: (text: string) => Promise<void>;
}

/** Transcribe audio via OpenRouter (Gemini Flash with native audio support). */
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
        model: config.openrouter.fastModel,
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

/** Safety timeout: auto-stop typing after 2 minutes */
const TYPING_TIMEOUT_MS = 120_000;
const DEDUP_CLEANUP_MS = 5 * 60_000;
const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };
const SEGMENT_DELAY_MS = 400;
const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DOCUMENT_TEXT = 30_000; // chars

export async function startTelegram(deps: TelegramDeps): Promise<TelegramResult> {
  const { config } = deps;
  const token = config.telegram.token!;
  const bot = new Bot(token);
  const allowFrom = new Set(config.telegram.allowFrom);
  const processedMessages = new Set<string>();
  const sentMessages = new Set<string>();
  const rateCounts = new Map<string, { count: number; resetAt: number }>();
  const typingRefCounts = new Map<string, number>();
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  const tierOverrides = new Map<string, Tier>();

  const dedupTimer = setInterval(() => {
    processedMessages.clear();
    sentMessages.clear();
  }, DEDUP_CLEANUP_MS);

  const isAllowed = (userId: string) => allowFrom.size === 0 || allowFrom.has(userId);

  const isRateLimited = (chatId: string): boolean => {
    const now = Date.now();
    let entry = rateCounts.get(chatId);
    if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + RATE_LIMIT.windowMs }; rateCounts.set(chatId, entry); }
    entry.count++;
    return entry.count > RATE_LIMIT.maxRequests;
  };

  const startTyping = (chatId: string) => {
    const nextCount = (typingRefCounts.get(chatId) ?? 0) + 1;
    typingRefCounts.set(chatId, nextCount);
    if (nextCount > 1) return;
    const send = () => bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
    send();
    typingIntervals.set(chatId, setInterval(send, 4000));
    typingTimeouts.set(chatId, setTimeout(() => {
      typingRefCounts.set(chatId, 0);
      stopTyping(chatId);
    }, TYPING_TIMEOUT_MS));
  };

  const stopTyping = (chatId: string) => {
    const current = typingRefCounts.get(chatId) ?? 0;
    if (current > 1) {
      typingRefCounts.set(chatId, current - 1);
      return;
    }
    typingRefCounts.delete(chatId);
    const iv = typingIntervals.get(chatId);
    if (iv) { clearInterval(iv); typingIntervals.delete(chatId); }
    const to = typingTimeouts.get(chatId);
    if (to) { clearTimeout(to); typingTimeouts.delete(chatId); }
  };

  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const markdownToTelegramHtml = (text: string): string => {
    let html = escapeHtml(text);
    html = html.replace(/```[\w-]*\n([\s\S]*?)```/g, (_m, code: string) => `<pre><code>${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    html = html.replace(/\*([^*]+)\*/g, "<i>$1</i>");
    html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
    return html.replace(/\n{3,}/g, "\n\n");
  };

  const chunkMessage = (text: string, maxLen = 4000): string[] => {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt <= 0) splitAt = maxLen;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  };

  const sendSegment = async (chatId: number, text: string) => {
    const outgoingKey = `${chatId}:${Bun.hash(text)}`;
    if (sentMessages.has(outgoingKey)) {
      log("telegram", "dedup: skipping duplicate outgoing message");
      return;
    }
    sentMessages.add(outgoingKey);

    // Detect image URLs from generation APIs and send as photos
    const imageUrlMatch = text.match(/https:\/\/[^\s"'<>]+\.(png|jpg|jpeg|webp)/i);
    if (imageUrlMatch) {
      await bot.api.sendPhoto(chatId, imageUrlMatch[0]).catch(() => {});
    }

    for (const chunk of chunkMessage(text)) {
      await bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), { parse_mode: "HTML" });
    }
  };

  const sendReply = async (chatId: number, text: string) => {
    const segments = splitOnDelimiter(text);
    for (let i = 0; i < segments.length; i++) {
      await sendSegment(chatId, segments[i]!);
      if (i < segments.length - 1) await new Promise((r) => setTimeout(r, SEGMENT_DELAY_MS + Math.random() * 200));
    }
  };

  const sendStreamReply = async (chatId: number, stream: AsyncIterable<string>, onStop: () => void) => {
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += chunk;
        // Track whether we're inside a code block — don't split there
        const fenceCount = (buffer.match(/```/g) || []).length;
        const inCodeBlock = fenceCount % 2 !== 0;
        if (inCodeBlock) continue;
        const segments = splitOnDelimiter(buffer);
        if (segments.length > 1) {
          for (let i = 0; i < segments.length - 1; i++) {
            await sendSegment(chatId, segments[i]!);
            await new Promise((r) => setTimeout(r, SEGMENT_DELAY_MS + Math.random() * 200));
          }
          buffer = segments[segments.length - 1] ?? "";
        }
      }
      const remaining = buffer.trim();
      if (remaining) await sendSegment(chatId, remaining);
    } finally {
      onStop();
    }
  };

  /** Send pending files from agent result */
  const sendPendingFiles = async (chatId: number, files: Array<{ path: string; caption?: string }>) => {
    for (const file of files) {
      try {
        const buffer = readFileSync(file.path);
        const filename = basename(file.path);
        await bot.api.sendDocument(chatId, new InputFile(buffer, filename), {
          caption: file.caption,
        });
      } catch (err) {
        console.error(`[telegram] Failed to send file ${file.path}:`, err);
      }
    }
  };

  const dedupKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

  // --- Consume tier override for a chat ---
  const consumeTierOverride = (chatId: string): Tier | undefined => {
    const override = tierOverrides.get(chatId);
    if (override) tierOverrides.delete(chatId);
    return override;
  };

  // --- Build content with forwarded/reply metadata ---
  const enrichContent = (text: string, message: any): string => {
    let content = text;

    // Forwarded message metadata (apply first)
    if (message.forward_from) {
      const name = message.forward_from.first_name;
      content = `[forwarded from ${name}]\n\n${content}`;
    } else if (message.forward_from_chat) {
      const title = message.forward_from_chat.title ?? "unknown channel";
      content = `[forwarded from ${title}]\n\n${content}`;
    }

    // Reply threading (can stack with forwarded)
    if (message.reply_to_message?.text) {
      content = `[replying to: "${message.reply_to_message.text.slice(0, 500)}"]\n\n${content}`;
    }

    return content;
  };

  // --- Extract text from a document ---
  const extractDocumentText = async (buffer: Buffer, mimeType: string, fileName: string): Promise<string | null> => {
    const textTypes = [
      "text/plain", "text/markdown", "text/csv", "text/html", "text/xml",
      "application/json", "application/xml",
    ];
    const textExtensions = [".txt", ".md", ".csv", ".json", ".html", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".log"];

    if (mimeType === "application/pdf") {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const result = await pdfParse(buffer);
        return result.text;
      } catch (err) {
        console.error("[telegram] PDF parse error:", err);
        return null;
      }
    }

    if (textTypes.some((t) => mimeType.startsWith(t)) || textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext))) {
      return buffer.toString("utf-8");
    }

    return null;
  };

  // --- Error tracking + reconnect ---
  let consecutiveErrors = 0;

  bot.catch(async (err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error(`[telegram] API error ${e.error_code}: ${e.description}`);
    } else if (e instanceof HttpError) {
      console.error("[telegram] Network error:", e.message);
      consecutiveErrors++;
      if (consecutiveErrors > 5) {
        console.error("[telegram] Too many network errors, restarting bot...");
        consecutiveErrors = 0;
        try { await bot.stop(); } catch {}
        startWithRetry();
      }
    } else {
      console.error("[telegram] Unknown error:", e ?? err);
      consecutiveErrors++;
      if (consecutiveErrors > 5) {
        console.error("[telegram] Too many errors, restarting bot...");
        consecutiveErrors = 0;
        try { await bot.stop(); } catch {}
        startWithRetry();
      }
    }
  });

  // --- Commands ---
  bot.command("start", async (ctx) => {
    if (!isAllowed(String(ctx.from?.id))) { await ctx.reply("Access denied."); return; }
    await ctx.reply("hey. send me a message to get started.");
  });

  bot.command("clear", async (ctx) => {
    if (!isAllowed(String(ctx.from?.id))) return;
    dbMessages.clear(`telegram_${ctx.chat.id}`);
    await ctx.reply("Conversation cleared.");
  });

  bot.command("help", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    await ctx.reply(
      "commands:\n" +
      "/help - this message\n" +
      "/clear - reset conversation\n" +
      "/usage - see token usage and costs\n" +
      "/status - system health summary\n" +
      "/deep - force next message to use deep tier\n" +
      "/fast - force next message to use fast tier\n" +
      "/recap - summarize recent conversation\n" +
      "/memories - list or delete stored memories\n" +
      "/model - view or change models\n\n" +
      "i can also search the web, remember things, run code, set reminders, manage files, generate images, and load skills.\n" +
      "send me voice messages — i'll transcribe and respond.\n" +
      "send me PDFs and text files — i'll read them. reply to messages for context.",
    );
  });

  bot.command("usage", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [today, month, allTime] = [dbUsage.getSummary(senderId, todayStart), dbUsage.getSummary(senderId, monthStart), dbUsage.getSummary(senderId)];
    const fmt = (cost: number) => `$${cost.toFixed(4)}`;
    await ctx.reply(`usage summary:\n\ntoday: ${today.totalRequests} requests, ${fmt(today.totalCost)}\nthis month: ${month.totalRequests} requests, ${fmt(month.totalCost)}\nall time: ${allTime.totalRequests} requests, ${fmt(allTime.totalCost)}`);
  });

  bot.command("status", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;

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
    status += `models: fast=${config.openrouter.fastModel}, deep=${config.openrouter.deepModel}\n`;
    if (nextTask) {
      status += `next task: ${nextTask.description} (${nextTask.nextRunAt})`;
    } else {
      status += `tasks: ${allReady.length} active`;
    }

    await ctx.reply(status);
  });

  bot.command("deep", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    tierOverrides.set(String(ctx.chat.id), "deep");
    await ctx.reply("next message will use deep tier.");
  });

  bot.command("fast", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    tierOverrides.set(String(ctx.chat.id), "fast");
    await ctx.reply("next message will use fast tier.");
  });

  bot.command("recap", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const chatId = String(ctx.chat.id);

    startTyping(chatId);
    try {
      const result = await deps.streamAgent({
        content: "give me a brief recap of our recent conversation — key topics, decisions, and any open items.",
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        source: "command",
      });
      await sendStreamReply(Number(chatId), result.fullStream, () => stopTyping(chatId));
      await result.finishedPromise.catch(console.error);
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Recap error:", err);
      await ctx.reply("ran into an issue generating the recap.").catch(() => {});
    }
  });

  bot.command("memories", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const chatId = String(ctx.chat.id);
    const args = ctx.message!.text.replace(/^\/memories\s*/, "").trim();

    startTyping(chatId);
    try {
      let prompt: string;
      if (args.startsWith("delete ")) {
        const target = args.slice(7).trim();
        prompt = `Delete the memory matching: "${target}". Use the deleteMemory tool. Confirm what was deleted.`;
      } else {
        prompt = "List my 10 most recent memories using the recall tool with a broad query. Number each one clearly.";
      }

      const result = await deps.streamAgent({
        content: prompt,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        source: "command",
      });
      await sendStreamReply(Number(chatId), result.fullStream, () => stopTyping(chatId));
      await result.finishedPromise.catch(console.error);
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Memories error:", err);
      await ctx.reply("ran into an issue with memories.").catch(() => {});
    }
  });

  bot.command("model", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const args = ctx.message!.text.replace(/^\/model\s*/, "").trim();

    if (!args) {
      await ctx.reply(
        `models:\nfast: ${config.openrouter.fastModel}\ndeep: ${config.openrouter.deepModel}\nimage: ${config.openrouter.imageModel}\n\nchange: /model fast <id> or /model deep <id> or /model image <id>`,
      );
      return;
    }

    const [tier, ...modelParts] = args.split(/\s+/);
    const modelId = modelParts.join(" ");

    if ((tier === "fast" || tier === "deep" || tier === "image") && modelId) {
      if (tier === "image") {
        config.openrouter.imageModel = modelId;
      } else {
        config.openrouter[`${tier}Model`] = modelId;
      }
      try {
        await persistConfig(config);
        await ctx.reply(`${tier} model changed to ${modelId}`);
      } catch (err) {
        // Config change takes effect in memory even if persist fails
        await ctx.reply(`${tier} model changed to ${modelId} (config save failed: ${(err as Error).message})`);
      }
    } else {
      await ctx.reply("usage: /model fast <model-id> or /model deep <model-id> or /model image <model-id>");
    }
  });

  // --- Text messages (streaming) ---
  bot.on("message:text", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) { log("telegram", "dedup: text hash collision"); return; }
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    log("telegram", "text from=%s chat=%s len=%d", senderId, chatId, ctx.message.text.length);
    if (isRateLimited(chatId)) { await ctx.reply("slow down! you're sending messages too fast."); return; }

    const content = enrichContent(ctx.message.text, ctx.message);
    const tierOverride = consumeTierOverride(chatId);

    startTyping(chatId);
    try {
      const streamResult = await deps.streamAgent({
        content,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        tierOverride,
        onAck: (text) => ctx.reply(text).catch(() => {}),
      });

      consecutiveErrors = 0;
      await sendStreamReply(Number(chatId), streamResult.fullStream, () => stopTyping(chatId));
      const agentResult = await streamResult.finishedPromise.catch((err) => { console.error(err); return null; });

      // Send pending files
      if (agentResult?.files?.length) {
        await sendPendingFiles(Number(chatId), agentResult.files);
      }
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Stream error:", err);
      await ctx.reply("ran into an issue, try again?").catch(() => {});
    }
  });

  // --- Photo messages (streaming) ---
  bot.on("message:photo", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    log("telegram", "photo from=%s chat=%s", senderId, chatId);
    if (isRateLimited(chatId)) { await ctx.reply("slow down!"); return; }

    let caption = ctx.message.caption ?? "What's in this image?";

    // Reply context for photos
    if (ctx.message.reply_to_message?.text) {
      caption = `[replying to: "${ctx.message.reply_to_message.text.slice(0, 500)}"]\n\n${caption}`;
    }

    const photos = ctx.message.photo;
    if (!photos.length) {
      await ctx.reply("I couldn't read that image.");
      return;
    }
    const largest = photos.at(-1);
    if (!largest) {
      await ctx.reply("I couldn't read that image.");
      return;
    }
    const file = await ctx.api.getFile(largest.file_id);
    if (!file.file_path) {
      await ctx.reply("I couldn't access that image.");
      return;
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      await ctx.reply("I couldn't download that image.");
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    startTyping(chatId);
    try {
      const streamResult = await deps.streamAgent({
        content: caption,
        attachments: [{ type: "image", mimeType: "image/jpeg", data: buffer.toString("base64") }],
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        onAck: (text) => ctx.reply(text).catch(() => {}),
      });

      consecutiveErrors = 0;
      await sendStreamReply(Number(chatId), streamResult.fullStream, () => stopTyping(chatId));
      const agentResult = await streamResult.finishedPromise.catch((err) => { console.error(err); return null; });
      if (agentResult?.files?.length) {
        await sendPendingFiles(Number(chatId), agentResult.files);
      }
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Photo stream error:", err);
      await ctx.reply("ran into an issue, try again?").catch(() => {});
    }
  });

  // --- Document/PDF messages ---
  bot.on("message:document", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    log("telegram", "document from=%s chat=%s", senderId, chatId);
    if (isRateLimited(chatId)) { await ctx.reply("slow down!"); return; }

    const doc = ctx.message.document;
    const fileName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";
    const fileSize = doc.file_size ?? 0;

    if (fileSize > MAX_DOCUMENT_SIZE) {
      await ctx.reply("That file is too large (max 20MB).");
      return;
    }

    // Download the file
    const file = await ctx.api.getFile(doc.file_id);
    if (!file.file_path) {
      await ctx.reply("I couldn't access that file.");
      return;
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      await ctx.reply("I couldn't download that file.");
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Extract text
    const extractedText = await extractDocumentText(buffer, mimeType, fileName);
    if (extractedText === null) {
      await ctx.reply("I can read PDFs and text files (.txt, .md, .csv, .json, .html, .xml). This format isn't supported yet.");
      return;
    }

    const truncatedText = extractedText.slice(0, MAX_DOCUMENT_TEXT);
    const caption = ctx.message.caption ?? "";
    let content = `[document: ${fileName}]\n\n${truncatedText}`;
    if (truncatedText.length < extractedText.length) {
      content += `\n\n[truncated — showing ${MAX_DOCUMENT_TEXT} of ${extractedText.length} characters]`;
    }
    if (caption) {
      content = `${caption}\n\n${content}`;
    }

    // Reply context for documents
    if (ctx.message.reply_to_message?.text) {
      content = `[replying to: "${ctx.message.reply_to_message.text.slice(0, 500)}"]\n\n${content}`;
    }

    startTyping(chatId);
    try {
      const streamResult = await deps.streamAgent({
        content,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        onAck: (text) => ctx.reply(text).catch(() => {}),
      });

      consecutiveErrors = 0;
      await sendStreamReply(Number(chatId), streamResult.fullStream, () => stopTyping(chatId));
      const agentResult = await streamResult.finishedPromise.catch((err) => { console.error(err); return null; });
      if (agentResult?.files?.length) {
        await sendPendingFiles(Number(chatId), agentResult.files);
      }
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Document stream error:", err);
      await ctx.reply("ran into an issue processing that file.").catch(() => {});
    }
  });

  // --- Voice messages ---
  bot.on("message:voice", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    log("telegram", "voice from=%s chat=%s", senderId, chatId);
    if (isRateLimited(chatId)) { await ctx.reply("slow down!"); return; }

    const voice = ctx.message.voice;
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      await ctx.reply("I couldn't access that voice message.");
      return;
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      await ctx.reply("I couldn't download that voice message.");
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribeAudio(buffer, config);
    if (!transcription) {
      await ctx.reply("I couldn't transcribe that voice message. Try again or send it as text.");
      return;
    }

    let content = `[voice message] ${transcription}`;
    content = enrichContent(content, ctx.message);
    const tierOverride = consumeTierOverride(chatId);

    startTyping(chatId);
    try {
      const streamResult = await deps.streamAgent({
        content,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        tierOverride,
        onAck: (text) => ctx.reply(text).catch(() => {}),
      });

      consecutiveErrors = 0;
      await sendStreamReply(Number(chatId), streamResult.fullStream, () => stopTyping(chatId));
      const agentResult = await streamResult.finishedPromise.catch((err) => { console.error(err); return null; });
      if (agentResult?.files?.length) {
        await sendPendingFiles(Number(chatId), agentResult.files);
      }
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Voice stream error:", err);
      await ctx.reply("ran into an issue, try again?").catch(() => {});
    }
  });

  // --- Video note (circle video) messages ---
  bot.on("message:video_note", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    log("telegram", "video_note from=%s chat=%s", senderId, chatId);
    if (isRateLimited(chatId)) { await ctx.reply("slow down!"); return; }

    const videoNote = ctx.message.video_note;
    const file = await ctx.api.getFile(videoNote.file_id);
    if (!file.file_path) {
      await ctx.reply("I couldn't access that video note.");
      return;
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      await ctx.reply("I couldn't download that video note.");
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribeAudio(buffer, config);
    if (!transcription) {
      await ctx.reply("I couldn't transcribe that video note. Try again or send it as text.");
      return;
    }

    let content = `[voice message] ${transcription}`;
    content = enrichContent(content, ctx.message);
    const tierOverride = consumeTierOverride(chatId);

    startTyping(chatId);
    try {
      const streamResult = await deps.streamAgent({
        content,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
        tierOverride,
        onAck: (text) => ctx.reply(text).catch(() => {}),
      });

      consecutiveErrors = 0;
      await sendStreamReply(Number(chatId), streamResult.fullStream, () => stopTyping(chatId));
      const agentResult = await streamResult.finishedPromise.catch((err) => { console.error(err); return null; });
      if (agentResult?.files?.length) {
        await sendPendingFiles(Number(chatId), agentResult.files);
      }
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Video note stream error:", err);
      await ctx.reply("ran into an issue, try again?").catch(() => {});
    }
  });

  // --- Edited message handling ---
  bot.on("edited_message:text", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = `edit:${ctx.editedMessage!.chat.id}:${ctx.editedMessage!.message_id}`;
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.editedMessage!.chat.id);
    log("telegram", "edited text from=%s chat=%s", senderId, chatId);
    if (isRateLimited(chatId)) return;

    const content = `[edited] ${ctx.editedMessage!.text}`;

    startTyping(chatId);
    try {
      const streamResult = await deps.streamAgent({
        content,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`,
      });

      consecutiveErrors = 0;
      await sendStreamReply(Number(chatId), streamResult.fullStream, () => stopTyping(chatId));
      await streamResult.finishedPromise.catch(console.error);
    } catch (err) {
      stopTyping(chatId);
      console.error("[telegram] Edited message error:", err);
    }
  });

  // --- Start polling with retry ---
  const startWithRetry = async () => {
    let delay = 1000;
    const maxDelay = 60_000;
    while (true) {
      try {
        await bot.start({
          onStart: async () => {
            console.log("[telegram] Bot is running");
            consecutiveErrors = 0;
            // Notify admins
            for (const adminId of config.telegram.adminIds) {
              bot.api.sendMessage(Number(adminId), `koda v${VERSION} is online.`).catch(() => {});
            }
          },
        });
        break;
      } catch (err) {
        console.error(`[telegram] Connection failed, retrying in ${delay / 1000}s...`, err);
        await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  };

  // --- Environment detection ---
  const kodaEnv = process.env.KODA_ENV ?? (config.telegram.useWebhook ? "production" : "development");
  const isAdmin = (userId: string) => config.telegram.adminIds.includes(userId);
  const bootTime = new Date();

  // --- Notify admins helper ---
  const notifyAdmins = async (text: string) => {
    for (const adminId of config.telegram.adminIds) {
      await bot.api.sendMessage(Number(adminId), text).catch(() => {});
    }
  };

  // --- /debug command (admin-only) ---
  bot.command("debug", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAdmin(senderId)) { await ctx.reply("admin only."); return; }

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
    msg += `---\n`;
    msg += `today: ${todayUsage.totalRequests} req, $${todayUsage.totalCost.toFixed(4)}\n`;
    msg += `month: ${monthUsage.totalRequests} req, $${monthUsage.totalCost.toFixed(4)}\n`;
    msg += `all-time: ${allUsage.totalRequests} req, $${allUsage.totalCost.toFixed(4)}\n`;
    msg += `tasks: ${allTasks.length} active\n`;
    msg += `node: ${process.version}\n`;
    msg += `platform: ${process.platform}/${process.arch}`;

    await ctx.reply(msg);
  });

  // --- Initialize bot (required before handleUpdate in webhook mode) ---
  await bot.init();
  console.log(`[telegram] Bot initialized: @${bot.botInfo.username}`);

  // --- Webhook or polling ---
  if (config.telegram.useWebhook && config.telegram.webhookUrl) {
    // Webhook mode — register with retry (Railway networking may not be ready on first boot)
    const setWebhookWithRetry = async (retries = 5, delay = 3000) => {
      for (let i = 0; i < retries; i++) {
        try {
          await bot.api.setWebhook(config.telegram.webhookUrl!, {
            secret_token: config.telegram.webhookSecret,
          });
          // Verify it actually took
          const info = await bot.api.getWebhookInfo();
          if (info.url === config.telegram.webhookUrl) {
            console.log("[telegram] Webhook set:", config.telegram.webhookUrl);
            return;
          }
          console.warn(`[telegram] Webhook URL mismatch after set (got "${info.url}"), retrying...`);
        } catch (err) {
          console.warn(`[telegram] setWebhook attempt ${i + 1}/${retries} failed:`, (err as Error).message);
        }
        if (i < retries - 1) await new Promise((r) => setTimeout(r, delay));
      }
      console.error("[telegram] Failed to set webhook after all retries!");
    };
    await setWebhookWithRetry();

    // Re-register webhook after 10s to survive old container's shutdown race
    setTimeout(async () => {
      try {
        const info = await bot.api.getWebhookInfo();
        if (info.url !== config.telegram.webhookUrl) {
          console.warn("[telegram] Webhook was cleared (deploy race), re-registering...");
          await bot.api.setWebhook(config.telegram.webhookUrl!, {
            secret_token: config.telegram.webhookSecret,
          });
          console.log("[telegram] Webhook re-registered successfully");
        }
      } catch (err) {
        console.error("[telegram] Webhook re-check failed:", (err as Error).message);
      }
    }, 10_000);

    // Notify admins bot is online
    await notifyAdmins(`koda v${VERSION} is online. [${kodaEnv}]`);

    return {
      notifyAdmins,
      async sendDirect(chatId: string, text: string) {
        const id = Number(chatId);
        if (!Number.isFinite(id)) throw new Error("Invalid chat id");
        await sendReply(id, text);
      },
      async stop() {
        for (const chatId of typingIntervals.keys()) stopTyping(chatId);
        clearInterval(dedupTimer);
        processedMessages.clear();
        sentMessages.clear();
        await notifyAdmins(`koda is updating, give me a sec... [${kodaEnv}]`);
        // Do NOT call deleteWebhook() — during Railway zero-downtime deploys,
        // the new container sets the webhook first, then the old container shuts down.
        // Calling deleteWebhook here would wipe the new container's registration.
      },
      async handleWebhook(req: Request): Promise<Response> {
        // Verify secret token if configured
        if (config.telegram.webhookSecret) {
          const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
          if (secretHeader !== config.telegram.webhookSecret) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
        try {
          const update = await req.json();
          await bot.handleUpdate(update);
          return new Response("ok");
        } catch (err) {
          console.error("[telegram] Webhook error:", err);
          return new Response("error", { status: 500 });
        }
      },
    };
  }

  // Polling mode
  startWithRetry();

  return {
    notifyAdmins,
    async sendDirect(chatId: string, text: string) {
      const id = Number(chatId);
      if (!Number.isFinite(id)) throw new Error("Invalid chat id");
      await sendReply(id, text);
    },
    async stop() {
      for (const chatId of typingIntervals.keys()) stopTyping(chatId);
      clearInterval(dedupTimer);
      processedMessages.clear();
      sentMessages.clear();
      await notifyAdmins(`koda is updating, give me a sec... [${kodaEnv}]`);
      await bot.stop();
    },
  };
}
