import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Header from "@/components/Header";
import OrderEngine from "@/components/OrderEngine";
import Toaster from "@/components/Toaster";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Don't Get Nuked",
  description: "Paper-trade Solana meme coins with live market data and a simulated wallet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <WalletProvider>
          <OrderEngine />
          <Header />
          <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
          <Toaster />
        </WalletProvider>
      </body>
    </html>
  );
}
