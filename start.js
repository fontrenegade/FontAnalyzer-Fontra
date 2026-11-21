// Font Analyzer – Free, for Fontra.
//
// A sidebar panel that sends the open font to Font Analyzer
// (https://fontanalyzer.app) and lets you know when the analysis is ready.
// No account, no settings. The Fontra counterpart of the Glyphs palette
// "Font Analyzer – Free".
//
// Fontra runs in the browser and can't export OTF/TTF there, so the panel
// sends the font's source data: the same JSON Fontra's server gives the editor
// (glyphs, axes, sources, font info, features, kerning), gzipped. The server
// compiles it with fontmake, as Fontra Pak's File > Export As does, and
// analyses the result.
//
// Fontra calls start(editorController, pluginPath) once per editor window
// (plugin.json). The panel is plain DOM: a plug-in can't import Fontra's own
// modules, they are bundled.

const PLUGIN_VERSION = "0.1.0";
const DEFAULT_SERVER = "https://fontanalyzer.app";
// For development only: localStorage["fontanalyzer.server"] = "http://127.0.0.1:8001"
const SERVER_STORAGE_KEY = "fontanalyzer.server";
const PREFS_KEY = "fontanalyzer.free.prefs";
const PANEL_IDENTIFIER = "font-analyzer-free";
const PANEL_TITLE = "Font Analyzer – Free";
const POLL_MS = 4000;
const POLL_GIVE_UP_MS = 60 * 60 * 1000;
const GLYPH_READERS = 8; // parallel getGlyph calls to Fontra's server
const PAYLOAD_FORMAT_VERSION = 1;

const FORMATS = [
  { label: "Static OTF", value: "otf" },
  { label: "Static TTF", value: "ttf" },
  { label: "Variable TTF", value: "variable" },
];

export function start(editorController, pluginPath) {
  if (!customElements.get("font-analyzer-free-panel")) {
    customElements.define("font-analyzer-free-panel", FontAnalyzerPanel);
  }
  const panel = new FontAnalyzerPanel();
  panel.setup(editorController, pluginPath);
  editorController.addSidebarPanel(panel, "right");
  // The tab tooltip is looked up as "sidebar.<identifier>" in Fontra's
  // translations, which don't know this panel.
  const tab = document.querySelector(`.sidebar-tab[data-sidebar-name="${PANEL_IDENTIFIER}"]`);
  tab?.setAttribute("data-tooltip", PANEL_TITLE);
}

function serverAddress() {
  let server = DEFAULT_SERVER;
  try {
    server = localStorage.getItem(SERVER_STORAGE_KEY) || DEFAULT_SERVER;
  } catch (e) {
    // storage blocked: use the default
  }
  return server.replace(/\/+$/, "");
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    // not important
  }
}

class FAError extends Error {}

async function requestJSON(url, options = {}) {
  // No custom headers and no credentials: these stay "simple" CORS requests,
  // so the browser sends no preflight.
  let response;
  try {
    response = await fetch(url, { ...options, credentials: "omit" });
  } catch (e) {
    throw new FAError("Font Analyzer can't be reached. Check your connection.");
  }
  let data = {};
  try {
    data = await response.json();
  } catch (e) {
    // empty or not JSON
  }
  if (!response.ok) {
    throw new FAError(data.error || `The server answered ${response.status}.`);
  }
  return data;
}

// --- Reading the font from Fontra -------------------------------------------

async function optionalCall(promiseFactory, fallback) {
  // Methods that older Fontra servers don't have yet.
  try {
    const value = await promiseFactory();
    return value ?? fallback;
  } catch (e) {
    return fallback;
  }
}

async function collectFontSource(fontController, onProgress) {
  // fontController.font is the proxy to Fontra's server; its methods return
  // the wire format (unstructured fontra.core.classes), which the Font
  // Analyzer server structures back into Fontra's classes.
  const font = fontController.font;
  const [glyphMap, axes, sources, fontInfo, unitsPerEm, features, kerning, customData] =
    await Promise.all([
      font.getGlyphMap(),
      font.getAxes(),
      font.getSources(),
      font.getFontInfo(),
      font.getUnitsPerEm(),
      font.getFeatures(),
      font.getKerning(),
      font.getCustomData(),
    ]);
  const glyphInfos = await optionalCall(() => font.getGlyphInfos(), {});
  const conditionalSubstitutions = await optionalCall(
    () => font.getConditionalSubstitutions(),
    null
  );

  const glyphNames = Object.keys(glyphMap);
  const glyphs = {};
  let next = 0;
  let done = 0;
  async function reader() {
    while (next < glyphNames.length) {
      const glyphName = glyphNames[next++];
      const glyph = await font.getGlyph(glyphName);
      if (glyph) {
        glyphs[glyphName] = glyph;
      }
      done++;
      if (done % 50 === 0 || done === glyphNames.length) {
        onProgress(done, glyphNames.length);
      }
    }
  }
  await Promise.all(Array.from({ length: GLYPH_READERS }, reader));

  const payload = {
    formatVersion: PAYLOAD_FORMAT_VERSION,
    generator: `fontanalyzer-fontra-free/${PLUGIN_VERSION}`,
    projectName: fontController.metaInfo?.projectName || "",
    unitsPerEm,
    fontInfo,
    axes,
    sources,
    glyphMap,
    glyphs,
    kerning,
    features,
    customData,
    glyphInfos,
  };
  if (conditionalSubstitutions) {
    payload.conditionalSubstitutions = conditionalSubstitutions;
  }
  return payload;
}

async function gzipJSON(value) {
  const stream = new Blob([JSON.stringify(value)], { type: "application/json" })
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

// --- The panel ------------------------------------------------------------------

const STYLES = `
  :host {
    display: block;
    height: 100%;
    box-sizing: border-box;
    color: var(--ui-element-foreground-color);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75em;
    padding: 1em;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: bold;
  }
  label {
    display: grid;
    gap: 0.3em;
  }
  .label-text {
    font-size: 0.9em;
    opacity: 0.75;
  }
  select,
  button {
    font: inherit;
    color: var(--ui-element-foreground-color);
    background-color: var(--text-input-background-color);
    border: 1px solid var(--horizontal-rule-color);
    border-radius: 0.4em;
    padding: 0.35em 0.5em;
  }
  button {
    cursor: pointer;
    background-color: var(--ui-element-background-color);
  }
  button:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.primary {
    font-weight: bold;
  }
  button.highlight {
    color: white;
    background-color: #2f6fe4;
    border-color: #2f6fe4;
  }
  .status {
    min-height: 2.6em;
    font-size: 0.9em;
    line-height: 1.3;
    opacity: 0.8;
    overflow-wrap: anywhere;
  }
  .status.error {
    color: var(--fontra-red-color);
    opacity: 1;
  }
  .footer {
    font-size: 0.8em;
    opacity: 0.6;
  }
  .footer a {
    color: inherit;
  }
  [hidden] {
    display: none !important;
  }
`;

class FontAnalyzerPanel extends HTMLElement {
  // Read by Fontra's sidebar
  identifier = PANEL_IDENTIFIER;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.templates = [];
    this.templatesState = "notLoaded"; // notLoaded, loading, loaded, failed
    this.analysisRun = 0; // bumped to stop polling an older analysis
    this.busy = false;
    this.resultsUrl = null;
    this.prefs = loadPrefs();
  }

  setup(editorController, pluginPath) {
    this.editorController = editorController;
    this.iconPath = `${pluginPath}/icon.svg`;
    this.render();
  }

  render() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="panel">
        <h2>${PANEL_TITLE}</h2>
        <label>
          <span class="label-text">Analysis</span>
          <select id="template" disabled><option>Loading…</option></select>
        </label>
        <label>
          <span class="label-text">Export as</span>
          <select id="format"></select>
        </label>
        <button id="send" class="primary">Send to Font Analyzer</button>
        <div id="status" class="status" role="status" aria-live="polite"></div>
        <button id="open" hidden>Open Results</button>
        <div class="footer">
          Compiled and checked on <a id="site" target="_blank" rel="noopener"></a>.
          Uploads are anonymous; only you get the results link.
        </div>
      </div>
    `;
    this.templateSelect = root.querySelector("#template");
    this.formatSelect = root.querySelector("#format");
    this.sendButton = root.querySelector("#send");
    this.statusElement = root.querySelector("#status");
    this.openButton = root.querySelector("#open");

    for (const { label, value } of FORMATS) {
      this.formatSelect.append(new Option(label, value));
    }
    if (FORMATS.some(({ value }) => value === this.prefs.format)) {
      this.formatSelect.value = this.prefs.format;
    }
    const site = root.querySelector("#site");
    site.href = serverAddress() + "/";
    site.textContent = new URL(serverAddress()).host;

    this.templateSelect.addEventListener("change", () => {
      this.prefs.templateId = this.templateSelect.value;
      savePrefs(this.prefs);
    });
    this.formatSelect.addEventListener("change", () => {
      this.prefs.format = this.formatSelect.value;
      savePrefs(this.prefs);
    });
    this.sendButton.addEventListener("click", () => this.sendClicked());
    this.openButton.addEventListener("click", () => this.openClicked());
  }

  // Called by Fontra's sidebar when the panel is shown or hidden
  async toggle(on, focus) {
    if (on && (this.templatesState === "notLoaded" || this.templatesState === "failed")) {
      await this.loadTemplates();
    }
  }

  setStatus(text, isError = false) {
    this.statusElement.textContent = text || "";
    this.statusElement.classList.toggle("error", !!isError);
  }

  refreshUI() {
    const ready = this.templatesState === "loaded" && this.templates.length > 0;
    this.templateSelect.disabled = !ready || this.busy;
    this.formatSelect.disabled = this.busy;
    this.sendButton.disabled = this.busy || this.templatesState === "loading";
  }

  showResultsButton(url, highlight) {
    this.resultsUrl = url;
    this.openButton.hidden = !url;
    this.openButton.classList.toggle("highlight", !!highlight);
  }

  async loadTemplates() {
    this.templatesState = "loading";
    this.refreshUI();
    try {
      const data = await requestJSON(`${serverAddress()}/api/v1/plugin/public/templates/`);
      this.templates = data.templates || [];
      this.templatesState = "loaded";
      this.templateSelect.replaceChildren(
        ...(this.templates.length
          ? this.templates.map((template) => new Option(template.name, template.id))
          : [new Option("No analyses available")])
      );
      if (this.templates.some((template) => String(template.id) === String(this.prefs.templateId))) {
        this.templateSelect.value = this.prefs.templateId;
      }
      if (!this.busy && this.statusElement.classList.contains("error")) {
        this.setStatus("");
      }
    } catch (e) {
      this.templatesState = "failed";
      this.templateSelect.replaceChildren(new Option("Not loaded"));
      this.setStatus(`${e.message} Click Send to try again.`, true);
    }
    this.refreshUI();
  }

  async sendClicked() {
    if (this.templatesState !== "loaded") {
      await this.loadTemplates();
      return;
    }
    const template = this.templates.find(
      (template) => String(template.id) === this.templateSelect.value
    );
    if (!template) {
      this.setStatus("Choose an analysis first.", true);
      return;
    }
    // Ask while we still have the click (browsers want a user gesture).
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    const fontController = this.editorController.fontController;
    const outputFormat = this.formatSelect.value;
    const run = ++this.analysisRun;
    this.busy = true;
    this.showResultsButton(null, false);
    this.refreshUI();

    try {
      this.setStatus("Reading the font…");
      const payload = await collectFontSource(fontController, (done, total) => {
        if (run === this.analysisRun) {
          this.setStatus(`Reading glyphs ${done} / ${total}…`);
        }
      });
      if (outputFormat === "variable" && !payload.axes?.axes?.length) {
        throw new FAError("This font has no axes. Choose Static OTF or Static TTF.");
      }
      const familyName = payload.fontInfo?.familyName || payload.projectName || "The font";

      this.setStatus("Uploading…");
      const form = new FormData();
      form.append("analysisTemplate", template.id);
      form.append("format", outputFormat);
      form.append("source", await gzipJSON(payload), "font.fontra.json.gz");
      const data = await requestJSON(`${serverAddress()}/api/v1/plugin/public/fontra-analyses/`, {
        method: "POST",
        body: form,
      });
      if (run !== this.analysisRun) {
        return;
      }
      const analysis = data.analysis;
      this.busy = false;
      this.refreshUI();
      this.showResultsButton(serverAddress() + analysis.path, false);
      this.setStatus(this.describe(analysis));
      await this.pollAnalysis(run, analysis.hash, familyName);
    } catch (e) {
      if (run !== this.analysisRun) {
        return;
      }
      if (!(e instanceof FAError)) {
        console.error("Font Analyzer:", e);
      }
      this.busy = false;
      this.refreshUI();
      this.setStatus(e instanceof FAError ? e.message : `Sending failed: ${e.message || e}`, true);
    }
  }

  async pollAnalysis(run, analysisHash, familyName) {
    const url = `${serverAddress()}/api/v1/plugin/public/analyses/${encodeURIComponent(analysisHash)}/`;
    const deadline = Date.now() + POLL_GIVE_UP_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (run !== this.analysisRun) {
        return;
      }
      let analysis;
      try {
        analysis = (await requestJSON(url)).analysis;
      } catch (e) {
        continue; // transient network problem, keep waiting
      }
      if (run !== this.analysisRun || !analysis) {
        return;
      }
      this.setStatus(this.describe(analysis), analysis.status === "failed");
      const resultsUrl = serverAddress() + analysis.path;
      if (analysis.status === "complete") {
        this.showResultsButton(resultsUrl, true);
        this.notify(
          `${analysis.familyName || familyName} is ready`,
          `${analysis.errorCount ?? 0} errors, ${analysis.warningCount ?? 0} warnings. Click to open the results.`,
          resultsUrl
        );
        return;
      }
      if (analysis.status === "failed") {
        this.showResultsButton(resultsUrl, false);
        this.notify(
          `The analysis of ${familyName} failed`,
          "Open the results page for the details.",
          resultsUrl
        );
        return;
      }
    }
    if (run === this.analysisRun) {
      this.setStatus("Still not finished. Open Results to check later.");
    }
  }

  notify(title, body, url) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return; // the highlighted Open Results button is enough
    }
    try {
      const notification = new Notification(title, { body, tag: "font-analyzer" });
      notification.onclick = () => {
        window.focus();
        window.open(url, "_blank", "noopener");
        this.showResultsButton(url, false);
        notification.close();
      };
    } catch (e) {
      console.error("Font Analyzer: notification failed", e);
    }
  }

  openClicked() {
    if (this.resultsUrl) {
      window.open(this.resultsUrl, "_blank", "noopener");
      this.showResultsButton(this.resultsUrl, false);
    }
  }

  describe(analysis) {
    switch (analysis.status) {
      case "queuedNormal":
      case "queuedHeavy":
        return `Queued, position ${analysis.queuePosition ?? "?"}…`;
      case "processing":
        return "Compiling and analysing…";
      case "complete":
        return `Ready: ${analysis.errorCount ?? 0} errors, ${analysis.warningCount ?? 0} warnings.`;
      case "failed":
        return "The analysis failed. Open Results for the details.";
      default:
        return "Sent.";
    }
  }
}
