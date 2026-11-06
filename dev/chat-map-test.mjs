import { buildChatRequest } from "../lib/chat.js"
import { readFile } from "node:fs/promises"
const text = JSON.parse(await readFile(".devdata/studio/papers/p-rsi-2026/text.json", "utf8"))
const req = buildChatRequest({ meta: { title: "T" }, paragraphs: text.paragraphs, question: "核心贡献是什么" })
console.log("system chars:", req.system.length)
console.log("outline?", req.system.includes("章节结构"))
console.log("excerpts:", req.excerpts.length)
console.log(req.system.slice(0, 300).replace(/\n+/g, " | "))
