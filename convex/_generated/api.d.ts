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
import type * as financeDesk from "../financeDesk.js";
import type * as financeIntake from "../financeIntake.js";
import type * as financeInvestigationActions from "../financeInvestigationActions.js";
import type * as financeInvestigations from "../financeInvestigations.js";
import type * as financeProposals from "../financeProposals.js";
import type * as lib_investigationRecords from "../lib/investigationRecords.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_moneyValidators from "../lib/moneyValidators.js";
import type * as lib_validators from "../lib/validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  finance: typeof finance;
  financeDesk: typeof financeDesk;
  financeIntake: typeof financeIntake;
  financeInvestigationActions: typeof financeInvestigationActions;
  financeInvestigations: typeof financeInvestigations;
  financeProposals: typeof financeProposals;
  "lib/investigationRecords": typeof lib_investigationRecords;
  "lib/money": typeof lib_money;
  "lib/moneyValidators": typeof lib_moneyValidators;
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
