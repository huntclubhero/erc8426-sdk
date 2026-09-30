import { notFound } from "next/navigation";

import { PassDetail } from "@/components/PassDetail";

export default async function PassPage({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  if (!/^[0-9]{1,78}$/.test(tokenId)) notFound();
  return <PassDetail tokenId={tokenId} />;
}
