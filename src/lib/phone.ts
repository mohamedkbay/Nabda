export function normalizeE164(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, "");
  const normalized = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
