// Live presence for portraits: an agent is "working" while Weave's presence says so (live mode:
// a run in flight for that agent, from window/server/weave.ts; mock mode: the fixture world).
import { useWeave } from "@/lib/weave-store";

export function useWorking(agentId: string): boolean {
  const { presence } = useWeave();
  return presence.some((p) => p.agentId === agentId && p.state === "working");
}
