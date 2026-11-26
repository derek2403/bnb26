import type { ReactNode } from "react";
import "@/styles/openfour/tokens.css";
import "@/styles/openfour/base.css";

export default function MemesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="of-page -mx-4 -mt-6 rounded-none">
      <div className="of-main">
        <div className="mb-4 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--of-border-strong)", color: "var(--of-muted)" }}>
          Four.meme launchpad · our OpenFour fork on BSC testnet with the &quot;SplitStock Pool Launch&quot; preset (styled with OpenFour&apos;s frontend tokens). It never
          touches the shared testnet Core.
        </div>
        {children}
      </div>
    </div>
  );
}
