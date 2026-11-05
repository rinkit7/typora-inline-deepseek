import { DATA_DIRECTORY, writeDiagnostic } from "./runtime-paths.js";
import { createAppearanceStore, normalizeDetachedGeometry } from "./appearance.js";
import { showToast } from "./typora-host.js";
const ROOT = `${DATA_DIRECTORY}/detached`;
// The detached window is a real Typora document whose file name still carries
// the session identifier for identification. Its visible title, tab label and
// taskbar entry are switched to this clean display title right after opening;
// window lookups keep working because the native helper stores the identifier
// in a Win32 window property instead of relying on the title text.
export const DETACHED_WINDOW_TITLE = "DeepSeek 问答";
// The detached window is a full Typora window: the community framework draws
// a document tab strip and Typora shows its native menu bar above the chat.
// Both are removed inside the detached window so it reads as a standalone
// chat window. These rules only apply while the marker class is present.
export const DETACHED_STANDALONE_CLASS = "typora-inline-deepseek-standalone";
const STANDALONE_CSS = [
  `.${DETACHED_STANDALONE_CLASS} .typ-tabs-wrapper.typ-workspace-tab-header`,
  `.${DETACHED_STANDALONE_CLASS} .typ-ribbon`,
  `.${DETACHED_STANDALONE_CLASS} #typora-sidebar`,
  `.${DETACHED_STANDALONE_CLASS} #typora-sidebar-resizer`
].join(",") + "{display:none!important}";

// Remove Typora chrome from the detached window. This never touches the OS
// window title, so the native helper can still find the window either way.
export function purifyDetachedChrome(view, title = DETACHED_WINDOW_TITLE) {
  const root = view?.documentElement;
  if (!root?.classList || !view.head || typeof view.createElement !== "function") return false;
  root.classList.add(DETACHED_STANDALONE_CLASS);
  if (!view.getElementById("typora-inline-deepseek-standalone-style")) {
    const style = view.createElement("style");
    style.id = "typora-inline-deepseek-standalone-style";
    style.textContent = STANDALONE_CSS;
    view.head.appendChild(style);
  }
  // Typora may render the title text inside the page on some setups.
  const titleText = view.getElementById("title-text");
  if (titleText && titleText.textContent !== title) titleText.textContent = title;
  return true;
}

function helperExecutable() {
  return decodeURIComponent(new URL("../bin/activate-window.exe",import.meta.url).pathname).replace(/^\/(?=[a-z]:)/i,"");
}

function runHelper(runtime,args,parse) {
  return new Promise((resolve,reject) => {
    runtime.reqnode("child_process").execFile(helperExecutable(),args,{windowsHide:true,timeout:6000},(error,stdout) => {
      let result;
      try { result = JSON.parse(stdout); } catch (_) {}
      parse(result,error,resolve,reject);
    });
  });
}

export function activateNativeWindow(runtime, identifier) {
  if (!/^[a-f0-9-]{36}$/i.test(identifier)) return Promise.reject(Error("问答窗口标识无效。"));
  return runHelper(runtime,[identifier,runtime.reqnode("process").execPath,"--title",DETACHED_WINDOW_TITLE],(result,_,resolve,reject) => {
    if (result?.restored) resolve(result);
    else reject(Error(result?.found === false ? "未找到对应的独立问答窗口，请关闭旧小窗后重新打开。" : "独立问答窗口恢复失败，请重新打开小窗。"));
  });
}

export function registerNativeWindow(runtime, identifier) {
  if (!/^[a-f0-9-]{36}$/i.test(identifier)) return Promise.reject(Error("问答窗口标识无效。"));
  return runHelper(runtime,[identifier,runtime.reqnode("process").execPath,"--register","--title",DETACHED_WINDOW_TITLE],(result,_,resolve,reject) => {
    if (result?.registered) resolve(result);
    else reject(Error(result?.found === false ? "未找到对应的独立问答窗口，请关闭旧小窗后重新打开。" : "独立问答窗口注册失败。"));
  });
}

export function setNativeOpacity(runtime, identifier, value) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(identifier)) return Promise.reject(Error("问答窗口标识无效。"));
  if (!Number.isInteger(value) || value < 40 || value > 100) return Promise.reject(Error("不透明度应为 40%–100%。"));
  return runHelper(runtime,[identifier,runtime.reqnode("process").execPath,"--opacity",String(value),"--title",DETACHED_WINDOW_TITLE],(result,error,resolve,reject) => {
    if (!error && result?.opacityApplied) resolve(result);
    else reject(Error("独立窗口透明度设置失败，请重试或重新打开小窗。"));
  });
}

export function moveNativeWindow(runtime, identifier, geometry) {
  if (!/^[a-f0-9-]{36}$/i.test(identifier)) return Promise.reject(Error("问答窗口标识无效。"));
  const box = normalizeDetachedGeometry(geometry);
  if (!box) return Promise.reject(Error("窗口位置数据无效。"));
  return runHelper(runtime,[identifier,runtime.reqnode("process").execPath,"--move",String(box.x),String(box.y),String(box.width),String(box.height)],(result,_,resolve,reject) => {
    if (result?.found && result?.moved) resolve(result);
    else reject(Error(result?.found === false ? "未找到对应的独立问答窗口，请关闭旧小窗后重新打开。" : "独立窗口位置还原失败。"));
  });
}

// Reads the window rect synchronously: this runs in beforeunload, where only
// blocking work survives the window teardown.
function queryNativeWindowSync(runtime, identifier) {
  const childProcess = runtime.reqnode("child_process");
  return JSON.parse(childProcess.execFileSync(helperExecutable(),[identifier,runtime.reqnode("process").execPath,"--query"],{windowsHide:true,timeout:2000}));
}

// Replace the session file name wherever Typora shows it as plain text
// (tab label). Returns how many text nodes were rewritten.
export function relabelDetachedText(view, marker, title = DETACHED_WINDOW_TITLE) {
  if (!view?.body || typeof view.createTreeWalker !== "function") return 0;
  let changed = 0;
  const walker = view.createTreeWalker(view.body,4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode()) {
    const node = walker.currentNode, value = node.nodeValue;
    if (!value || !value.includes(marker)) continue;
    node.nodeValue = value.split(marker).join(title);
    changed++;
  }
  return changed;
}

export function createChannel(fs, directory, role, onMessage, interval = 250) {
  const incoming = `${directory}/${role === "host" ? "to-host" : "to-detached"}.json`;
  const outgoing = `${directory}/${role === "host" ? "to-detached" : "to-host"}.json`;
  let sequence = 0, disposed = false, reading = false;
  const received = new Set();
  const poll = async () => {
    if (disposed || reading) return;
    reading = true;
    try {
      const {packets = []} = JSON.parse(fs.readFileSync(incoming,"utf8"));
      for (const packet of packets) {
        if (!packet.id || received.has(packet.id)) continue;
        received.add(packet.id);
        await onMessage(packet);
      }
    } catch (_) {} finally { reading = false; }
  };
  const timer = setInterval(poll,interval);
  return {
    poll,
    send(type,payload = {}) {
      const id = `${Date.now()}-${++sequence}`;
      let packets = [];
      try { packets = JSON.parse(fs.readFileSync(outgoing,"utf8")).packets || []; } catch (_) {}
      packets.push({id,type,payload});
      fs.writeFileSync(outgoing,JSON.stringify({packets:packets.slice(-32)}),"utf8");
      return id;
    },
    dispose() { disposed = true; clearInterval(timer); }
  };
}

export function createDetachedSession(plugin, getController, runtime = window) {
  const fs = runtime.reqnode("fs");
  const crypto = runtime.reqnode("crypto");
  const store = createAppearanceStore(runtime);
  const filePath = String(runtime._options?.initFilePath || runtime.File?.bundle?.filePath || "").replace(/\\/g,"/");
  const relativeNote = filePath.toLowerCase().startsWith(`${ROOT.toLowerCase()}/`) ? filePath.slice(ROOT.length + 1) : "";
  const childMatch = relativeNote.match(/^([a-f0-9-]{36})\/DeepSeek(?:-[a-f0-9-]+)?\.md$/i);
  let channel, directory, active = false, pendingPayload, opening, disposed = false, waiting = new Map();
  const invoke = (...args) => runtime.JSBridge.invoke(...args);
  const closeWindow = () => { void Promise.resolve(invoke("window.close")).catch(() => {}); };
  const child = !!childMatch;
  let observer = null, beautifyTimer = null, chromeRetryTimer = null;
  // Swap the identifier file name that Typora shows for the clean title.
  // Typora manages the OS window title through its own "window.setTitle"
  // command; an external Win32 title write is overridden by the page, so the
  // clean title is applied through the same channel Typora itself uses.
  const beautifyWindow = () => {
    if (!child || disposed) return;
    const marker = `DeepSeek-${childMatch[1]}.md`;
    const apply = () => {
      if (disposed) return;
      try {
        relabelDetachedText(runtime.document,marker);
        if (runtime.document && runtime.document.title !== DETACHED_WINDOW_TITLE) runtime.document.title = DETACHED_WINDOW_TITLE;
        void Promise.resolve(invoke("window.setTitle",DETACHED_WINDOW_TITLE)).catch(() => {});
      } catch (_) {}
    };
    const watch = () => {
      if (disposed || observer || !runtime.document?.documentElement || typeof runtime.MutationObserver !== "function") return;
      // documentElement also covers <title> in the head, so a reverted window
      // title is re-applied even when Typora never touches the body.
      observer = new runtime.MutationObserver(() => { clearTimeout(beautifyTimer); beautifyTimer = setTimeout(apply,400); });
      observer.observe(runtime.document.documentElement,{childList:true,characterData:true,subtree:true});
    };
    apply();
    watch();
  };
  // Strip the Typora chrome: framework tab strip, sidebar, ribbon and the
  // native menu bar. Must run only after the window property is registered —
  // the register call finds this window through the identifier in its title.
  const startStandaloneChrome = () => {
    if (!child || disposed) return;
    try { purifyDetachedChrome(runtime.document); } catch (_) {}
    const hideChrome = () => {
      if (disposed) return;
      try { void Promise.resolve(invoke("window.setMenuBarVisibility",false)).catch(() => {}); } catch (_) {}
      try { void Promise.resolve(invoke("window.setTitle",DETACHED_WINDOW_TITLE)).catch(() => {}); } catch (_) {}
    };
    hideChrome();
    // Typora finishes menu and title initialization shortly after the plugin
    // loads; repeat once so a partially drawn menu bar or title cannot stay.
    chromeRetryTimer = setTimeout(hideChrome,1200);
  };
  const startChildWindow = async () => {
    // Register while the window title still carries the identifier; after the
    // property is stored the title may change freely.
    for (let attempt = 0; attempt < 5 && !disposed; attempt++) {
      try { await registerNativeWindow(runtime,childMatch[1]); break; }
      catch (_) { await new Promise(resolve => setTimeout(resolve,400)); }
    }
    if (disposed) return;
    // Put the window back where the user last kept it.
    try {
      const geometry = store.loadDetachedGeometry();
      if (geometry) await moveNativeWindow(runtime,childMatch[1],geometry);
    } catch (_) {}
    if (disposed) return;
    startStandaloneChrome();
    beautifyWindow();
    // Typora rewrites the OS window title when the window is activated; win
    // the last write by re-applying the clean title shortly after each focus.
    const reapplyOnFocus = () => {
      if (disposed) return;
      applyDetachedTitle();
      for (const delay of [150,500,1200]) setTimeout(() => { if (!disposed) applyDetachedTitle(); },delay);
    };
    const applyDetachedTitle = () => {
      if (disposed) return;
      try {
        if (runtime.document && runtime.document.title !== DETACHED_WINDOW_TITLE) runtime.document.title = DETACHED_WINDOW_TITLE;
        void Promise.resolve(invoke("window.setTitle",DETACHED_WINDOW_TITLE)).catch(() => {});
      } catch (_) {}
    };
    runtime.addEventListener("focus",reapplyOnFocus);
  };
  if (child) {
    directory = `${ROOT}/${childMatch[1]}`;
    channel = createChannel(fs,directory,"detached", async packet => {
      if (packet.type === "open") {
        getController()?.restore(packet.payload);
        // Do not block the message channel on a window-management RPC.
        // The host restores the existing window through the native helper.
        void Promise.resolve(invoke("window.focus")).catch(() => {});
      }
      if (packet.type === "close") closeWindow();
      if (packet.type === "reveal") getController()?.reveal();
      if (packet.type === "result") {
        const request = waiting.get(packet.payload.requestId);
        if (!request) return;
        waiting.delete(packet.payload.requestId); clearTimeout(request.timer);
        packet.payload.ok ? request.resolve() : request.reject(Error(packet.payload.error));
      }
    });
  }
  const unload = () => {
    if (!child) return;
    // Remember where the user kept this window so the next detach restores it.
    // A minimized window reports the phantom -32000 rect; never store that.
    try {
      const rect = queryNativeWindowSync(runtime,childMatch[1]);
      const geometry = normalizeDetachedGeometry(rect);
      if (geometry) store.saveDetachedGeometry(geometry);
    } catch (_) {}
    channel?.send("closed");
  };
  runtime.addEventListener("beforeunload",unload);
  return {
    child,
    start() { if (child) { channel.send("ready"); void startChildWindow(); } },
    isActive:() => active,
    async minimize() {
      if (!child || disposed) throw Error("独立问答窗口尚未就绪。");
      await invoke("window.minimize");
    },
    async reveal() {
      if (!active || !channel || disposed) throw Error("独立问答窗口已关闭，请重新选区打开。");
      channel.send("reveal");
      await activateNativeWindow(runtime,directory.split("/").pop());
    },
    setOpacity(value) {
      if (!child || disposed) return Promise.reject(Error("独立问答窗口尚未就绪。"));
      return setNativeOpacity(runtime,childMatch[1],value);
    },
    setPinned(value) {
      if (!child || disposed) return Promise.reject(Error("独立问答窗口尚未就绪。"));
      // Typora's own window.pin command closes a freshly opened detached
      // window (observed on 1.9.5); the OS topmost style is used instead.
      return runHelper(runtime,[childMatch[1],runtime.reqnode("process").execPath,"--topmost",value ? "on" : "off"],(result,_,resolve,reject) => {
        if (result?.found) resolve(result);
        else reject(Error("独立窗口置顶设置失败，请重试。"));
      });
    },
    notifyHost(message) {
      if (!child || !channel || disposed) return;
      channel.send("notify",{message:String(message || "小窗回答已完成")});
    },
    async detach(payload) {
      if (disposed) throw Error("问答插件已关闭。");
      pendingPayload = payload;
      if (opening) return opening;
      opening = (async () => {
        if (active && channel) {
          // Restore the exact helper window via Win32; Typora's own focus and
          // document-opening RPCs can leave minimized windows on the taskbar.
          channel.send("open",{...payload,preserveConversation:true});
          const identifier = directory.split("/").pop();
          const activation = await activateNativeWindow(runtime,identifier);
          writeDiagnostic(runtime,"window-activation.json",{time:new Date().toISOString(),...activation});
          return;
        }
        directory = `${ROOT}/${crypto.randomUUID()}`;
        fs.mkdirSync(directory,{recursive:true});
        const note = `${directory}/DeepSeek-${directory.split("/").pop()}.md`;
        fs.writeFileSync(note,"# DeepSeek 问答窗口\n\n此窗口由 Typora 的 DeepSeek 插件创建。\n","utf8");
        channel?.dispose();
        let confirmReady;
        const readyPromise = new Promise(resolve => { confirmReady = resolve; });
        channel = createChannel(fs,directory,"host", async packet => {
          if (packet.type === "ready") { active = true; channel.send("open",pendingPayload); confirmReady(); }
          if (packet.type === "dock") {
            active = false; getController()?.restore(packet.payload);
          }
          if (packet.type === "closed") active = false;
          if (packet.type === "insert") {
            try {
              const controller = getController();
              if (!controller?.insertFromRemote) throw Error("原文档窗口尚未就绪。");
              await controller.insertFromRemote(packet.payload.text,packet.payload.targetId);
              channel.send("result",{requestId:packet.id,ok:true});
            } catch (error) { channel.send("result",{requestId:packet.id,ok:false,error:error.message}); }
          }
          if (packet.type === "notify") showToast(packet.payload?.message || "小窗回答已完成");
        });
        let timer;
        try {
          // The timeout also covers a window-opening RPC which never settles.
          await Promise.race([readyPromise,new Promise((_,reject) => {
            timer = setTimeout(() => reject(Error("新窗口未成功加载 DeepSeek 插件。")),10000);
          }), Promise.resolve(invoke("app.openFile",note,{forceCreateWindow:true})).then(() => readyPromise)]);
          if (disposed) throw Error("问答插件已关闭。");
        } catch (error) { active = false; channel?.dispose(); throw error; }
        finally { clearTimeout(timer); }
      })();
      try { await opening; } finally { opening = null; }
    },
    async dock(payload) { channel.send("dock",payload); closeWindow(); },
    insert(text,targetId) {
      return new Promise((resolve,reject) => {
        const id = channel.send("insert",{text,targetId});
        const timer = setTimeout(() => { waiting.delete(id); reject(Error("原 Typora 文档窗口未响应，请确认它仍然打开。")); },5000);
        waiting.set(id,{resolve,reject,timer});
      });
    },
    close() { channel?.send("closed"); closeWindow(); },
    dispose() {
      disposed = true;
      clearTimeout(beautifyTimer);
      clearTimeout(chromeRetryTimer);
      observer?.disconnect();
      observer = null;
      runtime.removeEventListener("beforeunload",unload);
      if (!child && active) channel?.send("close");
      channel?.dispose();
      for (const request of waiting.values()) { clearTimeout(request.timer); request.reject(Error("问答窗口已关闭。")); }
      waiting.clear();
    }
  };
}
