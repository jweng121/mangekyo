/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as finance from "../finance.js";
import type * as financeAgentApi from "../financeAgentApi.js";
import type * as financeAudit from "../financeAudit.js";
import type * as financeDesk from "../financeDesk.js";
import type * as financeIntake from "../financeIntake.js";
import type * as financeInvestigationActions from "../financeInvestigationActions.js";
import type * as financeInvestigations from "../financeInvestigations.js";
import type * as financeOrchestrator from "../financeOrchestrator.js";
import type * as financeProposals from "../financeProposals.js";
import type * as financeReconciliation from "../financeReconciliation.js";
import type * as financeScorecard from "../financeScorecard.js";
import type * as financeSmoke from "../financeSmoke.js";
import type * as financeTrust from "../financeTrust.js";
import type * as lib_agents from "../lib/agents.js";
import type * as lib_investigationRecords from "../lib/investigationRecords.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_moneyValidators from "../lib/moneyValidators.js";
import type * as lib_orchestrator from "../lib/orchestrator.js";
import type * as lib_orchestratorValidators from "../lib/orchestratorValidators.js";
import type * as lib_validators from "../lib/validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  finance: typeof finance;
  financeAgentApi: typeof financeAgentApi;
  financeAudit: typeof financeAudit;
  financeDesk: typeof financeDesk;
  financeIntake: typeof financeIntake;
  financeInvestigationActions: typeof financeInvestigationActions;
  financeInvestigations: typeof financeInvestigations;
  financeOrchestrator: typeof financeOrchestrator;
  financeProposals: typeof financeProposals;
  financeReconciliation: typeof financeReconciliation;
  financeScorecard: typeof financeScorecard;
  financeSmoke: typeof financeSmoke;
  financeTrust: typeof financeTrust;
  "lib/agents": typeof lib_agents;
  "lib/investigationRecords": typeof lib_investigationRecords;
  "lib/money": typeof lib_money;
  "lib/moneyValidators": typeof lib_moneyValidators;
  "lib/orchestrator": typeof lib_orchestrator;
  "lib/orchestratorValidators": typeof lib_orchestratorValidators;
  "lib/validators": typeof lib_validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
