import { PoolDetailView } from "@/components/PoolDetailView";

export default async function PoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PoolDetailView id={decodeURIComponent(id)} />;
}
