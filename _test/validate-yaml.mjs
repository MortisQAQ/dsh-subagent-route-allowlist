
import { parse } from "file:///D:/dsh-home/profiles/desktop/node_modules/yaml/dist/index.js";
import { readFileSync } from "node:fs";
const doc = parse(readFileSync("D:/dsh-home/profiles/desktop/cordis.patch.yml", "utf8"));
console.log("entries:", doc.length);
const s = doc.find(e => e.id === "subagent-model-selection-settings");
console.log("enabled:", s.config.enabled);
console.log("allowedModels:", JSON.stringify(s.config.allowedModels, null, 1));
console.log("duplicates:", s.config.allowedModels.length !== new Set(s.config.allowedModels.map(r => r.provider + "/" + r.model)).size);
