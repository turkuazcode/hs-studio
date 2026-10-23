import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, createAppState, INITIAL_STATE } from "../../src/core/state.js";
import { createEventBus } from "../../src/core/events.js";
import * as tauri from "../../src/core/tauri.js";

test("store: get / set / update / snapshot", () => {
  const s = createStore({ a: 1 });
  assert.equal(s.get("a"), 1);
  assert.equal(s.set("a", 2), 2);
  assert.equal(s.update("a", (v) => v + 10), 12);
  assert.deepEqual(s.snapshot(), { a: 12 });
});

test("store: subscribers fire on change only, unsubscribe works", () => {
  const s = createStore({ n: 0 });
  const seen = [];
  const all = [];
  const off = s.subscribe("n", (v, old) => seen.push([v, old]));
  s.subscribe("*", (k, v) => all.push([k, v]));
  s.set("n", 1);
  s.set("n", 1); // unchanged: no notification
  s.set("other", true);
  off();
  s.set("n", 2);
  assert.deepEqual(seen, [[1, 0]]);
  assert.deepEqual(all, [["n", 1], ["other", true], ["n", 2]]);
});

test("app state: original initial values, fresh playlist per store", () => {
  const a = createAppState();
  const b = createAppState();
  assert.equal(a.get("currentMediaType"), "none");
  assert.equal(a.get("currentPlaylistIndex"), -1);
  assert.equal(a.get("aiSharpLevel"), 2);
  assert.equal(a.get("aiContrastBoost"), 8);
  assert.equal(a.get("currentAspect"), "contain");
  a.get("playlist").push({ name: "x" });
  assert.equal(b.get("playlist").length, 0);
  assert.equal(INITIAL_STATE.playlist.length, 0);
  assert.ok(Object.isFrozen(INITIAL_STATE));
});

test("event bus: on / emit / off, same handler on two types", () => {
  const bus = createEventBus();
  const got = [];
  const h = (d) => got.push(d.v);
  bus.on("a", h);
  const offB = bus.on("b", h);
  bus.emit("a", { v: 1 });
  bus.emit("b", { v: 2 });
  offB();
  bus.emit("b", { v: 3 });
  bus.off("a", h);
  bus.emit("a", { v: 4 });
  assert.deepEqual(got, [1, 2]);
});

test("event bus: emit without detail passes an empty object", () => {
  const bus = createEventBus();
  let detail = null;
  bus.on("x", (d) => { detail = d; });
  bus.emit("x");
  assert.deepEqual(detail, {});
});

test("tauri wrapper: no-op outside the app", async () => {
  assert.equal(tauri.isTauri, false);
  assert.equal(tauri.invoke, undefined);
  assert.equal(tauri.appWindow, undefined);
  assert.equal(tauri.dialogOpen, undefined);
  assert.equal(tauri.listen("x", () => {}), undefined);
});
