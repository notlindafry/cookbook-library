import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter } from "next/font/google";
import "./globals.css";

// Canonical shared fonts (single source of truth: vibe-shelf). Loaded as
// variable fonts — no weight array — and self-hosted by next/font at build,
// so every weight is available and there is no external font request.
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const serif = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Linda's Cookbook Collection Search",
  description:
    "Search Linda's cookbook collection in plain English — find recipes by dish, ingredient, cuisine, or mood.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.svg",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "cookbook-finder",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0F120D",
  width: "device-width",
  initialScale: 1,
};

// Render dynamically so the per-request CSP nonce (set in middleware) is applied
// to script tags. Static prerendering would bake in HTML without the nonce.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
