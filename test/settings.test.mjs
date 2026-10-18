import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSavedModel, restoreSavedModel, seedCompactWindow } from "../src/settings.mjs";

const fileWith = (settings) => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-settings-")), "settings.json");
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
};
const modelIn = (file) => JSON.parse(readFileSync(file, "utf8")).model;

test("reads the saved model, ignoring a leftover sentinel", () => {
  assert.equal(readSavedModel(fileWith({ model: "opus" })), "opus");
  assert.equal(readSavedModel(fileWith({ model: "cj-auto" })), undefined);
  assert.equal(readSavedModel(fileWith({})), undefined);
  assert.equal(readSavedModel(join(tmpdir(), "does-not-exist.json")), undefined);
});

test("restores the previous model when the sentinel was saved", () => {
  const file = fileWith({ model: "cj-auto", permissions: { deny: ["Bash(rm*)"] } });
  assert.equal(restoreSavedModel("opus", file), true);
  assert.equal(modelIn(file), "opus");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions, { deny: ["Bash(rm*)"] });
});

test("removes the sentinel when there was no previous model", () => {
  const file = fileWith({ model: "cj-auto" });
  assert.equal(restoreSavedModel(undefined, file), true);
  assert.equal(modelIn(file), undefined);
});

test("leaves a real model the user chose during the session alone", () => {
  const file = fileWith({ model: "claude-opus-4-6" });
  assert.equal(restoreSavedModel("sonnet", file), false);
  assert.equal(modelIn(file), "claude-opus-4-6");
});

test("a missing or unreadable settings file is not an error", () => {
  assert.equal(restoreSavedModel("opus", join(tmpdir(), "nope", "settings.json")), false);
});

const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("seeds the sentinel's compact window once, leaving everything else alone", () => {
  const file = fileWith({ model: "opus", modelSettings: { "claude-opus-5-5": { effortLevel: "high" } } });
  assert.equal(seedCompactWindow(400000, file), true);
  assert.deepEqual(read(file).modelSettings, {
    "claude-opus-5-5": { effortLevel: "high" },
    "cj-auto": { autoCompactWindow: 400000 },
  });
  assert.equal(read(file).model, "opus");
});

test("never overwrites a window the user chose with /autocompact", () => {
  const file = fileWith({ modelSettings: { "cj-auto": { autoCompactWindow: "auto", effortLevel: "xhigh" } } });
  assert.equal(seedCompactWindow(400000, file), false);
  assert.deepEqual(read(file).modelSettings["cj-auto"], { autoCompactWindow: "auto", effortLevel: "xhigh" });
});

test("keeps other per-model settings saved for the sentinel", () => {
  const file = fileWith({ modelSettings: { "cj-auto": { effortLevel: "medium" } } });
  seedCompactWindow(400000, file);
  assert.deepEqual(read(file).modelSettings["cj-auto"], { effortLevel: "medium", autoCompactWindow: 400000 });
});

test("a missing or unreadable settings file is not created or touched", () => {
  assert.equal(seedCompactWindow(400000, join(tmpdir(), "no-such-dir-cj", "settings.json")), false);
});
