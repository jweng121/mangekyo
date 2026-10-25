import { NextRequest, NextResponse } from "next/server";
import type { InvestigationChatMessage } from "../../../../../../packages/contracts";
import { auditProvider } from "../../../../lib/audit-provider";
import { assertLocalAccess } from "../../../../lib/local-access";
import { appendChatMessage, readInvestigation } from "../../../../lib/local-store";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertLocalAccess(request);
    const { question, snapshotId, conversationId, conversationTitle } = await request.json() as { question?: string; snapshotId?: string; conversationId?: string; conversationTitle?: string };
    if ((conversationId !== undefined && (typeof conversationId !== "string" || conversationId.length > 100)) || (conversationTitle !== undefined && (typeof conversationTitle !== "string" || conversationTitle.length > 80))) return NextResponse.json({ error: "Invalid conversation" }, { status: 400 });
    if (!question?.trim() || question.length > 2000) return NextResponse.json({ error: "Question must be 1 to 2000 characters" }, { status: 400 });
    const record = await readInvestigation();
    const selected = record.snapshots.find(snapshot => snapshot.id === snapshotId);
    if (!selected) return NextResponse.json({ error: "Select a saved snapshot" }, { status: 400 });
    const provider = auditProvider();
    const answer = await provider.answer(question, selected, { ...record, chatMessages: record.chatMessages.filter(message => (message.conversationId ?? "default") === (conversationId ?? "default")) });
    const createdAt = new Date().toISOString();
    const user: InvestigationChatMessage = { id: crypto.randomUUID(), runId: selected.runId, role: "user", text: question.trim(), snapshotIds: [selected.id], provider: "local", createdAt };
    const assistant: InvestigationChatMessage = { id: crypto.randomUUID(), runId: selected.runId, role: "assistant", text: answer.text, sections: answer.sections, snapshotIds: answer.snapshotIds, provider: answer.provider, createdAt };
    if (conversationId) { user.conversationId = assistant.conversationId = conversationId; user.conversationTitle = assistant.conversationTitle = conversationTitle; }
    await appendChatMessage(user);
    await appendChatMessage(assistant);
    return NextResponse.json({ user, assistant });
  } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 500 }); }
}
