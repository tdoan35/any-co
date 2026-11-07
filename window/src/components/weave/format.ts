import { WEAVE_NOW, WEAVE_TZ } from "@/lib/mock/weave";
import { httpMode } from "@/lib/api";
export const weaveNow = () => httpMode ? new Date() : WEAVE_NOW;

/** Every Weave time renders in Ty's timezone, whatever the viewer's is. */
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: WEAVE_TZ, hour: "numeric", minute: "2-digit" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: WEAVE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: WEAVE_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" });
const shortDate = new Intl.DateTimeFormat("en-US", { timeZone: WEAVE_TZ, month: "short", day: "numeric" });

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));
/** "2026-10-02" in Ty's timezone. */
export const dayKey = (d: string | Date) => keyFmt.format(typeof d === "string" ? new Date(d) : d);
export const TODAY = dayKey(weaveNow());

/** Minutes since midnight in Ty's timezone. */
export function clockMinutes(d: string | Date) {
  const parts = partsFmt.formatToParts(typeof d === "string" ? new Date(d) : d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** Compact age, Linear-style: "now", "12m", "3h", "Sep 29". */
export function age(iso: string, now: Date = weaveNow()) {
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  return shortDate.format(new Date(iso));
}

/** Spelled-out age for detail headers: "just now", "12 min ago", "3 h ago", "Sep 29". */
export function ago(iso: string, now: Date = weaveNow()) {
  const a = age(iso, now);
  if (a === "now") return "just now";
  return /^\d+[mh]$/.test(a) ? `${a.slice(0, -1)} ${a.endsWith("m") ? "min" : "h"} ago` : a;
}

/** "12 min", "1 h 5 min": how long work has been waiting. */
export function waited(iso: string, now: Date = weaveNow()) {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Calendar-date helpers work on "YYYY-MM-DD" keys, so they never depend on the viewer's timezone. */
export function fromKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function toKey(d: Date) {
  return d.toISOString().slice(0, 10);
}
const longDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
const fullDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });

/** Day group heading: "Today", "Yesterday", "Tuesday, Sep 29". */
export function dayLabel(key: string) {
  if (key === TODAY) return "Today";
  const y = fromKey(TODAY);
  y.setUTCDate(y.getUTCDate() - 1);
  if (key === toKey(y)) return "Yesterday";
  return longDay.format(fromKey(key));
}
/** "Good morning, Ty", by the mock clock so it agrees with the date in the header. */
export function greeting(now: Date = weaveNow()) {
  const h = clockMinutes(now) / 60;
  return `Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}, Ty`;
}

const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
/** "Fri, Oct 2". */
export const shortDayLabel = (key: string) => shortDay.format(fromKey(key));

/** "Friday, October 2". */
export const fullDayLabel = (key: string) => fullDay.format(fromKey(key));
