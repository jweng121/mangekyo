import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FinanceProvider } from "./provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mangekyo | Finance Development",
  description: "Synthetic finance persistence and live audit integration.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><FinanceProvider>{children}</FinanceProvider></body></html>;
}
