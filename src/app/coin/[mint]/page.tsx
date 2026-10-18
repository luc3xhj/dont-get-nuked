import { redirect } from "next/navigation";

// Coins open in the terminal's focus panel.
export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  redirect(`/?coin=${encodeURIComponent(mint)}`);
}
