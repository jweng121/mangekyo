import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Schibsted_Grotesk, Spline_Sans_Mono } from "next/font/google";
import { FinanceProvider } from "./provider";

const display = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const mono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Mangekyo",
  description: "Every dollar in a pooled account, proven to its owner.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={`${display.variable} ${mono.variable}`}><body style={{ margin: 0 }}><FinanceProvider>{children}</FinanceProvider></body></html>;
}
