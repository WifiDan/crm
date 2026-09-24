export const BRIDGE_MARKER = "data-leadgen-bridge";

export const BRIDGE_BODY = `(function () {
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;
  function send(message) {
    message.leadgen = 1;
    try { parentWindow.postMessage(message, "*"); } catch (e) {}
  }
  function serialize() {
    var root = document.documentElement.cloneNode(true);
    var marked = root.querySelectorAll("script[${BRIDGE_MARKER}]");
    for (var i = 0; i < marked.length; i++) marked[i].parentNode.removeChild(marked[i]);
    return "<!doctype html>\\n" + root.outerHTML;
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || data.leadgen !== 1 || typeof data.type !== "string") return;
    if (data.type === "edit") {
      document.designMode = data.on ? "on" : "off";
      send({ type: "edit-state", on: document.designMode === "on" });
    } else if (data.type === "get-html") {
      document.designMode = "off";
      send({ type: "html", nonce: String(data.nonce), html: serialize() });
    }
  });
  send({ type: "ready" });
})();`;

export const BRIDGE_SCRIPT = `<script ${BRIDGE_MARKER}>${BRIDGE_BODY}</script>`;

const BRIDGE_BLOCK = new RegExp(
	`<script ${BRIDGE_MARKER}>[\\s\\S]*?</script>`,
	"g",
);

export function injectBridge(html: string): string {
	const withoutOld = stripBridge(html);
	const head = /<head(\s[^>]*)?>/i.exec(withoutOld);
	if (head) {
		const at = head.index + head[0].length;
		return withoutOld.slice(0, at) + BRIDGE_SCRIPT + withoutOld.slice(at);
	}
	const root = /<html(\s[^>]*)?>/i.exec(withoutOld);
	if (root) {
		const at = root.index + root[0].length;
		return withoutOld.slice(0, at) + BRIDGE_SCRIPT + withoutOld.slice(at);
	}
	return BRIDGE_SCRIPT + withoutOld;
}

export function stripBridge(html: string): string {
	return html.replace(BRIDGE_BLOCK, "");
}
