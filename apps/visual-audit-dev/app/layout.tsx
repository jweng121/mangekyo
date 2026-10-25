import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/stack-sans-notch";
import "./globals.css";
import "./memory.css";
import "./narration.css";
import "./real.css";
import "./monochrome.css";
import "./conversation.css";
import "./companion.css";
import "./review.css";

export const metadata: Metadata = {
  title: "Mangekyo | Visual Agent Audit",
  icons: { icon: "/mangekyo-logo.png", apple: "/mangekyo-logo.png" },
  description: "Visual investigation of monitored agent browser evidence.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
