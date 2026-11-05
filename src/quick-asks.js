export const MAX_QUICK_ASKS = 20;
export const MAX_QUICK_ASK_LABEL = 24;
export const MAX_QUICK_ASK_PROMPT = 4000;
export const DEFAULT_QUICK_ASKS = Object.freeze(["解释这段内容","总结要点","翻译成英文","润色这段文字","续写这段文字"].map(text => Object.freeze({label:text,prompt:text})));
const defaults = () => DEFAULT_QUICK_ASKS.map(item => ({...item}));

export function normalizeQuickAsks(value) {
  if (!Array.isArray(value)) return defaults();
  const result = [], labels = new Set();
  for (const raw of value.slice(0,MAX_QUICK_ASKS)) {
    const item = typeof raw === "string" ? {label:raw,prompt:raw} : raw;
    if (typeof item?.label !== "string" || typeof item?.prompt !== "string") continue;
    const label = item.label.trim().slice(0,MAX_QUICK_ASK_LABEL), prompt = item.prompt.trim().slice(0,MAX_QUICK_ASK_PROMPT);
    if (!label || !prompt || labels.has(label)) continue;
    labels.add(label); result.push({label,prompt});
  }
  return value.length && !result.length ? defaults() : result;
}

export function validateQuickAsks(value) {
  if (!Array.isArray(value) || value.length > MAX_QUICK_ASKS) throw Error(`最多保存 ${MAX_QUICK_ASKS} 个快捷提问。`);
  const labels = new Set();
  return value.map((item,index) => {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    const prompt = typeof item?.prompt === "string" ? item.prompt.trim() : "";
    if (!label || !prompt) throw Error(`第 ${index + 1} 个快捷提问需要填写按钮名称和提问内容。`);
    if (label.length > MAX_QUICK_ASK_LABEL || prompt.length > MAX_QUICK_ASK_PROMPT) throw Error(`第 ${index + 1} 个快捷提问过长：名称最多 ${MAX_QUICK_ASK_LABEL} 字，内容最多 ${MAX_QUICK_ASK_PROMPT} 字。`);
    if (labels.has(label)) throw Error(`按钮名称“${label}”重复，请使用不同名称。`);
    labels.add(label); return {label,prompt};
  });
}
