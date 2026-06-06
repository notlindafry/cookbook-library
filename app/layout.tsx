import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Linda's Cookbook Collection Search",
  description:
    "Search Linda's cookbook collection in plain English — find recipes by dish, ingredient, cuisine, or mood.",
};

// Render dynamically so the per-request CSP nonce (set in middleware) is applied
// to script tags. Static prerendering would bake in HTML without the nonce,
// causing the browser to block the page's scripts.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
