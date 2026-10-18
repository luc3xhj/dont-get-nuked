import CoinView from "@/components/CoinView";

export default async function CoinPage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  return <CoinView pairAddress={pair} />;
}
