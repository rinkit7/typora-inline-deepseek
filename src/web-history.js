// Runs in the existing logged-in webview. Only read same-origin conversation
// links; no token extraction, private API requests or local history files.
export function inspectWebHistory(now = Date.now()) {
  const seen = new Set(), items = [];
  const format = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  function dateValue(value) {
    if (value == null || String(value).trim() === "") return "";
    const text = String(value).trim();
    let date;
    if (/^\d{10,13}(?:\.\d+)?$/.test(text)) {const number = Number(text); date = new Date(number < 1e11 ? number * 1000 : number);}
    else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s].*)?$/.test(text)) {
      const parts = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/).slice(1).map(Number);
      const check = new Date(parts[0],parts[1] - 1,parts[2]);
      if (check.getFullYear() !== parts[0] || check.getMonth() + 1 !== parts[1] || check.getDate() !== parts[2]) return "";
      date = text.length <= 10 ? check : new Date(text);
    } else return "";
    return Number.isFinite(date.getTime()) && date.getFullYear() >= 2000 && date.getFullYear() <= 2100 ? format(date) : "";
  }
  function groupDate(text) {
    const value = text.trim();
    if (/^(今天|今日|today)$/i.test(value)) return format(new Date(now));
    if (/^(昨天|昨日|yesterday)$/i.test(value)) {const date = new Date(now); date.setDate(date.getDate() - 1); return format(date);}
    const exact = dateValue(value); if (exact) return exact;
    if (/^(?:过去|最近|近)\s*(?:7|七|30|三十)\s*天$|^previous\s+(?:7|30)\s+days$|^last\s+(?:7|30)\s+days$/i.test(value)) return `${value}（网页分组）`;
    return "";
  }
  function itemDate(link,id) {
    // Prefer explicit per-item timestamps. Never infer a date from the title,
    // UUID, record order or the current time when the source has no date.
    for (let node = link, depth = 0; node && depth < 4; node = node.parentElement,depth++) {
      if (node !== link && node.querySelectorAll('a[href*="/a/chat/s/"]').length !== 1) break;
      for (const attribute of ["data-updated-at","data-update-time","data-created-at","data-create-time","data-timestamp","datetime"]) {
        const value = dateValue(node.getAttribute(attribute)); if (value) return value;
      }
      const time = node.querySelector("time[datetime]");
      const explicit = dateValue(time?.getAttribute("datetime")); if (explicit) return explicit;
      // Some webpage builds keep timestamps in a row component's props rather
      // than HTML. Read only matching conversation records and date fields.
      for (const key of Object.keys(node).filter(key => key.startsWith("__reactProps$") || key.startsWith("__reactFiber$"))) {
        for (let owner = node[key], level = 0; owner && level < 6; owner = owner.return,level++) {
          const props = owner.memoizedProps || owner;
          for (const record of [props,props?.session,props?.chatSession,props?.chat_session,props?.conversation,props?.item,props?.data]) {
            if (!record || String(record.id || record.chat_session_id || "") !== id) continue;
            for (const field of ["updated_at","updatedAt","update_time","created_at","createdAt","create_time"]) {
              const value = dateValue(record[field]); if (value) return value;
            }
          }
        }
      }
    }
    for (let node = link, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement,depth++) {
      let previous = node.previousElementSibling;
      for (let i = 0; previous && i < 200; i++,previous = previous.previousElementSibling) {
        if (previous.matches('a[href]') || previous.querySelector('a[href]')) continue;
        const text = previous.textContent.trim();
        if (text.length <= 40) {const value = groupDate(text); if (value) return value;}
      }
    }
    return "日期未知";
  }
  for (const link of document.querySelectorAll('a[href]')) {
    let url; try {url = new URL(link.getAttribute("href"),"https://chat.deepseek.com/");} catch (_) {continue;}
    if (url.origin !== "https://chat.deepseek.com" || !/^\/a\/chat\/s\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) continue;
    if (link.closest(".ds-markdown") || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const title = (link.getAttribute("title") || link.textContent || "历史问答").replace(/\s+/g," ").trim().slice(0,200);
    items.push({id:url.pathname,url:url.origin + url.pathname,title:title || "历史问答",dateLabel:itemDate(link,url.pathname.split("/").filter(Boolean).at(-1))});
  }
  return {items,loggedIn:!!document.querySelector("textarea")};
}

export function validateHistoryURL(value,{allowNew = false} = {}) {
  const url = new URL(value,"https://chat.deepseek.com/");
  if (url.origin !== "https://chat.deepseek.com" || !(allowNew && url.pathname === "/") && !/^\/a\/chat\/s\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) throw Error("历史会话地址无效。");
  return url.origin + url.pathname;
}
