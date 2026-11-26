import { PoolTable } from "@/components/PoolTable";
import { PageHeader } from "@/components/ui";

export default function PoolsPage() {
  return (
    <>
      <PageHeader
        title="Stock pools"
        lede={
          <>
            Each pool splits one tokenized stock into <b className="text-stable">sUSD</b>, a dollar backed by the stock, and{" "}
            <b className="text-lever">xSTOCK</b>, leverage of about 2x that is never liquidated. Every launch opens a new pool: Flap opened NVDA, Four.meme opened TSLA.
          </>
        }
      />
      <PoolTable />
    </>
  );
}
