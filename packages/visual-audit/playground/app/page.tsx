import {
  AgentChat,
  AuditPanel,
  ScreenshotViewer,
  SnapshotGraph,
} from "@mangekyo/visual-audit";

export default function PlaygroundPage() {
  return (
    <main>
      <h1>Visual Audit Playground</h1>
      <p>Local workspace for developing Mangekyo visual audit components.</p>
      <AgentChat />
      <SnapshotGraph />
      <ScreenshotViewer />
      <AuditPanel />
    </main>
  );
}
