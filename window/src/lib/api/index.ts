import { mockApi } from "./mock";
import { httpApi } from "./http";
import { currentApiBase } from "../studio";

export const httpMode = import.meta.env.VITE_API_MODE === "http";
export const api = httpMode ? httpApi : mockApi;
export const streamUrl = (path: string) => `${currentApiBase()}/api${path}`;
export { httpApi };
export { boardCardOf } from "./http";
export type { BoardCardRow, CardStatus } from "./board-view";
export { STUDIO_PROJECT_ID, gameName } from "./board-view";
export type { BoardSummary, Interventions, ShowcaseGame } from "./http";
export type Api = typeof api;
