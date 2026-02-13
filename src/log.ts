let enabled = false;
export function enableDebug() { enabled = true; }
export const log = (tag: string, ...args: unknown[]) => {
  if (enabled) console.log(`[${tag}]`, ...args);
};
