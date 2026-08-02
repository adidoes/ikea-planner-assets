import type { Metadata } from "next";
import { PLANNERS } from "@ikea-planner-assets/planner-registry";
import "./globals.css";

export const metadata: Metadata = {
  title: "Planner Exporter",
  description: `Local OBJ export dashboard for ${PLANNERS.length} IKEA planners.`,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
