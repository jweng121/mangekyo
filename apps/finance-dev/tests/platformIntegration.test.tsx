/// <reference types="vite/client" />
import {convexTest} from "convex-test";
import {it,expect,vi} from "vitest";
import {mkdirSync,writeFileSync} from "node:fs";
import schema from "../../../convex/schema";
import {api} from "../../../convex/_generated/api";
import {platformRecord} from "../../visual-audit-dev/lib/platform-record";
import {resolveAnnotation} from "../../../packages/visual-audit/annotations/highlight-resolver";
const modules=import.meta.glob(["../../../convex/**/*.{ts,js}","!../../../convex/**/*.test.ts"]);
it("adapts persisted platform runs without inventing source captures or future results",async()=>{
 vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,24,12));vi.stubEnv("FINANCE_AGENT_MODE","mock");
 try {
 const t=convexTest(schema,modules);await t.mutation(api.financeIntake.loadDemoFixture,{});
 for(let i=0;i<10;i++){vi.advanceTimersByTime(1);await t.finishInProgressScheduledFunctions();}
 const accountId="demo:account:pool-001";
 const initial=await t.query(api.financeDesk.getDeskData,{accountId});
 const question=initial.questions[0];
 if(question){await t.mutation(api.financeInvestigations.answerQuestion,{runId:question.runId,questionId:question.questionId,answer:"J Smith pays rent for DEMO Owner Y - Yankee Trust."});for(let i=0;i<10;i++){vi.advanceTimersByTime(1);await t.finishInProgressScheduledFunctions();}}
 const desk=await t.query(api.financeDesk.getDeskData,{accountId});
 const runId=desk.checkerStopped[0]?.runId??desk.tasks.find(t=>t.latestRun)?.latestRun!.runId!;
 const view=(await t.query(api.financeDesk.getRunView,{runId}))!;
 const snapshots=await t.query(api.finance.listTaskSnapshots,{taskId:view.run.taskId});
 const views=await Promise.all(view.runs.map(run=>t.query(api.financeDesk.getRunView,{runId:run.runId})));
 const record=platformRecord(views.filter((v):v is NonNullable<typeof v>=>!!v),snapshots);
 expect(record.snapshots.length).toBeGreaterThan(0);expect(record.snapshots.every(s=>!s.screenshot)).toBe(true);
 expect(record.snapshots.every(s=>s.evidence.every(e=>!!e.value))).toBe(true);
 for(const snapshot of record.snapshots) for(const annotation of snapshot.annotations??[]) expect(resolveAnnotation(snapshot,annotation)).toBeDefined();
 for(const snapshot of record.snapshots){const saved=snapshots.find(s=>s.snapshotId===snapshot.id);if(saved && !("result" in saved.output && saved.output.result))expect(snapshot.observation.fields.some(f=>f.label==="Agent finding")).toBe(false);}
 expect(record.runs.some(r=>r.parentRunId)).toBe(views.length>1);
 const queries={
 "financeIntake:listAccounts":await t.query(api.financeIntake.listAccounts,{}),
 "financeIntake:getAccountOverview":await t.query(api.financeIntake.getAccountOverview,{accountId}),
 "financeDesk:getDeskData":desk,
 "financeDesk:getActivity":await t.query(api.financeDesk.getActivity,{accountId,paginationOpts:{numItems:50,cursor:null}}),
 "financeInvestigations:getProviderConfiguration":await t.query(api.financeInvestigations.getProviderConfiguration,{}),
 "financeOrchestrator:getConfiguration":await t.query(api.financeOrchestrator.getConfiguration,{now:Date.now()}),
 "financeOrchestrator:getPipeline":await t.query(api.financeOrchestrator.getPipeline,{accountId}),
 "financeReconciliation:listCorrections":await t.query(api.financeReconciliation.listCorrections,{accountId}),
 "financeScorecard:getScorecard":await t.query(api.financeScorecard.getScorecard,{accountId}),
 "financeDesk:getRunView":view,
 "finance:listTaskSnapshots":snapshots,
 };
 if(process.env.MANGEKYO_EXPORT_UI_FIXTURE==="1") {mkdirSync("output",{recursive:true});writeFileSync("output/platform-fixture.json",JSON.stringify({queries,record,runId}));}
 }finally{vi.useRealTimers();vi.unstubAllEnvs();}
},20000);
