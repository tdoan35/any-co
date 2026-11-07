// Art pipeline CLI: lock | snap | outline | strip | sheet | gate — JSON on stdout.
// Run: npm run art -- <command> ...   (node --import tsx tools/art/art.ts)
// The runner's `art_tools` capability wraps the same library functions.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { decodePng, encodePng, type RgbaImage } from "./png.ts";
import { addOutline, contactSheet, lockPalette, snapToGrid, splitStrip } from "./ops.ts";
import { runGate, type GateReport } from "./gate.ts";

function readPng(file: string): RgbaImage {
  return decodePng(new Uint8Array(readFileSync(file)));
}

function writePng(file: string, img: RgbaImage): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(img));
}

export type CommandResult =
  | { kind: "ok"; json: Record<string, unknown>; exitCode: number }
  | { kind: "error"; json: { error: string }; exitCode: 1 | 2 };

const USAGE = `usage: art.ts <command> ...
  lock    <in.png> <out.png> --palette "#rrggbb,#rrggbb,..." [--alpha-threshold N]
  snap    <in.png> <out.png> --w N --h N
  outline <in.png> <out.png> --color "#rrggbb" [--mode outer]
  strip   <in.png> --frames N [--out-dir DIR]     (default DIR: <in>-frames/)
  sheet   <out.png> --frames "a.png,b.png,..." [--anchor N] [--scale N] [--gap N]
  gate    <game-repo-dir> [--schema <asset.schema.json>]`;

function num(name: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${String(value)}"`);
  return n;
}

/** Parse argv (without the command word) and execute. Pure library calls + file IO; prints nothing. */
export function runCommand(argv: string[]): CommandResult {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "lock": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { palette: { type: "string" }, "alpha-threshold": { type: "string" } } });
        const [inPath, outPath] = positionals;
        if (!inPath || !outPath || !values.palette) throw new Error("usage: lock <in.png> <out.png> --palette \"#rrggbb,...\"");
        const palette = values.palette.split(",").map((s) => s.trim()).filter(Boolean);
        const img = readPng(inPath);
        const { image, stats } = lockPalette(img, palette, { alphaThreshold: values["alpha-threshold"] ? num("--alpha-threshold", values["alpha-threshold"]) : undefined });
        writePng(outPath, image);
        return { kind: "ok", json: { out: outPath, width: image.width, height: image.height, paletteSize: palette.length, ...stats }, exitCode: 0 };
      }
      case "snap": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { w: { type: "string" }, h: { type: "string" } } });
        const [inPath, outPath] = positionals;
        if (!inPath || !outPath || !values.w || !values.h) throw new Error("usage: snap <in.png> <out.png> --w N --h N");
        const w = num("--w", values.w);
        const h = num("--h", values.h);
        const img = readPng(inPath);
        const r = snapToGrid(img, { w, h });
        writePng(outPath, r.image);
        return {
          kind: "ok",
          json: { out: outPath, width: w, height: h, sourceWidth: img.width, sourceHeight: img.height, scaleX: r.scaleX, scaleY: r.scaleY, uniform: r.uniform, integerScale: r.integerScale },
          exitCode: 0,
        };
      }
      case "outline": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { color: { type: "string" }, mode: { type: "string" } } });
        const [inPath, outPath] = positionals;
        if (!inPath || !outPath || !values.color) throw new Error("usage: outline <in.png> <out.png> --color \"#rrggbb\"");
        const image = addOutline(readPng(inPath), values.color, { mode: (values.mode as "outer") ?? "outer" });
        writePng(outPath, image);
        return { kind: "ok", json: { out: outPath, width: image.width, height: image.height, mode: values.mode ?? "outer" }, exitCode: 0 };
      }
      case "strip": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { frames: { type: "string" }, "out-dir": { type: "string" } } });
        const [inPath] = positionals;
        if (!inPath || !values.frames) throw new Error("usage: strip <in.png> --frames N [--out-dir DIR]");
        const count = num("--frames", values.frames);
        const frames = splitStrip(readPng(inPath), count);
        const outDir = values["out-dir"] ?? `${inPath.replace(/\.png$/i, "")}-frames`;
        frames.forEach((f, i) => writePng(path.join(outDir, `frame-${i}.png`), f));
        return { kind: "ok", json: { outDir, frames: frames.length, frameWidth: frames[0].width, frameHeight: frames[0].height }, exitCode: 0 };
      }
      case "sheet": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { frames: { type: "string" }, anchor: { type: "string" }, scale: { type: "string" }, gap: { type: "string" } },
        });
        const [outPath] = positionals;
        if (!outPath || !values.frames) throw new Error('usage: sheet <out.png> --frames "a.png,b.png,..." [--anchor N] [--scale N] [--gap N]');
        const files = values.frames.split(",").map((s) => s.trim()).filter(Boolean);
        const imgs = files.map(readPng);
        const { image, cells } = contactSheet(imgs, {
          anchor: values.anchor ? num("--anchor", values.anchor) : undefined,
          scale: values.scale ? num("--scale", values.scale) : undefined,
          gap: values.gap ? num("--gap", values.gap) : undefined,
        });
        writePng(outPath, image);
        const sidecar = outPath.replace(/\.png$/i, ".cells.json");
        writeFileSync(sidecar, JSON.stringify({ image: path.basename(outPath), cells }, null, 2));
        return { kind: "ok", json: { image: outPath, sidecar, cells }, exitCode: 0 };
      }
      case "gate": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { schema: { type: "string" } } });
        const [repoDir] = positionals;
        if (!repoDir) throw new Error("usage: gate <game-repo-dir> [--schema <asset.schema.json>]");
        const report: GateReport = runGate(repoDir, { schemaPath: values.schema });
        return { kind: "ok", json: report as unknown as Record<string, unknown>, exitCode: report.ok ? 0 : 1 };
      }
      default:
        return { kind: "error", json: { error: command ? `unknown command "${command}"` : `missing command\n${USAGE}` }, exitCode: 2 };
    }
  } catch (e) {
    return { kind: "error", json: { error: (e as Error).message }, exitCode: 1 };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runCommand(process.argv.slice(2));
  console.log(JSON.stringify(r.json));
  process.exitCode = r.exitCode;
}
