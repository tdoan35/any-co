import { useCallback, useEffect, useRef, useState } from "react";

export type ClockSource = "live" | "replay";
export type Speed = 1 | 60 | 600;
export const SPEEDS: Speed[] = [1, 60, 600];

/**
 * How a loop opens:
 * - `sim`: a recorded loop played from 0 at 1× as if live (the demo's live start, `?live=1`).
 * - `now`: a running loop, parked at "now". Scrubbing back replays it; Go live returns.
 * - `end`: a finished loop, parked on its final state.
 */
export type ClockStart = "sim" | "now" | "end";

/**
 * One clock for live and replay. Anything faster than 1× pauses on each stop (the reviewer's
 * verdicts), so fast-forward lands on the bounce instead of flying past it.
 */
export function useRunClock(max: number, start: ClockStart, stops: number[], liveStartedAt?: string, liveAllowed = true) {
  const elapsed = () => liveStartedAt ? Math.max(0, (Date.now() - new Date(liveStartedAt).getTime()) / 1000) : max;
  const [liveMax, setLiveMax] = useState(elapsed);
  const limit = liveStartedAt ? liveMax : max;
  const [t, setT] = useState(start === "sim" ? 0 : limit);
  const [speed, setSpeed] = useState<Speed>(start === "sim" ? 1 : 60);
  const [playing, setPlaying] = useState(start === "sim");
  const [source, setSource] = useState<ClockSource>(start === "end" ? "replay" : "live");
  /** The stop the clock last paused on, until playback resumes. */
  const [halt, setHalt] = useState<number>();
  const last = useRef<number | null>(null);
  const tRef = useRef(t);
  const stopsRef = useRef(stops);
  useEffect(() => { tRef.current = t; }, [t]);
  useEffect(() => { stopsRef.current = stops; }, [stops]);

  useEffect(() => {
    if (!liveStartedAt) return;
    const tick = () => {
      const next = Math.max(0, (Date.now() - new Date(liveStartedAt).getTime()) / 1000);
      setLiveMax(next);
      if (source === "live" && start === "now") { tRef.current = next; setT(next); }
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [liveStartedAt, source, start]);

  useEffect(() => {
    if (!playing) { last.current = null; return; }
    // Timer (not rAF) so the clock keeps running in background tabs.
    const id = setInterval(() => {
      const now = performance.now();
      const dt = last.current == null ? 0 : (now - last.current) / 1000;
      last.current = now;
      const prev = tRef.current;
      let next = Math.min(limit, prev + dt * speed);
      const stop = speed > 1 ? stopsRef.current.find((s) => s > prev && s <= next) : undefined;
      if (stop !== undefined) {
        next = stop;
        setPlaying(false);
        setHalt(stop);
      } else if (next >= limit) setPlaying(false);
      tRef.current = next;
      setT(next);
    }, 100);
    return () => clearInterval(id);
  }, [playing, speed, limit]);

  const play = useCallback((p: boolean) => {
    setHalt(undefined);
    // Play at the end starts the replay over.
    if (p && tRef.current >= limit) { tRef.current = 0; setT(0); }
    if (p && start === "now") setSource("replay");
    setPlaying(p);
  }, [limit, start]);
  const changeSpeed = useCallback((s: Speed) => {
    setSpeed(s);
    if (s > 1) setSource("replay");
  }, []);
  const scrub = useCallback((v: number) => {
    tRef.current = v;
    setT(v);
    setHalt(undefined);
    setSource(start === "now" && liveAllowed && v >= limit ? "live" : "replay");
  }, [start, limit, liveAllowed]);
  const fastForward = useCallback(() => {
    setSpeed(600);
    setSource("replay");
    setHalt(undefined);
    if (tRef.current >= limit) { tRef.current = 0; setT(0); }
    setPlaying(true);
  }, [limit]);
  const fastForwardFrom = useCallback((at: number) => {
    tRef.current = at;
    setT(at);
    setSpeed(600);
    setSource("replay");
    setHalt(undefined);
    setPlaying(true);
  }, []);
  const restart = useCallback(() => {
    tRef.current = 0;
    setT(0);
    setHalt(undefined);
    setSpeed(start === "sim" ? 1 : 60);
    setSource(start === "sim" ? "live" : "replay");
    setPlaying(true);
  }, [start]);
  /** Running loops: back to "now". */
  const goLive = useCallback(() => {
    if (!liveAllowed) return;
    tRef.current = limit;
    setT(limit);
    setHalt(undefined);
    setPlaying(false);
    setSource("live");
  }, [limit, liveAllowed]);

  return { t, max: limit, speed, playing, source, halt, play, changeSpeed, scrub, fastForward, fastForwardFrom, restart, goLive };
}
export type RunClock = ReturnType<typeof useRunClock>;
