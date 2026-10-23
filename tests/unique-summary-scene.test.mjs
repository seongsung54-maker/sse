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


test("본문 저장 전 구조·반복·질문답변·이미지를 함께 검사한다", () => {
  assert.match(source, /function validateGutenbergBlockStructure/);
  assert.match(source, /function validateNearDuplicateParagraphs/);
  assert.match(source, /function validateQuestionAnswerPairs/);
  assert.match(source, /function validateImageBlocks/);
  assert.match(source, /validateGutenbergBlockStructure\(html\)/);
  assert.match(source, /validateNearDuplicateParagraphs\(html\)/);
  assert.match(source, /validateQuestionAnswerPairs\(html\)/);
});

test("워드프레스 저장 뒤 실제 저장 본문을 다시 검사한다", () => {
  assert.match(source, /async function readSavedPost/);
  assert.match(source, /function validateSavedPost/);
  assert.match(source, /post = await readSavedPost\(/);
  assert.match(source, /validateSavedPost\(post,/);
});
