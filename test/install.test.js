import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

test("release installer preserves user data and other plugins, and keeps backups outside the source", {skip:process.platform !== "win32"}, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  const cache = path.join(root,".cache"); fs.mkdirSync(cache,{recursive:true});
  const fixture = fs.mkdtempSync(path.join(cache,"installer-test-"));
  try {
    fs.writeFileSync(path.join(fixture,"loader.js"),"// synthetic framework");
    fs.mkdirSync(path.join(fixture,"settings"));
    fs.writeFileSync(path.join(fixture,"settings/plugins.json"),JSON.stringify({otherPlugin:true,disabledPlugin:false}));
    const install = () => {
      const run = spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(root,"install.ps1"),"-CommunityDirectory",fixture],{encoding:"utf8",windowsHide:true,timeout:30000});
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
  } finally {
    const target = fs.realpathSync(fixture), allowed = fs.realpathSync(cache) + path.sep;
    if (!target.startsWith(allowed)) throw Error("Refusing cleanup outside project cache");
    fs.rmSync(target,{recursive:true,force:true});
  }
});
