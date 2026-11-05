// Keep transient bridge files with this plugin, rather than in a developer's
// workspace. Electron's persistent web partition remains unchanged for login.
export const PLUGIN_DIRECTORY = decodeURIComponent(new URL("../",import.meta.url).pathname).replace(/^\/(?=[a-z]:)/i,"").replace(/\/$/,"");
export const DATA_DIRECTORY = `${PLUGIN_DIRECTORY}/data`;
export function writeDiagnostic(runtime, filename, state) {
  try {
    const fs = runtime.reqnode("fs");
    fs.mkdirSync(DATA_DIRECTORY,{recursive:true});
    fs.writeFileSync(`${DATA_DIRECTORY}/${filename}`,JSON.stringify(state,null,2),"utf8");
  } catch (_) {}
}
