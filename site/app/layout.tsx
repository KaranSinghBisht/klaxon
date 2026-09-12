import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

/* Bricolage carries the display: it has actual drawing in it, so a headline reads as lettering
   rather than as a system font scaled up. Hanken sets the body at weight 500, which holds up on a
   near-black ground where a 400 would go thin and grey. Plex Mono carries every hash, account id
   and transaction, because those are the parts a reader is meant to check rather than read. */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["600", "700", "800"],
  display: "swap",
});

const body = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "KLAXON — stolen, but never quietly",
  description:
    "CI secrets that a stolen credential cannot use. Share A is encrypted under a Ledger Key Ring; share B is released only against a Hedera payment whose memo is the commitment, bound to the workflow that asked.",
  openGraph: {
    title: "KLAXON — stolen, but never quietly",
    description:
      "Take the encrypted share, the Ledger credential, the payment key and the release step. You still cannot use them anywhere but the job the owner authorised.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${plexMono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
