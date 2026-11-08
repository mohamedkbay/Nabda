"use client";

type Language = "en" | "ar";

export function useLanguage(): { language: Language; toggle: () => void } {
  return { language: "en", toggle: () => {} };
}

export function Frame({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
