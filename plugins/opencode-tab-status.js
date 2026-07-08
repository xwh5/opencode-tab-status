// opencode-tab-status — show OpenCode running status in the terminal tab title.
//
// This file is self-contained (no relative imports) so OpenCode can load it
// whether it picks plugins/opencode-tab-status.js or the package entry. The
// pure state machine is also published in src/status.js and covered by tests.
//
// Configure via environment variables (zero-config by default):
//   STATUS_TAB_LANG=en|zh        language for status labels (default zh)
//   STATUS_TAB_NO_EMOJI=1        use plain text instead of emoji icons
//   STATUS_TAB_FIELDS=status,title,model,tool,usage   field order
//   STATUS_TAB_NOTIFY=1          ring the terminal bell on done/error
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
  return { lang, emoji, fields, notify };
}

function createStatus(opts = resolveOptions()) {
  const labels = LABELS[opts.lang] || LABELS.zh;
  const state = { phase: "idle", inTurn: false, waiting: false, model: "", tool: "", title: "", tokens: "", cost: "" };
  let lastPhase = state.phase;

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
    if (starting && !state.inTurn && state.phase !== "tool") state.phase = "thinking";
  };

  const apply = (event) => {
    if (!event) return null;
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
      case "session.idle":
        state.inTurn = false; state.phase = "idle"; state.tool = "";
        break;
      case "session.error":
        state.phase = "error"; break;
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
    if (state.phase !== lastPhase) {
      if (state.phase === "idle" && (state.title || state.model)) notify = "done";
      else if (state.phase === "error") notify = "error";
      lastPhase = state.phase;
    }
    return notify;
  };

  const title = () => {
    let icon = ICONS[state.phase] || ICONS.idle;
    let label = labels[state.phase] || labels.idle;
    if (state.waiting) { icon = ICONS.retry; label = labels.retry; }
    else if (state.phase === "idle" && (state.title || state.model)) { icon = ICONS.done; label = labels.done; }
    if (!opts.emoji) icon = "";
    const seg = {
      status: `${icon}${label}`,
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

  await client?.app?.log?.({ body: { service: "tab-status", level: "info", message: "loaded" } }).catch(() => {});

  setTabTitle(st.title());

  return {
    event: async ({ event }) => {
      const signal = st.apply(event);
      setTabTitle(st.title());
      if (signal && opts.notify) notify(signal);
    },
    "tool.execute.before": async (input) => {
      st.state.inTurn = true;
      st.state.phase = "tool";
      if (input?.tool) st.state.tool = input.tool;
      st.state.waiting = false;
      setTabTitle(st.title());
    },
    "tool.execute.after": async () => {
      st.state.tool = "";
      st.state.phase = "thinking";
      setTabTitle(st.title());
    },
  };
};
