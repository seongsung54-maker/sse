import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const read = (file) => readFile(join(root, file), "utf8");

test("article worker returns before the Codex transport limit", async () => {
  const source = await read("앱/승인글.mjs");
  assert.match(source, /ARTICLE_WORKER_TIMEOUT_SECONDS\s*=\s*240/);
  assert.match(source, /시간초:\s*ARTICLE_WORKER_TIMEOUT_SECONDS/);
});

test("OpenAI and WordPress requests have abort timeouts", async () => {
  const draft = await read("99_절대_건들지마세요_프로그램파일/scripts/adsense-create-drafts.mjs");
  const wp = await read("99_절대_건들지마세요_프로그램파일/scripts/lib/wp.mjs");
  assert.match(draft, /function openAiFetch\(/);
  assert.match(draft, /AbortSignal\.timeout/);
  assert.match(wp, /AbortSignal\.timeout/);
});
