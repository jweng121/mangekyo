import { MangekyoWorkspace } from "@mangekyo/visual-audit";
import { CompanionWorkspace } from "./CompanionWorkspace";

export default async function PlaygroundPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  return (await searchParams).mode === "synthetic" ? <MangekyoWorkspace /> : <CompanionWorkspace />;
}
