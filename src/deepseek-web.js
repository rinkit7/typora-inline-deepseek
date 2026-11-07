import {createWebviewLifecycle,executeWebScript,fillWebComposer,submitWebComposer} from "./web-provider.js";
import {inspectWebHistory,validateHistoryURL} from "./web-history.js";

// Build the in-page readers for the isolated DeepSeek webpage. All output is
// inert Markdown text. The builder is serialized into the page as a whole, so
// both readers share one Markdown serializer and stay byte-identical on the
// same content. In-process callers use the thin wrapper below.
export function inspectDeepSeekReplyBuilder() {
  const messageLimit = 200000;
  let budget = messageLimit;
  const citations = / -\d+(?:-\d+)*(?=[\s。．！!？?；;]|$)/g;
  function codeBlock(pre,language = "") {
    const code = pre.querySelector("code"), clean = (code || pre).cloneNode(true);
    clean.querySelectorAll('button,[role="button"],[aria-hidden="true"],script,style').forEach(node => node.remove());
    const value = String(clean.textContent || "").slice(0,budget); budget -= value.length;
    const hint = (code?.className || "").match(/(?:^|\s)language-([\w#+.-]+)/)?.[1] || pre.getAttribute("data-language") || language;
    const label = /^[\w#+.-]{1,32}$/.test(hint) ? hint : "";
    const fence = "`".repeat(Math.max(3,...[...value.matchAll(/`+/g)].map(match => match[0].length + 1)));
    return `\n\n${fence}${label}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
  }
  function markdown(node,depth = 0) {
    if (!node || depth > 40 || budget <= 0) return "";
    if (node.nodeType === 3) {const value = String(node.nodeValue || "").slice(0,budget); budget -= value.length; return value.replace(citations,"");}
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (["script","style","iframe","object","embed","img","svg","button","input"].includes(tag)) return "";
    if (node.classList?.contains("katex")) {
      const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (source) {const value = source.slice(0,budget); budget -= value.length; return node.parentElement?.classList?.contains("katex-display") ? `\n\n$$\n${value}\n$$\n\n` : `$${value}$`;}
    }
    if (node.getAttribute("aria-hidden") === "true") return "";
    if (tag === "pre") return codeBlock(node);
    // Recognize code wrappers by structure and toolbar-only surrounding text.
    // Do not strip words like "复制" from ordinary prose or from the code.
    const blocks = node.querySelectorAll("pre");
    if (blocks.length === 1) {
      const surrounding = node.cloneNode(true); surrounding.querySelector("pre").remove();
      const toolbar = surrounding.textContent.match(/^\s*([\w#+.-]{1,32})?\s*(?:(?:复制(?:代码)?|下载(?:代码)?|Copy(?: code)?|Download(?: code)?)\s*)+$/i);
      if (toolbar) return codeBlock(blocks[0],toolbar[1] || "");
    }
    if (tag === "code") {
      const content = String(node.textContent || "").slice(0,budget); budget -= content.length;
      const fence = "`".repeat(Math.max(1,...[...content.matchAll(/`+/g)].map(match => match[0].length + 1)));
      return `${fence} ${content} ${fence}`;
    }
    const content = [...node.childNodes].map(child => markdown(child,depth + 1)).join("");
    if (tag === "br") return "\n";
    if (tag === "p" || tag === "blockquote" || /^h[1-6]$/.test(tag)) return `\n\n${tag === "blockquote" ? "> " : tag[0] === "h" ? "#".repeat(Number(tag[1])) + " " : ""}${content.trim()}\n\n`;
    if (tag === "strong" || tag === "b") return `**${content}**`;
    if (tag === "em" || tag === "i") return `*${content}*`;
    if (tag === "li") return `\n${node.parentElement?.tagName === "OL" ? "1." : "-"} ${content.trim()}`;
    if (tag === "ul" || tag === "ol") return `\n${content}\n`;
    if (tag === "table") {
      const rows = [...node.querySelectorAll("tr")].map(row => [...row.querySelectorAll("th,td")].map(cell => markdown(cell,depth + 1).trim().replace(/\|/g,"\\|").replace(/\n/g," ")));
      if (!rows.length) return "";
      return `\n\n| ${rows[0].join(" | ")} |\n| ${rows[0].map(() => "---").join(" | ")} |\n${rows.slice(1).map(row => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
    }
    return content;
  }
  function readMarkdown(node) {
    // Each answer has the same limit as the live reader. Sharing a budget
    // across turns would truncate a later answer differently from reply().
    budget = messageLimit;
    return markdown(node).trim().slice(0,messageLimit);
  }
  function reply() {
    const nodes = [...document.querySelectorAll(".ds-markdown")], last = nodes.at(-1);
    const textarea = document.querySelector("textarea");
    let scope = textarea?.parentElement, generating = !!textarea?.disabled;
    for (let i = 0; scope && i < 6 && scope !== document.body; i++,scope = scope.parentElement) {
      if (scope.querySelector(".ds-markdown")) break;
      for (const button of scope.querySelectorAll('button,[role="button"]')) {
        const label = ["aria-label","title","data-testid"].map(key => button.getAttribute(key) || "").join(" ");
        const disabled = button.disabled || button.getAttribute("aria-disabled") === "true" || button.classList.contains("ds-button--disabled") || button.classList.contains("ds-icon-button--disabled");
        const box = button.getBoundingClientRect();
        if (!disabled && box.width && box.height && (/stop|停止|取消/i.test(label) || (!textarea.value.trim() && button.matches(".ds-button--primary.ds-button--filled.ds-button--circle")))) generating = true;
      }
    }
    // DeepSeek appends web-citation markers like " -2-4-10" before sentence
    // punctuation or line breaks; they are page furniture, not answer content.
    // The leading space is required so real ranges (2024-2025) survive.
    return {count:nodes.length,text:last ? readMarkdown(last) : "",generating,loggedIn:!!textarea,url:document.location?.href};
  }
  // Read the whole visible conversation of a loaded history session: every
  // user message and every assistant answer in document order. User bubbles
  // have no stable class, so content is classified structurally: subtrees
  // containing an answer block are walked further, leaf subtrees without one
  // are user text; page furniture lines (action labels, thinking headers,
  // clocks) are dropped.
  function conversation() {
    const marks = [...document.querySelectorAll(".ds-markdown")];
    const textarea = document.querySelector("textarea");
    const loggedIn = !!textarea;
    if (!marks.length) return {messages:[],count:0,text:"",generating:!!textarea?.disabled,loggedIn};
    const skipLines = new Set(["复制","已复制","重新生成","继续生成","编辑","删除","复制代码","下载"]);
    const messages = [];
    let truncated = false;
    const ignored = node => node.matches?.('script,style,iframe,object,embed,svg,button,input,textarea,nav,aside,header,[role="button"],[role="navigation"],[aria-hidden="true"],[hidden]');
    // User bubbles have no stable class and their <br> line breaks matter for
    // filtering page furniture, so the text is read structurally instead of
    // via innerText (which jsdom lacks and which hides <br> breaks).
    const bubbleText = node => {
      let out = "";
      const visit = child => {
        if (child.nodeType === 3) {out += child.nodeValue || ""; return;}
        if (child.nodeType !== 1) return;
        const tag = child.tagName.toLowerCase();
        if (tag === "br") {out += "\n"; return;}
        if (ignored(child)) return;
        const block = /^(p|div|li|pre|blockquote|h[1-6])$/.test(tag);
        if (block) out += "\n";
        for (const grand of child.childNodes) visit(grand);
        if (block) out += "\n";
      };
      for (const child of node.childNodes) visit(child);
      return out;
    };
    const userText = node => {
      if (!node || ignored(node)) return "";
      const lines = bubbleText(node).split("\n").map(line => line.trim())
        .filter(line => line && !skipLines.has(line) && !/^已?深度思考/.test(line) && !/^思考过程$/.test(line) && !/^\d{1,2}:\d{2}$/.test(line));
      return lines.join("\n");
    };
    const pushUser = (node,preserve = false) => {
      const text = preserve ? bubbleText(node).trim() : userText(node);
      if (!text) return;
      if (text.length > messageLimit) truncated = true;
      messages.push({role:"user",text:text.slice(0,messageLimit)});
    };
    const pushAssistant = node => {
      const text = readMarkdown(node);
      if (!text) return;
      if (budget <= 0) truncated = true;
      messages.push({role:"assistant",text});
    };
    const virtualList = marks[0].closest('.ds-virtual-list');
    const virtualItems = virtualList?.querySelector('.ds-virtual-list-visible-items');
    if (virtualItems) {
      // Offscreen messages are unmounted. Read keyed message rows, never the
      // page title, composer or auxiliary rendering trees.
      for (const row of virtualItems.children) {
        const webKey = row.getAttribute('data-virtual-list-item-key');
        if (webKey == null) continue;
        const answers = [...row.querySelectorAll('.ds-assistant-message-main-content')];
        const blocks = answers.length ? answers : [...row.querySelectorAll('.ds-markdown')];
        const start = messages.length;
        if (blocks.length) for (const block of blocks) pushAssistant(block);
        else pushUser(row,true);
        for (let i = start; i < messages.length; i++) messages[i].webKey = `${webKey}:${i - start}`;
      }
      return {...reply(),messages,truncated,virtual:true};
    }
    let container = marks[0].parentElement;
    while (container && !container.contains(marks.at(-1))) container = container.parentElement;
    const main = marks[0].closest('main,[role="main"]');
    if (main?.contains(marks.at(-1))) container = main;
    else {
      // In a single-turn session the answer's parent is not the message list.
      // Expand to include a preceding user bubble, skipping toolbar-only and
      // navigation siblings instead of assuming an unstable webpage class.
      for (let branch = container; branch?.parentElement && branch !== document.body; branch = branch.parentElement) {
        const before = [...branch.parentElement.children].slice(0,[...branch.parentElement.children].indexOf(branch));
        if (before.some(node => !node.matches('.ds-markdown') && !node.querySelector('.ds-markdown,textarea') && userText(node))) {container = branch.parentElement; break;}
      }
    }
    const walk = node => {
      if (!node || node.nodeType !== 1 || ignored(node)) return;
      if (node.classList?.contains("ds-markdown")) {pushAssistant(node); return;}
      // A composer can share an ancestor with every message. Descend through
      // that ancestor and skip only its actual controls, not the conversation.
      if (node.querySelector?.(".ds-markdown,textarea")) {for (const child of node.children) walk(child); return;}
      pushUser(node);
    };
    walk(container);
    return {...reply(),messages,truncated};
  }
  async function history() {
    const list = document.querySelector('.ds-assistant-message-main-content,.ds-markdown')?.closest('.ds-virtual-list');
    if (!list?.querySelector('.ds-virtual-list-visible-items')) return conversation();
    const pause = () => new Promise(resolve => setTimeout(resolve,80));
    const records = new Map(), deadline = Date.now() + 25000, sourceURL = document.location.href;
    const originalTop = list.scrollTop, originalBehavior = list.style.scrollBehavior;
    let truncated = false, completed = false;
    list.style.scrollBehavior = 'auto';
    try {
      list.scrollTop = 0;
      for (let step = 0; step < 1000 && Date.now() < deadline; step++) {
        let snapshot, signature = '', stable = 0;
        for (let attempt = 0; attempt < 12 && Date.now() < deadline; attempt++) {
          await pause();
          if (!list.isConnected || document.location.href !== sourceURL) throw Error('读取期间网页会话已改变，请重新选择。');
          snapshot = conversation();
          const next = JSON.stringify(snapshot.messages);
          stable = next === signature ? stable + 1 : 1; signature = next;
          if (snapshot.messages.length && stable >= 3) break;
        }
        if (!snapshot?.loggedIn || !snapshot.virtual || snapshot.generating || stable < 3) throw Error('历史消息仍在加载或生成，请稍后重新选择会话。');
        for (const message of snapshot.messages) records.set(message.webKey,message);
        truncated ||= snapshot.truncated;
        const bottom = Math.max(0,list.scrollHeight - list.clientHeight);
        if (list.scrollTop >= bottom - 2) {completed = true; break;}
        const rows = list.querySelector('.ds-virtual-list-visible-items').children;
        const last = rows[rows.length - 1];
        // Mounted long answers already have their complete DOM. Advance past
        // the last read row with overlap rather than scrolling inside it.
        const throughLast = last ? last.getBoundingClientRect().bottom - list.getBoundingClientRect().top - list.clientHeight * .2 : 0;
        const nextTop = Math.min(bottom,list.scrollTop + Math.max(120,list.clientHeight * .8,throughLast));
        if (nextTop <= list.scrollTop) throw Error('无法继续读取网页历史，请在网页确认后重试。');
        list.scrollTop = nextTop;
      }
      if (!completed) throw Error('会话较长，尚未完整读取，请在网页确认加载后重试。');
      const messages = [...records.values()].map(({webKey,...message}) => message);
      return {...reply(),messages,truncated};
    } finally {
      // Follow-up sends need the latest answer as their baseline. Failed
      // reads restore the original webpage position instead.
      if (!completed && list.isConnected && document.location.href === sourceURL) list.scrollTop = originalTop;
      list.style.scrollBehavior = originalBehavior;
    }
  }
  return {reply,conversation,history};
}

// In-process wrapper; the webview path serializes the builder instead.
export function inspectDeepSeekReply() {
  return inspectDeepSeekReplyBuilder().reply();
}

export function createDeepSeekWeb({webview,onStatus = () => {},interval = 900,historyPause = ms => new Promise(resolve => setTimeout(resolve,ms)),historyAttempts = 40}) {
  let disposed = false, active = false, polling = false, paused = false, suspended = false, switching = false, historyFailed = false, epoch = 0;
  const listeners = new Set();
  const lifecycle = createWebviewLifecycle(webview,state => onStatus(state));
  const replyScript = `(${inspectDeepSeekReplyBuilder.toString()})().reply()`;
  const conversationScript = `(${inspectDeepSeekReplyBuilder.toString()})().conversation()`;
  const historyScript = `(${inspectDeepSeekReplyBuilder.toString()})().history()`;
  const read = () => executeWebScript(webview,replyScript,false,2200);
  async function poll() {
    if (disposed || !active || polling || paused || suspended || switching || historyFailed) return;
    try {if (new URL(webview.getURL()).origin !== "https://chat.deepseek.com") return;} catch (_) {return;}
    polling = true;
    const started = epoch;
    try {const reply = await read(); if (!disposed && active && !suspended && !switching && epoch === started) for (const listener of listeners) listener(reply);}
    catch (_) {} finally {polling = false;}
  }
  const timer = setInterval(poll,interval);
  return {
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    setActive(value) {active = !!value; if (active) void poll();},
    setPaused(value) {paused = !!value; if (!paused) void poll();},
    setSuspended(value) {suspended = !!value; if (!suspended) void poll();},
    async send(prompt) {
      if (switching) throw Error("正在打开历史问答，请稍候。");
      if (historyFailed) throw Error("历史会话切换未完成，请重新选择会话后再发送。");
      await lifecycle.ensureReady();
      if (new URL(webview.getURL()).origin !== "https://chat.deepseek.com") throw Error("请先切换网页，回到 DeepSeek 聊天页面。");
      let baseline;
      try {baseline = await read();} catch (_) {baseline = null;}
      if (baseline?.generating) throw Error("DeepSeek 还在回答上一条问题，请等回答结束后发送。");
      const filled = await executeWebScript(webview,`(${fillWebComposer.toString()})(${JSON.stringify(prompt)})`,true);
      if (!filled.ok) {const error = Error(filled.reason); if (/登录/.test(filled.reason)) error.code = "LOGIN_REQUIRED"; throw error;}
      const result = await executeWebScript(webview,`(${submitWebComposer.toString()})()`,true,7000);
      if (!result.ok) throw Error(result.reason);
      paused = false;
      return {baseline};
    },
    poll,
    async listHistory() {
      await lifecycle.ensureReady();
      if (new URL(webview.getURL()).origin !== "https://chat.deepseek.com") throw Error("请先回到 DeepSeek 网页并登录。");
      const result = await executeWebScript(webview,`(${inspectWebHistory.toString()})()`,false,3000);
      if (!result?.loggedIn) throw Error("请先切换“网页”并登录 DeepSeek，再刷新历史列表。");
      return (result.items || []).map(item => ({...item,url:validateHistoryURL(item.url)}));
    },
    async openHistory(value) {
      const url = validateHistoryURL(value,{allowNew:true});
      const sameURL = value => {
        try {const page = new URL(value); return `${page.origin}${page.pathname}`.replace(/\/$/,"") === url.replace(/\/$/,"");} catch (_) {return false;}
      };
      if (switching) throw Error("正在切换会话，请稍候。");
      const previous = this.getURL();
      switching = true; epoch++;
      try {
        if (url !== this.getURL()) webview.setAttribute("src",url);
        else if (url === "https://chat.deepseek.com/") webview.reload?.();
        const deadline = Date.now() + 12000;
        let signature = "", stableReads = 0;
        for (let attempt = 0; attempt < historyAttempts && !disposed && Date.now() < deadline; attempt++) {
          await historyPause(150);
          if (!sameURL(this.getURL())) {signature = ""; stableReads = 0; continue;}
          let reply;
          try {
            if (!await lifecycle.probe()) {signature = ""; stableReads = 0; continue;}
            reply = await executeWebScript(webview,conversationScript,false,4000);
          } catch (_) {signature = ""; stableReads = 0; continue;}
          if (!reply?.loggedIn || reply.generating || reply.url && !sameURL(reply.url) || url !== "https://chat.deepseek.com/" && !reply.text) {signature = ""; stableReads = 0; continue;}
          const current = JSON.stringify([reply.count,reply.messages,reply.text,reply.generating]);
          stableReads = current === signature ? stableReads + 1 : 1; signature = current;
          // Retry only readiness probes. A full scan failure must propagate;
          // silently retrying it can restart long scans or hide route changes.
          if (stableReads >= 3) {
            const result = reply.virtual ? await executeWebScript(webview,historyScript,false,30000) : reply;
            if (disposed || !sameURL(this.getURL()) || result?.url && !sameURL(result.url)) throw Error('读取期间网页会话已改变，请重新选择。');
            historyFailed = false; return result;
          }
        }
        throw Error("历史会话尚未加载完成，请在“网页”中确认后重试。");
      } catch (error) {historyFailed = true; if (previous !== url) webview.setAttribute("src",previous); throw error;}
      finally {switching = false;}
    },
    getURL() {try {const url = new URL(webview.getURL()); return url.origin === "https://chat.deepseek.com" ? url.href : "https://chat.deepseek.com/";} catch (_) {return "https://chat.deepseek.com/";}},
    navigate(url) {if (new URL(url).origin === "https://chat.deepseek.com" && url !== this.getURL()) webview.setAttribute("src",url);},
    reload() {webview.reload();},
    dispose() {disposed = true; active = false; clearInterval(timer); lifecycle.dispose(); listeners.clear();}
  };
}
