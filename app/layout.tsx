import type { Metadata } from "next";
import "./globals.css";
import Image from "next/image";
import logo from "@/app/assets/getautocue_logo_mid.png";

export const metadata: Metadata = {
  title: "getautocue",
  description:
    "A voice controlled teleprompter in your browser - Powered by AssemblyAI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <div className="fixed top-0 left-0 z-50 p-4">
          <Image src={logo} alt="getautocue logo" className="h-12 w-12" />
        </div>
        {children}
      </body>
    </html>
  );
}
