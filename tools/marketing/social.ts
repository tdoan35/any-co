// Release-video uploads for the social media manager. Dry-run is the default.
// A real YouTube upload needs dry_run:false, the operator's approval (the capability is ask-gated),
// and YOUTUBE_* in the environment. TikTok's live post is refused: unaudited apps stay private
// and the audit will not finish before the freeze. Keys never appear in results.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { errText, resolveInWorkspace, type ToolImpl, type ToolOutput } from "../../runner/tools/kit.ts";

const MAX_BYTES = 64 * 1024 * 1024;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const videoFile = z.string().min(3).max(200).describe("Workspace path under media/, an .mp4");
const title = z.string().min(1).max(100);
const description = z.string().min(1).max(5000);

function pack(obj: Record<string, unknown>, is_error = false): ToolOutput {
  return { content: JSON.stringify(obj), ...(is_error ? { is_error: true } : {}) };
}

/** disclosure env is the operator's required phrase. Unset, present in the text, or absent from it. */
export function disclosureState(descriptionText: string): "unset" | "present" | "absent" {
  const needle = process.env.STUDIO_DISCLOSURE?.trim();
  if (!needle) return "unset";
  return descriptionText.includes(needle) ? "present" : "absent";
}

function loadMp4(workspace: string, rel: string): { rel: string; bytes: number; abs: string } {
  const norm = rel.replace(/\\/g, "/");
  if (!norm.startsWith("media/") || norm.split("/").includes("..")) throw new Error(`file must be under media/ in the workspace, got "${rel}"`);
  if (!norm.toLowerCase().endsWith(".mp4")) throw new Error("file must be an .mp4");
  const abs = resolveInWorkspace(workspace, norm);
  if (!existsSync(abs)) throw new Error(`file not found: ${norm}`);
  const st = lstatSync(abs);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("file must be a regular file, not a symlink");
  if (st.size <= 0) throw new Error("file is empty");
  if (st.size > MAX_BYTES) throw new Error(`file is ${st.size} bytes; cap is ${MAX_BYTES}`);
  return { rel: norm, bytes: st.size, abs };
}

function base(platform: "youtube" | "tiktok", file: { rel: string; bytes: number }, titleText: string, descriptionText: string, extra: Record<string, unknown>) {
  return {
    platform,
    file: file.rel,
    bytes: file.bytes,
    title: titleText,
    description_chars: descriptionText.length,
    disclosure: disclosureState(descriptionText),
    sent: false,
    ...extra,
  };
}

export function createYoutubeUpload(fetchImpl: FetchLike = globalThis.fetch): ToolImpl {
  return {
    description:
      "Upload one mp4 to the studio YouTube channel. Dry-run by default (no network). A real upload needs dry_run:false after operator approval, " +
      "YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN. The description must contain STUDIO_DISCLOSURE. Result is JSON; secrets are never included.",
    input: z
      .object({
        file: videoFile,
        title,
        description,
        privacy: z.enum(["public", "unlisted", "private"]).default("unlisted"),
        dry_run: z.boolean().default(true).describe("Default true. false uploads for real, and only after the approval gate"),
      })
      .strict(),
    async run(input, ctx) {
      try {
        const file = loadMp4(ctx.workspace, input.file as string);
        const titleText = input.title as string;
        const descriptionText = input.description as string;
        const privacy = (input.privacy as string) ?? "unlisted";
        const dryRun = (input.dry_run as boolean) ?? true;
        const body = base("youtube", file, titleText, descriptionText, { privacy, dry_run: dryRun });
        if (dryRun) return pack(body);
        if (body.disclosure !== "present") {
          return pack({ ...body, reason: "description does not contain STUDIO_DISCLOSURE, or STUDIO_DISCLOSURE is unset" }, true);
        }
        const video_id = await youtubeSend(file.abs, titleText, descriptionText, privacy, fetchImpl);
        return pack({ ...body, sent: true, video_id });
      } catch (e) {
        return pack({ platform: "youtube", sent: false, dry_run: input.dry_run !== false, reason: errText(e) }, true);
      }
    },
  };
}

async function youtubeSend(abs: string, titleText: string, descriptionText: string, privacy: string, fetchImpl: FetchLike): Promise<string> {
  const id = process.env.YOUTUBE_CLIENT_ID;
  const secret = process.env.YOUTUBE_CLIENT_SECRET;
  const refresh = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!id || !secret || !refresh) throw new Error("missing YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, or YOUTUBE_REFRESH_TOKEN");
  const tokenRes = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  if (!tokenRes.ok) throw new Error(`youtube token refresh failed: HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("youtube token refresh returned no access_token");
  const bytes = readFileSync(abs);
  const init = await fetchImpl("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-type": "video/mp4",
      "x-upload-content-length": String(bytes.length),
    },
    body: JSON.stringify({
      snippet: { title: titleText, description: descriptionText, categoryId: "20" },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) throw new Error(`youtube upload init failed: HTTP ${init.status}`);
  const location = init.headers.get("location");
  if (!location) throw new Error("youtube upload init returned no Location");
  const put = await fetchImpl(location, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-length": String(bytes.length) },
    body: new Uint8Array(bytes),
  });
  if (!put.ok) throw new Error(`youtube upload failed: HTTP ${put.status}`);
  const done = (await put.json()) as { id?: string };
  if (!done.id) throw new Error("youtube upload returned no video id");
  return done.id;
}

export const youtubeUpload = createYoutubeUpload();

const TIKTOK_REFUSAL = "Live TikTok posting is refused: unaudited clients can only post private, and app review will not finish before the freeze.";

export const tiktokUpload: ToolImpl = {
  description:
    "Package one mp4 for TikTok. Dry-run by default and does not call TikTok. dry_run:false is refused: unaudited apps cannot make a public post before the freeze. Result is JSON.",
  input: z
    .object({
      file: videoFile,
      title,
      description: z.string().min(1).max(2200),
      dry_run: z.boolean().default(true),
    })
    .strict(),
  async run(input, ctx) {
    try {
      const file = loadMp4(ctx.workspace, input.file as string);
      const titleText = input.title as string;
      const descriptionText = input.description as string;
      const dryRun = (input.dry_run as boolean) ?? true;
      const body = base("tiktok", file, titleText, descriptionText, { dry_run: dryRun });
      if (!dryRun) return pack({ ...body, reason: TIKTOK_REFUSAL }, true);
      return pack(body);
    } catch (e) {
      return pack({ platform: "tiktok", sent: false, dry_run: input.dry_run !== false, reason: errText(e) }, true);
    }
  },
};
