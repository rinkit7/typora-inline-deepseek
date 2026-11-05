import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
let checked = 0;
function check(file) {
  checked++;
  const result = spawnSync(process.execPath,["--check",file],{encoding:"utf8",windowsHide:true});
  if (result.status !== 0) throw Error(result.stderr || `Syntax error: ${file}`);
  if (file.includes(`${path.sep}dist${path.sep}`)) return;
  for (const match of fs.readFileSync(file,"utf8").matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(file),match[1]))) throw Error(`Missing import in ${file}: ${match[1]}`);
  }
}
function walk(directory) {for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {const file = path.join(directory,entry.name); if (entry.isDirectory()) walk(file); else if (/\.(js|mjs)$/.test(entry.name)) check(file);}}
check(path.join(root,"main.js"));
for (const directory of ["src","test","scripts"]) walk(path.join(root,directory));
check(path.join(root,"dist/chat-ui.js"));
const info = JSON.parse(fs.readFileSync(path.join(root,"dist/build-info.json"),"utf8"));
const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root,"dist/chat-ui.js"))).digest("hex");
if (hash !== info.sha256) throw Error("Bundle hash does not match its build record.");
const uiSourceHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root,"ui/chat-ui.jsx"))).update(fs.readFileSync(path.join(root,"ui/chat-ui.css"))).update(fs.readFileSync(path.join(root,"src/pointer-gestures.js"))).update(fs.readFileSync(path.join(root,"src/quick-asks.js"))).digest("hex");
if (uiSourceHash !== info.sourceSha256) throw Error("UI source changed after the last build. Run npm run build.");
const source = fs.readFileSync(path.join(root,"dist/chat-ui.js"),"utf8");
for (const file of new Set([...source.matchAll(/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf)/g)].map(match => match[0]))) {
  if (!fs.existsSync(path.join(root,"dist/fonts",file))) throw Error(`Missing KaTeX font: ${file}`);
}
console.log(`Checked ${checked} JavaScript files, bundle hash and KaTeX resources.`);
