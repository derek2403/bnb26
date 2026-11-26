import { ScenarioView } from "@/components/ScenarioView";
import { PageHeader } from "@/components/ui";

export default function ScenarioPage() {
  return (
    <>
      <PageHeader
        title="Scenario"
        lede="Break a pool on purpose. When leverage gets too high, the pool sells stock for USDC itself. If Atlas and CMC disagree, minting stops. In a crash, the Flap tax vault steps in."
      />
      <ScenarioView />
    </>
  );
}
