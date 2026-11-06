// Runs in the existing logged-in webview. Only read same-origin conversation
// links; no token extraction, private API requests or local history files.
export function inspectWebHistory() {
  const seen = new Set(), items = [];
  for (const link of document.querySelectorAll('a[href]')) {
    let url; try {url = new URL(link.getAttribute("href"),"https://chat.deepseek.com/");} catch (_) {continue;}
    if (url.origin !== "https://chat.deepseek.com" || !/^\/a\/chat\/s\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) continue;
    if (link.closest(".ds-markdown") || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const title = (link.getAttribute("title") || link.textContent || "历史问答").replace(/\s+/g," ").trim().slice(0,200);
    items.push({id:url.pathname,url:url.origin + url.pathname,title:title || "历史问答"});
  }
  return {items,loggedIn:!!document.querySelector("textarea")};
}

export function validateHistoryURL(value,{allowNew = false} = {}) {
  const url = new URL(value,"https://chat.deepseek.com/");
  if (url.origin !== "https://chat.deepseek.com" || !(allowNew && url.pathname === "/") && !/^\/a\/chat\/s\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) throw Error("历史会话地址无效。");
  return url.origin + url.pathname;
}
