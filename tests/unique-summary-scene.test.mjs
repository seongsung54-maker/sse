import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "99_절대_건들지마세요_프로그램파일", "scripts", "adsense-create-drafts.mjs"), "utf8");

test("반복된 요약글 첫 문장이 있으면 다른 생활 장면을 고른다", () => {
  assert.match(source, /function situationForTitle\(title, site, recentSummaries = \[\]\)/);
  assert.match(source, /summaryOpeningIsRepeated\(candidate, recentSummaries\)/);
  assert.match(source, /situationForTitle\(title, site, recentSummaries\)/);
});
