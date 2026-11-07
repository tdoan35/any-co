// Worker: top-k search for a slice of query rows over shared buffers.
import { parentPort, workerData } from "node:worker_threads";
import { topK } from "./math.ts";

const { queries, base, dims, k, start, end, outIdx, outSim, skipSelf } = workerData as {
  queries: SharedArrayBuffer; base: SharedArrayBuffer; dims: number; k: number;
  start: number; end: number; outIdx: SharedArrayBuffer; outSim: SharedArrayBuffer; skipSelf: boolean;
};
const f32 = (b: SharedArrayBuffer) => new Float32Array(b as unknown as ArrayBuffer);
topK(f32(queries), f32(base), dims, k, start, end, new Int32Array(outIdx as unknown as ArrayBuffer), f32(outSim), skipSelf);
parentPort!.postMessage("done");
