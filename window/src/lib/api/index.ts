import { mockApi } from "./mock";
import { httpApi, apiBase } from "./http";

export const httpMode = import.meta.env.VITE_API_MODE === "http";
export const api = httpMode ? httpApi : mockApi;
export const streamUrl = (path: string) => `${apiBase}/api${path}`;
export { httpApi };
export type { Interventions } from "./http";
export type Api = typeof api;
