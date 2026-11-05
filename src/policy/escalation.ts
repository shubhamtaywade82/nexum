export type EscalationFlags = {
  multiFile?: boolean;
  multiStep?: boolean;
  largePatch?: boolean;
  crossModule?: boolean;
  schemaChange?: boolean;
  migrationRequired?: boolean;
  securitySensitive?: boolean;
  debuggingRequired?: boolean;
  architectureRequired?: boolean;
  localToolCallInvalid?: boolean;
  localPatchFailed?: boolean;
  testsStillFail?: boolean;
  diagnosticsStillPresent?: boolean;
  lowRetrievalConfidence?: boolean;
  ambiguousAfterTinyModel?: boolean;
  localTimeout?: boolean;
  localOom?: boolean;
  userRequestedCloud?: boolean;
  localFailed?: boolean;
};

export type MateriallyUnresolvedFlags = {
  changeNotApplied?: boolean;
  validationFailed?: boolean;
  testsFailed?: boolean;
  diagnosticsRemain?: boolean;
  answerDoesNotAddressRequest?: boolean;
  nextStepUnclear?: boolean;
};

const ESCALATION_REASONS: Array<[keyof EscalationFlags, string]> = [
  ["multiFile", "multi_file"],
  ["multiStep", "multi_step"],
  ["largePatch", "large_patch"],
  ["crossModule", "cross_module"],
  ["schemaChange", "schema_change"],
  ["migrationRequired", "migration_required"],
  ["securitySensitive", "security_sensitive"],
  ["debuggingRequired", "debugging_required"],
  ["architectureRequired", "architecture_required"],
  ["localToolCallInvalid", "local_tool_call_invalid"],
  ["localPatchFailed", "local_patch_failed"],
  ["testsStillFail", "tests_still_fail"],
  ["diagnosticsStillPresent", "diagnostics_still_present"],
  ["lowRetrievalConfidence", "low_retrieval_confidence"],
  ["ambiguousAfterTinyModel", "ambiguous_after_tiny_model"],
  ["localTimeout", "local_timeout"],
  ["localOom", "local_oom"],
  ["userRequestedCloud", "user_requested_cloud"],
  ["localFailed", "local_failed"],
];

export function isMateriallyUnresolved(flags: MateriallyUnresolvedFlags): boolean {
  return (
    flags.changeNotApplied === true ||
    flags.validationFailed === true ||
    flags.testsFailed === true ||
    flags.diagnosticsRemain === true ||
    flags.answerDoesNotAddressRequest === true ||
    flags.nextStepUnclear === true
  );
}

export type EscalationDecision = {
  escalate: boolean;
  reasons: string[];
  materiallyUnresolved: boolean;
};

export function evaluateEscalation(
  flags: EscalationFlags,
  unresolved: MateriallyUnresolvedFlags = {},
): EscalationDecision {
  const reasons: string[] = [];
  for (const [key, label] of ESCALATION_REASONS) {
    if (flags[key] === true) reasons.push(label);
  }
  const materiallyUnresolved = isMateriallyUnresolved(unresolved);
  if (materiallyUnresolved) {
    reasons.push("materially_unresolved");
  }
  if (flags.localFailed === true && materiallyUnresolved) {
    if (!reasons.includes("local_failed_unresolved")) {
      reasons.push("local_failed_unresolved");
    }
  }
  return {
    escalate: reasons.length > 0,
    reasons,
    materiallyUnresolved,
  };
}
