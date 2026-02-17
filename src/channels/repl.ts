/**
 * REPL channel — simple readline interface for terminal chat.
 */

import * as readline from "readline";
const MESSAGE_DELIMITER = "<|msg|>";

export interface ReplDeps {
  runAgent: (input: { content: string; senderId: string; chatId: string; channel: string; sessionKey: string }) => Promise<{ text: string }>;
  userId: string;
  chatId: string;
  prompt: string;
}

export function startRepl(deps: ReplDeps): { stop: () => void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > 50_000) { console.log("Message too long (max 50,000 characters)"); return; }

    const result = await deps.runAgent({
      content: trimmed,
      senderId: deps.userId,
      chatId: deps.chatId,
      channel: "cli",
      sessionKey: `cli_${deps.chatId}`,
    });

    const prefix = deps.prompt ? `${deps.prompt}: ` : "";
    // Split on the same delimiter used by Telegram.
    const segments = result.text.split(MESSAGE_DELIMITER).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      console.log(`${prefix}${seg}`);
    }
  });

  rl.on("close", () => { /* stdin closed */ });

  return { stop: () => rl.close() };
}
