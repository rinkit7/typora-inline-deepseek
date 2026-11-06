import { DATA_DIRECTORY } from "./runtime-paths.js";
import {normalizeQuickAsks,validateQuickAsks} from "./quick-asks.js";

export function normalizeOpacity(value) {
  if (!["number","string"].includes(typeof value) || String(value).trim() === "") return 100;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(40,Math.min(100,Math.round(number))) : 100;
}

export function normalizeReaderOpacity(value) {
  if (!["number","string"].includes(typeof value) || String(value).trim() === "") return 80;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(20,Math.min(100,Math.round(number))) : 80;
}

export function normalizeReaderWidth(value) {
  if (!["number","string"].includes(typeof value) || String(value).trim() === "") return 440;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(300,Math.min(640,Math.round(number))) : 440;
}

export function normalizeReaderHeight(value) {
  if (!["number","string"].includes(typeof value) || String(value).trim() === "") return 640;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(320,Math.min(12000,Math.round(number))) : 640;
}

export function normalizeReaderFont(value) {
  if (!["number","string"].includes(typeof value) || String(value).trim() === "") return 16;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(14,Math.min(22,Math.round(number))) : 16;
}

// The detached window remembers where the user kept it. Values outside any
// screen (the -32000 phantom rect of a minimized window) are rejected so a
// minimized close never poisons the saved position.
export function normalizeDetachedGeometry(value) {
  const box = value && typeof value === "object" ? value : {};
  const numbers = [box.x,box.y,box.width,box.height].map(entry => Number(entry));
  if (numbers.some(entry => !Number.isFinite(entry))) return null;
  const [x,y,width,height] = numbers.map(entry => Math.round(entry));
  if (x < -10000 || y < -10000 || x > 20000 || y > 20000) return null;
  if (width < 240 || height < 240 || width > 12000 || height > 12000) return null;
  return {x,y,width,height};
}

export function createAppearanceStore(runtime) {
  const filename = `${DATA_DIRECTORY}/preferences.json`;
  const read = () => {
    try { return JSON.parse(runtime.reqnode("fs").readFileSync(filename,"utf8")) || {}; }
    catch (_) { return {}; }
  };
  function save(key,value) {
      try {
        const settings = {...read(),[key]:value};
        const fs = runtime.reqnode("fs");
        fs.mkdirSync(DATA_DIRECTORY,{recursive:true});
        fs.writeFileSync(filename,JSON.stringify(settings,null,2),"utf8");
        return true;
      } catch (_) { return false; }
  }
  return {
    loadLauncherVisible:() => read().launcherVisible !== false,
    saveLauncherVisible:value => save("launcherVisible",value !== false),
    loadQuickAsks:() => normalizeQuickAsks(read().quickAsks),
    saveQuickAsks:value => save("quickAsks",validateQuickAsks(value)),
    loadOpacity:() => normalizeOpacity(read().opacity),
    saveOpacity:value => save("opacity",normalizeOpacity(value)),
    loadReaderOpacity:() => normalizeReaderOpacity(read().readerOpacity),
    saveReaderOpacity:value => save("readerOpacity",normalizeReaderOpacity(value)),
    loadReaderWidth:() => normalizeReaderWidth(read().readerWidth),
    saveReaderWidth:value => save("readerWidth",normalizeReaderWidth(value)),
    loadReaderHeight:() => normalizeReaderHeight(read().readerHeight),
    saveReaderHeight:value => save("readerHeight",normalizeReaderHeight(value)),
    loadReaderFont:() => normalizeReaderFont(read().readerFont),
    saveReaderFont:value => save("readerFont",normalizeReaderFont(value)),
    loadPinned:() => read().pinned === true,
    savePinned:value => save("pinned",value === true),
    loadDetachedGeometry:() => normalizeDetachedGeometry(read().detachedGeometry),
    saveDetachedGeometry:value => save("detachedGeometry",normalizeDetachedGeometry(value))
  };
}
