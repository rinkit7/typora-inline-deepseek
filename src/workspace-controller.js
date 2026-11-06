import {mountChatUI} from "../dist/chat-ui.js";
import {createChatSession} from "./chat-session.js";
import {createSelectionTracker} from "./selection-tracker.js";
import {createDeepSeekWeb} from "./deepseek-web.js";
import {registerDeepSeekMenu,canInsertAtSnapshot} from "./web-provider.js";
import {createAppearanceStore} from "./appearance.js";
import {writeDiagnostic} from "./runtime-paths.js";
import {showToast} from "./typora-host.js";

export function createWorkspaceChat(plugin,options = {}) {
  const view = document, runtime = window, host = plugin.editorSelection;
  const detached = !!options.detachedHost;
  const targets = new Map();
  let disposed = false, transferring = false, pressedTarget = null;
  const appearance = createAppearanceStore(runtime);
  let geometry = {left:null,top:48,width:460,height:appearance.loadReaderHeight()}, ui, interaction = null;
  const node = view.createElement("div");
  node.id = "deepseek-workspace";
  node.style.cssText = "position:fixed;right:18px;top:48px;width:min(460px,calc(100vw - 36px));height:calc(100vh - 90px);z-index:999990;pointer-events:none;isolation:isolate;";
  // The detached window's Typora chrome (tab strip and menu bar) is removed
  // by the session, so the chat fills the whole client area under the OS bar.
  if (detached) {node.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:999990;pointer-events:none;isolation:isolate;";}
  node.hidden = true;
  const setStyle = (key,value) => {if (node.style[key] !== value) node.style[key] = value;};
  function applyGeometry() {
    if (detached) {node.style.setProperty("--workspace-height",`${innerHeight}px`); return;}
    const width = Math.max(300,Math.min(640,Number(geometry.width) || 440));
    // Moving the card changes its position, never its height. Only shrinking
    // the Typora viewport may reduce the rendered size to keep it reachable.
    const height = Math.min(Math.max(320,Number(geometry.height) || 640),Math.max(0,innerHeight - 36));
    const top = Math.max(18,Math.min(innerHeight - height - 18,Number.isFinite(Number(geometry.top)) ? Number(geometry.top) : 48));
    setStyle("width",`${Math.min(width,Math.max(0,innerWidth - 36))}px`);
    geometry.top = top;
    setStyle("top",`${top}px`); setStyle("height",`${height}px`);
    if (node.style.getPropertyValue("--workspace-height") !== `${height}px`) node.style.setProperty("--workspace-height",`${height}px`);
    if (geometry.left !== null && Number.isFinite(Number(geometry.left))) {
      geometry.left = Math.max(0,Math.min(innerWidth - Math.min(width,innerWidth - 36) - 18,Number(geometry.left)));
      setStyle("left",`${geometry.left}px`); setStyle("right","auto");
    } else {setStyle("left","auto"); setStyle("right","18px");}
  }
  applyGeometry();
  function startDrag(rect) {
    if (detached) return;
    startInteraction(rect,"drag");
  }
  function startInteraction(rect,type,edge) {
    if (detached) return;
    if (interaction) endDrag();
    interaction = {type,origin:rect,left:rect.left,top:rect.top,width:type === "resize" && (edge === "left" || edge === "right") ? rect.width : geometry.width,height:geometry.height,maxLeft:Math.max(0,innerWidth - rect.width - 18),maxTop:Math.max(18,innerHeight - rect.height - 18)};
    if (type === "drag") node.style.willChange = "transform";
    // Render geometry on the real card each frame. Pause only background
    // extraction and editor selection capture, leaving the webpage visible.
    provider.setSuspended(true);
    tracker?.setSuspended(true);
  }
  function moveDrag(x,y) {
    if (interaction?.type !== "drag") return;
    const current = interaction;
    const left = Math.max(0,Math.min(current.maxLeft,x)), top = Math.max(18,Math.min(current.maxTop,y));
    if (left === current.left && top === current.top) return;
    current.left = left; current.top = top;
    setStyle("transform",`translate3d(${left - current.origin.left}px,${top - current.origin.top}px,0)`);
  }
  function endDrag() {
    if (!interaction) return;
    geometry = {...geometry,left:interaction.left,top:interaction.top,width:interaction.width,height:interaction.height};
    interaction = null;
    applyGeometry();
    node.style.transform = ""; node.style.willChange = "";
    provider.setSuspended(false);
    tracker?.setSuspended(false);
  }
  const viewportResize = () => {endDrag(); applyGeometry();};
  const webpage = view.createElement("webview");
  webpage.setAttribute("partition","persist:typora-inline-deepseek");
  webpage.setAttribute("webpreferences","contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes,backgroundThrottling=no");
  webpage.setAttribute("src","https://chat.deepseek.com/");
  webpage.style.cssText = "position:absolute;left:0;top:58px;width:100%;height:calc(100% - 94px);display:flex;opacity:.01;pointer-events:none;z-index:0;background:white;";
  const app = view.createElement("div");
  app.style.cssText = "position:absolute;inset:0;z-index:2;pointer-events:none";
  node.appendChild(app); view.body.appendChild(node);
  const shadow = app.attachShadow({mode:"open"});
  const mount = view.createElement("div"); mount.style.height = "100%"; shadow.appendChild(mount);
  const provider = createDeepSeekWeb({webview:webpage});
  const session = createChatSession({provider:{subscribe:listener => provider.subscribe(listener),send:prompt => {
    const quote = session.getSnapshot().quote;
    if (!detached && quote?.key && quote.key !== plugin.getCurrentDocumentIdentity().key) throw Error("文档已切换，请重新选择正文后提问。");
    return provider.send(prompt);
  }}});
  const tracker = detached ? null : createSelectionTracker({host,getIdentity:() => plugin.getCurrentDocumentIdentity(),view,runtime});
  const targetId = () => runtime.reqnode("crypto").randomUUID();
  function diagnose(event) {
    writeDiagnostic(runtime,"runtime-status.json",{plugin:"DeepSeek 选区问答",version:"2.2.0",dragEngine:"native-capture-v1",geometryRendering:"live",layout:"assistant-ui",detached,event,quoted:!!session.getSnapshot().quote,messageCount:session.getSnapshot().messages.length,time:new Date().toISOString()});
  }
  function remember(target) {
    if (!target?.text) return null;
    const id = target.targetId || targetId();
    const snapshot = {...target,targetId:id}; targets.set(id,snapshot);
    return snapshot;
  }
  function exportPayload() {return {state:{session:session.export(),geometry},url:provider.getURL(),selection:session.getSnapshot().quote?.text || ""};}
  function askSelection(target) {
    const current = remember(target);
    if (!current) {reveal(); return;}
    tracker?.clear();
    if (!detached && options.isDetachedActive?.()) {
      const payload = exportPayload();
      payload.selection = current.text;
      payload.selectionContext = {text:current.text,key:current.key,label:current.label,targetId:current.targetId};
      payload.intent = "selection";
      void options.onDetach(payload).catch(error => {session.askSelection(current); session.report(error); ui?.focusComposer();});
    } else {
      session.askSelection(current);
      ui?.focusComposer();
    }
    diagnose("selection-attached");
  }
  function open(target) {if (target?.text) askSelection(target); else reveal();}
  function reveal() {
    if (disposed) return;
    const quote = session.getSnapshot().quote;
    if (!detached && quote?.key && quote.key !== plugin.getCurrentDocumentIdentity().key) session.setQuote(null);
    session.show(); provider.setActive(true); ui?.focusComposer();
  }
  function restore(payload) {
    if (disposed) return;
    if (payload.preserveConversation && payload.intent === "selection" && payload.selectionContext) {
      session.askSelection(payload.selectionContext);
    } else if (!payload.preserveConversation) {
      if (payload.state?.geometry) {geometry = {...payload.state.geometry}; applyGeometry();}
      provider.navigate(payload.url || "https://chat.deepseek.com/");
      session.restore(payload.state?.session || {});
      if (payload.selectionContext) session.askSelection(payload.selectionContext);
    }
    reveal(); diagnose("session-restored");
  }
  async function transfer() {
    if (transferring || session.getSnapshot().sending || session.getSnapshot().responding) throw Error("请等回答结束后再切换窗口。");
    transferring = true;
    try {
      const payload = exportPayload();
      if (detached) await options.onDock(payload); else {await options.onDetach(payload); session.hide();}
    } finally {transferring = false;}
  }
  async function openHistory(url) {
    if (session.getSnapshot().sending || session.getSnapshot().responding) throw Error("请等当前回答结束后再切换历史问答。");
    const reply = await provider.openHistory(url);
    const current = session.export();
    const quotedTarget = targets.get(current.quote?.targetId);
    targets.clear(); if (quotedTarget) targets.set(quotedTarget.targetId,quotedTarget); tracker?.clear();
    const messages = reply.text && url !== "https://chat.deepseek.com/" ? [{id:targetId(),role:"assistant",text:reply.text,imported:true}] : [];
    session.restore({...current,messages,contextTargetId:null,view:"chat"},{resume:!!messages.length});
    session.notify(messages.length ? "已打开网页历史；当前显示最近回答，完整记录可在网页查看。" : "已打开新问答");
  }
  async function insert(text,id) {
    if (!String(text).trim()) throw Error("回答为空。");
    if (detached) {await options.onInsert(text,id); session.notify("已插入原文档，可在原文档中撤销。"); return;}
    const target = id ? targets.get(id) : null;
    const identity = plugin.getCurrentDocumentIdentity();
    if (!canInsertAtSnapshot(target,identity,host.getDocumentText())) throw Error("原文档已改变或插入位置已失效，请复制回答后手动插入。");
    const content = `\n\n${text}\n\n`;
    if (target.cm) {
      if (!target.cm.wrapper.isConnected || !view.getElementById("write")?.contains(target.cm.wrapper)) throw Error("原选区已失效。");
      target.cm.editor.replaceRange(content,target.to,target.to);
    } else {
      if (!host.isChatCaretRangeUsable(target.range)) throw Error("原选区已失效。");
      view.getElementById("write").focus();
      const selection = runtime.getSelection(); selection.removeAllRanges(); selection.addRange(target.range.cloneRange());
      if (!view.execCommand("insertText",false,content)) throw Error("插入失败，请复制回答后手动插入。");
    }
    session.notify("已插入原文档，可使用 Ctrl+Z 撤销。");
  }
  const unsubscribe = session.subscribe(() => {
    const state = session.getSnapshot();
    node.hidden = !state.visible;
    // Creating a plugin for another Markdown window must not load another
    // DeepSeek browser until the user actually opens this workspace.
    if (state.visible && !webpage.isConnected) node.insertBefore(webpage,app);
    provider.setActive(state.visible && !state.sending);
    webpage.style.opacity = state.view === "web" ? "1" : ".01";
    webpage.style.pointerEvents = state.view === "web" ? "auto" : "none";
    webpage.style.zIndex = state.view === "web" ? "1" : "0";
  });
  // An answer that settles while the user reads elsewhere deserves a cue:
  // a local toast in this window, or a relay to the document window when the
  // conversation lives in the detached window.
  const notifyAnswerSettled = () => {
    let focused = true;
    try { focused = view.hasFocus(); } catch (_) {}
    writeDiagnostic(runtime,"answer-settled.json",{focused,detached,time:new Date().toISOString()});
    if (focused) return;
    if (detached) options.notifyHost?.();
    else showToast("回答已完成");
  };
  ui = mountChatUI(mount,shadow,{session,detached,appearance,
    actions:{transfer,close:() => detached ? options.onClose?.() : session.hide(),
      listHistory:() => provider.listHistory(),openHistory,
      newConversation:() => openHistory("https://chat.deepseek.com/"),
      viewHistoryWeb:() => {session.setView("web"); session.notify("可在网页查看完整记录；展开侧栏后，可返回历史列表刷新并选择会话。");},
      copy:async text => {if (!await plugin.copyTextToClipboard(text)) throw Error("复制失败。"); session.notify("回答已复制。");},
      insert,reload:() => provider.reload(),pause:value => provider.setPaused(value),
      opacity:value => options.onOpacity?.(value),
      pin:value => options.onPin?.(value),
      onAnswerSettled:notifyAnswerSettled,
      motionStats:stats => writeDiagnostic(runtime,"drag-performance.json",stats),
      startDrag,drag:moveDrag,endDrag,
      startResize:(rect,edge) => startInteraction(rect,"resize",edge),endResize:endDrag,
      getPosition:() => node.getBoundingClientRect(),
      resize:(width,left) => {
        if (detached) return;
        if (interaction?.type === "resize") {
          interaction.width = width; interaction.left = left;
          geometry = {...geometry,width,left}; applyGeometry();
        } else {geometry = {...geometry,width,left}; applyGeometry();}
      },
      resizeHeight:(height,top) => {
        if (detached) return;
        if (interaction?.type === "resize") {
          interaction.height = height; interaction.top = top;
        }
        geometry = {...geometry,height,top}; applyGeometry();
      },
      webBounds:rect => {const outer = node.getBoundingClientRect(); if (rect.height > 0) {webpage.style.top = `${rect.top - outer.top}px`; webpage.style.height = `${rect.height}px`; }},
      width:value => {if (!detached) {geometry.width = value; applyGeometry();}},
      height:value => {if (!detached) {geometry.height = value; applyGeometry();}}
    }});
  const launch = view.createElement("button");
  launch.id = "deepseek-workspace-launch"; launch.textContent = "✦ DeepSeek 问答";
  launch.style.cssText = "position:fixed;bottom:70px;right:18px;z-index:999980;border:1px solid #7180a555;border-radius:10px;padding:8px 13px;background:var(--bg-color,#fff);color:var(--text-color,#253047);cursor:pointer";
  launch.addEventListener("pointerdown",event => {pressedTarget = tracker?.capture(); event.preventDefault();});
  launch.addEventListener("click",() => {
    const selected = pressedTarget || tracker?.capture(); pressedTarget = null;
    if (selected?.text) askSelection(selected);
    else if (options.isDetachedActive?.()) void options.onReveal().catch(error => session.report(error));
    else reveal();
  });
  if (!detached) view.body.appendChild(launch);
  const disposeMenu = detached ? null : registerDeepSeekMenu(plugin.app.workspace,() => tracker.capture({fresh:true}),open);
  const keydown = event => {
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "i" && host.isEditorTarget(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); open(tracker.capture({fresh:true}));
    }
  };
  if (!detached) view.addEventListener("keydown",keydown,true);
  runtime.addEventListener("resize",viewportResize);
  diagnose("loaded");
  return {open,askSelection,reveal,restore,insertFromRemote:insert,dispose() {
    disposed = true; unsubscribe(); tracker?.dispose(); provider.dispose(); session.dispose(); ui.dispose();
    interaction = null;
    runtime.removeEventListener("resize",viewportResize);
    disposeMenu?.(); view.removeEventListener("keydown",keydown,true); node.remove(); launch.remove(); targets.clear();
  }};
}
