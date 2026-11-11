import {createWebviewLifecycle,executeWebScript,fillWebComposer,sendWebQuestion,submitWebComposer} from "./web-provider.js";
import {conversationAt,DEEPSEEK_HOME,getConversationURL,inspectWebHistory,validateHistoryURL} from "./web-history.js";

// Build the in-page readers for the isolated DeepSeek webpage. All output is
// inert Markdown text. The builder is serialized into the page as a whole, so
// both readers share one Markdown serializer and stay byte-identical on the
// same content. In-process callers use the thin wrapper below.
export function inspectDeepSeekReplyBuilder() {
  const messageLimit = 200000;
  let budget = messageLimit;
  const citationMarker = '.ds-markdown-citation,[data-citation],[data-citation-id],[data-citation-index],[role="doc-noteref"]';
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
    if (node.nodeType === 3) {const value = String(node.nodeValue || "").slice(0,budget); budget -= value.length; return value;}
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (["script","style","iframe","object","embed","img","svg","button","input"].includes(tag)) return "";
    if (node.classList?.contains("katex")) {
      const source = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (source) {const value = source.slice(0,budget); budget -= value.length; return node.parentElement?.classList?.contains("katex-display") ? `\n\n$$\n${value}\n$$\n\n` : `$${value}$`;}
    }
    if (node.getAttribute("aria-hidden") === "true" || node.matches(citationMarker)) return "";
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
  const visibleItems = list => list?.querySelector(".ds-virtual-list-visible-items");
  const rowKey = "data-virtual-list-item-key";
  const keyedRows = items => [...(items?.children || [])].filter(row => row.hasAttribute(rowKey));
  const cssPx = (node,property) => parseFloat(document.defaultView.getComputedStyle(node)[property]) || 0;
  const waitForRender = () => new Promise(resolve => setTimeout(resolve,80));
  function answerBlocks(row) {
    const answers = row.querySelectorAll(".ds-assistant-message-main-content");
    return answers.length ? answers : row.querySelectorAll(".ds-markdown");
  }
  function findMessageList(allowEmpty = false) {
    const answer = document.querySelector(".ds-assistant-message-main-content,.ds-markdown");
    if (answer) {
      const list = answer.closest(".ds-virtual-list");
      if (visibleItems(list)) return list;
      if (!allowEmpty) return null;
    }
    // The viewport can contain only a question, or be past the message track.
    const lists = [...document.querySelectorAll(".ds-virtual-list")].filter(list => {
      const items = visibleItems(list);
      if (!items || list.closest('aside,nav,[role="navigation"]') || items.querySelector('a[href*="/a/chat/s/"]')) return false;
      return keyedRows(items).length || allowEmpty && messageWindow(list,items)?.hasTrack;
    });
    return lists.length === 1 ? lists[0] : null;
  }
  function messageWindow(list,items = visibleItems(list)) {
    if (!items) return null;
    const height = list.clientHeight;
    if (!height) return null;
    const top = list.scrollTop, extent = Math.max(height,list.scrollHeight);
    const origin = list.getBoundingClientRect().top + list.clientTop - top;
    // The full virtual track excludes scrollable space before or after the messages.
    const track = items.closest(".ds-virtual-list-items");
    const rect = list.contains(track) ? track.getBoundingClientRect() : null;
    const start = rect ? Math.max(0,rect.top - origin) : 0;
    const end = rect ? Math.min(extent,rect.bottom - origin) : 0;
    const hasTrack = end > start;
    const from = hasTrack ? start : 0, to = hasTrack ? end : extent;
    const bottom = Math.min(extent - height,Math.max(0,Math.ceil(to - height)));
    const firstTop = Math.min(bottom,Math.floor(from));
    return {items,height,top,origin,from,to,bottom,firstTop,hasTrack};
  }
  function mountedWindow(list,bounds,rows = keyedRows(bounds?.items)) {
    if (!bounds || !rows.length) return null;
    const {items,height,top,origin,from,to,bottom,firstTop,hasTrack} = bounds;
    const first = rows[0], last = rows.at(-1);
    const start = first.getBoundingClientRect().top - origin;
    const end = last.getBoundingClientRect().bottom - origin;
    if (!(end > start)) return null;
    const before = cssPx(first,"marginTop") + (top <= firstTop + 2 ? cssPx(items,"paddingTop") + (hasTrack ? 0 : cssPx(list,"paddingTop")) : 0);
    const after = cssPx(last,"marginBottom") + (top >= bottom - 2 ? cssPx(items,"paddingBottom") + (hasTrack ? 0 : cssPx(list,"paddingBottom")) : 0);
    // scrollTop can change before the virtual list has rendered that position.
    // Require the mounted rows to cover the visible part of the message track.
    const visibleStart = Math.max(top,from), visibleEnd = Math.min(top + height,to);
    if (visibleEnd <= visibleStart) return null;
    if ((hasTrack || bottom > 2) && (start - before > visibleStart + 2 || end + after < visibleEnd - 2)) return null;
    return {top,bottom,height,end};
  }
  function reply(list = findMessageList(),bounds = messageWindow(list)) {
    const rows = keyedRows(bounds?.items || visibleItems(list));
    const nodes = list ? rows.flatMap(row => [...answerBlocks(row)]) : [...document.querySelectorAll(".ds-markdown")];
    const last = nodes.at(-1);
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
    const row = last?.closest("[" + rowKey + "]");
    const key = row ? "row:" + row.getAttribute(rowKey) : last ? "block:" + nodes.length : null;
    const viewport = mountedWindow(list,bounds,rows);
    const atEnd = !list || !!viewport && viewport.top >= viewport.bottom - 2;
    // A tall final answer can already be mounted while the page is anchored
    // at the question. Its row reaches the end of the full message track.
    const latest = bounds?.hasTrack
      ? !!row && row === rows.at(-1) && (atEnd ||
        row.getBoundingClientRect().bottom - bounds.origin + cssPx(row,"marginBottom") + cssPx(bounds.items,"paddingBottom") >= bounds.to - 2)
      : atEnd;
    return {count:nodes.length,key,atEnd,latest,text:last ? readMarkdown(last) : "",generating,loggedIn:!!textarea,url:document.location.href};
  }
  function followReply(expectedURL,conversationAt) {
    if (conversationAt(document.location) !== expectedURL) return {url:document.location.href};
    const list = findMessageList(true);
    const bounds = messageWindow(list);
    const result = reply(list,bounds);
    // If the reply is offscreen, bring it into the background viewport.
    // The next poll can verify that the virtual list has mounted those rows.
    if (bounds && result.loggedIn && !result.atEnd && !result.latest && Math.abs(bounds.top - bounds.bottom) > 2) {
      list.scrollTo({top:bounds.bottom,behavior:"instant"});
    }
    return result;
  }
  async function sendBaseline(expectedURL,conversationAt) {
    const matches = () => conversationAt(document.location) === expectedURL;
    if (!matches()) throw Error("DeepSeek 网页会话已切换，请从「历史」重新选择。");
    const list = findMessageList();
    let result = reply(list);
    if (!list || result.atEnd || !result.loggedIn || result.generating) return result;
    const originalTop = list.scrollTop, originalBehavior = list.style.scrollBehavior;
    const deadline = Date.now() + 1800;
    list.style.scrollBehavior = "auto";
    try {
      while (Date.now() < deadline) {
        const bottom = messageWindow(list)?.bottom;
        if (bottom != null && Math.abs(list.scrollTop - bottom) > 2) list.scrollTop = bottom;
        await waitForRender();
        if (!list.isConnected || !matches()) throw Error("DeepSeek 网页会话已切换，请从「历史」重新选择。");
        result = reply(list);
        if (result.atEnd || result.generating) break;
      }
      return result;
    } finally {
      if (!result.atEnd && list.isConnected && matches()) list.scrollTop = originalTop;
      list.style.scrollBehavior = originalBehavior;
    }
  }
  // Read the whole visible conversation of a loaded history session: every
  // user message and every assistant answer in document order. User bubbles
  // have no stable class, so content is classified structurally: subtrees
  // containing an answer block are walked further, leaf subtrees without one
  // are user text; page furniture lines (action labels, thinking headers,
  // clocks) are dropped.
  function conversation(list = findMessageList()) {
    const marks = [...document.querySelectorAll(".ds-markdown")];
    const virtualItems = visibleItems(list);
    if (!marks.length && !virtualItems) return {...reply(list),messages:[]};
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
    if (virtualItems) {
      // Offscreen messages are unmounted. Read keyed message rows, never the
      // page title, composer or auxiliary rendering trees.
      for (const row of keyedRows(virtualItems)) {
        const webKey = row.getAttribute(rowKey);
        const blocks = answerBlocks(row);
        const start = messages.length;
        if (blocks.length) for (const block of blocks) pushAssistant(block);
        else pushUser(row,true);
        for (let i = start; i < messages.length; i++) messages[i].webKey = `${webKey}:${i - start}`;
      }
      return {...reply(list),messages,truncated,virtual:true};
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
    const list = findMessageList();
    if (!list) return conversation();
    const records = new Map(), deadline = Date.now() + 25000, sourceURL = document.location.href;
    const originalTop = list.scrollTop, originalBehavior = list.style.scrollBehavior;
    let truncated = false, completed = false;
    list.style.scrollBehavior = 'auto';
    try {
      let requestedTop = messageWindow(list)?.firstTop ?? 0;
      while (Date.now() < deadline) {
        list.scrollTop = requestedTop;
        let snapshot, viewport, signature = '', stable = 0;
        const windowDeadline = Math.min(deadline,Date.now() + 2000);
        while (Date.now() < windowDeadline) {
          await waitForRender();
          if (!list.isConnected || document.location.href !== sourceURL) throw Error('读取期间网页会话已改变，请重新选择。');
          const bounds = messageWindow(list);
          if (bounds) {
            const target = Math.max(bounds.firstTop,Math.min(requestedTop,bounds.bottom));
            if (Math.abs(bounds.top - target) > 2) {
              list.scrollTop = target;
              signature = ''; stable = 0; continue;
            }
          }
          const mounted = mountedWindow(list,bounds);
          if (!mounted) {signature = ''; stable = 0; continue;}
          const candidate = conversation(list);
          if (!candidate.loggedIn || candidate.generating || !candidate.messages.length) {signature = ''; stable = 0; continue;}
          const next = JSON.stringify(candidate.messages);
          stable = next === signature ? stable + 1 : 1; signature = next;
          if (stable >= 3) {snapshot = candidate; viewport = mounted; break;}
        }
        if (!snapshot) throw Error('历史消息仍在加载或生成，请稍后重新选择会话。');
        for (const message of snapshot.messages) records.set(message.webKey,message);
        truncated ||= snapshot.truncated;
        const {top,bottom,height,end} = viewport;
        if (top >= bottom - 2) {completed = true; break;}
        // Mounted long answers already have their complete DOM. Advance past
        // most of the covered area, keeping overlap with the next viewport.
        requestedTop = Math.min(bottom,Math.floor(end - height * .2));
        if (requestedTop <= top) throw Error('无法继续读取网页历史，请在网页确认后重试。');
      }
      if (!completed) throw Error('会话较长，尚未完整读取，请在网页确认加载后重试。');
      const messages = [...records.values()].map(({webKey,...message}) => message);
      return {...reply(list),messages,truncated};
    } finally {
      // Follow-up sends need the latest answer as their baseline. Failed
      // reads restore the original webpage position instead.
      if (!completed && list.isConnected && document.location.href === sourceURL) list.scrollTop = originalTop;
      list.style.scrollBehavior = originalBehavior;
    }
  }
  return {reply,followReply,sendBaseline,conversation,history};
}

// In-process wrapper; the webview path serializes the builder instead.
export function inspectDeepSeekReply() {
  return inspectDeepSeekReplyBuilder().reply();
}

export function createDeepSeekWeb({webview,onStatus = () => {},interval = 900,historyPause = ms => new Promise(resolve => setTimeout(resolve,ms)),historyAttempts = 40}) {
  let disposed = false, active = false, polling = false, paused = false, suspended = false, switching = false, historyFailed = false, epoch = 0;
  let followingURL = null;
  const listeners = new Set();
  const lifecycle = createWebviewLifecycle(webview,state => onStatus(state));
  const reader = `(${inspectDeepSeekReplyBuilder.toString()})()`;
  const replyScript = `${reader}.reply()`;
  const conversationScript = `${reader}.conversation()`;
  const historyScript = `${reader}.history()`;
  const read = url => executeWebScript(webview,url === followingURL
    ? `${reader}.followReply(${JSON.stringify(url)},(${conversationAt.toString()}))` : replyScript,false,2200);
  const pageURL = () => {try {return webview.getURL();} catch (_) {return "";}};
  const currentURL = () => getConversationURL(pageURL());
  const pageChanged = () => Error("DeepSeek 网页会话已切换，请从「历史」重新选择后再发送。");
  async function poll() {
    if (disposed || !active || polling || paused || suspended || switching || historyFailed) return;
    const address = pageURL();
    if (!address) return;
    const url = getConversationURL(address);
    polling = true;
    const started = epoch;
    try {
      const reply = url ? await read(url) : {url:null};
      if (disposed || !active || paused || suspended || switching || epoch !== started || currentURL() !== url) return;
      if (url && getConversationURL(reply?.url) !== url) return;
      for (const listener of listeners) listener({...reply,url});
    }
    catch (_) {} finally {polling = false;}
  }
  const timer = setInterval(poll,interval);
  return {
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    setActive(value,follow = null) {active = !!value; followingURL = follow; if (active) void poll();},
    setPaused(value) {paused = !!value; if (!paused) void poll();},
    setSuspended(value) {suspended = !!value; if (!suspended) void poll();},
    async send(prompt,conversationURL) {
      if (switching) throw Error("正在打开历史问答，请稍候。");
      if (historyFailed) throw Error("历史会话切换未完成，请重新选择会话后再发送。");
      const target = validateHistoryURL(conversationURL || DEEPSEEK_HOME,{allowNew:true});
      const started = epoch;
      await lifecycle.ensureReady();
      const address = pageURL();
      const openURL = getConversationURL(address);
      if (openURL !== target) {
        if (!openURL && address && new URL(address).origin === new URL(DEEPSEEK_HOME).origin) {
          throw Object.assign(Error("请先在 DeepSeek 网页登录并回到聊天页面。"),{code:"LOGIN_REQUIRED"});
        }
        throw pageChanged();
      }
      const baselineScript = `${reader}.sendBaseline(${JSON.stringify(target)},(${conversationAt.toString()}))`;
      const baseline = await executeWebScript(webview,baselineScript,false,3500);
      if (disposed || started !== epoch || currentURL() !== target || getConversationURL(baseline?.url) !== target) throw pageChanged();
      if (baseline.generating) throw Error("DeepSeek 还在回答上一条问题，请等回答结束后发送。");
      if (baseline.atEnd === false) throw Error("请在 DeepSeek 网页滚到会话底部，等待最新消息加载后再发送。");
      const args = [target,prompt,Date.now() + 6000].map(value => JSON.stringify(value)).join(",");
      const script = `(${sendWebQuestion.toString()})(${args},(${conversationAt.toString()}),(${fillWebComposer.toString()}),(${submitWebComposer.toString()}))`;
      const result = await executeWebScript(webview,script,true,7000);
      if (!result?.ok) {
        const error = Error(result?.reason || "网页未确认发送，请先查看网页状态。");
        if (/登录/.test(error.message)) error.code = "LOGIN_REQUIRED";
        throw error;
      }
      const url = getConversationURL(result.url);
      if (disposed || started !== epoch || !url || (url !== target && target !== DEEPSEEK_HOME)) throw Error("网页已点击发送，但无法确认会话。请先查看网页状态。");
      paused = false;
      return {baseline:url === target ? baseline : null,url};
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
      if (switching) throw Error("正在切换会话，请稍候。");
      const previous = currentURL();
      switching = true; epoch++;
      try {
        if (url !== previous) webview.setAttribute("src",url);
        else if (url === DEEPSEEK_HOME) webview.reload?.();
        const deadline = Date.now() + 12000;
        let signature = "", stableReads = 0;
        for (let attempt = 0; attempt < historyAttempts && !disposed && Date.now() < deadline; attempt++) {
          await historyPause(150);
          if (currentURL() !== url) {signature = ""; stableReads = 0; continue;}
          let reply;
          try {
            if (!await lifecycle.probe()) {signature = ""; stableReads = 0; continue;}
            reply = await executeWebScript(webview,conversationScript,false,4000);
          } catch (_) {signature = ""; stableReads = 0; continue;}
          const hasMessages = !!(reply?.text || reply?.messages?.length);
          const ready = reply?.loggedIn && !reply.generating && getConversationURL(reply.url) === url && hasMessages === (url !== DEEPSEEK_HOME);
          if (!ready) {signature = ""; stableReads = 0; continue;}
          const current = JSON.stringify([reply.count,reply.messages,reply.text,reply.generating]);
          stableReads = current === signature ? stableReads + 1 : 1; signature = current;
          // Retry only readiness probes. A full scan failure must propagate;
          // silently retrying it can restart long scans or hide route changes.
          if (stableReads >= 3) {
            const result = reply.virtual ? await executeWebScript(webview,historyScript,false,30000) : reply;
            if (disposed || currentURL() !== url || getConversationURL(result?.url) !== url) throw Error('读取期间网页会话已改变，请重新选择。');
            historyFailed = false; return {...result,url};
          }
        }
        throw Error("历史会话尚未加载完成，请在“网页”中确认后重试。");
      } catch (error) {
        historyFailed = true;
        if (!disposed && previous !== url) webview.setAttribute("src",previous || DEEPSEEK_HOME);
        const message = error?.message;
        const prefix = /^Error invoking remote method ['"]GUEST_VIEW_MANAGER_CALL['"]:\s*(?:Error:\s*)?/;
        if (prefix.test(message)) throw Error(message.replace(prefix,""),{cause:error});
        throw error;
      }
      finally {switching = false;}
    },
    navigate(value) {
      const url = validateHistoryURL(value,{allowNew:true});
      epoch++; historyFailed = false;
      if (url !== currentURL()) webview.setAttribute("src",url);
    },
    reload() {epoch++; webview.reload();},
    dispose() {disposed = true; active = false; clearInterval(timer); lifecycle.dispose(); listeners.clear();}
  };
}
