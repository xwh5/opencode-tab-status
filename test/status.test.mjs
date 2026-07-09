import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatus, resolveOptions } from "../src/status.js";

// Helper: feed a list of events, return the final title. Some events need a
// `properties` wrapper like the real opencode event shape.
const ev = (type, properties = {}) => ({ type, properties });

test("loading a session shows ✅ at rest (idle == done), and stays after a turn", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.created", { info: { title: "my task", model: { id: "m", providerID: "p" } } }));
  const t = s.title();
  assert.match(t, /✅/);
  assert.doesNotMatch(t, /完成/);
  assert.match(t, /my task/);
  assert.match(t, /p\/m/);
  // still ✅ after a turn ends
  s.apply(ev("session.status", { status: { type: "busy" } }));
  assert.match(s.title(), /💭/);
  s.apply(ev("session.idle"));
  assert.match(s.title(), /✅/);
});

test("during a turn shows 💭 (never ✅); at rest with a session shows ✅", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  // at rest with a loaded session -> done (idle == done)
  assert.match(s.title(), /✅/);
  // start a turn
  s.apply(ev("session.status", { status: { type: "busy" } }));
  assert.match(s.title(), /💭/);
  // a spurious session.status: idle mid-turn (inTurn still true) must NOT show done
  s.apply(ev("session.status", { status: { type: "idle" } }));
  assert.doesNotMatch(s.title(), /✅/);
  assert.match(s.title(), /💭/);
  // turn really ends
  const sig = s.apply(ev("session.idle"));
  assert.equal(sig, "done");
  assert.match(s.title(), /✅/);
});

test("turn-start idle must NOT ring the done bell (notify only on real session.idle)", () => {
  const s = createStatus(resolveOptions({ STATUS_TAB_NOTIFY: "1" }));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  // busy -> thinking, then a spurious idle (inTurn now false) — must not notify
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const sigSpurious = s.apply(ev("session.status", { status: { type: "idle" } }));
  assert.equal(sigSpurious, null);
  // real end of turn rings the bell exactly once
  const sigDone = s.apply(ev("session.idle"));
  assert.equal(sigDone, "done");
  // a second session.idle without a new turn must not re-ring
  const sigAgain = s.apply(ev("session.idle"));
  assert.equal(sigAgain, null);
});

test("empty start (no session) shows 🌱", () => {
  const s = createStatus(resolveOptions({}));
  assert.match(s.title(), /🌱/);
  assert.doesNotMatch(s.title(), /空闲/);
});

test("busy -> 💭", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  assert.match(s.title(), /💭/);
  assert.doesNotMatch(s.title(), /思考/);
});

test("tool running -> 🔧 with name", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "running" } } }));
  const t = s.title();
  assert.match(t, /🔧/);
  assert.doesNotMatch(t, /工具/);
  assert.match(t, /bash/);
});

test("transient idle between tools does NOT flash ✅", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  // tool 1 starts
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "running" } } }));
  assert.match(s.title(), /🔧/);
  // tool 1 finishes
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "completed" } } }));
  assert.match(s.title(), /💭/);
  // opencode emits a transient session.status=idle between sub-steps
  s.apply(ev("session.status", { status: { type: "idle" } }));
  // must NOT show 完成 yet (tool gap)
  assert.doesNotMatch(s.title(), /✅/);
  assert.match(s.title(), /💭/);
});

test("true end of turn shows ✅ and signals notify:done exactly once", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "running" } } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "completed" } } }));
  // final idle (dedicated session.idle) -> done
  const sig1 = s.apply(ev("session.idle"));
  assert.equal(sig1, "done");
  assert.match(s.title(), /✅/);
  assert.doesNotMatch(s.title(), /完成/);
  // a few more events after done must not re-fire notify
  const sig2 = s.apply(ev("session.updated", { info: { title: "t", model: { id: "m", providerID: "p" }, tokens: { input: 1, output: 2 } } }));
  assert.equal(sig2, null);
  assert.doesNotMatch(s.title(), /🌱/);
});

test("error shows ⚠️ and signals notify:error", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const sig = s.apply(ev("session.error"));
  assert.equal(sig, "error");
  assert.match(s.title(), /⚠️/);
  assert.doesNotMatch(s.title(), /错误/);
});

test("permission.asked / tui.prompt.append shows ⏳ (highest priority)", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "running" } } }));
  // user is asked to confirm
  s.apply(ev("permission.asked"));
  assert.match(s.title(), /⏳/);
  assert.doesNotMatch(s.title(), /等待/);
  // still waiting even after the tool part completes
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "completed" } } }));
  assert.match(s.title(), /⏳/);
  // user replies -> back to thinking
  s.apply(ev("permission.replied"));
  assert.match(s.title(), /💭/);
});

test("STATUS_TAB_ICON_ONLY=0 restores the 完成/思考 text labels", () => {
  const s = createStatus(resolveOptions({ STATUS_TAB_ICON_ONLY: "0" }));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  assert.match(s.title(), /💭思考/);
  // dedicated end-of-turn -> done label
  s.apply(ev("session.idle"));
  assert.match(s.title(), /✅完成/);
});

test("icon-only + no-emoji falls back to text labels", () => {
  const s = createStatus(resolveOptions({ STATUS_TAB_LANG: "en", STATUS_TAB_NO_EMOJI: "1" }));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const t = s.title();
  assert.match(t, /thinking/);
  assert.doesNotMatch(t, /💭/);
  assert.doesNotMatch(t, /✅/);
});

test("english + no-emoji config", () => {
  const s = createStatus(resolveOptions({ STATUS_TAB_LANG: "en", STATUS_TAB_NO_EMOJI: "1" }));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const t = s.title();
  assert.match(t, /thinking/);
  assert.doesNotMatch(t, /💭/);
  assert.doesNotMatch(t, /✅/);
});

test("switching into a session resets transient state and shows ✅ (not stale)", () => {
  const s = createStatus(resolveOptions({}));
  // session A: mid-turn, thinking
  s.apply(ev("session.created", { info: { id: "A", title: "task A", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy", sessionID: "A" } }));
  assert.match(s.title(), /💭/);
  // user switches to session B (different id) — transient state must reset
  s.apply(ev("session.created", { info: { id: "B", title: "task B", model: { id: "m", providerID: "p" } } }));
  // B at rest -> done (✅), not a stale "task A thinking"
  const t = s.title();
  assert.match(t, /✅/);
  assert.doesNotMatch(t, /💭/);
  assert.match(t, /task B/);
  // now interacting in B -> thinking
  s.apply(ev("session.status", { status: { type: "busy", sessionID: "B" } }));
  assert.match(s.title(), /💭/);
  // B's turn ends for real -> done
  s.apply(ev("session.idle"));
  assert.match(s.title(), /✅/);
});

test("tool waiting for confirmation keeps ⏳ (not clobbered by tool hook)", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  // a tool needs the user's confirmation
  s.apply(ev("permission.asked"));
  assert.match(s.title(), /⏳/);
  // simulate tool.execute.before firing (plugin clears inTurn/phase/tool but
  // must NOT clear `waiting`) — still waiting for the user
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "running" } } }));
  assert.match(s.title(), /⏳/);
  // user replies -> back to tool/thinking
  s.apply(ev("permission.replied"));
  assert.match(s.title(), /🔧/);
});

test("custom field order via STATUS_TAB_FIELDS", () => {
  const s = createStatus(resolveOptions({ STATUS_TAB_FIELDS: "model,status,title" }));
  s.apply(ev("session.created", { info: { title: "mytask", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const t = s.title();
  // model must come before the status icon
  const mi = t.indexOf("p/m");
  const si = t.indexOf("💭");
  assert.ok(mi >= 0 && si > mi, `expected model before status, got: ${t}`);
});
