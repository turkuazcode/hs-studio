// Loads the real dictionaries into the app-wide i18n instance (Turkish active, as at startup),
// so pure helpers that build texts with t() can be unit tested. Imported by *.test.mjs files.
import { readFileSync } from "node:fs";
import { i18n } from "../../src/core/i18n.js";

const dict = (lang) => JSON.parse(readFileSync(new URL(`../../src/i18n/${lang}.json`, import.meta.url), "utf8"));
i18n.addDictionary("tr", dict("tr"));
i18n.addDictionary("en", dict("en"));
i18n.setLanguage("tr");
