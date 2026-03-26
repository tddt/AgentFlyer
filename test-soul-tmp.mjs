import { syncSoulMd } from "./src/agent/prompt/soul.js";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync("c:/Users/Administrator/.agentflyer/agentflyer.json", "utf8"));
const w3 = cfg.agents.find(a => a.id === "worker3");
const existing = readFileSync("d:/agentflyer_workspace/worker3_space/SOUL.md", "utf8");
const result = syncSoulMd(w3, existing);
console.log(result);
