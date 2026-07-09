// opencode-tab-status — show OpenCode running status in the terminal tab title.
//
import * as fs from "node:fs";
//
// This file is self-contained (no relative imports) so OpenCode can load it
// whether it picks plugins/opencode-tab-status.js or the package entry. The
// pure state machine is also published in src/status.js and covered by tests.
//
// Configure via environment variables (zero-config by default):
//   STATUS_TAB_LANG=en|zh        language for status labels (default zh)
//   STATUS_TAB_NO_EMOJI=1        use plain text instead of emoji icons
//   STATUS_TAB_FIELDS=status,title,model,tool,usage   field order
//   STATUS_TAB_ICON_ONLY=0       show "完成/思考" text too (default: icon only)
//   STATUS_TAB_NOTIFY=1          ring the terminal bell on done/error
//   STATUS_TAB_DEBUG=1           append every event to %TEMP%/tab-status-debug.log
//
// Install (npm): add "opencode-tab-status" to opencode.json "plugin".
// Install (local): copy this file to ~/.config/opencode/plugins/.

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
const ICONS = {
  idle: "🌱",
  thinking: "💭",
  tool: "🔧",
  done: "✅",
  compact: "🗜️",
  retry: "⏳",
  error: "⚠️",
};
const LABELS = {
  zh: { idle: "空闲", thinking: "思考", tool: "工具", done: "完成", compact: "压缩", retry: "等待", error: "错误" },
  en: { idle: "idle", thinking: "thinking", tool: "tool", done: "done", compact: "compact", retry: "waiting", error: "error" },
};

function resolveOptions(env = {}) {
  const lang = env.STATUS_TAB_LANG === "en" ? "en" : "zh";
  const emoji = env.STATUS_TAB_NO_EMOJI !== "1";
  let fields = ["status", "title", "model", "tool", "usage"];
  if (env.STATUS_TAB_FIELDS) {
    const f = env.STATUS_TAB_FIELDS.split(",").map((s) => s.trim())
      .filter((s) => ["status", "title", "model", "tool", "usage"].includes(s));
    if (f.length) fields = f;
  }
  const notify = env.STATUS_TAB_NOTIFY === "1";
  // icon-only: show just the status glyph in the tab, no "完成/思考" text.
  // Default on (saves tab space). Set STATUS_TAB_ICON_ONLY=0 to show labels.
  const iconOnly = env.STATUS_TAB_ICON_ONLY !== "0";
  return { lang, emoji, fields, notify, iconOnly };
}

function createStatus(opts = resolveOptions()) {
  const labels = LABELS[opts.lang] || LABELS.zh;
  const state = {
    phase: "idle", // idle|thinking|tool|compact|error
    inTurn: false, // true while a turn is actively running (busy / tool / step)
    waiting: false, // true while paused for the user (permission / question / prompt)
    pendingQuestion: false, // a `question` tool is awaiting the user's answer
    model: "", tool: "", title: "", tokens: "", cost: "",
    sessionID: "", // active session id; a change means the user switched session
    hasSession: false, // a session is loaded — at rest it shows ✅ done (idle == done)
  };

  const clip = (s, n) => (!s ? s : s.length > n ? s.slice(0, n - 1) + "…" : s);

  const applyPart = (part) => {
    if (!part) return;
    if (part.type === "tool" || part.tool) {
      const name = part.tool || part.name;
      if (name) {
        const st = part.state?.status;
        if (st === "running" || st === "pending") {
          state.tool = name; state.phase = "tool"; state.inTurn = true;
        } else if (st === "completed" || st === "error") {
          state.tool = "";
          if (state.phase === "tool") state.phase = "thinking";
        }
      }
    }
    if (part.modelID) state.model = part.providerID ? `${part.providerID}/${part.modelID}` : part.modelID;
  };
  const onStep = (part, starting) => {
    if (!part) return;
    if (starting) {
      if (!state.inTurn && state.phase !== "tool") state.phase = "thinking";
      state.inTurn = true;
    }
  };

  const apply = (event) => {
    if (!event) return null;
    const evSessionID =
      event.properties?.info?.id ||
      event.properties?.sessionID ||
      event.properties?.status?.sessionID;
    if (evSessionID && evSessionID !== state.sessionID) {
      state.sessionID = evSessionID;
      state.inTurn = false;
      state.waiting = false;
      state.pendingQuestion = false;
      state.tool = "";
      state.phase = "idle";
    }
    let notify = null;
    switch (event.type) {
      case "session.status": {
        const t = event.properties?.status?.type;
        if (t === "busy") {
          state.waiting = false; state.inTurn = true;
          if (state.phase !== "tool" && state.phase !== "error") state.phase = "thinking";
        } else if (t === "idle") {
          if (!state.inTurn) { state.phase = "idle"; state.tool = ""; }
        }
        break;
      }
      case "session.idle": {
        const wasActive = state.inTurn;
        state.inTurn = false; state.phase = "idle"; state.tool = ""; state.waiting = false;
        if (wasActive) notify = "done";
        break;
      }
      case "session.error":
        state.phase = "error"; notify = "error"; break;
      case "session.compacting":
      case "experimental.session.compacting":
        state.phase = "compact"; break;
      case "permission.asked":
        state.waiting = true; break;
      case "permission.replied":
        state.waiting = false; break;
      case "tui.prompt.append":
      case "tui.command.execute":
        state.waiting = true; break;
      case "session.created":
      case "session.updated": {
        const info = event.properties?.info;
        if (info?.title) state.title = info.title;
        if (info?.model?.id) state.model = info.model.providerID ? `${info.model.providerID}/${info.model.id}` : info.model.id;
        if (typeof info?.cost === "number") state.cost = `$${info.cost.toFixed(4)}`;
        if (info?.tokens) state.tokens = `${info.tokens.input ?? 0}/${info.tokens.output ?? 0}`;
        state.hasSession = true;
        break;
      }
      case "message.part.updated": {
        const part = event.properties?.part || event.properties;
        if (part?.type === "step-start") onStep(part, true);
        else if (part?.type === "step-finish") onStep(part, false);
        else applyPart(part);
        break;
      }
      case "message.updated": {
        const info = event.properties?.info;
        if (info && info.role === "assistant") {
          if (info.modelID) state.model = info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID;
          if (typeof info.cost === "number") state.cost = `$${info.cost.toFixed(4)}`;
          if (info.tokens) { const tk = info.tokens; state.tokens = `${tk.input ?? 0}/${tk.output ?? 0}`; }
        }
        break;
      }
      default: break;
    }
    return notify;
  };

  const title = () => {
    let icon = ICONS[state.phase] || ICONS.idle;
    let label = labels[state.phase] || labels.idle;
    if (state.waiting) { icon = ICONS.retry; label = labels.retry; }
    else if (state.phase === "error") { icon = ICONS.error; label = labels.error; }
    else if (state.phase === "compact") { icon = ICONS.compact; label = labels.compact; }
    else if (state.phase === "tool" && state.tool) { icon = ICONS.tool; label = labels.tool; }
    else if (state.phase === "thinking" || state.inTurn) { icon = ICONS.thinking; label = labels.thinking; }
    else if (state.hasSession) { icon = ICONS.done; label = labels.done; } // idle == done
    if (!opts.emoji) icon = "";
    const seg = {
      status: opts.iconOnly && opts.emoji ? icon : `${icon}${label}`,
      title: state.title ? clip(state.title, 28) : "",
      model: state.model ? clip(state.model, 24) : "",
      tool: state.phase === "tool" && state.tool ? clip(state.tool, 16) : "",
      usage: (() => { const u = [state.tokens, state.cost].filter(Boolean).join(" "); return u ? `·${u}` : ""; })(),
    };
    return opts.fields.map((f) => seg[f]).filter(Boolean).join(" · ");
  };

  return { apply, title, state };
}

// ---------------------------------------------------------------------------
// OSC output + optional notifications
// ---------------------------------------------------------------------------
const ESC = "\x1b";
const setTabTitle = (text) => { try { process.stdout.write(`${ESC}]0;${text}${ESC}\\`); } catch {} };
const notify = (kind) => {
  try {
    if (kind === "error") {
      process.stdout.write("\x07");
      process.stdout.write("\x1b[?5h");
      setTimeout(() => process.stdout.write("\x1b[?5l"), 400);
    } else {
      process.stdout.write("\x07");
    }
  } catch {}
};

export const StatusTab = async ({ client }) => {
  const opts = resolveOptions(process.env);
  const st = createStatus(opts);

  // Optional event tracing — set STATUS_TAB_DEBUG=1 to dump every event to a
  // file, useful for discovering the exact event/tool names opencode emits
  // (e.g. the `question` tool) when behaviour needs tuning.
  let debugLog = null;
  if (process.env.STATUS_TAB_DEBUG === "1") {
    const p = `${process.env.TEMP || process.env.TMP || "."}/tab-status-debug.log`;
    debugLog = (e) => { try { fs.appendFileSync(p, JSON.stringify(e) + "\n"); } catch {} };
  }

  // Skip writing the OSC sequence when the rendered title is unchanged — during
  // streaming, message.part.updated fires many times with no title change, and
  // re-sending identical OSC sequences just wastes terminal repaints. `force`
  // bypasses the cache (used for re-assertion after a likely clobber).
  let lastTitle = null;
  const writeTitle = (force = false) => {
    const t = st.title();
    if (force || t !== lastTitle) {
      lastTitle = t;
      setTabTitle(t);
    }
  };
  // Re-assert the title a beat after a turn/tool ends. OpenCode spawns child
  // shells (pwsh) to run tools, and those children reset the console window
  // title to the default ("Administrator: Windows PowerShell") on startup/exit,
  // clobbering our OSC title. Writing again shortly after wins that race.
  const reassertSoon = (ms = 300) => setTimeout(() => writeTitle(true), ms);
  // Safety net: periodically force the title so any clobber self-heals within a
  // couple seconds even with no opencode event firing (e.g. background tasks).
  const heartbeat = setInterval(() => writeTitle(true), 2000);

  await client?.app?.log?.({ body: { service: "tab-status", level: "info", message: "loaded" } }).catch(() => {});

  writeTitle();

  return {
    event: async ({ event }) => {
      if (debugLog) debugLog(event);
      const signal = st.apply(event);
      writeTitle();
      if (signal && opts.notify) notify(signal);
      // a real end-of-turn -> re-assert shortly after, beating child teardown
      if (event?.type === "session.idle") reassertSoon();
    },
    "tool.execute.before": async (input) => {
      st.state.inTurn = true;
      st.state.phase = "tool";
      if (input?.tool) st.state.tool = input.tool;
      // The `question` tool pauses for the user's answer — show ⏳, not 🔧.
      // (If opencode names it differently, enable STATUS_TAB_DEBUG to learn it.)
      if (/question/i.test(input?.tool || "")) {
        st.state.pendingQuestion = true;
        st.state.waiting = true;
      }
      // NOTE: do NOT clear `waiting` here — if a tool is waiting on the user's
      // confirmation (permission.asked), we must keep showing ⏳ until
      // permission.replied fires.
      writeTitle();
      reassertSoon();
    },
    "tool.execute.after": async () => {
      st.state.tool = "";
      st.state.phase = "thinking";
      // The question tool finished (user answered) — clear its wait state.
      if (st.state.pendingQuestion) {
        st.state.pendingQuestion = false;
        st.state.waiting = false;
      }
      writeTitle();
      reassertSoon();
    },
  };
};
