import type { CSSProperties } from "react";
import type { SpriteAvatar } from "@/lib/mock/assistant";
import { cn } from "@/lib/utils";

type Loop = { strip: string; frames: number; fps: number };

const loopStyle = ({ frames, fps }: Loop) => ({
  width: `${frames * 100}%`,
  "--sprite-end": `${-((frames - 1) / frames) * 100}%`,
  animation: `sprite-strip ${frames / fps}s steps(${frames}, jump-none) infinite alternate`,
}) as CSSProperties;

/**
 * Round profile container that plays a sprite-strip loop: the idle loop, or the working loop while `working`.
 * - The still sits underneath, so there is never an empty frame while a strip loads.
 * - Plays forward then backward (alternate) so the loop has no visible seam.
 * - Both strips stay mounted (the inactive one display:none) so switching never waits on a download.
 * - Reduced motion: the strips are hidden and only the still shows.
 */
export function AgentAvatar({ avatar, name, working = false, className }: { avatar: SpriteAvatar; name: string; working?: boolean; className?: string }) {
  const { strip, frames, fps } = avatar;
  const idle: Loop | undefined = strip && frames && fps ? { strip, frames, fps } : undefined;
  const busy = working && !!avatar.working;
  const loops = [
    idle && { key: "idle", loop: idle, active: !busy },
    avatar.working && { key: "working", loop: avatar.working, active: busy },
  ].filter((l) => !!l);
  return (
    <div className={cn("relative size-28 shrink-0 overflow-hidden rounded-full bg-ok-soft shadow-sm", className)} role="img" aria-label={working ? `${name}, working` : name}>
      <img src={avatar.still} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
      {loops.map(({ key, loop, active }) => (
        <img
          key={key} src={loop.strip} alt="" decoding="async" draggable={false} style={loopStyle(loop)}
          className={cn("absolute left-0 top-0 h-full max-w-none will-change-transform motion-reduce:hidden", !active && "hidden")}
        />
      ))}
    </div>
  );
}

/** Fallback when an agent has no art yet: a round initial that matches the portrait container. */
export function InitialAvatar({ initial, name, tone, className }: { initial: string; name: string; tone: string; className?: string }) {
  return (
    <div
      className={cn("relative flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold shadow-sm", tone, className)}
      role="img"
      aria-label={name}
    >
      <span className="text-[2.6em] leading-none">{initial}</span>
    </div>
  );
}
