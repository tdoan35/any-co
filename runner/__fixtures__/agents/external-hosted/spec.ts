import { defineAgent } from "../../../spec.ts";
export default defineAgent({ name: "external-hosted", description: "Fixture: external provider on hosted runner.", dept: "eng", runner: "naive",
  model: "m", budget: { cap_usd: 1, max_task_usd: 1, period: "day" },
  provider: { kind: "openai_compatible", model: "x", base_url_env: "FAST_BASE_URL", api_key_env: "FAST_API_KEY", usd_per_mtok: { input: 0.1, output: 0.4 } } });
