import { defineApp } from "convex/server";
import { v } from "convex/values";

const optional = v.optional(v.string());

export default defineApp({
  env: {
    // Trust Intake (was the investigator). INTAKE_MODE wins; FINANCE_AGENT_MODE stays as its alias. Unset means mock.
    INTAKE_MODE: optional,
    FINANCE_AGENT_MODE: optional,
    CREAO_INTAKE_APP_ID: optional,
    CREAO_INTAKE_API_KEY: optional,
    CREAO_APP_ID: optional,
    CREAO_API_KEY: optional,
    INTAKE_EXTERNAL_API_KEY: optional,
    INTAKE_EXTERNAL_MODEL: optional,
    INTAKE_EXTERNAL_URL: optional,
    // Disbursement agent.
    DISBURSEMENT_MODE: optional,
    CREAO_DISBURSEMENT_APP_ID: optional,
    CREAO_DISBURSEMENT_API_KEY: optional,
    DISBURSEMENT_EXTERNAL_API_KEY: optional,
    DISBURSEMENT_EXTERNAL_MODEL: optional,
    DISBURSEMENT_EXTERNAL_URL: optional,
    // Evidence Checker (was the claim checker). EVIDENCE_CHECKER_MODE wins; CHECKER_MODE stays as its alias. The code part always runs.
    EVIDENCE_CHECKER_MODE: optional,
    CHECKER_MODE: optional,
    CREAO_EVIDENCE_CHECKER_APP_ID: optional,
    CREAO_EVIDENCE_CHECKER_API_KEY: optional,
    CREAO_CHECKER_APP_ID: optional,
    CREAO_CHECKER_API_KEY: optional,
    EVIDENCE_CHECKER_EXTERNAL_API_KEY: optional,
    EVIDENCE_CHECKER_EXTERNAL_MODEL: optional,
    EVIDENCE_CHECKER_EXTERNAL_URL: optional,
    // Three-Way Reconciler (was the mismatch agent).
    RECONCILER_MODE: optional,
    CREAO_RECONCILER_APP_ID: optional,
    CREAO_RECONCILER_API_KEY: optional,
    RECONCILER_EXTERNAL_API_KEY: optional,
    RECONCILER_EXTERNAL_MODEL: optional,
    RECONCILER_EXTERNAL_URL: optional,
    // Trust Compliance Auditor.
    AUDITOR_MODE: optional,
    CREAO_AUDITOR_APP_ID: optional,
    CREAO_AUDITOR_API_KEY: optional,
    AUDITOR_EXTERNAL_API_KEY: optional,
    AUDITOR_EXTERNAL_MODEL: optional,
    AUDITOR_EXTERNAL_URL: optional,
    // Shared.
    AUTO_INVESTIGATE: optional,
    OUTSTANDING_MAX_DAYS: optional,
    PROVIDER_TIMEOUT_MS: optional,
    MAX_REAL_RUNS_PER_DAY: optional,
    MAX_REAL_RUNS_PER_DEPOSIT: optional,
    // Mock mode only: network_once | network_always | hang | invalid_output. Leave unset outside tests and demos.
    MOCK_PROVIDER_FAULT: optional,
  },
});
