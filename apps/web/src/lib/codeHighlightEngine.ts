/** highlight.js with the common language set, plus the two shells and file
 * types enterprise chats ask for most that the set leaves out. Loaded on
 * demand by codeHighlight.ts so it never weighs on the first page load. */
import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import powershell from "highlight.js/lib/languages/powershell";

hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("powershell", powershell);
// Fence tags highlight.js has no alias for, mapped to the closest grammar.
hljs.registerAliases(["vue", "svelte", "astro"], { languageName: "xml" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });
hljs.registerAliases(["env", "dotenv"], { languageName: "ini" });
hljs.registerAliases(["pwsh", "ps"], { languageName: "powershell" });

export default hljs;
