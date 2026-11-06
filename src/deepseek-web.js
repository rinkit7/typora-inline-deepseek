import {createWebviewLifecycle,executeWebScript,fillWebComposer,submitWebComposer} from "./web-provider.js";

// Runs inside the isolated webpage. All output is inert Markdown text.
export function inspectDeepSeekReply() {
  const nodes = [...document.querySelectorAll(".ds-markdown")], last = nodes.at(-1);
  let budget = 200000;
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
  return {count:nodes.length,text:last ? markdown(last).trim().slice(0,200000) : "",generating,loggedIn:!!textarea};
}

export function createDeepSeekWeb({webview,onStatus = () => {},interval = 900}) {
  let disposed = false, active = false, polling = false, paused = false, suspended = false;
  const listeners = new Set();
  const lifecycle = createWebviewLifecycle(webview,state => onStatus(state));
  const read = () => executeWebScript(webview,`(${inspectDeepSeekReply.toString()})()`,false,2200);
  async function poll() {
    if (disposed || !active || polling || paused || suspended) return;
    try {if (new URL(webview.getURL()).origin !== "https://chat.deepseek.com") return;} catch (_) {return;}
    polling = true;
    try {const reply = await read(); if (!disposed && active && !suspended) for (const listener of listeners) listener(reply);}
    catch (_) {} finally {polling = false;}
  }
  const timer = setInterval(poll,interval);
  return {
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    setActive(value) {active = !!value; if (active) void poll();},
    setPaused(value) {paused = !!value; if (!paused) void poll();},
    setSuspended(value) {suspended = !!value; if (!suspended) void poll();},
    async send(prompt) {
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
    getURL() {try {const url = new URL(webview.getURL()); return url.origin === "https://chat.deepseek.com" ? url.href : "https://chat.deepseek.com/";} catch (_) {return "https://chat.deepseek.com/";}},
    navigate(url) {if (new URL(url).origin === "https://chat.deepseek.com" && url !== this.getURL()) webview.setAttribute("src",url);},
    reload() {webview.reload();},
    dispose() {disposed = true; active = false; clearInterval(timer); lifecycle.dispose(); listeners.clear();}
  };
}
