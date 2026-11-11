const HOST = "data-deepseek-dock-host";
const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
const BOTTOM_SHARE = .55;
const MIN_DOCK_WIDTH = 300;
const MIN_READING_WIDTH = 600;
const SNAP_WIDTH_TOLERANCE = 12;
export const MIN_DOCK_HEIGHT = 180;

function visibleArea(rect,viewportWidth,viewportHeight) {
  const left = Math.max(0,rect.left), top = Math.max(0,rect.top);
  const right = Math.min(viewportWidth,rect.right), bottom = Math.min(viewportHeight,rect.bottom);
  const width = right - left, height = bottom - top;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_DOCK_WIDTH ||
    Math.floor(height * BOTTOM_SHARE) < MIN_DOCK_HEIGHT) return null;
  return {left,top,right,bottom,width,height};
}

export function createReadingDock(view,runtime) {
  let style = null, hosts = [], area = null, position = null;

  function clear() {
    for (const {element} of hosts) element.removeAttribute(HOST);
    hosts = [];
    area = position = null;
    style?.remove();
    style = null;
  }

  function measure(mode) {
    // Chromium can keep CSSOM declarations when style.textContent is assigned
    // the same string. Remove the old sheet before reading editor dimensions.
    clear();
    if (mode === "floating") return;
    const content = view.getElementById("write")?.closest("content") || view.querySelector("content");
    const workspace = view.querySelector(".typ-workspace-root");
    const source = view.getElementById("typora-source");
    const boundContent = content?.classList.contains("typ-workspace-binding");
    const usesWorkspace = workspace && (!content || boundContent || workspace.contains(content));
    const editors = (usesWorkspace ? [workspace,content] : [content,workspace]).filter(Boolean);
    // The source editor can be fixed to the window even when nested inside
    // the writing area. Give it the same boundary as the rendered editor.
    if (source && runtime.getComputedStyle(source).position === "fixed") editors.push(source);
    if (!editors.length) return;
    style = view.createElement("style");
    const rules = editors.map((_,index) => `[${HOST}="${index}"] { box-sizing: border-box !important; }`);
    style.textContent = `[${HOST}] { transition: none !important; }\n${rules.join("\n")}`;
    view.head.appendChild(style);
    if (!style.sheet) {clear(); return;}
    hosts = editors.map((element,index) => {
      element.setAttribute(HOST,String(index));
      return {element,index};
    });
    hosts = hosts.map(host => ({...host,rect:host.element.getBoundingClientRect()}));
    const width = Math.min(runtime.innerWidth,view.documentElement.clientWidth || runtime.innerWidth);
    const height = Math.min(runtime.innerHeight,view.documentElement.clientHeight || runtime.innerHeight);
    // A workspace wrapper can temporarily have only a tab bar, or extend
    // outside the viewport. Size the panel from a usable, visible editor box.
    const editor = hosts.map(host => ({...host,visible:visibleArea(host.rect,width,height)}))
      .find(host => host.element !== source && host.visible);
    if (!editor) {clear(); return;}
    area = editor.visible;
    if (editor.element === workspace && boundContent) {
      // The framework moves and resizes this editor with its active tab.
      // Constrain the workspace once, so tab changes cannot retain stale caps.
      content.removeAttribute(HOST);
      hosts = hosts.filter(host => host.element !== content);
    }
    const screenWidth = runtime.screen?.availWidth || runtime.screen?.width || 0;
    const windowWidth = runtime.outerWidth || runtime.innerWidth;
    // Windows can report a snapped window a few pixels wider than half the screen.
    const halfScreen = screenWidth > 0 && windowWidth <= Math.ceil(screenWidth / 2) + SNAP_WIDTH_TOLERANCE;
    const fitsSideBySide = area.width >= MIN_READING_WIDTH + MIN_DOCK_WIDTH;
    position = mode === "bottom" || halfScreen || !fitsSideBySide ? "bottom" : "right";
  }

  function range() {
    if (!area) return null;
    if (position === "right") return {min:MIN_DOCK_WIDTH,max:Math.min(640,area.width - MIN_READING_WIDTH)};
    const max = Math.floor(area.height * BOTTOM_SHARE);
    return {min:Math.min(220,max),max};
  }

  function place(preferred) {
    const limits = range();
    const size = clamp(Math.round(preferred ?? area.height * .46),limits.min,limits.max);
    const right = position === "right";
    const boundary = right ? area.right - size : area.bottom - size;
    const property = right ? "max-width" : "max-height";
    for (const {rect,index} of hosts) {
      const edge = right ? rect.right : rect.bottom;
      const start = right ? rect.left : rect.top;
      const rule = style.sheet.cssRules[index + 1].style;
      if (edge > boundary && start < boundary) {
        const size = `${boundary - start}px`;
        if (rule.getPropertyValue(property) !== size) rule.setProperty(property,size,"important");
      } else rule.removeProperty(property);
    }
    return right
      ? {left:boundary,top:area.top,width:size,height:area.height}
      : {left:area.left,top:boundary,width:area.width,height:size};
  }

  return {measure,clear,range,place,get position() {return position;}};
}
