import { httpMode } from "@/lib/api";

// The demo build (VITE_DEMO=1, D7): hides group chat, Full auto, voice and the 1M context meter, and
// locks "Runs on" to the Sprite sandbox — in the chat, the composer and Settings.
export const demoMode = import.meta.env.VITE_DEMO === "1";

/**
 * Live studio chat (adapter running): one conversation with the Studio Head. Hides what has no meaning
 * there: agent/team switching, incognito, group chat, attachments, approval mode, model/effort, voice,
 * project/connector/run-target pickers and the context meter.
 */
export const liveChat = httpMode;
