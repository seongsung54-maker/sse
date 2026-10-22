import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "99_절대_건들지마세요_프로그램파일", "scripts", "adsense-create-drafts.mjs"), "utf8");

test("요약글을 확정한 뒤 같은 장면의 발췌문을 생성하고 검사한다", () => {
  const article = source.indexOf("const made = await generateArticle");
  const meta = source.indexOf("const generatedMeta = await generatePostMeta");
  assert.ok(article >= 0 && meta >= 0, "본문과 발췌문 생성 호출이 모두 있어야 합니다.");
  assert.ok(article < meta, "본문 요약글을 먼저 만든 뒤 발췌문을 만들어야 합니다.");
  assert.match(source, /validateExcerptSituationMatch\(/, "같은 상황 장면 검사 함수가 필요합니다.");
  assert.match(source, /summary:\s*articleSummary/, "발췌문 생성에 확정된 요약글을 전달해야 합니다.");
});
