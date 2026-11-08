import { mockApi } from "./mock";
import { httpApi } from "./http";
import { currentApiBase } from "../studio";

export const httpMode = import.meta.env.VITE_API_MODE === "http";
export const api = httpMode ? httpApi : mockApi;
export const streamUrl = (path: string) => `${currentApiBase()}/api${path}`;
export { httpApi };
export type { Interventions } from "./http";
export type Api = typeof api;
