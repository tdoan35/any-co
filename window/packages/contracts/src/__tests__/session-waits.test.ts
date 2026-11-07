// ANY-82 T17 — K1: the four session-command schemas the wait-answer and
// approval-mode routes parse and answer with (S3's module, next to the
// session schemas). The request shapes gate what the app sends; the response
// is the accepted/refused union R10's `respond` returns, refusal reasons
// verbatim.
import {
  RespondWaitRequestSchema,
  RespondWaitResponseSchema,
  SetApprovalModeRequestSchema,
  SetApprovalModeResponseSchema,
} from "../sessions";
import { expect, test } from "vitest";

test("K1 RespondWaitRequestSchema parses a non-empty decision and rejects an empty one", () => {
  expect(RespondWaitRequestSchema.parse({ decision: "approve" })).toEqual({ decision: "approve" });
  expect(RespondWaitRequestSchema.parse({ decision: "Tuesday" })).toEqual({ decision: "Tuesday" });
  expect(() => RespondWaitRequestSchema.parse({ decision: "" })).toThrow();
  expect(() => RespondWaitRequestSchema.parse({})).toThrow();
  expect(() => RespondWaitRequestSchema.parse({ decision: 7 })).toThrow();
});

test("K1 RespondWaitResponseSchema parses accepted and the four refusal reasons, rejects an unknown one", () => {
  expect(RespondWaitResponseSchema.parse({ outcome: "accepted" })).toEqual({ outcome: "accepted" });
  for (const reason of ["expired", "already_answered", "cancelled", "gated"]) {
    expect(RespondWaitResponseSchema.parse({ outcome: "refused", reason })).toEqual({
      outcome: "refused",
      reason,
    });
  }
  expect(() => RespondWaitResponseSchema.parse({ outcome: "refused", reason: "whatever" })).toThrow();
  expect(() => RespondWaitResponseSchema.parse({ outcome: "refused" })).toThrow();
  expect(() => RespondWaitResponseSchema.parse({ outcome: "maybe" })).toThrow();
});

test("K1 SetApprovalModeRequestSchema parses the three modes and rejects an unknown one", () => {
  for (const mode of ["ask", "auto_edits", "full_auto"]) {
    expect(SetApprovalModeRequestSchema.parse({ mode })).toEqual({ mode });
  }
  expect(() => SetApprovalModeRequestSchema.parse({ mode: "yolo" })).toThrow();
  expect(() => SetApprovalModeRequestSchema.parse({})).toThrow();
  expect(() => SetApprovalModeRequestSchema.parse({ mode: 3 })).toThrow();
});

test("K1 SetApprovalModeResponseSchema echoes a set mode and rejects an unknown one", () => {
  expect(SetApprovalModeResponseSchema.parse({ mode: "auto_edits" })).toEqual({ mode: "auto_edits" });
  expect(SetApprovalModeResponseSchema.parse({ mode: "ask" })).toEqual({ mode: "ask" });
  expect(() => SetApprovalModeResponseSchema.parse({ mode: "yolo" })).toThrow();
  expect(() => SetApprovalModeResponseSchema.parse({})).toThrow();
});
