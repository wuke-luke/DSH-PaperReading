import { resolveSelection, resetSelection } from "../lib/llm.js"
const ctx = { llm: { listProviders: () => [{ id: "deepseek-official" }], listModels: async () => [{ id: "deepseek-flash" }] } }
resetSelection()
console.log("with provider/model:", JSON.stringify(await resolveSelection(ctx, { llm: { mode: "host", provider: "deepseek-official", model: "deepseek-flash-pro" } })))
resetSelection()
console.log("without:", JSON.stringify(await resolveSelection(ctx, { llm: { mode: "host" } })))
