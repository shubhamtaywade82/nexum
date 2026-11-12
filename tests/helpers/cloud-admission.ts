/**
 * A recording CloudAdmission for tests that exercise dispatch and routing rather than budget accounting. It admits
 * every call and records what the dispatcher reported, so a test can assert the reservation lifecycle without a
 * ledger. Budget behaviour itself is tested against the real ledger (tests/economics).
 */
import type {
  CloudAdmission,
  CloudAdmissionRequest,
  CloudLease,
  UnexecutedReason,
} from "../../src/models/gateway/cloud-admission.js";

export interface AdmissionRecord {
  readonly admitted: CloudAdmissionRequest[];
  readonly settled: CloudLease[];
  readonly released: Array<{ lease: CloudLease; reason: UnexecutedReason }>;
  readonly unknown: Array<{ lease: CloudLease; reason: string }>;
}

export function recordingCloudAdmission(): { admission: CloudAdmission; record: AdmissionRecord } {
  const record: AdmissionRecord = { admitted: [], settled: [], released: [], unknown: [] };
  let next = 0;
  const admission: CloudAdmission = {
    admit: (req) => {
      record.admitted.push(req);
      next += 1;
      return {
        kind: "ADMITTED",
        lease: {
          reservationId: `test-${next}`,
          model: req.model,
          boundMicro: 1,
          maxOutputTokens: req.maxOutputTokens ?? 4096,
        },
      };
    },
    settle: (lease) => {
      record.settled.push(lease);
    },
    releaseUnexecuted: (lease, reason) => {
      record.released.push({ lease, reason });
    },
    markUnknown: (lease, reason) => {
      record.unknown.push({ lease, reason });
    },
  };
  return { admission, record };
}
