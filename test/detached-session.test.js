import test from "node:test";
import assert from "node:assert/strict";
import { activateNativeWindow, createChannel, createDetachedSession, DETACHED_STANDALONE_CLASS, DETACHED_WINDOW_TITLE, purifyDetachedChrome, registerNativeWindow, relabelDetachedText } from "../src/detached-session.js";
import { DATA_DIRECTORY } from "../src/runtime-paths.js";
import { browserEnvironment } from "./helpers/browser-env.js";

test("window bridge preserves dock and close messages sent together, without duplicating them", async () => {
  const files = new Map(), events = [];
  const fs = {readFileSync:path => {
    if (!files.has(path)) throw Error("not found");
    return files.get(path);
  },writeFileSync:(path,data) => files.set(path,data)};
  const host = createChannel(fs,"test-session","host",packet => events.push(packet.type),60000);
  const child = createChannel(fs,"test-session","detached",() => {},60000);
  try {
    child.send("dock",{url:"https://chat.deepseek.com/a/chat/s/example"});
    child.send("closed");
    await host.poll();
    await host.poll();
    assert.deepEqual(events,["dock","closed"]);
  } finally {host.dispose();child.dispose();}
});

test("an insertion request and its result cross the two window channels", async () => {
  const files = new Map(), replies = [];
  const fs = {readFileSync:path => {
    if (!files.has(path)) throw Error("not found");
    return files.get(path);
  },writeFileSync:(path,data) => files.set(path,data)};
  const host = createChannel(fs,"test-session","host",packet => {
    assert.equal(packet.type,"insert");
    assert.equal(packet.payload.text,"answer");
    host.send("result",{requestId:packet.id,ok:true});
  },60000);
  const child = createChannel(fs,"test-session","detached",packet => replies.push(packet),60000);
  try {
    const id = child.send("insert",{text:"answer"});
    await host.poll(); await child.poll();
    assert.equal(replies[0].payload.requestId,id);
    assert.equal(replies[0].payload.ok,true);
  } finally {host.dispose();child.dispose();}
});

test("reopening restores the uniquely identified window without creating another, even if focus RPC never resolves", async () => {
  const files = new Map(), opens = [], selections = [], activations = [];
  let childSession, minimized = false, focused = false, notesCreated = 0, reveals = 0;
  const fs = {
    readFileSync(path) {
      if (!files.has(path)) throw Error("not found");
      return files.get(path);
    },
    writeFileSync(path,data) { files.set(path,data); if (path.endsWith(".md")) notesCreated++; },
    mkdirSync() {}
  };
  const runtimeBase = {reqnode:name => name === "fs" ? fs : name === "process" ? {execPath:"E:\\Typora\\Typora.exe"} : name === "child_process" ? {
    execFile(helper,args,options,callback) {
      activations.push({helper,args,options}); minimized = false; focused = true;
      callback(null,JSON.stringify(args.includes("--register") ? {found:true,registered:true,retitled:true} : {found:true,restored:true,foreground:true}));
    }
  } : {randomUUID:() => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
    addEventListener() {}, removeEventListener() {}};
  const hostRuntime = {...runtimeBase,_options:{initFilePath:"E:/notes/original.md"},JSBridge:{
    async invoke(command,note,options) {
      if (command !== "app.openFile") return;
      opens.push({note,options});
      minimized = false; focused = true;
      if (options.forceCreateWindow) {
        const childRuntime = {...runtimeBase,_options:{initFilePath:note},JSBridge:{
          invoke(command) {
            if (command === "window.focus") return new Promise(() => {});
            if (command === "window.minimize") minimized = true;
            return Promise.resolve();
          }
        }};
        childSession = createDetachedSession(null,() => ({restore:payload => selections.push(payload),reveal:() => {reveals++;}}),childRuntime);
        childSession.start();
      }
    }
  }};
  const hostSession = createDetachedSession(null,() => ({}),hostRuntime);
  async function waitForSelections(count) {
    const deadline = Date.now() + 2500;
    while (selections.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(selections.length,count);
  }
  try {
    // Repeated clicks while the helper window is starting must share one launch.
    await Promise.all([hostSession.detach({selection:"outdated"}),hostSession.detach({selection:"first"})]);
    await waitForSelections(1);
    for (const [index,selection] of ["second","third"].entries()) {
      minimized = true; focused = false;
      await hostSession.detach({selection});
      assert.equal(minimized,false);
      assert.equal(focused,true);
      await waitForSelections(index + 2);
      assert.equal(selections[index + 1].preserveConversation,true);
    }
    assert.equal(notesCreated,1,"existing sessions must not create another window document");
    assert.deepEqual(opens.map(call => call.options.forceCreateWindow),[true]);
    const activationsOnly = activations.filter(call => !call.args.includes("--register"));
    const registrations = activations.filter(call => call.args.includes("--register"));
    assert.equal(activationsOnly.length,2);
    assert.equal(registrations.length,1,"the child registers itself once at startup");
    assert.deepEqual(registrations[0].args,["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","E:\\Typora\\Typora.exe","--register","--title",DETACHED_WINDOW_TITLE]);
    assert.ok(activations.every(call => call.args[0] === "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" && call.args[1] === "E:\\Typora\\Typora.exe"));
    assert.ok(activations.every(call => call.options.windowsHide === true));
    assert.deepEqual(selections.map(payload => payload.selection),["first","second","third"]);
    await childSession.minimize(); assert.equal(minimized,true);
    await hostSession.reveal();
    const deadline = Date.now() + 2500;
    while (!reveals && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(minimized,false); assert.equal(reveals,1);
    assert.equal(selections.length,3,"revealing must not replace the selection or draft");
    assert.equal(notesCreated,1);
  } finally { hostSession.dispose(); childSession?.dispose(); }
});

test("activation refuses invalid identifiers and reports a missing exact window", async () => {
  const calls = [];
  const runtime = {reqnode:() => ({execFile(helper,args,options,callback) {
    calls.push(args); callback(Error("no target"),'{"found":false,"matches":0}');
  }})};
  await assert.rejects(activateNativeWindow(runtime,"not-a-window-id"), /标识无效/);
  assert.equal(calls.length,0);
  await assert.rejects(activateNativeWindow(runtime,"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), /未找到对应/);
  assert.equal(calls.length,1);
});

test("an unresponsive window-opening RPC times out instead of leaving detachment pending", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const fs = {mkdirSync() {},writeFileSync() {},readFileSync() { throw Error("not ready"); }};
  const runtime = {
    reqnode:name => name === "fs" ? fs : {randomUUID:() => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
    addEventListener() {},removeEventListener() {},
    JSBridge:{invoke:() => new Promise(() => {})}
  };
  const session = createDetachedSession(null,() => ({}),runtime);
  try {
    const opening = session.detach({selection:"test"});
    const rejected = assert.rejects(opening,/新窗口未成功加载/);
    t.mock.timers.tick(10000);
    await rejected;
    assert.equal(session.isActive(),false);
  } finally {session.dispose();}
});

test("chrome cleanup waits for the registration attempts and then runs regardless of their outcome", async () => {
  const identifier = "dd4f0c1e-1111-4222-8333-444455556666";
  const marker = `DeepSeek-${identifier}.md`;
  const env = browserEnvironment(`<body><div class="typ-tabs-wrapper typ-workspace-tab-header"><div class="typ-tabs"><span class="typ-tab">${marker}</span></div></div></body>`);
  const invoked = [];
  let registerCalls = 0;
  const fs = {readFileSync() { throw Error("quiet"); },writeFileSync() {},mkdirSync() {}};
  const runtime = {
    reqnode:name => name === "fs" ? fs : name === "process" ? {execPath:"E:\\Typora\\Typora.exe"} : name === "child_process" ? {
      execFile(helper,args,options,callback) {
        registerCalls++;
        callback(null,JSON.stringify({found:false,matches:0}));
      }
    } : {},
    addEventListener() {},removeEventListener() {},
    _options:{initFilePath:`${DATA_DIRECTORY}/detached/${identifier}/${marker}`},
    document:env.document,
    MutationObserver:env.window.MutationObserver,
    JSBridge:{invoke:(command,value) => {invoked.push([command,value]); return Promise.resolve();}}
  };
  const session = createDetachedSession(null,() => ({}),runtime);
  const waitFor = async condition => {
    const deadline = Date.now() + 4000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,25));
  };
  try {
    session.start();
    // While registration retries, the identifier stays visible and no chrome
    // command runs: the register call still needs the identifier in the title.
    await new Promise(resolve => setTimeout(resolve,300));
    assert.ok(registerCalls >= 1,"registration is attempted first");
    assert.equal(invoked.length,0,"no title or menu commands before registration settles");
    assert.equal(env.document.title,"");
    assert.equal(env.document.documentElement.classList.contains(DETACHED_STANDALONE_CLASS),false);
    await waitFor(() => invoked.length >= 2);
    assert.ok(registerCalls >= 5,"all registration attempts are used before giving up");
    assert.deepEqual(invoked.slice(0,2),[["window.setMenuBarVisibility",false],["window.setTitle",DETACHED_WINDOW_TITLE]]);
    assert.equal(env.document.documentElement.classList.contains(DETACHED_STANDALONE_CLASS),true);
    const style = env.document.getElementById("typora-inline-deepseek-standalone-style");
    assert.ok(style?.textContent.includes(".typ-tabs-wrapper.typ-workspace-tab-header"),"the framework tab header must be hidden");
    assert.equal(env.document.title,DETACHED_WINDOW_TITLE);
    assert.equal(purifyDetachedChrome(undefined),false);
  } finally { session.dispose(); env.dispose(); }
});

test("a detached child window registers its identity, then shows the clean title everywhere", async () => {
  const identifier = "bb2f0c1e-1111-4222-8333-444455556666";
  const marker = `DeepSeek-${identifier}.md`;
  const env = browserEnvironment(`<body><div class="tabs"><span class="tab">${marker}</span></div></body>`);
  const calls = [];
  const fs = {readFileSync() { throw Error("quiet"); },writeFileSync() {},mkdirSync() {}};
  const runtime = {
    reqnode:name => name === "fs" ? fs : name === "process" ? {execPath:"E:\\Typora\\Typora.exe"} : name === "child_process" ? {
      execFile(helper,args,options,callback) {
        calls.push(args);
        callback(null,JSON.stringify(args.includes("--register") ? {found:true,registered:true,retitled:true} : {found:true,restored:true,foreground:true}));
      }
    } : {},
    addEventListener() {},removeEventListener() {},
    _options:{initFilePath:`${DATA_DIRECTORY}/detached/${identifier}/${marker}`},
    document:env.document,
    MutationObserver:env.window.MutationObserver,
    JSBridge:{invoke:async () => {}}
  };
  const session = createDetachedSession(null,() => ({}),runtime);
  const waitFor = async condition => {
    const deadline = Date.now() + 4000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,25));
  };
  try {
    assert.equal(session.child,true);
    session.start();
    await waitFor(() => env.document.title === DETACHED_WINDOW_TITLE);
    assert.equal(env.document.querySelector(".tab").textContent,DETACHED_WINDOW_TITLE);
    assert.deepEqual(calls,[[identifier,"E:\\Typora\\Typora.exe","--register","--title",DETACHED_WINDOW_TITLE]]);
    // Typora may restore the file-based title later; the watcher re-applies.
    env.document.title = `${marker} - Typora`;
    await waitFor(() => env.document.title === DETACHED_WINDOW_TITLE);
    assert.equal(env.document.title,DETACHED_WINDOW_TITLE);
    assert.equal(calls.length,1,"re-applied cosmetics must not register the window again");
  } finally { session.dispose(); env.dispose(); }
});

test("registration refuses invalid identifiers and relabeling rewrites every plain-text occurrence", async () => {
  const calls = [];
  const runtime = {reqnode:name => name === "process" ? {execPath:"E:\\Typora\\Typora.exe"} : {execFile(helper,args,options,callback) {
    calls.push(args); callback(null,'{"found":true,"registered":true}');
  }}};
  await assert.rejects(registerNativeWindow(runtime,"not-a-window-id"), /标识无效/);
  assert.equal(calls.length,0);
  await registerNativeWindow(runtime,"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.deepEqual(calls,[["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","E:\\Typora\\Typora.exe","--register","--title",DETACHED_WINDOW_TITLE]]);
  const env = browserEnvironment("<body></body>");
  try {
    const body = env.document.body;
    body.append(Object.assign(env.document.createElement("span"),{textContent:"DeepSeek-bb2f0c1e-1111-4222-8333-444455556666.md"}));
    body.append(Object.assign(env.document.createElement("div"),{textContent:"前缀 DeepSeek-bb2f0c1e-1111-4222-8333-444455556666.md 后缀"}));
    assert.equal(relabelDetachedText(env.document,"DeepSeek-bb2f0c1e-1111-4222-8333-444455556666.md"),2);
    assert.equal(env.document.querySelector("span").textContent,DETACHED_WINDOW_TITLE);
    assert.equal(env.document.querySelector("div").textContent,`前缀 ${DETACHED_WINDOW_TITLE} 后缀`);
    assert.equal(relabelDetachedText(undefined,"anything"),0);
  } finally { env.dispose(); }
});

test("closing the detached window remembers its geometry, the next start restores it, and pin and notify reach their targets", async () => {
  const identifier = "ee5f0c1e-1111-4222-8333-444455556666";
  const marker = `DeepSeek-${identifier}.md`;
  const env = browserEnvironment("<body></body>");
  const files = new Map(), helperCalls = [], pinCalls = [];
  let beforeunload = null;
  const fs = {
    readFileSync(path) {
      if (path.endsWith("preferences.json")) {const data = files.get(path); if (data === undefined) throw Error("no preferences"); return data;}
      throw Error("quiet channel");
    },
    writeFileSync(path,data) {files.set(path,String(data));},
    mkdirSync() {}
  };
  const childProcess = {
    execFile(helper,args,options,callback) {
      helperCalls.push(args);
      callback(null,JSON.stringify(args.includes("--register") ? {found:true,registered:true,retitled:true} : {found:true,restored:true}));
    },
    execFileSync(helper,args,options) {
      helperCalls.push(args);
      return JSON.stringify({found:true,x:120,y:80,width:1000,height:700});
    }
  };
  const runtime = {
    reqnode:name => name === "fs" ? fs : name === "process" ? {execPath:"E:\Typora\Typora.exe"} : name === "child_process" ? childProcess : {},
    addEventListener(name,handler) {if (name === "beforeunload") beforeunload = handler;},
    removeEventListener() {},
    _options:{initFilePath:`${DATA_DIRECTORY}/detached/${identifier}/${marker}`},
    document:env.document,
    MutationObserver:env.window.MutationObserver,
    JSBridge:{invoke:async command => {pinCalls.push(command); return Promise.resolve();}}
  };
  const waitFor = async condition => {
    const deadline = Date.now() + 4000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,25));
  };
  const first = createDetachedSession(null,() => ({}),runtime);
  try {
    first.start();
    await waitFor(() => helperCalls.some(args => args.includes("--register")));
    assert.equal(env.document.title,DETACHED_WINDOW_TITLE);
    assert.equal(helperCalls.some(args => args.includes("--move")),false,"nothing to restore on the very first open");
    beforeunload();
    assert.ok(helperCalls.some(args => args.includes("--query")),"the closing window reports its rect");
    const prefs = JSON.parse(files.get(`${DATA_DIRECTORY}/preferences.json`));
    assert.deepEqual(prefs.detachedGeometry,{x:120,y:80,width:1000,height:700});
    assert.equal(JSON.parse(files.get(`${DATA_DIRECTORY}/detached/${identifier}/to-host.json`)).packets.some(packet => packet.type === "closed"),true);
    await first.setPinned(true);
    assert.ok(helperCalls.some(args => args.includes("--topmost") && args.includes("on")),"pin goes through the native helper");
    first.notifyHost();
    assert.equal(JSON.parse(files.get(`${DATA_DIRECTORY}/detached/${identifier}/to-host.json`)).packets.some(packet => packet.type === "notify"),true);
  } finally { first.dispose(); }
  // A fresh child must put the window back at the remembered geometry.
  helperCalls.length = 0;
  const second = createDetachedSession(null,() => ({}),runtime);
  try {
    second.start();
    await waitFor(() => helperCalls.some(args => args.includes("--move")));
    const move = helperCalls.find(args => args.includes("--move"));
    assert.deepEqual(move,[identifier,"E:\Typora\Typora.exe","--move","120","80","1000","700"]);
  } finally { second.dispose(); env.dispose(); }
});
