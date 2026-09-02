export function normalizeE164(value: string): string | null {
  const latinDigits = value.trim()
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
  const compact = latinDigits.replace(/[\s().-]/g, "");
  let normalized = compact;
  if (compact.startsWith("00")) normalized = `+${compact.slice(2)}`;
  else if (compact.startsWith("218")) normalized = `+${compact}`;
  else if (/^0\d{8,9}$/.test(compact)) normalized = `+218${compact.slice(1)}`;
  else if (/^9\d{8}$/.test(compact)) normalized = `+218${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
