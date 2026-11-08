// Studio window portraits: check window/public against the cast (src/lib/cast.ts) and fill gaps
// from Ty's Fabric assets. Studio UI art only: never copy these into games/.
//   node window/scripts/export-avatars.mjs           check + export what's missing
//   node window/scripts/export-avatars.mjs --check   check only (exit 1 on a missing or wrong-size file)
//   FABRIC_DIR=/path/to/fabric                        source checkout (default ~/Desktop/projects/fabric)
// Webp files come from Fabric's web-ready exports (apps/web/public); this machine has no webp encoder
// (ffmpeg without libwebp, sips reads webp only), so new stills are exported as PNG with macOS sips.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const FABRIC = process.env.FABRIC_DIR ?? path.join(os.homedir(), "Desktop/projects/fabric");
const checkOnly = process.argv.includes("--check");

const PERSONAS = ["bea", "carlos", "diego", "elliot", "jonah", "lila", "maya", "megan", "nadine", "nikhil", "rosa", "sana", "yuki"];
const STRIP = { w: 73 * 192, h: 192 }; // 73 frames of 192x192, one row

/** [published path, expected size, how to make it] */
const ASSETS = [
  ...PERSONAS.map((p) => [`agents/${p}-happy.webp`, { w: 384, h: 384 }, { copy: `apps/web/public/agents/${p}-happy.webp` }]),
  ["dana/happy-idle-still.webp", { w: 384, h: 384 }, { copy: "apps/web/public/dana/happy-idle-still.webp" }],
  ["dana/happy-idle-strip.webp", STRIP, { copy: "apps/web/public/dana/happy-idle-strip.webp" }],
  ["dana/working-strip.webp", STRIP, { copy: "apps/web/public/dana/working-strip.webp" }],
  ["dana/waving.png", { w: 384, h: 384 }, { resize: "assets/dana/dana_waving.png" }],
];

const sizeOf = (file) => {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  return { w: Number(/pixelWidth: (\d+)/.exec(out)?.[1]), h: Number(/pixelHeight: (\d+)/.exec(out)?.[1]) };
};

let bad = 0;
for (const [rel, want, how] of ASSETS) {
  const dest = path.join(PUBLIC, rel);
  const ok = () => { if (!existsSync(dest)) return false; const s = sizeOf(dest); return s.w === want.w && s.h === want.h; };
  if (ok()) { console.log(`ok       ${rel}`); continue; }
  if (checkOnly) { console.log(`MISSING  ${rel} (want ${want.w}x${want.h})`); bad++; continue; }
  const src = path.join(FABRIC, how.copy ?? how.resize);
  if (!existsSync(src)) { console.log(`NO SRC   ${rel} <- ${src}`); bad++; continue; }
  mkdirSync(path.dirname(dest), { recursive: true });
  if (how.copy) copyFileSync(src, dest);
  else execFileSync("sips", ["-s", "format", "png", "-Z", String(want.w), src, "--out", dest], { stdio: "ignore" });
  if (ok()) console.log(`wrote    ${rel} <- ${path.relative(FABRIC, src)}`);
  else { console.log(`WRONG    ${rel}: ${JSON.stringify(sizeOf(dest))}, want ${want.w}x${want.h}`); bad++; }
}
process.exit(bad ? 1 : 0);
