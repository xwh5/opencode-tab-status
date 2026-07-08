import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatus, resolveOptions } from "../src/status.js";

// Helper: feed a list of events, return the final title. Some events need a
// `properties` wrapper like the real opencode event shape.
const ev = (type, properties = {}) => ({ type, properties });

test("initial state with a session shows ✅完成 (ready), not blank 空闲", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.created", { info: { title: "my task", model: { id: "m", providerID: "p" } } }));
  const t = s.title();
  assert.match(t, /✅完成/);
  assert.match(t, /my task/);
  assert.match(t, /p\/m/);
});

test("empty start (no session) shows 🌱空闲", () => {
  const s = createStatus(resolveOptions({}));
  assert.match(s.title(), /🌱空闲/);
});

test("busy -> 💭思考", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  assert.match(s.title(), /💭思考/);
});

test("tool running -> 🔧工具 with name", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "running" } } }));
  const t = s.title();
  assert.match(t, /🔧工具/);
  assert.match(t, /bash/);
});

test("transient idle between tools does NOT flash ✅完成", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  // tool 1 starts
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "running" } } }));
  assert.match(s.title(), /🔧工具/);
  // tool 1 finishes
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "completed" } } }));
  assert.match(s.title(), /💭思考/);
  // opencode emits a transient session.status=idle between sub-steps
  s.apply(ev("session.status", { status: { type: "idle" } }));
  // must NOT show 完成 yet (tool gap)
  assert.doesNotMatch(s.title(), /✅完成/);
  assert.match(s.title(), /💭思考/);
});

test("true end of turn shows ✅完成 and signals notify:done exactly once", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.created", { info: { title: "t", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "running" } } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "Edit", state: { status: "completed" } } }));
  // final idle (dedicated session.idle) -> done
  const sig1 = s.apply(ev("session.idle"));
  assert.equal(sig1, "done");
  assert.match(s.title(), /✅完成/);
  // a few more events after done must not re-fire notify
  const sig2 = s.apply(ev("session.updated", { info: { title: "t", model: { id: "m", providerID: "p" }, tokens: { input: 1, output: 2 } } }));
  assert.equal(sig2, null);
  assert.doesNotMatch(s.title(), /🌱空闲/);
});

test("error shows ⚠️错误 and signals notify:error", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const sig = s.apply(ev("session.error"));
  assert.equal(sig, "error");
  assert.match(s.title(), /⚠️错误/);
});

test("permission.asked / tui.prompt.append shows ⏳等待 (highest priority)", () => {
  const s = createStatus(resolveOptions({}));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "running" } } }));
  // user is asked to confirm
  s.apply(ev("permission.asked"));
  assert.match(s.title(), /⏳等待/);
  // still waiting even after the tool part completes
  s.apply(ev("message.part.updated", { part: { type: "tool", tool: "bash", state: { status: "completed" } } }));
  assert.match(s.title(), /⏳等待/);
  // user replies -> back to thinking
  s.apply(ev("permission.replied"));
  assert.match(s.title(), /💭思考/);
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

test("custom field order via STATUS_TAB_FIELDS", () => {
  const s = createStatus(resolveOptions({ STATUS_TAB_FIELDS: "model,status,title" }));
  s.apply(ev("session.created", { info: { title: "mytask", model: { id: "m", providerID: "p" } } }));
  s.apply(ev("session.status", { status: { type: "busy" } }));
  const t = s.title();
  // model must come before the status label
  const mi = t.indexOf("p/m");
  const si = t.indexOf("💭思考");
  assert.ok(mi >= 0 && si > mi, `expected model before status, got: ${t}`);
});
