// R02 updater: status texts map to existing TR/EN keys; install error codes are parsed.
import "./i18n-setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { errorCode, statusKey } from "../../src/ui/updates.js";
import { lookup } from "../../src/core/i18n.js";

const dict = (lang) => JSON.parse(readFileSync(new URL(`../../src/i18n/${lang}.json`, import.meta.url), "utf8"));

test("every updater status has a TR and EN text", () => {
  for (const s of ["available", "none", "offline", "not-configured", "signature", "download", "verified", "checking", "installing", "error", "weird"]) {
    for (const lang of ["tr", "en"]) assert.equal(typeof lookup(dict(lang), statusKey(s)), "string", `${lang} ${s}`);
  }
  assert.equal(statusKey("unknown-code"), "updates.status.error");
});

test("install errors are reduced to their code", () => {
  assert.equal(errorCode("signature: minisign error"), "signature");
  assert.equal(errorCode("download: status 404"), "download");
  assert.equal(errorCode(""), "error");
  assert.equal(errorCode(undefined), "error");
});
