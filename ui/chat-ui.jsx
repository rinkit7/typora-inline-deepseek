import React,{createContext,useContext,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from "react";
import {createRoot} from "react-dom/client";
import {AssistantRuntimeProvider,ThreadPrimitive,MessagePrimitive,ComposerPrimitive,useExternalStoreRuntime,useAui,useAuiState,MessageNotSentError} from "@assistant-ui/react";
import {MarkdownTextPrimitive} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {createPointerGestures} from "../src/pointer-gestures.js";
import {DEFAULT_QUICK_ASKS,MAX_QUICK_ASKS,MAX_QUICK_ASK_LABEL,MAX_QUICK_ASK_PROMPT,normalizeQuickAsks,validateQuickAsks} from "../src/quick-asks.js";
import styles from "./chat-ui.css";
import mathStyles from "katex/dist/katex.min.css";

const Services = createContext(null);
const convertMessage = message => ({id:message.id,role:message.role,content:[{type:"text",text:message.text || "正在等待 DeepSeek 回答…"}],metadata:{custom:{quote:message.quote || null,targetId:message.targetId,imported:!!message.imported,empty:!message.text}}});
const run = (session,action) => Promise.resolve().then(action).catch(error => session.report(error));

function CodeHeader({language,code}) {
  const {actions,session} = useContext(Services);
  const [copied,setCopied] = useState(null), [busy,setBusy] = useState(false);
  const copy = async () => {
    setBusy(true);
    try {
      if (await actions.copy(code) === false) throw Error("代码复制失败，请重试。");
      setCopied(code);
    } catch (error) {setCopied(null); session.report(error);}
    finally {setBusy(false);}
  };
  return <div className="ds-code-header"><span>{language || "代码"}</span><button type="button" aria-label="复制代码" disabled={busy} onClick={copy}>{copied === code ? "已复制" : "复制代码"}</button></div>;
}

function Markdown() {
  return <MarkdownTextPrimitive className="ds-markdown" smooth={false} defer skipHtml remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[[rehypeKatex,{trust:false,throwOnError:false,strict:"ignore"}]]} components={{CodeHeader,a:({children,href}) => <span className="ds-link" title={href}>{children}</span>}}/>;
}

function Message() {
  const message = useAuiState(s => s.message);
  const {actions,session} = useContext(Services);
  const quote = message.metadata?.custom?.quote;
  const content = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const user = message.role === "user";
  return <MessagePrimitive.Root className={`ds-message ${user ? "ds-user" : "ds-assistant"}`}>
    <div className="ds-message-label">{user ? "你" : message.metadata?.custom?.imported ? "DeepSeek · 网页最近回答" : "DeepSeek"}</div>
    {quote && <details className="ds-sent-quote"><summary>引用 · {quote.label}</summary><blockquote>{quote.text}</blockquote></details>}
    <MessagePrimitive.Parts components={{Text:Markdown}}/>
    {!user && <div className="ds-message-actions"><button type="button" disabled={message.metadata?.custom?.empty} onClick={() => run(session,() => actions.copy(content))}>复制</button><button type="button" disabled={message.metadata?.custom?.empty || !message.metadata?.custom?.targetId} title={!message.metadata?.custom?.targetId ? "此回答没有可用的原文插入位置，可复制后手动插入" : "插入本次问题对应的原文位置"} onClick={() => run(session,() => actions.insert(content,message.metadata?.custom?.targetId))}>插入文档</button></div>}
  </MessagePrimitive.Root>;
}

function Composer({state,quickAsks,onEditQuickAsks}) {
  const {session} = useContext(Services), aui = useAui();
  useEffect(() => {if (aui.composer.getState().text !== state.draft) aui.composer.setText(state.draft);},[state.draft,aui]);
  const askTemplate = text => {
    if (state.sending || state.responding) return;
    const previous = state.draft;
    session.setDraft(text);
    void session.submit(text).then(ok => {if (!ok && session.getSnapshot().draft === text) session.setDraft(previous);});
  };
  return <div className="ds-composer-wrap">
    {state.quote && <div className="ds-quick" role="group" aria-label="快捷提问">
      {quickAsks.map(item => <button key={item.label} type="button" title={item.prompt} disabled={state.sending || state.responding} onClick={() => askTemplate(item.prompt)}>{item.label}</button>)}
      <button type="button" className="ds-quick-edit" aria-label="自定义快捷提问" onClick={onEditQuickAsks}>自定义</button>
    </div>}
    {state.quote && <div className="ds-quote" aria-label="已引用的正文选区">
      <div className="ds-quote-title"><span>已选文字 · {state.quote.label}</span><button type="button" aria-label="移除引用" onClick={() => session.setQuote(null)}>×</button></div>
      <details><summary>{state.quote.text.length > 90 ? state.quote.text.slice(0,90) + "…" : state.quote.text}</summary><blockquote>{state.quote.text}</blockquote></details>
      <span className="ds-quote-count">{Array.from(state.quote.text).length} 字 · 将随问题发送</span>
    </div>}
    <ComposerPrimitive.Root className="ds-composer">
      <ComposerPrimitive.Input aria-label="输入问题" placeholder="针对选区提问，或继续追问…" value={state.draft} onChange={event => session.setDraft(event.target.value)} submitMode="ctrlEnter" minRows={2} maxRows={7} autoFocus={false} addAttachmentOnPaste={false}/>
      <div className="ds-composer-tools"><span>{state.responding ? "正在回答，可先写下一条问题" : "Ctrl + Enter 发送"}</span><ComposerPrimitive.Send aria-label="发送问题" className="ds-send">{state.sending ? "发送中…" : "发送 ↑"}</ComposerPrimitive.Send></div>
    </ComposerPrimitive.Root>
  </div>;
}

function QuickAskEditor({items,onSave,onCancel}) {
  const nextKey = useRef(items.length);
  const [rows,setRows] = useState(() => items.map((item,key) => ({...item,key})));
  const [error,setError] = useState("");
  const change = (key,field,value) => {setRows(current => current.map(row => row.key === key ? {...row,[field]:value} : row)); setError("");};
  const replace = values => {setRows(values.map(item => ({...item,key:nextKey.current++}))); setError("");};
  const save = () => {try {onSave(validateQuickAsks(rows));} catch (failure) {setError(failure.message || "保存失败，请重试。");}};
  return <section className="ds-template-editor" aria-label="快捷提问设置">
    <div className="ds-template-heading"><strong>自定义快捷提问</strong><p>按钮名称用于显示，提问内容会与所选文字一起发送。</p></div>
    <div className="ds-template-list">
      {!rows.length && <p className="ds-template-empty">尚无快捷提问，可新增或恢复默认。</p>}
      {rows.map((row,index) => <div key={row.key} className="ds-template-row">
        <div className="ds-template-row-title"><span>快捷提问 {index + 1}</span><button type="button" aria-label={`删除快捷提问 ${index + 1}`} onClick={() => {setRows(current => current.filter(item => item.key !== row.key)); setError("");}}>删除</button></div>
        <label>按钮名称<input aria-label={`快捷提问 ${index + 1} 的按钮名称`} maxLength={MAX_QUICK_ASK_LABEL} value={row.label} placeholder="例如：通俗解释" onChange={event => change(row.key,"label",event.target.value)}/></label>
        <label>提问内容<textarea aria-label={`快捷提问 ${index + 1} 的提问内容`} maxLength={MAX_QUICK_ASK_PROMPT} rows={3} value={row.prompt} placeholder="例如：请用生活中的例子解释这段内容" onChange={event => change(row.key,"prompt",event.target.value)}/></label>
      </div>)}
      <button type="button" className="ds-template-add" disabled={rows.length >= MAX_QUICK_ASKS} onClick={() => setRows(current => [...current,{key:nextKey.current++,label:"",prompt:""}])}>＋ 新增快捷提问</button>
    </div>
    {error && <p role="alert" className="ds-template-error">{error}</p>}
    <div className="ds-template-actions"><button type="button" onClick={() => replace(DEFAULT_QUICK_ASKS)}>恢复默认</button><span/><button type="button" onClick={onCancel}>取消</button><button type="button" className="ds-template-save" onClick={save}>保存快捷提问</button></div>
  </section>;
}

function HistoryPicker({actions,session,busy,onClose}) {
  const [items,setItems] = useState([]), [query,setQuery] = useState(""), [error,setError] = useState(""), [loading,setLoading] = useState(true), [selecting,setSelecting] = useState(false), [revision,setRevision] = useState(0);
  useEffect(() => {let alive = true; setLoading(true); setError(""); Promise.resolve().then(() => actions.listHistory()).then(value => {if (alive) setItems(value);}).catch(error => {if (alive) setError(error.message);}).finally(() => {if (alive) setLoading(false);}); return () => {alive = false;};},[actions,revision]);
  const choose = async action => {setSelecting(true); try {await action(); onClose();} catch (error) {setError(error.message); session.report(error);} finally {setSelecting(false);}};
  const disabled = busy || selecting;
  const filtered = items.filter(item => item.title.toLowerCase().includes(query.toLowerCase()));
  return <section className="ds-history" aria-label="历史问答">
    <div className="ds-history-heading"><strong>网页历史问答</strong><button type="button" disabled={selecting} onClick={onClose}>返回对话</button></div>
    <div className="ds-history-search"><input aria-label="搜索历史问答" value={query} placeholder="搜索会话标题…" onChange={event => setQuery(event.target.value)}/><button type="button" disabled={disabled} onClick={() => choose(actions.newConversation)}>新建问答</button></div>
    <div className="ds-history-search"><button type="button" disabled={loading || disabled} onClick={() => setRevision(value => value + 1)}>刷新列表</button><button type="button" disabled={disabled} onClick={() => {actions.viewHistoryWeb(); onClose();}}>在网页查看完整历史</button></div>
    <p className="ds-history-note">历史由 DeepSeek 保存，不另存本地历史库。列表读取网页已加载的会话；选择后显示最近回答，完整记录可在网页查看。{selecting ? "正在打开会话…" : ""}</p>
    {error && <p role="alert" className="ds-template-error">{error}</p>}
    <div className="ds-history-list">{loading ? <p>正在读取历史…</p> : !filtered.length ? <p>{query ? "没有匹配的历史问答" : "网页尚未加载历史列表，请在网页展开侧栏后刷新列表。"}</p> : filtered.map(item => <button type="button" key={item.id} disabled={disabled} onClick={() => choose(() => actions.openHistory(item.url))}><strong>{item.title}</strong><span>DeepSeek 网页会话</span></button>)}</div>
  </section>;
}

function App({services}) {
  const {session,actions,appearance,detached,gestures} = services;
  const state = useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  const [background,setBackground] = useState(() => appearance.loadReaderOpacity());
  const {width,height} = useSyncExternalStore(gestures.subscribe,gestures.getSnapshot,gestures.getSnapshot);
  const [font,setFont] = useState(() => appearance.loadReaderFont());
  const [paused,setPaused] = useState(false), [opacity,setOpacity] = useState(() => appearance.loadOpacity());
  const [pinned,setPinned] = useState(() => appearance.loadPinned ? appearance.loadPinned() : false);
  const [quickAsks,setQuickAsks] = useState(() => normalizeQuickAsks(appearance.loadQuickAsks?.()));
  const [editingQuickAsks,setEditingQuickAsks] = useState(false);
  const [showingHistory,setShowingHistory] = useState(false);
  useEffect(() => {
    const refresh = () => {
      const next = normalizeQuickAsks(appearance.loadQuickAsks?.());
      setQuickAsks(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    if (state.visible) refresh();
    window.addEventListener("focus",refresh);
    return () => window.removeEventListener("focus",refresh);
  },[appearance,state.visible]);
  const saveQuickAsks = values => {
    if (appearance.saveQuickAsks?.(values) !== true) throw Error("快捷提问保存失败，请检查本地文件是否可写后重试。");
    setQuickAsks(values); setEditingQuickAsks(false); session.notify("快捷提问已保存。");
  };
  const webArea = useRef(null);
  const runtime = useExternalStoreRuntime({messages:state.messages,isRunning:state.sending || state.responding,isSendDisabled:state.sending || state.responding,
    convertMessage,onNew:async message => {
      const value = message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (!await session.submit(value)) throw new MessageNotSentError(session.getSnapshot().error);
    }});
  // The detached window applies its saved opacity right after mount, but the
  // native helper may not see the new window until Typora finishes opening it;
  // retry quietly and only surface an error after every attempt fails.
  useEffect(() => {
    if (!detached) return;
    let cancelled = false;
    (async () => {
      for (const delay of [0,600,1400,2400]) {
        if (delay) await new Promise(resolve => setTimeout(resolve,delay));
        if (cancelled) return;
        try { await actions.opacity(opacity); return; } catch (_) {}
      }
      if (!cancelled) session.report(Error("独立窗口透明度设置失败，请重试或重新打开小窗。"));
    })();
    return () => {cancelled = true;};
  },[opacity,detached,session,actions]);
  // A pinned detached window stays above the document the user is reading.
  // The helper may not see the brand-new window yet, so retry quietly.
  useEffect(() => {
    if (!detached || !pinned) return;
    let cancelled = false;
    (async () => {
      for (const delay of [200,900,2000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve,delay));
        if (cancelled) return;
        try { await actions.pin?.(true); return; } catch (_) {}
      }
    })();
    return () => {cancelled = true;};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // When an answer settles outside the user's attention, surface a cue.
  const respondingRef = useRef(state.responding);
  useEffect(() => {
    const was = respondingRef.current;
    respondingRef.current = state.responding;
    if (was && !state.responding && !state.error && !state.sending) actions.onAnswerSettled?.();
  },[state.responding,state.error,state.sending,actions]);
  useLayoutEffect(() => {
    if (state.view !== "web" || !webArea.current) return;
    const measure = () => actions.webBounds?.(webArea.current.getBoundingClientRect());
    measure(); const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(webArea.current); return () => observer?.disconnect();
  },[state.view,state.error,editingQuickAsks,showingHistory,actions]);
  const transparent = state.transparent && !detached;
  return <Services.Provider value={services}><AssistantRuntimeProvider runtime={runtime}>
    <section aria-label="DeepSeek 选区问答" className={`ds-shell ${transparent ? "ds-transparent" : ""} ${state.view === "web" ? "ds-web" : ""} ${detached ? "ds-detached" : ""}`} style={{"--card-alpha":`${background}%`,"--reader-font":`${font}px`}}>
      {!detached && <>{["left","right","top","bottom"].map(edge => {
        const vertical = edge === "top" || edge === "bottom", label = `拖动${{left:"左",right:"右",top:"上",bottom:"下"}[edge]}边框调整${vertical ? "高度" : "宽度"}`;
        return <div key={edge} className={`ds-resize-edge ds-resize-${edge}`} role="separator" aria-label={label} aria-orientation={vertical ? "horizontal" : "vertical"} aria-valuemin={vertical ? 320 : 300} aria-valuemax={vertical ? 12000 : 640} aria-valuenow={vertical ? height : width} tabIndex={0} title={label}/>;
      })}</>}
      <div className="ds-header">
        <div className="ds-brand"><span>✦</span><div><strong>DeepSeek</strong><small>选区问答</small></div></div>
        <div className="ds-header-actions"><button type="button" className="ds-tab" aria-pressed={state.view === "chat"} onClick={() => session.setView("chat")}>对话</button><button type="button" className="ds-tab" aria-pressed={state.view === "web"} onClick={() => session.setView("web")}>网页</button>
          <details className="ds-settings"><summary aria-label="更多设置">···</summary><div className="ds-settings-menu">
            <button type="button" onClick={() => run(session,actions.transfer)}>{detached ? "移回文档" : "独立窗口"}</button>
            <button type="button" onClick={() => run(session,actions.reload)}>刷新 DeepSeek 网页</button>
            <button type="button" disabled={state.sending || state.responding} onClick={event => {setShowingHistory(true); setEditingQuickAsks(false); event.currentTarget.closest("details").removeAttribute("open");}}>历史问答</button>
            <button type="button" onClick={event => {setEditingQuickAsks(true); setShowingHistory(false); event.currentTarget.closest("details").removeAttribute("open");}}>快捷提问设置</button>
            <label className="ds-check"><input type="checkbox" checked={state.transparent} disabled={detached} onChange={event => session.setTransparent(event.target.checked)}/>透明共读</label>
            {detached && <p>透明共读在原文档内使用</p>}
            <label>回答底色 <output>{background}%</output><input aria-label="回答底色" type="range" min="20" max="100" step="5" value={background} onChange={event => {const value = +event.target.value; setBackground(value); appearance.saveReaderOpacity(value);}}/></label>
            <label>阅读字号 <output>{font}px</output><input aria-label="阅读字号" type="range" min="14" max="22" value={font} onChange={event => {const value = +event.target.value; setFont(value); appearance.saveReaderFont(value);}}/><span className="ds-font-preview" style={{fontSize:`${font}px`}}>文字预览 Aa 中文</span></label>
            {detached && <label>小窗不透明度 <output>{opacity}%</output><input aria-label="小窗不透明度" type="range" min="40" max="100" step="5" value={opacity} onChange={event => {const value = +event.target.value; setOpacity(value); appearance.saveOpacity(value);}}/></label>}
            {detached && <label className="ds-check"><input type="checkbox" checked={pinned} onChange={event => {const value = event.target.checked; setPinned(value); appearance.savePinned?.(value); actions.pin?.(value);}}/>小窗置顶</label>}
          </div></details><button type="button" className="ds-close" aria-label="关闭问答" onClick={actions.close}>×</button>
        </div>
      </div>
      {state.error && <div role="alert" className="ds-error">{state.error}</div>}
      {showingHistory ? <HistoryPicker actions={actions} session={session} busy={state.sending || state.responding} onClose={() => setShowingHistory(false)}/> : editingQuickAsks ? <QuickAskEditor items={quickAsks} onSave={saveQuickAsks} onCancel={() => setEditingQuickAsks(false)}/> : state.view === "chat" ? <ThreadPrimitive.Root className="ds-thread">
        <ThreadPrimitive.Viewport className="ds-viewport" autoScroll>
          {!state.messages.length && <div className="ds-empty"><div>✦</div><h2>从一段文字开始</h2><p>在正文选中文字，右键选择<br/>“DeepSeek 问答”，引用会出现在输入框上方。</p><span>首次使用请在“网页”中登录 DeepSeek</span></div>}
          <ThreadPrimitive.Messages components={{UserMessage:Message,AssistantMessage:Message}}/>
        </ThreadPrimitive.Viewport>
        <div className="ds-thread-tools"><button type="button" onClick={() => {const value = !paused; setPaused(value); actions.pause(value);}}>{paused ? "继续同步" : "暂停同步"}</button><ThreadPrimitive.ScrollToBottom behavior="smooth">↓ 最新回答</ThreadPrimitive.ScrollToBottom></div>
        <Composer state={state} quickAsks={quickAsks} onEditQuickAsks={() => setEditingQuickAsks(true)}/>
      </ThreadPrimitive.Root> : <div className="ds-web-placeholder" ref={webArea} aria-label="DeepSeek 网页区域"/>}
      <div className="ds-footer">{paused ? "同步已暂停" : state.notice || (state.quote ? "已附加选区，可直接发送" : "选中正文 · 右键提问 · 保留会话")}</div>
    </section>
  </AssistantRuntimeProvider></Services.Provider>;
}

export function mountChatUI(element,shadow,services) {
  const style = document.createElement("style");
  const fontCSS = mathStyles.replace(/url\(([^)]+)\)/g,(_,value) => {
    const name = value.replace(/["']/g,"").split("/").at(-1);
    return `url("${new URL(`./fonts/${name}`,import.meta.url).href}")`;
  });
  style.textContent = styles + "\n" + fontCSS; shadow.prepend(style);
  const closeSettings = event => {
    if (!event.composedPath().some(node => node?.classList?.contains("ds-settings"))) shadow.querySelector(".ds-settings")?.removeAttribute("open");
  };
  const escapeSettings = event => {if (event.key === "Escape") shadow.querySelector(".ds-settings")?.removeAttribute("open");};
  shadow.addEventListener("pointerdown",closeSettings); shadow.addEventListener("keydown",escapeSettings);
  const gestures = createPointerGestures({shadow,...services});
  const root = createRoot(element); root.render(<App services={{...services,gestures}}/>);
  return {focusComposer() {setTimeout(() => shadow.querySelector('textarea[aria-label="输入问题"]')?.focus(),30);},dispose() {gestures.dispose(); shadow.removeEventListener("pointerdown",closeSettings); shadow.removeEventListener("keydown",escapeSettings); root.unmount(); style.remove();}};
}
