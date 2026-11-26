import { TradeView } from "@/components/trade/TradeView";

export default async function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TradeView id={decodeURIComponent(id).toLowerCase()} />;
}
