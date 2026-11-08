import type { Metadata } from "next";
import "./globals.css";
import "./illustrated.css";

export const metadata: Metadata = {
  title: {default:"Nabda — The story of a text",template:"%s · Nabda"},
  description: "Connect your Android phone, get an API key, and send SMS from your own SIM. Free to use, with your message queue on your phone.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
