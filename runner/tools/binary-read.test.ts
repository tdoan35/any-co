// Nov 8: workspace_read on a PNG flooded a GLM context with binary-as-text ($21 in one call). Text reads refuse binary files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTextForModel } from "./kit.ts";
import { encodePng, makeImage } from "../../tools/art/png.ts";

test("text reads refuse binary files with a pointer to the right tool; text and UTF-8 still read", async () => {
  const d = mkdtempSync(path.join(tmpdir(), "binread-"));
  writeFileSync(path.join(d, "a.png"), encodePng(makeImage(32, 32)));
  writeFileSync(path.join(d, "b.mp4"), Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  writeFileSync(path.join(d, "c.md"), "# Caravan — “quotes”, émoji 🐪\n");
  const png = await readTextForModel(path.join(d, "a.png"));
  assert.equal(png.is_error, true);
  assert.match(png.content, /binary .*art_view/);
  assert.ok(png.content.length < 300, "a short refusal, not the bytes");
  const mp4 = await readTextForModel(path.join(d, "b.mp4"));
  assert.match(mp4.content, /media_probe/);
  const md = await readTextForModel(path.join(d, "c.md"));
  assert.equal(md.is_error, undefined);
  assert.equal(md.content, "# Caravan — “quotes”, émoji 🐪\n");
});
