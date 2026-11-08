import type { SVGProps } from "react";

export function Mark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true" {...props}><path d="M14 8C7 8 6 12 6 19v24c0 7 4 10 11 10h9l11 7 1-7h12c6 0 9-4 9-10V19c0-8-4-11-12-11H14Z" fill="currentColor"/><path d="M16 31h8l5-10 7 21 5-11h7" stroke="var(--mark-line, #faf9f4)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
export function Arrow({ className, ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} {...props}><path d="M4 12h15M13 5l7 7-7 7"/></svg>;
}
export function Coffee({ className, ...props }: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} {...props}><path d="M12 24c2 12 0 25 15 25 14 0 16-12 17-25H12Zm32 3c17-6 16 15-4 13M8 54c11 2 26 2 40 0M23 17c-9-8 8-10 0-16M34 17c-8-7 7-9 1-14"/></svg>;
}
export function CopyIcon(){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h4"/></svg>;}
