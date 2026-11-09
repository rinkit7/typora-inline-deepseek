import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const cache = path.join(root,".cache");
function makeFixture() {
  fs.mkdirSync(cache,{recursive:true});
  return fs.mkdtempSync(path.join(cache,"installer-test-"));
}
function removeFixture(fixture) {
  const target = fs.realpathSync(fixture), allowed = fs.realpathSync(cache) + path.sep;
  if (!target.startsWith(allowed)) throw Error("Refusing cleanup outside project cache");
  fs.rmSync(target,{recursive:true,force:true});
}
function runPowerShell(file,args) {
  return spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",file,...args],{encoding:"utf8",windowsHide:true,timeout:30000});
}

test("release installer preserves user data and other plugins, and keeps backups outside the source", {skip:process.platform !== "win32"}, () => {
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture,"loader.js"),"// synthetic framework");
    fs.mkdirSync(path.join(fixture,"settings"));
    fs.writeFileSync(path.join(fixture,"settings/plugins.json"),JSON.stringify({otherPlugin:true,disabledPlugin:false}));
    const install = () => {
      const run = runPowerShell(path.join(root,"install.ps1"),["-CommunityDirectory",fixture]);
      assert.equal(run.status,0,run.stderr || run.stdout || run.error?.message);
      return JSON.parse(run.stdout.replace(/^\uFEFF/,""));
    };
    const result = install(), destination = path.join(fixture,"plugins/typora-inline-deepseek");
    assert.equal(result.id,"typora-inline-deepseek");
    assert.ok(result.verifiedFiles >= 80);
    assert.ok(fs.readFileSync(path.join(destination,"README.md"),"utf8").includes("KokuYu-sysu/AI4Typora"));
    fs.mkdirSync(path.join(destination,"data"));
    fs.writeFileSync(path.join(destination,"data/preferences.json"),'{"readerFont":19}');
    fs.mkdirSync(path.join(fixture,"plugins/OtherPlugin"));
    fs.writeFileSync(path.join(fixture,"plugins/OtherPlugin/main.js"),"keep");
    const second = install();
    assert.ok(second.backup.startsWith(path.join(fixture,"backups/typora-inline-deepseek") + path.sep));
    assert.equal(fs.readFileSync(path.join(destination,"data/preferences.json"),"utf8"),'{"readerFont":19}');
    assert.equal(fs.readFileSync(path.join(second.backup,"typora-inline-deepseek/data/preferences.json"),"utf8"),'{"readerFont":19}');
    assert.equal(fs.readFileSync(path.join(fixture,"plugins/OtherPlugin/main.js"),"utf8"),"keep");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture,"settings/plugins.json"),"utf8")),{otherPlugin:true,disabledPlugin:false,"typora-inline-deepseek":true});
    assert.deepEqual(fs.readdirSync(fixture).sort(),["backups","loader.js","plugins","settings"]);
  } finally {removeFixture(fixture);}
});

test("an incomplete release and a failed settings swap both leave the previous installation usable", {skip:process.platform !== "win32"}, () => {
  const fixture = makeFixture();
  try {
    const community = path.join(fixture,"community"), settings = path.join(community,"settings","plugins.json");
    const destination = path.join(community,"plugins","typora-inline-deepseek");
    fs.mkdirSync(path.dirname(settings),{recursive:true});
    fs.writeFileSync(path.join(community,"loader.js"),"// synthetic framework");
    const oldSettings = '{"otherPlugin":true,"typora-inline-deepseek":false}';
    fs.writeFileSync(settings,oldSettings);
    fs.mkdirSync(path.join(destination,"dist"),{recursive:true});
    fs.mkdirSync(path.join(destination,"data"));
    const oldManifest = '{"id":"typora-inline-deepseek","version":"2.2.3"}';
    fs.writeFileSync(path.join(destination,"manifest.json"),oldManifest);
    fs.writeFileSync(path.join(destination,"dist/chat-ui.js"),"// previous bundle");
    fs.writeFileSync(path.join(destination,"data/preferences.json"),'{"readerFont":18}');
    const assertOldInstall = () => {
      assert.equal(fs.readFileSync(path.join(destination,"manifest.json"),"utf8"),oldManifest);
      assert.equal(fs.readFileSync(path.join(destination,"dist/chat-ui.js"),"utf8"),"// previous bundle");
      assert.equal(fs.readFileSync(path.join(destination,"data/preferences.json"),"utf8"),'{"readerFont":18}');
      assert.equal(fs.readFileSync(settings,"utf8"),oldSettings);
      assert.ok(fs.readdirSync(community).every(name => !name.startsWith(".typora-inline-deepseek-")));
    };
    const incomplete = path.join(fixture,"incomplete");
    fs.mkdirSync(incomplete);
    for (const name of ["install.ps1","main.js","manifest.json","package.json","README.md","THIRD_PARTY_NOTICES.md","bin","dist","src"]) {
      fs.cpSync(path.join(root,name),path.join(incomplete,name),{recursive:true});
    }
    const preflight = runPowerShell(path.join(incomplete,"install.ps1"),["-CommunityDirectory",community]);
    assert.equal(preflight.status,1,preflight.error?.message || preflight.stdout);
    assert.match(preflight.stderr,/LICENSE/);
    assertOldInstall();

    // Allow reads while denying the atomic replacement of settings/plugins.json.
    const lockSettings = path.join(fixture,"lock-settings.ps1");
    fs.writeFileSync(lockSettings,[
      "param($Installer,$Community,$Settings)",
      "$ErrorActionPreference = 'Stop'",
      "$lock = [System.IO.File]::Open($Settings,'Open','Read','Read')",
      "try {& $Installer -CommunityDirectory $Community}",
      "finally {$lock.Dispose()}"
    ].join("\r\n"));
    const swap = runPowerShell(lockSettings,["-Installer",path.join(root,"install.ps1"),"-Community",community,"-Settings",settings]);
    assert.equal(swap.status,1,swap.error?.message || swap.stdout);
    assert.match(swap.stderr,/Replace/);
    assertOldInstall();
  } finally {removeFixture(fixture);}
});
