import {buildWebQuestion} from "./web-provider.js";

export function createChatSession({provider,clock = () => Date.now()} = {}) {
  let state = {messages:[],draft:"",quote:null,contextTargetId:null,sending:false,responding:false,error:"",notice:"",view:"chat",transparent:false,visible:false};
  let sequence = 0, pending = null, disposed = false, importLatest = true;
  const listeners = new Set();
  const publish = patch => {if (disposed) return; state = {...state,...patch}; for (const callback of listeners) callback();};
  const id = () => `m-${clock()}-${++sequence}`;
  function receive(reply) {
    if (disposed || state.sending) return;
    if (pending && state.responding && clock() - pending.sentAt > 90000 && (!reply?.text || pending.baseline === JSON.stringify([reply.count,reply.text]))) publish({responding:false,notice:"网页暂未返回回答，可切换“网页”查看。"});
    if (!reply?.text) return;
    const signature = JSON.stringify([reply.count,reply.text]);
    if (!pending) {
      if (importLatest && !state.messages.length && !state.quote && !state.draft) publish({messages:[{id:id(),role:"assistant",text:reply.text,imported:true}]});
      return;
    }
    if (pending.baseline === signature) return;
    const now = clock();
    if (pending.lastText !== reply.text) {pending.changedAt = now; pending.lastText = reply.text;}
    const running = reply.generating || now - pending.changedAt < 2500;
    if (state.responding === running && state.messages.find(message => message.id === pending.id)?.text === reply.text) return;
    const messages = state.messages.map(message => message.id === pending.id ? {...message,text:reply.text} : message);
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
      publish({sending:true,error:"",notice:"正在发送…"});
      try {
        const result = await provider.send(buildWebQuestion(quote?.text,question));
        if (disposed) return false;
        const targetId = quote?.targetId || contextTargetId;
        const user = {id:id(),role:"user",text:question,quote,targetId};
        const assistant = {id:id(),role:"assistant",text:"",targetId};
        pending = {id:assistant.id,baseline:JSON.stringify([result.baseline?.count,result.baseline?.text]),lastText:"",changedAt:clock(),sentAt:clock()};
        publish({messages:[...state.messages,user,assistant],draft:state.draft.trim() === question ? "" : state.draft,quote:state.quote === quote ? null : state.quote,sending:false,responding:true,notice:"问题已发送，等待回答…"});
        return true;
      } catch (error) {
        publish({sending:false,error:error.message || String(error),view:error.code === "LOGIN_REQUIRED" ? "web" : state.view,notice:""});
        return false;
      }
    },
    receive,
    export() {return {...state,messages:state.messages.map(message => ({...message})),sending:false,responding:false};},
    restore(data,{resume = true} = {}) {
      pending = null;
      importLatest = resume;
      const messages = Array.isArray(data?.messages) ? data.messages.filter(m => ["user","assistant"].includes(m.role) && typeof m.text === "string").map(m => ({...m,id:m.id || id()})) : [];
      if (resume && messages.at(-1)?.role === "assistant") pending = {id:messages.at(-1).id,baseline:null,lastText:messages.at(-1).text,changedAt:clock() - 3000,sentAt:clock()};
      publish({messages,draft:String(data?.draft || ""),quote:data?.quote?.text ? data.quote : null,contextTargetId:data?.contextTargetId || null,transparent:!!data?.transparent,view:data?.view === "web" ? "web" : "chat",visible:true,sending:false,responding:false,error:"",notice:"已恢复会话"});
    },
    clear() {pending = null; publish({messages:[],draft:"",quote:null,error:"",responding:false});},
    dispose() {disposed = true; unsubscribe?.(); listeners.clear();}
  };
}
