/**
 * Telegram channel — Grammy bot with voice pipeline (Gemini STT via OpenRouter + Cartesia TTS).
 *
 * Direct ctx.reply() after runAgent(), no MessageBus.
 */

import { Bot } from "grammy";
import type { Config } from "../config.js";
import { messages as dbMessages, usage as dbUsage } from "../db.js";

export interface TelegramDeps {
  runAgent: (input: {
    content: string; senderId: string; chatId: string; channel: string;
    sessionKey: string; source?: string;
    onAck?: (text: string) => void;
    onTypingStart?: () => void;
    onTypingStop?: () => void;
  }) => Promise<{ text: string }>;
  config: Config;
}

/** Safety timeout: auto-stop typing after 2 minutes */
const TYPING_TIMEOUT_MS = 120_000;
const DEDUP_CLEANUP_MS = 5 * 60_000;
const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

export function startTelegram(deps: TelegramDeps): { stop: () => Promise<void>; sendDirect: (chatId: string, text: string) => Promise<void> } {
  const { config } = deps;
  const token = config.telegram.token!;
  const bot = new Bot(token);
  const allowFrom = new Set(config.telegram.allowFrom);
  const processedMessages = new Set<string>();
  const rateCounts = new Map<string, { count: number; resetAt: number }>();
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  const dedupTimer = setInterval(() => processedMessages.clear(), DEDUP_CLEANUP_MS);

  const isAllowed = (userId: string) => allowFrom.size === 0 || allowFrom.has(userId);

  const isRateLimited = (chatId: string): boolean => {
    const now = Date.now();
    let entry = rateCounts.get(chatId);
    if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + RATE_LIMIT.windowMs }; rateCounts.set(chatId, entry); }
    entry.count++;
    return entry.count > RATE_LIMIT.maxRequests;
  };

  const startTyping = (chatId: string) => {
    if (typingIntervals.has(chatId)) return;
    const send = () => bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
    send();
    typingIntervals.set(chatId, setInterval(send, 4000));
    typingTimeouts.set(chatId, setTimeout(() => stopTyping(chatId), TYPING_TIMEOUT_MS));
  };

  const stopTyping = (chatId: string) => {
    const iv = typingIntervals.get(chatId);
    if (iv) { clearInterval(iv); typingIntervals.delete(chatId); }
    const to = typingTimeouts.get(chatId);
    if (to) { clearTimeout(to); typingTimeouts.delete(chatId); }
  };

  const stripMarkdown = (text: string): string =>
    text.replace(/^#{1,6}\s+/gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1")
      .replace(/__(.+?)__/g, "$1").replace(/_(.+?)_/g, "$1").replace(/~~(.+?)~~/g, "$1")
      .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/^`{3}\w*\n?/, "").replace(/\n?`{3}$/, ""))
      .replace(/`(.+?)`/g, "$1").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^>\s?/gm, "").replace(/^---+$/gm, "").replace(/\n{3,}/g, "\n\n");

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

  const sendReply = async (chatId: number, text: string) => {
    const segments = text.split("|||").map((s) => stripMarkdown(s.trim())).filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      for (const chunk of chunkMessage(segments[i]!)) {
        await bot.api.sendMessage(chatId, chunk);
      }
      if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
    }
  };

  const dedupKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;

  // --- STT: Gemini 3 Flash via OpenRouter ---
  const transcribe = async (audioBuffer: Buffer): Promise<string | null> => {
    try {
      const base64Audio = audioBuffer.toString("base64");
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Transcribe this audio exactly as spoken. Return only the transcription, nothing else." },
              { type: "input_audio", input_audio: { data: base64Audio, format: "ogg" } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(config.timeouts.voice),
      });

      if (!res.ok) return null;
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch {
      return null;
    }
  };

  // --- TTS: Cartesia Sonic 3 ---
  const synthesize = async (text: string): Promise<Buffer | null> => {
    const cartesiaKey = config.voice.cartesiaApiKey;
    if (!cartesiaKey) return null;

    try {
      const res = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "X-API-Key": cartesiaKey,
          "Cartesia-Version": "2025-04-16",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: "sonic-3",
          transcript: text.slice(0, 4096),
          voice: {
            mode: "id",
            id: config.voice.cartesiaVoiceId,
          },
          output_format: {
            container: "mp3",
            encoding: "pcm_f32le",
            sample_rate: 44100,
          },
        }),
        signal: AbortSignal.timeout(config.timeouts.voice),
      });

      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  };

  // --- Error tracking + reconnect ---
  let consecutiveErrors = 0;

  bot.catch(async (err) => {
    console.error("[telegram] Grammy error:", err.error ?? err);
    consecutiveErrors++;
    if (consecutiveErrors > 5) {
      console.error("[telegram] Too many errors, restarting bot...");
      consecutiveErrors = 0;
      try { await bot.stop(); } catch {}
      startWithRetry();
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

  // --- Text messages ---
  bot.on("message:text", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) { await ctx.reply("slow down! you're sending messages too fast."); return; }

    const result = await deps.runAgent({
      content: ctx.message.text,
      senderId, chatId, channel: "telegram",
      sessionKey: `telegram_${chatId}`,
      onAck: (text) => ctx.reply(text).catch(() => {}),
      onTypingStart: () => startTyping(chatId),
      onTypingStop: () => stopTyping(chatId),
    });

    consecutiveErrors = 0;
    await sendReply(Number(chatId), result.text);
  });

  // --- Voice messages ---
  bot.on("message:voice", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) { await ctx.reply("slow down!"); return; }

    try {
      const file = await ctx.getFile();
      if (!file.file_path) { await ctx.reply("I couldn't access that voice message."); return; }

      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch voice (${response.status})`);
      const buffer = Buffer.from(await response.arrayBuffer());

      const transcription = await transcribe(buffer);
      if (!transcription) { await ctx.reply("I couldn't transcribe that audio."); return; }

      const result = await deps.runAgent({
        content: transcription,
        senderId, chatId, channel: "telegram",
        sessionKey: `telegram_${chatId}`, source: "voice",
        onAck: (text) => ctx.reply(text).catch(() => {}),
        onTypingStart: () => startTyping(chatId),
        onTypingStop: () => stopTyping(chatId),
      });

      consecutiveErrors = 0;

      // Voice reply first, text as fallback
      const audioBuffer = await synthesize(result.text.replace(/\|\|\|/g, " ").slice(0, 4096));
      if (audioBuffer) {
        await ctx.replyWithVoice(new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" }) as any);
      } else {
        await sendReply(Number(chatId), result.text);
      }
    } catch (err) {
      console.error("[telegram] Voice processing error:", err);
      await ctx.reply("Failed to process voice message.");
    }
  });

  // --- Photo messages ---
  bot.on("message:photo", async (ctx) => {
    const senderId = String(ctx.from?.id);
    if (!isAllowed(senderId)) return;
    const key = dedupKey(ctx.chat.id, ctx.message.message_id);
    if (processedMessages.has(key)) return;
    processedMessages.add(key);
    const chatId = String(ctx.chat.id);
    if (isRateLimited(chatId)) { await ctx.reply("slow down!"); return; }

    const caption = ctx.message.caption ?? "What's in this image?";

    const result = await deps.runAgent({
      content: caption,
      senderId, chatId, channel: "telegram",
      sessionKey: `telegram_${chatId}`,
      onAck: (text) => ctx.reply(text).catch(() => {}),
      onTypingStart: () => startTyping(chatId),
      onTypingStop: () => stopTyping(chatId),
    });

    consecutiveErrors = 0;
    await sendReply(Number(chatId), result.text);
  });

  // --- Start polling with retry ---
  const startWithRetry = async () => {
    let delay = 1000;
    const maxDelay = 60_000;
    while (true) {
      try {
        await bot.start({ onStart: () => { console.log("[telegram] Bot is running"); consecutiveErrors = 0; } });
        break;
      } catch (err) {
        console.error(`[telegram] Connection failed, retrying in ${delay / 1000}s...`, err);
        await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  };
  startWithRetry();

  return {
    async sendDirect(chatId: string, text: string) {
      const id = Number(chatId);
      if (!Number.isFinite(id)) throw new Error("Invalid chat id");
      await sendReply(id, text);
    },
    async stop() {
      for (const chatId of typingIntervals.keys()) stopTyping(chatId);
      clearInterval(dedupTimer);
      processedMessages.clear();
      await bot.stop();
    },
  };
}
