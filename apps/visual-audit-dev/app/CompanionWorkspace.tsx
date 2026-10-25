"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { InvestigationRecord, InvestigationReport, NarratedExplanation, Snapshot } from "../../../packages/contracts";
import { buildSpokenReply, buildWalkthroughDialogue, BrowserTtsProvider, CloudTtsProvider, MangekyoAvatar, NarrationController, SnapshotBranchGraph, visualActionsForQuestion, validatedFocus } from "@mangekyo/visual-audit";
import { CorrectionStatusMessage } from "./CorrectionStatusMessage";
import * as Tabs from "@radix-ui/react-tabs";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowUp, ArrowUpRight, ArrowRight, Check, ChevronDown, ChevronRight, CircleAlert, FileText, GitBranch, Inbox, PanelLeftOpen, MessageSquare, Mic, PanelLeftClose, Search, Scan, Square, Maximize2, Minimize2, Plus, X, Columns2 } from "lucide-react";
import { IconButton, ReviewMenu } from "./ReviewControls";
import { annotationContext } from "./annotation-context";
import { useMicrophoneMeter } from "./useMicrophoneMeter";
import { SnapshotChatReply } from "./SnapshotChatReply";
import { WalkthroughIsland } from "./WalkthroughIsland";
import { EvidenceCanvas } from "./EvidenceCanvas";

const empty: InvestigationRecord = { runs: [], events: [], snapshots: [], steeringRequests: [], reports: [], chatMessages: [], memoryRecords: [], findings: [], escalations: [] };
const taskName = (id: string) => id === "bank-line-1042" ? "Deposit ownership" : id.replaceAll(/[-_]/g, " ").replace(/^./, letter => letter.toUpperCase());
const agentName = (id: string) => id === "deposit-matching-agent" ? "Matching Agent" : id.replaceAll(/[-_]/g, " ").replace(/^./, letter => letter.toUpperCase());
const shortTime = (date: string) => new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });


type Task = { id: string; title: string; taskId: string; runIds: string[]; agentId: string; status: string; reviewLabel?: string; latestAt: string; searchable: string };
function tasksFrom(record: InvestigationRecord): Task[] {
  return record.runs.filter(run => !run.parentRunId && record.escalations.some(item => item.runId === run.id)).map(root => {
    const branches = record.runs.filter(run => run.parentRunId === root.id);
    const runIds = [root.id, ...branches.map(run => run.id)];
    const latest = branches.at(-1) ?? root;
    const escalated = record.escalations.some(item => item.runId === root.id && item.status === "open");
    const status = escalated ? "escalated" : "resolved";
    const report = [...record.reports].reverse().find(item => item.runId === root.id);
    const reviewLabel = escalated && branches.length ? report?.status === "filed" ? "Review filed" : "Human review open" : undefined;
    const title = root.displayName ?? taskName(root.taskId);
    const searchable = [title, taskName(root.taskId), agentName(root.agentId), root.taskId, root.agentId, ...record.snapshots.filter(item => runIds.includes(item.runId)).flatMap(item => [item.documentId ?? "", ...item.observation.fields.map(field => field.value)])].join(" ").toLowerCase();
    return { id: root.id, title, taskId: root.taskId, runIds, agentId: root.agentId, status, reviewLabel, latestAt: latest.createdAt, searchable };
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

type SpeechResult = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRecognitionLike = { lang: string; interimResults: boolean; continuous: boolean; onstart: (() => void) | null; onend: (() => void) | null; onresult: ((event: SpeechResult) => void) | null; onerror: ((event: { error?: string }) => void) | null; onspeechstart: (() => void) | null; onspeechend: (() => void) | null; start(): void; stop(): void };

export function CompanionWorkspace() {
  const [chatExpanded, setChatExpanded] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [conversationId, setConversationId] = useState("default");
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; caseId: string; title: string }>>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [liveCaption, setLiveCaption] = useState("");
  const [spokenCharIndex, setSpokenCharIndex] = useState(-1);
  const [record, setRecord] = useState<InvestigationRecord>(empty);
  const [taskId, setTaskId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [snapshotId, setSnapshotId] = useState<string>();
  const [follow, setFollow] = useState(false);
  const [query, setQuery] = useState("");
  const [inspectorTab, setInspectorTab] = useState("annotations");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [branchId, setBranchId] = useState<string>();
  const [composeMode, setComposeMode] = useState<"question" | "correction">("question");
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string>();
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [flowMessages, setFlowMessages] = useState<Array<{ id: string; text: string; kind?: "system" | "assistant" }>>([]);
  const [thinking, setThinking] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string>();
  const [listening, setListening] = useState(false);
  const microphoneMeter = useMicrophoneMeter(listening);
  const [voiceReply, setVoiceReply] = useState("");
  const [answerNarration, setAnswerNarration] = useState<NarratedExplanation>();
  const voiceSession = useRef(0);
  const [dictationError, setDictationError] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [draft, setDraft] = useState("");
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [focusBubble, setFocusBubble] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [steerOpen, setSteerOpen] = useState(false);
  const [instruction, setInstruction] = useState("The payment reference identifies Client B. Reevaluate the ownership allocation using the original bank evidence.");
  const [reportText, setReportText] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [caseStatus, setCaseStatus] = useState("escalated");
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const annotationRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const narrator = useRef<NarrationController | null>(null);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const voiceTranscript = useRef("");
  const voiceFinalizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const voiceFinalizing = useRef(false);
  const snapshotsRef = useRef(record.snapshots); snapshotsRef.current = record.snapshots;
  const steeringStartedAt = useRef(0);
  const steeringStage = useRef<"none" | "submitted" | "running">("none");
  useEffect(() => { if (window.innerWidth < 760) setSidebarOpen(false); }, []);

  const tasks = useMemo(() => tasksFrom(record), [record]);
  const task = tasks.find(item => item.id === taskId) ?? tasks.find(item => item.status === caseStatus);
  const taskRuns = record.runs.filter(item => task?.runIds.includes(item.id));
  const activeRun = taskRuns.find(item => item.id === runId) ?? taskRuns.find(item => item.id === task?.id) ?? taskRuns[0];
  const originalRun = taskRuns.find(item => item.id === task?.id);
  const escalation = record.escalations.find(item => item.runId === originalRun?.id && item.status === "open");
  const snapshots = record.snapshots.filter(item => item.runId === activeRun?.id).sort((a, b) => a.sequence - b.sequence);
  const latest = snapshots.at(-1);
  const latestCapture = [...snapshots].reverse().find(item => item.screenshot?.provenance === "actual");
  const selected = snapshots.find(item => item.id === snapshotId) ?? (follow ? latestCapture ?? latest : snapshots.find(item => item.id === escalation?.snapshotId) ?? snapshots.find(item => item.auditStatus === "flagged") ?? latestCapture ?? latest);
  const visual = selected;
  const finding = record.findings.find(item => item.runId === originalRun?.id);
  const proposal = record.snapshots.find(item => item.runId === originalRun?.id && item.actionType === "PROPOSE");
  const report = [...record.reports].reverse().find(item => item.runId === originalRun?.id);
  const memory = [...record.memoryRecords].reverse().find(item => item.sourceReportId === report?.id);
  const messages = [...record.chatMessages.filter(item => task?.runIds.includes(item.runId) && (item.conversationId ?? "default") === conversationId), ...record.steeringRequests.filter(item => conversationId === "default" && item.parentRunId === task?.id).map(item => ({ id: `steering-chat-${item.id}`, runId: item.parentRunId, role: "user" as const, text: item.instruction, snapshotIds: [item.checkpointSnapshotId], createdAt: item.createdAt }))].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useEffect(() => {
    const targetId = answerNarration?.segments[segmentIndex]?.snapshotId;
    if (!walkthroughOpen || !answerNarration || !targetId) return;
    const frame = requestAnimationFrame(() => {
      const container = chatScroll.current;
      const section = container?.querySelector(`[data-message-id="${CSS.escape(answerNarration.messageId)}"] [data-snapshot-id="${CSS.escape(targetId)}"]`);
      if (!container || !section) return;
      container.scrollTo({ top: container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top - 16, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [answerNarration, segmentIndex, walkthroughOpen]);
  const conversations = [...new Map([{ id: "default", caseId: task?.id ?? "", title: "Case review" }, ...record.chatMessages.filter(item => task?.runIds.includes(item.runId) && item.conversationId).map(item => ({ id: item.conversationId!, caseId: task!.id, title: item.conversationTitle ?? "Conversation" })), ...chatSessions.filter(item => item.caseId === task?.id)].map(item => [item.id, item])).values()];
  const conversation = conversations.find(item => item.id === conversationId) ?? conversations[0];
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem("mangekyo-chat-sessions") ?? "[]"); if (Array.isArray(saved)) setChatSessions(saved.filter(item => typeof item.id === "string" && typeof item.caseId === "string" && typeof item.title === "string")); } catch {} setSessionsLoaded(true); }, []);
  useEffect(() => { if (sessionsLoaded) { try { localStorage.setItem("mangekyo-chat-sessions", JSON.stringify(chatSessions)); } catch {} } }, [chatSessions, sessionsLoaded]);
  useEffect(() => { voiceSession.current++; setAnswerNarration(undefined); setConversationId("default"); setWalkthroughOpen(false); narrator.current?.stop(); stopDictation(); setVoiceReply(""); setDictationError(""); }, [task?.id]);
  const switchConversation = (id: string) => { voiceSession.current++; narrator.current?.stop(); stopDictation(); setWalkthroughOpen(false); setAnswerNarration(undefined); setConversationId(id); setDraft(""); setFlowMessages([]); setComposeMode("question"); };
  const newConversation = () => { if (!task) return; const id = crypto.randomUUID(); setChatSessions(current => [...current, { id, caseId: task.id, title: "New chat" }]); switchConversation(id); setInspectorTab("chat"); requestAnimationFrame(() => chatInput.current?.focus()); };
  const filteredTasks = tasks.filter(item => item.status === caseStatus && item.searchable.includes(query.toLowerCase()));
  const canSteer = !!selected && selected.id === proposal?.id && originalRun?.status === "escalated";
  const narration = useMemo<NarratedExplanation | undefined>(() => {
    if (!originalRun || !finding) return;
    return buildWalkthroughDialogue(originalRun.id, finding, record.snapshots);
  }, [originalRun?.id, finding?.id, record.snapshots]);

  useEffect(() => {
    const onSegment = (segment?: { snapshotId?: string; highlightIds: string[] }, index?: number) => {
      if (index !== undefined) setSegmentIndex(index);
      const target = snapshotsRef.current.find(item => item.id === segment?.snapshotId);
      if (target) { setRunId(target.runId); setSnapshotId(target.id); setFollow(false); setHighlightIds(segment?.highlightIds ?? []); setFocusedAnnotationId(segment?.highlightIds[0]); setFocusRequestId(value => value + 1); setCompareOpen(false); }
    };
    narrator.current = new NarrationController(new BrowserTtsProvider(), update => { setVoiceError(update.error ?? ""); setVoiceStatus(update.status); if (update.caption !== undefined) setLiveCaption(update.caption); if (update.spokenCharIndex !== undefined) setSpokenCharIndex(update.spokenCharIndex); if (update.segmentIndex !== undefined) setSegmentIndex(update.segmentIndex); }, onSegment);
    setVoiceAvailable(new BrowserTtsProvider().isAvailable());
    const speechWindow = window as typeof window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    setSpeechSupported(!!(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
    fetch("/api/visual-audit/tts").then(response => response.json()).then(config => {
      if ((config.provider === "fish" || config.provider === "elevenlabs") && config.configured) { narrator.current?.stop(); narrator.current = new NarrationController(new CloudTtsProvider(), update => { setVoiceError(update.error ?? ""); setVoiceStatus(update.status); if (update.caption !== undefined) setLiveCaption(update.caption); if (update.spokenCharIndex !== undefined) setSpokenCharIndex(update.spokenCharIndex); if (update.segmentIndex !== undefined) setSegmentIndex(update.segmentIndex); }, onSegment); setVoiceAvailable(true); }
    }).catch(() => {});
    return () => { narrator.current?.stop(); stopDictation(); };
  }, []);
  useEffect(() => {
    fetch("/api/visual-audit", { cache: "no-store" }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setRecord(data); }).catch(cause => setError(cause.message));
    const source = new EventSource("/api/visual-audit/stream"); source.onmessage = event => { try { setRecord(JSON.parse(event.data)); setError(""); } catch {} }; source.onerror = () => setError("Connection interrupted. Refresh to reconnect.");
    return () => { source.close(); };
  }, []);
  useEffect(() => { setHighlightIds(current => current.some(id => selected?.annotations?.some(item => item.id === id)) ? current : selected?.annotations?.map(item => item.id) ?? []); setFocusBubble(undefined); setFocusedAnnotationId(current => selected?.annotations?.some(item => item.id === current) ? current : undefined); }, [selected?.id]);
  useEffect(() => { setReportText(report?.content ?? ""); }, [report?.version, report?.id]);
  useEffect(() => { setMemoryText(memory?.content ?? ""); }, [memory?.id, memory?.version]);
  useEffect(() => { if (chatScroll.current) chatScroll.current.scrollTo({ top: chatScroll.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }, [messages.length, flowMessages.length, task?.id, inspectorTab]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(""), 8000); return () => clearTimeout(timeout); }, [notice]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key !== "Escape") return; setCompareOpen(false); setSteerOpen(false); setReportOpen(false); setChatExpanded(false); voiceSession.current++; setWalkthroughOpen(false); stopDictation(); narrator.current?.stop(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  useEffect(() => {
    if (!busy || !proposal || !steeringStartedAt.current) return;
    const request = record.steeringRequests.find(item => item.checkpointSnapshotId === proposal.id && new Date(item.createdAt).getTime() >= steeringStartedAt.current);
    if (request && steeringStage.current === "none") { steeringStage.current = "submitted"; addFlow("I've sent your correction to the tasked agent."); setNotice("Correction sent to the tasked agent."); }
    const child = request && record.runs.find(item => item.steeringId === request.id && item.status === "running");
    if (child && steeringStage.current !== "running") { steeringStage.current = "running"; addFlow("The tasked agent is reviewing the affected evidence again."); }
  }, [record, busy, proposal?.id, originalRun?.agentId]);

  const addFlow = (text: string, kind: "system" | "assistant" = "assistant") => setFlowMessages(current => [...current, { id: crypto.randomUUID(), text, kind }]);
  const chooseTask = (id: string) => { const next = tasks.find(item => item.id === id); if (!next) return; const escalated = record.escalations.find(item => item.runId === id && item.status === "open"); setTaskId(id); setRunId(id); setSnapshotId(escalated?.snapshotId); setFollow(false); setComposeMode("question"); setDraft(""); setFlowMessages([]); setCompareOpen(false); };
  const chooseSnapshot = (target: Snapshot) => { setRunId(target.runId); if (record.runs.find(item => item.id === target.runId)?.parentRunId) setBranchId(target.runId); setSnapshotId(target.id); setFollow(false); setHighlightIds(target.annotations?.map(item => item.id) ?? []); setFocusedAnnotationId(undefined); };
  const navigate = (delta: number) => { const index = snapshots.findIndex(item => item.id === selected?.id); const target = snapshots[index + delta]; if (target) chooseSnapshot(target); };
  const focusEvidence = (target: Snapshot, evidenceIds = target.evidence.map(item => item.id)) => { chooseSnapshot(target); setHighlightIds(target.annotations?.filter(item => evidenceIds.includes(item.evidenceRef)).map(item => item.id) ?? []); };
  const focusAnnotation = (annotationId: string, evidenceRef: string) => { setInspectorTab("annotations"); setFocusedAnnotationId(annotationId); setFocusRequestId(value => value + 1); setFocusBubble(evidenceRef); setHighlightIds([annotationId]); requestAnimationFrame(() => annotationRefs.current[annotationId]?.scrollIntoView({ block: "nearest", behavior: "smooth" })); };
  const suggest = (text: string, mode: "question" | "correction") => { setInspectorTab("chat"); setComposeMode(mode); setDraft(text); requestAnimationFrame(() => chatInput.current?.focus()); };
  const runAction = (action: ReturnType<typeof visualActionsForQuestion>[number]) => {
    if (!task) return;
    const target = validatedFocus(action, record, new Set(task.runIds));
    if (target) { focusEvidence(target, action.kind === "focus_snapshot" ? action.evidenceIds : undefined); return; }
    if (action.kind === "previous") navigate(-1);
    if (action.kind === "next") navigate(1);
    if (action.kind === "compare_evidence" && action.snapshotIds.every(id => record.snapshots.some(item => item.id === id && task.runIds.includes(item.runId)))) setCompareOpen(true);
    if (action.kind === "walkthrough" && narration) { voiceSession.current++; setAnswerNarration(undefined); stopDictation(); setWalkthroughOpen(true); setCompareOpen(false); narrator.current?.play(narration, 0, false); }
    if (action.kind === "steer" && canSteer) setSteerOpen(true);
    if (action.kind === "open_original" && visual?.screenshot) window.open(visual.screenshot.url, "_blank", "noopener,noreferrer");
  };
  const ask = async (question: string) => {
    narrator.current?.pause();
    stopDictation();
    const prompt = question.trim(); if (!prompt || !selected || thinking) return;
    const chatTitle = conversation?.title === "New chat" ? prompt.slice(0, 60) : conversation?.title;
    if (conversation?.title === "New chat") setChatSessions(current => current.map(item => item.id === conversationId ? { ...item, title: chatTitle! } : item));
    const replySession = ++voiceSession.current;
    setVoiceReply(""); setWalkthroughOpen(true);
    setDraft(""); setPendingQuestion(prompt); setThinking(true); setError("");
    try {
      const response = await fetch("/api/visual-audit/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: prompt, snapshotId: selected.id, conversationId, conversationTitle: chatTitle }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setRecord(current => ({ ...current, chatMessages: [...current.chatMessages, ...[data.user, data.assistant].filter(message => !current.chatMessages.some(existing => existing.id === message.id))] }));
      const actions = visualActionsForQuestion(prompt, selected, record, data.assistant.snapshotIds);
      if (voiceSession.current === replySession) {
        if (!data.assistant.sections?.length && actions[0] && actions[0].kind !== "walkthrough") runAction(actions[0]);
        const spoken = buildSpokenReply(data.assistant.id, data.assistant.text, data.assistant.sections, snapshotsRef.current);
        setAnswerNarration(spoken); setSegmentIndex(0); stopDictation();
        if (spoken.segments.length) narrator.current?.play(spoken, 0, true, true);
      }
    } catch (cause) { setError((cause as Error).message); } finally { setThinking(false); setPendingQuestion(undefined); }
  };
  const stopDictation = () => {
    clearTimeout(voiceFinalizeTimer.current); voiceFinalizeTimer.current = undefined; voiceFinalizing.current = false;
    voiceTranscript.current = "";
    const instance = recognizer.current;
    recognizer.current = null;
    if (instance) { instance.onresult = null; instance.onstart = null; instance.onend = null; instance.onerror = null; instance.onspeechstart = null; instance.onspeechend = null; instance.stop(); }
    setListening(false);
  };
  const startDictation = () => {
    if (recognizer.current) return;
    const speechWindow = window as typeof window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Constructor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Constructor) { setDictationError("Voice input unavailable. Type in chat."); return; }
    setDictationError(""); setVoiceReply(""); voiceTranscript.current = ""; setInspectorTab("chat");
    const instance = new Constructor(); recognizer.current = instance; instance.lang = "en-US"; instance.interimResults = true; instance.continuous = true;
    instance.onstart = () => { if (recognizer.current === instance) setListening(true); };
    instance.onend = () => { if (recognizer.current === instance) { if (composeMode === "question" && voiceTranscript.current.trim()) sendVoiceReply(instance); else stopDictation(); } };
    instance.onerror = event => { if (recognizer.current === instance) recognizer.current = null; setListening(false); setDictationError(event.error === "not-allowed" ? "Microphone blocked. Allow access or type in chat." : event.error === "no-speech" ? "No speech heard. Try again or type in chat." : "Voice input unavailable. Try again or type in chat."); };
    instance.onresult = event => { if (recognizer.current !== instance) return; const text = Array.from(event.results).map(result => result[0]?.transcript ?? "").join(" ").trim(); if (text) { voiceTranscript.current = text; setVoiceReply(text); setDraft(text); } };
    try { instance.start(); } catch { recognizer.current = null; setListening(false); setDictationError("Unable to start microphone. Try again."); }
  };
  const sendVoiceReply = (instance: SpeechRecognitionLike) => {
    if (recognizer.current !== instance) return;
    const text = voiceTranscript.current.trim();
    stopDictation(); setVoiceReply("");
    if (text) void ask(text);
  };
  useEffect(() => {
    if (!listening || microphoneMeter.speaking || !voiceReply.trim() || thinking || composeMode !== "question") return;
    const instance = recognizer.current;
    if (!instance) return;
    const silenceTimer = setTimeout(() => {
      if (recognizer.current !== instance || voiceFinalizing.current) return;
      voiceFinalizing.current = true;
      // Stop recognition to flush its final transcript; onend normally sends it.
      // Some browsers omit onend, so send the latest transcript after a short grace period.
      voiceFinalizeTimer.current = setTimeout(() => sendVoiceReply(instance), 800);
      instance.stop();
    }, 1200);
    return () => clearTimeout(silenceTimer);
  }, [listening, microphoneMeter.speaking, voiceReply, thinking, composeMode]);
  const microphone = () => {
    narrator.current?.pause();
    if (recognizer.current) stopDictation();
    else startDictation();
  };
  // Enter listening once per conversational turn, not on every meter/render update.
  // Manually stopping the mic stays respected until the next turn.
  useEffect(() => {
    if (walkthroughOpen && speechSupported && !thinking && (voiceStatus === "paused" || voiceStatus === "awaiting_input")) startDictation();
  }, [walkthroughOpen, voiceStatus, segmentIndex, speechSupported, thinking]);
  const post = async (body: object) => {
    setBusy(true); setError("");
    if ("action" in body && body.action === "steer") { steeringStartedAt.current = Date.now() - 1000; steeringStage.current = "none"; addFlow("I'm preparing a correction for the tasked agent based on this evidence."); }
    try { const response = await fetch("/api/visual-audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setRecord(data.record); const resultRun = data.corrected ?? data.run;
      const resultSnapshots = data.record.snapshots.filter((item: Snapshot) => item.runId === resultRun.id) as Snapshot[];
      setTaskId(data.corrected ? data.corrected.parentRunId : resultRun.id); setRunId(resultRun.id); setBranchId(resultRun.id);
      setSnapshotId(data.corrected ? (resultSnapshots.find(item => item.actionType === "PROPOSE" && item.screenshot) ?? resultSnapshots.filter(item => item.screenshot).at(-1))?.id : undefined); setFollow(!data.corrected); setSteerOpen(false);
      if (data.corrected) { addFlow("The corrected run is complete. I've recorded the updated observations."); const clear = resultRun.status === "corrected" && !data.record.findings.some((item: { runId: string; reviewStatus: string }) => item.runId === resultRun.id && item.reviewStatus === "open"); addFlow(clear ? "The conflict has been resolved in the corrected branch. The case is ready for your approval." : "The new branch still needs review. Check the evidence before approving."); }
      setNotice(data.corrected ? "Corrected run completed. Review the correction branch." : "The monitored agent finished.");
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const reviseReport = async (nextStatus: InvestigationReport["status"]) => {
    if (!report) return; setBusy(true); setError("");
    try { const response = await fetch("/api/visual-audit/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: report.id, content: reportText, status: nextStatus }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setRecord(data.record); setNotice(nextStatus === "filed" ? "The approved investigation report has been filed." : `Report ${nextStatus.replaceAll("_", " ")}.`); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const memoryAction = async (action: "propose" | "approve") => {
    if (!report) return; setBusy(true); setError("");
    try { const response = await fetch("/api/visual-audit/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, reportId: report.id, memoryId: memory?.id, content: memoryText }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setRecord(data.record); addFlow(action === "approve" ? "The approved context has been saved to agent memory." : "I've prepared this correction as reusable context for future similar tasks."); setNotice(action === "approve" ? "Context saved to agent memory." : "Lesson ready for review."); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const resolveCase = async () => {
    if (!originalRun) return;
    setBusy(true); setError("");
    try { const response = await fetch("/api/visual-audit/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: originalRun.id, conversationId, conversationTitle: conversation?.title }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setRecord(data.record); setTaskId(originalRun.id); setCaseStatus("resolved"); setInspectorTab("chat"); setFlowMessages([]); setNotice(""); }
    catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  };
  const originalSnapshots = record.snapshots.filter(item => item.runId === originalRun?.id).sort((a, b) => a.sequence - b.sequence);
  const correctedBranches = taskRuns.filter(item => item.branchId === "corrected");
  const latestCorrectedRun = correctedBranches.at(-1);
  const correctedRun = correctedBranches.find(item => item.id === branchId) ?? latestCorrectedRun;
  const correctedSnapshots = record.snapshots.filter(item => item.runId === correctedRun?.id).sort((a, b) => a.sequence - b.sequence);
  const annotations = selected?.annotations ?? [];
  const canResolve = !!escalation && !!correctedRun && correctedRun.id === latestCorrectedRun?.id && correctedRun.status === "corrected" && !!report && !record.findings.some(item => item.runId === correctedRun.id && item.reviewStatus === "open");
  const caseAnnotations = [...originalSnapshots, ...correctedSnapshots].flatMap(snapshot => (snapshot.annotations ?? []).map(annotation => ({ snapshot, annotation })));
  const annotationNumbers = Object.fromEntries(caseAnnotations.map(({ annotation }, index) => [annotation.id, index + 1]));
  const amount = originalSnapshots.map(item => item.summary).join(" ").match(/\$[\d,]+(?:\.\d{2})?/)?.[0];
  const reference = originalSnapshots.flatMap(item => item.observation.fields).find(item => item.id === "bank-reference")?.value.split(" / ")[0];
  const comparisonSnapshots = (correctedRun ? [proposal, correctedSnapshots.find(item => item.actionType === "PROPOSE")] : [originalSnapshots.find(item => /bank/i.test(item.title)), originalSnapshots.find(item => /invoice|funding/i.test(item.title))]).filter((item): item is Snapshot => !!item);
  const submitComposer = () => {
    if (!draft.trim() || busy || thinking) return;
    if (composeMode === "correction" && proposal) { if (draft.trim().length < 12) return; const text = draft.trim(); setDraft(""); post({ action: "steer", snapshotId: proposal.id, instruction: text, scope: "dependent_work" }); }
    else ask(draft);
  };

  return <div className={`review-shell ${chatExpanded ? "chat-expanded" : ""} ${sidebarOpen ? "" : "sidebar-closed"}`}>
    <aside className="review-sidebar" aria-label="Escalated cases">
      <div className="sidebar-brand"><MangekyoAvatar size={38}/><strong>Mangekyo</strong><IconButton label="Hide case list" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={16}/></IconButton></div>
      <div className="sidebar-section"><Inbox size={17}/><h2>Exceptions</h2><span>{tasks.filter(item => item.status === caseStatus).length}</span></div>
      <select className="case-status-filter" aria-label="Case status" value={caseStatus} onChange={event => { setCaseStatus(event.target.value); setTaskId(undefined); setRunId(undefined); setSnapshotId(undefined); }}><option value="escalated">Open exceptions</option><option value="resolved">Resolved</option></select>
      <label className="sidebar-search"><Search size={14}/><input aria-label="Search escalated cases" placeholder="Search cases" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="case-list">{filteredTasks.map(item => {
        const caseSnapshots = record.snapshots.filter(snapshot => snapshot.runId === item.id);
        const caseAmount = caseSnapshots.map(snapshot => snapshot.summary).join(" ").match(/\$[\d,]+(?:\.\d{2})?/)?.[0];
        return <button className={`case-row ${task?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => { chooseTask(item.id); setInspectorTab(item.status === "resolved" ? "chat" : "annotations"); if (window.innerWidth < 760) setSidebarOpen(false); }}>
          <span className="case-row-title"><strong>{item.title}</strong>{item.status === "resolved" ? <Check size={12} aria-label="Resolved"/> : <i aria-label="Escalated"/>}</span>
          <span className="case-row-agent">{agentName(item.agentId)} &middot; {item.status === "resolved" ? "Resolved" : "Unresolved"}</span>
          <span className="case-row-meta"><span>{caseAmount ?? "Review required"}</span><time>{shortTime(item.latestAt)}</time></span>
        </button>;
      })}{!filteredTasks.length && <p className="sidebar-empty">{query ? "No matching cases" : caseStatus === "resolved" ? "No resolved exceptions" : "No open exceptions"}</p>}</div>
    </aside>
    <main className="review-main">
          <WalkthroughIsland title={answerNarration ? "Mangekyo" : undefined} thinking={thinking} autoSend={composeMode === "question"} listening={listening} speaking={microphoneMeter.speaking} levels={microphoneMeter.bars} reply={voiceReply} inputError={dictationError || microphoneMeter.error} speechSupported={speechSupported} onListen={microphone} error={voiceError} caption={liveCaption} spokenCharIndex={spokenCharIndex} open={walkthroughOpen} status={voiceStatus} available={voiceAvailable} explanation={answerNarration ?? narration} index={segmentIndex} snapshots={record.snapshots} annotationNumbers={annotationNumbers} onStart={() => { if (answerNarration) { voiceSession.current++; stopDictation(); setWalkthroughOpen(true); narrator.current?.play(answerNarration, 0, true, true); return; } if (narration) { voiceSession.current++; setAnswerNarration(undefined); stopDictation(); setWalkthroughOpen(true); setCompareOpen(false); narrator.current?.play(narration, 0, false); } }} onContinue={() => { stopDictation(); narrator.current?.continue(); }} onPause={() => narrator.current?.pause()} onResume={() => { stopDictation(); narrator.current?.resume(); }} onClose={() => { voiceSession.current++; stopDictation(); narrator.current?.stop(); setWalkthroughOpen(false); }} onSeek={index => { if (narration) narrator.current?.play(narration, index, false); }}/>
      <header className="case-header">
        <div className="case-heading"><div className="case-breadcrumb">{sidebarOpen ? <IconButton label="Hide case list" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17}/></IconButton> : <button className="sidebar-reopen" aria-label="Show case list" aria-expanded={false} onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={17}/><span>Show cases</span></button>}<span>Exceptions</span><ChevronRight size={13}/><span>{task?.taskId.match(/\d+$/)?.[0] ? `#${task.taskId.match(/\d+$/)?.[0]}` : "Review"}</span></div><h1>{task ? task.title : "Exceptions"}</h1></div>
        {task && <div className="case-header-actions"><span className="case-status">{task.status === "resolved" ? <><Check size={12}/> Resolved</> : <><i/> Unresolved</>}</span>{canResolve && <button className="review-primary" onClick={resolveCase} disabled={busy}><Check size={15}/> Approve &amp; resolve</button>}<ReviewMenu items={[
          { label: "Compare evidence", icon: <Columns2 size={15}/>, onSelect: () => setCompareOpen(value => !value), disabled: comparisonSnapshots.length < 2 },
          { label: "Review report", icon: <FileText size={15}/>, onSelect: () => setReportOpen(true), disabled: !report },
          { label: "Correct decision", icon: <GitBranch size={15}/>, onSelect: () => suggest("Re-evaluate ownership using the bank payment reference and customer record.", "correction"), disabled: !proposal || busy },
        ]}/></div>}
      </header>
      {task && <div className="case-facts">{amount && <div><span>Amount</span><strong>{amount}</strong></div>}{reference && <div><span>Reference</span><strong>{reference}</strong></div>}<div><span>Proposed owner</span><strong className={originalRun?.proposedOwner ? "conflicting-value" : ""}>{originalRun?.proposedOwner ?? "Unassigned"}</strong>{canResolve && <><ArrowRight size={13}/><strong className="corrected-value">{correctedRun?.proposedOwner}</strong></>}</div><div className="case-facts-agent"><span>Agent</span><strong>{agentName(task.agentId)}</strong></div></div>}
      {error && <div className="review-error" role="alert"><CircleAlert size={16}/>{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={14}/></button></div>}
      {task ? <div className="review-workspace">
        <section className="review-evidence" aria-label="Snapshot review">
          <SnapshotBranchGraph branchControl={correctedBranches.length > 1 ? <select className="history-branch-select" aria-label="Correction branch" value={correctedRun?.id} onChange={event => { setBranchId(event.target.value); const target = record.snapshots.find(item => item.runId === event.target.value && item.actionType === "PROPOSE"); if (target) chooseSnapshot(target); }}>{correctedBranches.map((branch, index) => <option key={branch.id} value={branch.id}>Correction {index + 1}</option>)}</select> : undefined} original={originalSnapshots} corrected={correctedSnapshots} selectedId={selected?.id} conflictId={escalation?.snapshotId} onSelect={item => { setCompareOpen(false); chooseSnapshot(item); }}/>
          <div className="evidence-heading"><div><FileText size={16}/><h2>{compareOpen ? "Compare evidence" : selected?.title ?? "Snapshot"}</h2></div><div><span>{!compareOpen && selected ? `Snapshot ${selected.sequence}` : correctedRun ? "Before / After" : "Bank / Invoice"}</span><IconButton label={compareOpen ? "Close comparison" : "Compare evidence"} disabled={comparisonSnapshots.length < 2} onClick={() => setCompareOpen(value => !value)} className={compareOpen ? "is-active" : ""}><Columns2 size={16}/></IconButton></div></div>

          {compareOpen ? <div className="evidence-comparison">{comparisonSnapshots.map((item, index) => <div className="comparison-pane" key={item.id}><div className="comparison-pane-label"><i className={correctedRun && index === 1 ? "corrected" : ""}/><span>{correctedRun ? index === 0 ? "Before correction" : "After correction" : item.title}</span></div><EvidenceCanvas annotationNumbers={annotationNumbers} snapshot={item} highlightIds={item.annotations?.map(annotation => annotation.id) ?? []} onEvidence={evidenceId => { chooseSnapshot(item); setCompareOpen(false); const annotation = item.annotations?.find(note => note.evidenceRef === evidenceId); if (annotation) focusAnnotation(annotation.id, evidenceId); }}/><div className="comparison-value">{item.observation.fields.map(field => <span key={field.id}>{field.label}<strong>{field.value}</strong></span>)}</div></div>)}</div> : <EvidenceCanvas annotationNumbers={annotationNumbers} snapshot={selected} showCallout={walkthroughOpen} zoomOnFocus={!walkthroughOpen} focusedAnnotationId={focusedAnnotationId} focusRequestId={focusRequestId} highlightIds={highlightIds} onEvidence={evidenceId => { const annotation = selected?.annotations?.find(item => item.evidenceRef === evidenceId); if (annotation) focusAnnotation(annotation.id, evidenceId); }}/>} 

          <footer className="evidence-footer"><span><span className="capture-indicator"/>{selected?.screenshot?.provenance === "actual" ? (selected.observation.kind === "document" ? "Document capture" : selected.screenshotDimensions && selected.viewport && selected.screenshotDimensions.height > selected.viewport.height ? "Full-page capture" : "Viewport capture") : "Recorded observation"}</span><time>{selected && new Date(selected.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></footer>
        </section>
        <Tabs.Root className="review-inspector" value={inspectorTab} onValueChange={setInspectorTab}>
          <div className="inspector-heading"><MangekyoAvatar size={26}/><h2>Mangekyo</h2><span className={`agent-presence ${thinking || busy ? "working" : ""}`} title={thinking || busy ? "Working" : "Ready"}/><IconButton label={chatExpanded ? "Collapse chat" : "Expand chat"} onClick={() => { setChatExpanded(value => !value); setInspectorTab("chat"); }}>{chatExpanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</IconButton></div>
          <Tabs.List className="inspector-tabs" aria-label="Review panel"><Tabs.Trigger value="chat">Chat</Tabs.Trigger><Tabs.Trigger value="annotations">Annotations<span>{caseAnnotations.length}</span></Tabs.Trigger><Tabs.Trigger value="details">Details</Tabs.Trigger></Tabs.List>
          <Tabs.Content value="annotations" className="inspector-content notes-content">
            <div className="notes-scroll"><div className="issue-note"><span className="issue-title"><CircleAlert size={15}/>{finding?.category === "ownership_conflict" ? "Ownership mismatch" : "Review required"}</span><p>{finding?.explanation ?? selected?.summary}</p></div>
            <div className="annotation-list">{caseAnnotations.map(({ snapshot, annotation }, index) => <button key={annotation.id} ref={node => { annotationRefs.current[annotation.id] = node; }} className={`annotation-row ${focusedAnnotationId === annotation.id ? "active" : ""} ${snapshot.id === selected?.id ? "current-snapshot" : ""}`} onClick={() => { chooseSnapshot(snapshot); setCompareOpen(false); focusAnnotation(annotation.id, annotation.evidenceRef); }}><span className="annotation-number">{index + 1}</span><span className="annotation-copy"><strong>{annotation.label}</strong><span>{annotationContext(snapshot, annotation.evidenceRef, annotation.textQuote)}</span>{snapshot.actionType !== "READ" && snapshot.recordedJustification && <span className="annotation-context">{snapshot.recordedJustification}</span>}<small>{snapshot.runId === correctedRun?.id ? "Corrected · " : ""}Snapshot {snapshot.sequence}</small></span><ArrowUpRight size={13}/></button>)}</div></div>
            <div className="inspector-bottom"><button className="review-primary wide" disabled={!proposal || busy} onClick={() => suggest("Re-evaluate ownership using the bank payment reference and customer record.", "correction")}><GitBranch size={15}/> {correctedRun ? "Refine correction" : "Correct decision"}<ArrowRight size={15}/></button></div>
          </Tabs.Content>
          <Tabs.Content value="chat" className="inspector-content chat-content">
            <div className="chat-titlebar"><select aria-label="Chat title" value={conversationId} disabled={thinking || busy} onChange={event => switchConversation(event.target.value)}>{conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><IconButton label="New chat" disabled={thinking || busy} onClick={newConversation}><Plus size={16}/></IconButton></div>
            <div className="conversation-scroll" ref={chatScroll}>
              {!messages.length && !flowMessages.length && <div className="conversation-empty"><MangekyoAvatar size={38}/><h3>Let's review this.</h3><p>Would you like to start with the analysis now?</p><button onClick={() => { if (narration) { voiceSession.current++; setAnswerNarration(undefined); stopDictation(); setWalkthroughOpen(true); setCompareOpen(false); narrator.current?.play(narration, 0, false); } }}>Start the analysis<ArrowUpRight size={14}/></button><button onClick={() => suggest("Why was this decision flagged?", "question")}>Why was this flagged?<ArrowUpRight size={14}/></button><button onClick={() => suggest("Show me the bank reference and the proposed owner", "question")}>Show the conflicting evidence<ArrowUpRight size={14}/></button></div>}
              {messages.map(message => <div className={`conversation-message ${message.role}`} key={message.id}>{message.role === "assistant" && <div className="conversation-author"><MangekyoAvatar size={19}/><span>Mangekyo</span></div>}<SnapshotChatReply message={message} snapshots={record.snapshots} onOpen={snapshot => { focusEvidence(snapshot); setCompareOpen(false); }}/>{message.role === "assistant" && !message.sections?.length && message.snapshotIds.length > 0 && <div className="conversation-sources">{message.snapshotIds.map(id => { const snapshot = record.snapshots.find(item => item.id === id); return snapshot ? <button className={snapshot.screenshot ? "chat-snapshot-preview" : "chat-source-link"} key={id} onClick={() => { focusEvidence(snapshot); setCompareOpen(false); }} aria-label={`Open snapshot ${snapshot.sequence}: ${snapshot.title}`}>{snapshot.screenshot && <img src={snapshot.screenshot.url} alt={snapshot.screenshot.alt} loading="lazy"/>}<span><FileText size={12}/><span>Snapshot {snapshot.sequence}<strong>{snapshot.title}</strong></span><ArrowUpRight size={13}/></span></button> : null; })}</div>}</div>)}
              {pendingQuestion && <div className="conversation-message user"><p>{pendingQuestion}</p></div>}
              {flowMessages.map(message => <div className="conversation-message assistant" key={message.id}><p>{message.text}</p></div>)}
              {(thinking || busy) && <div className="thinking-indicator" role="status"><span><i/><i/><i/></span>{busy ? "Reviewing evidence" : "Thinking"}</div>}
              {record.steeringRequests.some(item => item.parentRunId === originalRun?.id) && <CorrectionStatusMessage kind="sent" agent={originalRun ? agentName(originalRun.agentId) : undefined}/>}{correctedRun?.status === "corrected" && <CorrectionStatusMessage kind="completed" agent={correctedRun ? agentName(correctedRun.agentId) : undefined}/>}{memory?.status === "approved" && <CorrectionStatusMessage kind="memory" agent={memory.agentRole} context={memory.taskType.replaceAll("_", " ")}/>}
            </div>
            <form className={`review-composer ${listening ? "listening" : ""}`} onSubmit={event => { event.preventDefault(); submitComposer(); }}>
              <textarea onFocus={() => narrator.current?.pause()} maxLength={2000} ref={chatInput} aria-label={composeMode === "correction" ? "Correction instruction" : "Ask Mangekyo"} placeholder={listening ? "Listening…" : composeMode === "correction" ? "What should the agent reconsider?" : "Ask anything about this case…"} rows={3} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submitComposer(); } }}/>
              <div className="composer-controls"><DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="composer-mode">{composeMode === "correction" ? <GitBranch size={13}/> : <MessageSquare size={13}/>} {composeMode === "correction" ? "Correction" : "Ask"}<ChevronDown size={12}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="review-dropdown" side="top" align="start" sideOffset={8}><DropdownMenu.Item className="review-dropdown-item" onSelect={() => setComposeMode("question")}><MessageSquare size={14}/>Ask a question</DropdownMenu.Item><DropdownMenu.Item className="review-dropdown-item" disabled={!proposal} onSelect={() => setComposeMode("correction")}><GitBranch size={14}/>Send a correction</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root><div><IconButton label={listening ? "Stop dictation" : speechSupported ? "Dictate message" : "Dictation unavailable in this browser"} disabled={!speechSupported} onClick={microphone}>{listening ? <Square size={14}/> : <Mic size={16}/>}</IconButton><button className="composer-send" type="submit" aria-label={composeMode === "correction" ? "Send correction" : "Send message"} disabled={busy || thinking || !draft.trim() || (composeMode === "correction" && draft.trim().length < 12)}><ArrowUp size={16}/></button></div></div>
            </form>
          </Tabs.Content>
          <Tabs.Content value="details" className="inspector-content details-content"><h3>{selected?.title}</h3><dl>{selected?.observation.fields.map(field => <div key={field.id}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}<div><dt>Agent</dt><dd>{task && agentName(task.agentId)}</dd></div><div><dt>Captured</dt><dd>{selected && new Date(selected.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</dd></div></dl>{selected?.recordedJustification && <div className="agent-reason"><h4>Decision context</h4><p>{selected.recordedJustification}</p></div>}{report && <button className="details-report" onClick={() => setReportOpen(true)}><FileText size={16}/><span>Investigation report<small>{report.status.replaceAll("_", " ")}</small></span><ArrowUpRight size={14}/></button>}<details className="provenance-details"><summary>Provenance</summary><code>Snapshot {selected?.id}<br/>Run {selected?.runId}<br/>Source {selected?.source}</code></details></Tabs.Content>
        </Tabs.Root>
      </div> : <div className="review-empty"><Check size={28}/><h2>You're all caught up.</h2><p>Cases appear here when an agent needs your review.</p></div>}
    </main>
    {notice && <div className="review-toast" role="status"><Check size={15}/><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notification"><X size={14}/></button></div>}

    {steerOpen && proposal && <div className="mc-modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) setSteerOpen(false); }}><section className="mc-modal mc-steer-modal" role="dialog" aria-modal="true" aria-label="Steer agent"><header><div><span>Correct this decision</span><h2>Guide the Matching Agent</h2></div><button onClick={() => setSteerOpen(false)} aria-label="Close steering">×</button></header><div className="mc-steer-preview">{proposal.screenshot && <img src={proposal.screenshot.url} alt={proposal.screenshot.alt}/>}<div><strong>{proposal.title}</strong><p>{proposal.summary}</p><small>{proposal.evidence.map(item => `${item.label}: ${item.value}`).join(" · ")}</small></div></div><label htmlFor="mc-instruction">What should the agent reconsider?</label><textarea id="mc-instruction" value={instruction} onChange={event => setInstruction(event.target.value)}/><p>The affected task will restart with preserved context. This does not post or approve a transaction.</p><footer><button onClick={() => setSteerOpen(false)}>Cancel</button><button disabled={busy || instruction.trim().length < 12} onClick={() => post({ action: "steer", snapshotId: proposal.id, instruction, scope: "dependent_work" })}>{busy ? "Rerunning agent…" : "Send direction and rerun"}</button></footer></section></div>}
      {reportOpen && report && <div className="mc-modal-shade" onMouseDown={event => { if (event.target === event.currentTarget) setReportOpen(false); }}><section className="mc-modal mc-report-modal" role="dialog" aria-modal="true" aria-label="Investigation report"><header><div><span>Investigation report</span><h2>Issue and correction</h2></div><button onClick={() => setReportOpen(false)} aria-label="Close report">×</button></header><div className="mc-report-status">{report.status.replaceAll("_", " ")} · {report.evidenceSnapshotIds.length} linked observations</div><textarea aria-label="Report content" value={reportText} onChange={event => setReportText(event.target.value)} disabled={report.status === "filed"}/><p>Remaining uncertainty: {report.remainingUncertainty}</p><div className="mc-report-actions"><button disabled={busy || report.status === "filed"} onClick={() => reviseReport(report.status)}>Save changes</button>{report.status === "draft" && <button onClick={() => reviseReport("pending_review")}>Submit for review</button>}{report.status === "pending_review" && <button onClick={() => reviseReport("approved")}>Approve report</button>}{report.status === "approved" && <button onClick={() => reviseReport("filed")}>File report</button>}</div>{report.status === "filed" && <div className="mc-memory"><h3>{memory?.status === "approved" ? "Approved agent context" : memory ? "Lesson awaiting approval" : "Save a lesson for future runs"}</h3><p>Lessons apply only to this agent’s matching task and remain separate from the steering instruction.</p>{memory ? <><textarea aria-label="Proposed agent memory" value={memoryText} disabled={memory.status !== "pending"} onChange={event => setMemoryText(event.target.value)}/><span>{memory.status === "approved" ? "Approved and available for matching tasks" : "Awaiting reviewer approval"}</span>{memory.status === "pending" && <button disabled={busy || memoryText.trim().length < 30} onClick={() => memoryAction("approve")}>Approve lesson</button>}</> : <button disabled={busy} onClick={() => memoryAction("propose")}>Prepare lesson for review</button>}</div>}</section></div>}
  </div>;
}

