// Pure status-state machine for the opencode-tab-status plugin.
//
// This module has NO side effects (no stdout, no OSC, no notifications) so it
// can be unit-tested in isolation: feed it events via apply(event) and read the
// current tab title via title(). The plugin entrypoint (plugins/*.js) wraps
// this with OSC output + optional notifications.
//
// The published plugin entrypoint (plugins/opencode-tab-status.js) inlines the
// exact same logic so it loads with zero relative-import fragility. Keep the
// two in sync.

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
export const ICONS = {
  idle: "🌱",
  thinking: "💭",
  tool: "🔧",
  done: "✅",
  compact: "🗜️",
  retry: "⏳",
  error: "⚠️",
};

export const LABELS = {
  zh: { idle: "空闲", thinking: "思考", tool: "工具", done: "完成", compact: "压缩", retry: "等待", error: "错误" },
  en: { idle: "idle", thinking: "thinking", tool: "tool", done: "done", compact: "compact", retry: "waiting", error: "error" },
};

// ---------------------------------------------------------------------------
// Options (from env vars, defaults below)
// ---------------------------------------------------------------------------
export function resolveOptions(env = {}) {
  const lang = env.STATUS_TAB_LANG === "en" ? "en" : "zh";
  const emoji = env.STATUS_TAB_NO_EMOJI !== "1";
  // fields order: status, title, model, tool, usage
  let fields = ["status", "title", "model", "tool", "usage"];
  if (env.STATUS_TAB_FIELDS) {
    const f = env.STATUS_TAB_FIELDS.split(",")
      .map((s) => s.trim())
      .filter((s) => ["status", "title", "model", "tool", "usage"].includes(s));
    if (f.length) fields = f;
  }
  const notify = env.STATUS_TAB_NOTIFY === "1";
  // icon-only: show just the status glyph in the tab, no "完成/思考" text.
  // Default on (saves tab space). Set STATUS_TAB_ICON_ONLY=0 to show labels.
  const iconOnly = env.STATUS_TAB_ICON_ONLY !== "0";
  return { lang, emoji, fields, notify, iconOnly };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
export function createStatus(opts = resolveOptions()) {
  const labels = LABELS[opts.lang] || LABELS.zh;

  const state = {
    phase: "idle", // idle|thinking|tool|compact|retry|error
    inTurn: false, // true while a turn is in progress (busy, incl. gaps between
    // tool calls). Stays true after a tool finishes until the session truly
    // returns to the user, so transient idles between sub-steps don't flash "完成".
    waiting: false, // true while opencode is paused waiting on the user
    model: "",
    tool: "",
    title: "",
    tokens: "",
    cost: "",
  };

  // Track phase transitions so the entrypoint can fire notifications only on
  // real changes (完成 / 错误), not on every event.
  let lastPhase = state.phase;

  const clip = (s, n) => {
    if (!s) return s;
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };

  const applyPart = (part) => {
    if (!part) return;
    if (part.type === "tool" || part.tool) {
      const name = part.tool || part.name;
      if (name) {
        const st = part.state?.status;
        if (st === "running" || st === "pending") {
          state.tool = name;
          state.phase = "tool";
          state.inTurn = true;
        } else if (st === "completed" || st === "error") {
          state.tool = "";
          // turn still in progress (agent likely continues thinking) — keep
          // inTurn true so a transient idle doesn't end it.
          if (state.phase === "tool") state.phase = "thinking";
        }
      }
    }
    if (part.modelID) {
      state.model = part.providerID ? `${part.providerID}/${part.modelID}` : part.modelID;
    }
  };

  const onStep = (part, starting) => {
    if (!part) return;
    if (starting && !state.inTurn && state.phase !== "tool") {
      state.phase = "thinking";
    }
  };

  // Apply a raw opencode event. Returns "done" | "error" | null so the
  // entrypoint knows when to fire a user notification.
  const apply = (event) => {
    if (!event) return null;
    let notify = null;
    switch (event.type) {
      case "session.status": {
        const t = event.properties?.status?.type;
        if (t === "busy") {
          state.waiting = false;
          state.inTurn = true;
          if (state.phase !== "tool" && state.phase !== "error")
            state.phase = "thinking";
        } else if (t === "idle") {
          // Ignore transient idles that happen mid-turn (e.g. right after a
          // tool finishes, before the next thinking step). Only end the turn
          // when inTurn is already false.
          if (!state.inTurn) {
            state.phase = "idle";
            state.tool = "";
          }
        }
        break;
      }
      case "session.idle":
        // Dedicated "session returned to user" event — the turn is done.
        state.inTurn = false;
        state.phase = "idle";
        state.tool = "";
        break;
      case "session.error":
        state.phase = "error";
        break;
      case "session.compacting":
      case "experimental.session.compacting":
        state.phase = "compact";
        break;
      case "permission.asked":
        state.waiting = true;
        break;
      case "permission.replied":
        state.waiting = false;
        break;
      case "tui.prompt.append":
      case "tui.command.execute":
        state.waiting = true;
        break;
      case "session.created":
      case "session.updated": {
        const info = event.properties?.info;
        if (info?.title) state.title = info.title;
        if (info?.model?.id) {
          state.model = info.model.providerID
            ? `${info.model.providerID}/${info.model.id}`
            : info.model.id;
        }
        if (typeof info?.cost === "number") state.cost = `$${info.cost.toFixed(4)}`;
        if (info?.tokens) {
          state.tokens = `${info.tokens.input ?? 0}/${info.tokens.output ?? 0}`;
        }
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
          if (info.modelID) {
            state.model = info.providerID
              ? `${info.providerID}/${info.modelID}`
              : info.modelID;
          }
          if (typeof info.cost === "number") state.cost = `$${info.cost.toFixed(4)}`;
          if (info.tokens) {
            const tk = info.tokens;
            state.tokens = `${tk.input ?? 0}/${tk.output ?? 0}`;
          }
        }
        break;
      }
      default:
        break;
    }

    if (state.phase !== lastPhase) {
      if (state.phase === "idle" && (state.title || state.model)) notify = "done";
      else if (state.phase === "error") notify = "error";
      lastPhase = state.phase;
    }
    return notify;
  };

  // Build the tab title string from current state + options.
  const title = () => {
    let icon = ICONS[state.phase] || ICONS.idle;
    let label = labels[state.phase] || labels.idle;
    if (state.waiting) {
      icon = ICONS.retry;
      label = labels.retry;
    } else if (state.phase === "idle" && (state.title || state.model)) {
      icon = ICONS.done;
      label = labels.done;
    }
    if (!opts.emoji) icon = "";

    const seg = {};
    seg.status = opts.iconOnly && opts.emoji ? icon : `${icon}${label}`;
    seg.title = state.title ? clip(state.title, 28) : "";
    seg.model = state.model ? clip(state.model, 24) : "";
    seg.tool = state.phase === "tool" && state.tool ? clip(state.tool, 16) : "";
    const usage = [state.tokens, state.cost].filter(Boolean).join(" ");
    seg.usage = usage ? `·${usage}` : "";

    const parts = opts.fields.map((f) => seg[f]).filter(Boolean);
    return parts.join(" · ");
  };

  return { apply, title, state };
}
