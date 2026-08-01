import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Planner Exporter",
  description: "Local PLATSA, PAX, and METHOD OBJ export dashboard.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
