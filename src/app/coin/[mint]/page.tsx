import CoinAgentView from "@/components/CoinAgentView";

export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return <CoinAgentView mint={mint} />;
}
