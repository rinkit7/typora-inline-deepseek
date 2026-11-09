import {buildWebQuestion} from "./web-provider.js";

export function createChatSession({provider,clock = () => Date.now()} = {}) {
  let state = {messages:[],draft:"",quote:null,contextTargetId:null,conversationURL:null,sending:false,responding:false,error:"",notice:"",view:"chat",transparent:false,visible:false};
  let sequence = 0, pending = null, disposed = false, importLatest = true;
  const listeners = new Set();
  const messageIds = new Set();
  const publish = patch => {if (disposed) return; state = {...state,...patch}; for (const callback of listeners) callback();};
  const id = () => {
    let value;
    do {value = `m-${clock()}-${++sequence}`;} while (messageIds.has(value));
    messageIds.add(value); return value;
  };
  const replyKey = reply => reply?.key || (reply?.count ? `block:${reply.count}` : null);
  function receive(reply) {
    if (disposed || state.sending) return;
    const turn = pending;
    if (!turn) {
      if (reply?.text && importLatest && !state.messages.length && !state.quote && !state.draft && (!state.conversationURL || reply.url === state.conversationURL)) {
        publish({messages:[{id:id(),role:"assistant",text:reply.text,imported:true}],conversationURL:reply.url || null});
      }
      return;
    }
    if (turn.url && reply?.url !== turn.url) {
      pending = null;
      publish({responding:false,error:"网页会话已切换，请从「历史」重新选择。",notice:"已停止同步"});
      return;
    }
    const now = clock();
    const key = replyKey(reply);
    const isNewAnswer = key && reply.atEnd !== false && (key.startsWith("row:") ? key !== turn.baselineKey : reply.count > turn.baselineCount);
    const matches = turn.key ? key === turn.key : isNewAnswer;
    if (!reply?.text || !matches) {
      if (now - turn.changedAt > 90000) {
        pending = null;
        publish({responding:false,notice:"网页暂未返回回答，可切换“网页”查看。"});
      }
      return;
    }
    turn.key = key;
    if (turn.lastText !== reply.text) {turn.changedAt = now; turn.lastText = reply.text;}
    const running = !!reply.generating || now - turn.changedAt < 2500;
    if (!running) pending = null;
    if (state.responding === running && state.messages.find(message => message.id === turn.id)?.text === reply.text) return;
    const messages = state.messages.map(message => message.id === turn.id ? {...message,text:reply.text} : message);
    publish({messages,responding:running,notice:running ? "DeepSeek 正在回答…" : "回答已同步"});
  }
  const unsubscribe = provider?.subscribe?.(receive);
  return {
    getSnapshot:() => state,
    subscribe(callback) {listeners.add(callback); return () => listeners.delete(callback);},
    setDraft:draft => publish({draft:String(draft)}),
    setQuote(quote) {publish({quote:quote?.text ? {text:String(quote.text),label:String(quote.label || "正文选区"),key:quote.key,targetId:quote.targetId} : null,error:"",visible:true});},
    askSelection(quote) {
      publish({quote:{text:String(quote.text),label:String(quote.label || "正文选区"),key:quote.key,targetId:quote.targetId},contextTargetId:quote.targetId,draft:state.draft || "解释这段内容",visible:true,error:""});
    },
    setView:view => publish({view:view === "web" ? "web" : "chat"}),
    setTransparent:transparent => publish({transparent:!!transparent}),
    show() {publish({visible:true});},
    hide() {publish({visible:false});},
    report(error) {publish({error:String(error?.message || error)});},
    notify(notice) {publish({notice:String(notice)});},
    async submit(value = state.draft) {
      if (state.sending || state.responding) return false;
      const question = String(value || "").trim();
      if (!question) {publish({error:"请输入问题。"}); return false;}
      const quote = state.quote;
      const contextTargetId = state.contextTargetId;
      const conversationURL = state.conversationURL;
      publish({sending:true,error:"",notice:"正在发送…"});
      try {
        const result = await provider.send(buildWebQuestion(quote?.text,question),conversationURL);
        if (disposed) return false;
        const targetId = quote?.targetId || contextTargetId;
        const user = {id:id(),role:"user",text:question,quote,targetId};
        const assistant = {id:id(),role:"assistant",text:"",targetId};
        const url = result.url || conversationURL;
        pending = {id:assistant.id,url,baselineKey:replyKey(result.baseline),baselineCount:result.baseline?.count || 0,lastText:"",changedAt:clock()};
        publish({messages:[...state.messages,user,assistant],conversationURL:url,draft:state.draft.trim() === question ? "" : state.draft,quote:state.quote === quote ? null : state.quote,sending:false,responding:true,notice:"问题已发送，等待回答…"});
        return true;
      } catch (error) {
        publish({sending:false,error:error.message || String(error),view:error.code === "LOGIN_REQUIRED" ? "web" : state.view,notice:""});
        return false;
      }
    },
    receive,
    export() {return {...state,messages:state.messages.map(message => ({...message})),sending:false,responding:false};},
    restore(data) {
      pending = null;
      importLatest = false;
      const restored = Array.isArray(data?.messages) ? data.messages.filter(m => ["user","assistant"].includes(m.role) && typeof m.text === "string") : [];
      messageIds.clear();
      for (const message of restored) if (typeof message.id === "string" && message.id) messageIds.add(message.id);
      const assigned = new Set();
      const messages = restored.map(message => {
        const key = typeof message.id === "string" && message.id && !assigned.has(message.id) ? message.id : id();
        assigned.add(key); return {...message,id:key};
      });
      publish({messages,conversationURL:data?.conversationURL || null,draft:String(data?.draft || ""),quote:data?.quote?.text ? data.quote : null,contextTargetId:data?.contextTargetId || null,transparent:!!data?.transparent,view:data?.view === "web" ? "web" : "chat",visible:true,sending:false,responding:false,error:"",notice:"已恢复会话"});
    },
    clear() {pending = null; messageIds.clear(); publish({messages:[],draft:"",quote:null,error:"",responding:false});},
    dispose() {disposed = true; unsubscribe?.(); listeners.clear();}
  };
}
