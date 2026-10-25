import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/stack-sans-notch";
import { PlatformShell } from "./components/PlatformShell";
import { FinanceProvider } from "./provider";
import "./base.css";

export const metadata: Metadata = {
  title: "Mangekyo",
  description: "Every dollar in a pooled account, proven to its owner.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><PlatformShell><FinanceProvider>{children}</FinanceProvider></PlatformShell></body></html>;
}
