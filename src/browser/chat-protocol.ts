export const CHAT_BIND = "chat.bind";
export const CHAT_REQUEST = "automations:chat:request:v1";
export const CHAT_REPLY = "automations:chat:reply:v1";

export function chatRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid automation chat message");
  return Object.fromEntries(Object.entries(value));
}

export function chatString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid automation chat identity");
  return value;
}
