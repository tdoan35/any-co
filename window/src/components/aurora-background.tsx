import { cn } from "@/lib/utils";

/**
 * Animated aurora backdrop, ported from velocity (frontend/src/components/ui/aurora-background.tsx).
 * Purely decorative: render it as the first child of a `relative` container and put content above it.
 */
export function AuroraBackground({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {/* Base gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-white via-gray-50 to-white dark:from-slate-950 dark:via-slate-900 dark:to-black" />

      {/* Light: static base */}
      <div
        className="absolute inset-0 opacity-100 dark:opacity-0"
        style={{
          background: `
            radial-gradient(ellipse 800px 600px at 20% 0%, rgba(59, 130, 246, 0.25), transparent),
            radial-gradient(ellipse 600px 800px at 80% 100%, rgba(236, 72, 153, 0.15), transparent),
            radial-gradient(ellipse 700px 500px at 100% 0%, rgba(147, 51, 234, 0.20), transparent),
            radial-gradient(ellipse 800px 700px at 0% 100%, rgba(34, 197, 94, 0.12), transparent),
            radial-gradient(ellipse 600px 600px at 50% 50%, rgba(251, 146, 60, 0.15), transparent)
          `,
        }}
      />
      {/* Dark: static base */}
      <div
        className="absolute inset-0 opacity-0 dark:opacity-100"
        style={{
          background: `
            radial-gradient(ellipse 800px 600px at 20% 0%, rgba(59, 130, 246, 0.08), transparent),
            radial-gradient(ellipse 600px 800px at 80% 100%, rgba(147, 51, 234, 0.05), transparent),
            radial-gradient(ellipse 700px 500px at 100% 0%, rgba(99, 102, 241, 0.07), transparent),
            radial-gradient(ellipse 800px 700px at 0% 100%, rgba(139, 92, 246, 0.05), transparent)
          `,
        }}
      />

      {/* Light: animated layer 1 */}
      <div
        className="absolute inset-0 animate-aurora opacity-100 motion-reduce:animate-none dark:opacity-0"
        style={{
          background: `
            radial-gradient(circle 800px at 20% 80%, rgba(147, 51, 234, 0.20), transparent),
            radial-gradient(circle 800px at 80% 20%, rgba(236, 72, 153, 0.15), transparent),
            radial-gradient(circle 600px at 60% 60%, rgba(59, 130, 246, 0.25), transparent)
          `,
          backgroundSize: "200% 200%",
          backgroundPosition: "0% 0%",
        }}
      />
      {/* Dark: animated layer 1 */}
      <div
        className="absolute inset-0 animate-aurora opacity-0 motion-reduce:animate-none dark:opacity-100"
        style={{
          background: `
            radial-gradient(circle 800px at 20% 80%, rgba(99, 102, 241, 0.07), transparent),
            radial-gradient(circle 800px at 80% 20%, rgba(139, 92, 246, 0.05), transparent),
            radial-gradient(circle 600px at 60% 60%, rgba(59, 130, 246, 0.08), transparent)
          `,
          backgroundSize: "200% 200%",
          backgroundPosition: "0% 0%",
        }}
      />

      {/* Light: animated layer 2 */}
      <div
        className="absolute inset-0 animate-aurora-reverse opacity-100 motion-reduce:animate-none dark:opacity-0"
        style={{
          background: `
            radial-gradient(circle 600px at 80% 80%, rgba(251, 146, 60, 0.15), transparent),
            radial-gradient(circle 700px at 20% 20%, rgba(34, 197, 94, 0.12), transparent)
          `,
          backgroundSize: "200% 200%",
          backgroundPosition: "100% 100%",
          animationDuration: "7.5s",
        }}
      />
      {/* Dark: animated layer 2 */}
      <div
        className="absolute inset-0 animate-aurora-reverse opacity-0 motion-reduce:animate-none dark:opacity-100"
        style={{
          background: `
            radial-gradient(circle 600px at 80% 80%, rgba(147, 51, 234, 0.04), transparent),
            radial-gradient(circle 700px at 20% 20%, rgba(99, 102, 241, 0.06), transparent)
          `,
          backgroundSize: "200% 200%",
          backgroundPosition: "100% 100%",
          animationDuration: "7.5s",
        }}
      />

      {/* Soft glow */}
      <div className="absolute inset-0 opacity-30 backdrop-blur-xl dark:opacity-20 dark:backdrop-blur-sm" />
    </div>
  );
}
