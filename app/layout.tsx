import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CueAuto",
  description: "A voice following teleprompter in your browser",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
