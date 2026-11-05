import {JSDOM} from "jsdom";
export function browserEnvironment(html = "<body></body>") {
  const dom = new JSDOM(`<!doctype html>${html}`,{url:"https://typora.local/",pretendToBeVisual:true});
  const previous = new Map(), win = dom.window;
  const globals = {window:win,document:win.document,navigator:win.navigator,innerWidth:1280,innerHeight:960,MessageChannel:undefined,
    requestAnimationFrame:win.requestAnimationFrame.bind(win),cancelAnimationFrame:win.cancelAnimationFrame.bind(win),getComputedStyle:win.getComputedStyle.bind(win),
    ResizeObserver:class {observe() {} unobserve() {} disconnect() {}},IntersectionObserver:class {observe() {} unobserve() {} disconnect() {}},fetch:() => {throw Error("Unexpected UI network request");}};
  for (const key of ["HTMLElement","Element","Node","ShadowRoot","MutationObserver","CustomEvent","DOMParser","XMLSerializer","Document","HTMLTextAreaElement","HTMLInputElement","HTMLFormElement","HTMLButtonElement","Event","EventTarget","KeyboardEvent","MouseEvent","Selection","Range","File","FileReader"]) globals[key] = win[key];
  for (const [key,value] of Object.entries(globals)) {previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
  win.matchMedia = () => ({matches:false,addListener() {},removeListener() {},addEventListener() {},removeEventListener() {}});
  win.HTMLElement.prototype.scrollTo = function(options) {this.scrollTop = options?.top || 0;};
  win.HTMLElement.prototype.scrollIntoView = function() {};
  return {window:win,document:win.document,dispose() {win.close(); for (const [key,descriptor] of previous) {if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];}}};
}
