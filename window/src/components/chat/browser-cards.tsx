import { useState } from "react";
import { useAui, useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";

/** Deliberately omit args/results: they can contain contact details or full browser traces. */
export function BrowserTaskStatus({ status }: ToolCallMessagePartProps) {
  return <div role="status" className="my-1 text-xs text-muted-foreground">Browser errand · {status.type === "running" ? "working in Session panel" : status.type === "incomplete" ? "stopped" : "finished"}</div>;
}

export function RecallStatus({ status }: ToolCallMessagePartProps) {
  return <div role="status" className="my-1 text-xs text-muted-foreground">Personal context · {status.type === "running" ? "recalling" : status.type === "incomplete" ? "unavailable" : "recalled"}</div>;
}

type Decision = { decision: "approved" | "declined" };
type ConfirmationArgs = { runId: string; summary: string; confirmation: { date: string; time: string; partySize: number; reference?: string } };

export function BrowserConfirmationCard({ args, result, addResult }: ToolCallMessagePartProps<ConfirmationArgs, Decision>) {
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const [submitted, setSubmitted] = useState(false);
  const decide = (decision: Decision["decision"]) => {
    setSubmitted(true);
    addResult({ decision });
    const messages = aui.thread().getState().messages;
    aui.thread().startRun({ parentId: messages[messages.length - 1].id });
  };
  if (!args.confirmation) return <div className="my-1 text-xs text-muted-foreground">Preparing reservation confirmation…</div>;
  return (
    <section className="my-3 rounded-xl border bg-card p-4" aria-label="Confirm browser submission">
      <h3 className="text-sm font-semibold">Confirm reservation submission</h3>
      <p className="mt-2 text-sm">{args.summary}</p>
      <dl className="my-3 grid grid-cols-[88px_1fr] gap-1 text-xs">
        <dt className="text-muted-foreground">Date</dt><dd>{args.confirmation.date}</dd>
        <dt className="text-muted-foreground">Time</dt><dd>{args.confirmation.time}</dd>
        <dt className="text-muted-foreground">Party size</dt><dd>{args.confirmation.partySize}</dd>
        {args.confirmation.reference && <><dt className="text-muted-foreground">Reference</dt><dd>{args.confirmation.reference}</dd></>}
      </dl>
      {result ? <p className="text-xs text-muted-foreground">{result.decision === "approved" ? "Approved — Dana can submit this reservation." : "Declined — this reservation will not be submitted."}</p> : <div className="flex gap-2">
        <Button size="sm" disabled={running || submitted} onClick={() => decide("approved")}>Approve submission</Button>
        <Button size="sm" variant="outline" disabled={running || submitted} onClick={() => decide("declined")}>Decline</Button>
      </div>}
    </section>
  );
}
