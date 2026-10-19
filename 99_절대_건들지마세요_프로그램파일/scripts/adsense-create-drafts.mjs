#!/usr/bin/env node

import {createHash, randomInt} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {readTitleEntries, resolveTitleFile} from "./title-files.mjs";
import {keysGuideMessage, requireLicense} from "./lib/env.mjs";
import {wpFetch} from "./lib/wp.mjs";
import {돈줄, 예산상태, 원장기록, 진행표시, 천단위, 퍼센트, 퍼센트문구} from "./lib/usage.mjs";

const programRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 앱 판은 MAKEIT_PROJECT_ROOT 로 수강생 작업 폴더를 넘긴다 (lib/env.mjs 와 같은 규칙)
const projectRoot = String(process.env.MAKEIT_PROJECT_ROOT || "").trim() || dirname(programRoot);
const GPT54_MINI_INPUT_PER_1M = 0.75;
const GPT54_MINI_OUTPUT_PER_1M = 4.5;
const DEFAULT_USD_KRW = 1543.57527;
const DEFAULT_IMAGE_MODEL = "gpt-image-1-mini";
const DEFAULT_IMAGE_QUALITY = "low";
const DEFAULT_IMAGE_SIZE = "1536x1024";
const DEFAULT_IMAGE_OUTPUT_FORMAT = "jpeg";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function ready(value, placeholders = []) {
  if (!value) return false;
  const lowered = value.toLowerCase();
  return !placeholders.some((token) => lowered.includes(token));
}

function sitePrefix(siteNumber) {
  return `ADSENSE_SITE_${String(siteNumber).padStart(2, "0")}`;
}

function cleanHtml(text) {
  return text
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTags(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableText(value) {
  return stripTags(value)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function hashText(value, length = 8) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function sanitizeEnglishSlug(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return "";
  if (slug.length < 8) return "";
  return slug;
}

function fallbackSlug(title) {
  const englishWords = String(title)
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  const words = (englishWords || [])
    .filter((word) => !["the", "and", "for", "with", "from", "into", "about"].includes(word))
    .slice(0, 6);
  if (words.length >= 2) return sanitizeEnglishSlug(words.join("-"));
  return `info-guide-${hashText(title)}`;
}

function compactKoreanPhrase(title) {
  const cleaned = String(title)
    .normalize("NFC")
    .replace(/[()[\]{}"'“”‘’!?.,:;|/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "핵심 정리";
  const words = cleaned.split(" ").slice(0, 3).join(" ");
  return words.length > 18 ? `${words.slice(0, 18).trim()} 정리` : `${words} 정리`;
}

function introHeadingForTitle(title) {
  const phrase = compactKoreanPhrase(title);
  const candidate = `${phrase}를 이해하기 위한 핵심`;
  if (comparableText(candidate) === comparableText(title)) return "핵심 내용을 먼저 정리하면";
  return candidate;
}

function headingBlock(level, text) {
  if (level === 3) {
    return `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${escapeHtml(text)}</h3>\n<!-- /wp:heading -->`;
  }
  return `<!-- wp:heading -->\n<h2 class="wp-block-heading">${escapeHtml(text)}</h2>\n<!-- /wp:heading -->`;
}

function withClass(tagHtml, className) {
  if (/\sclass\s*=/.test(tagHtml)) {
    return tagHtml.replace(/\sclass=(["'])(.*?)\1/i, (_match, quote, classes) => ` class=${quote}${classes} ${className}${quote}`);
  }
  return tagHtml.replace(/^<([a-z0-9]+)\b/i, `<$1 class="${className}"`);
}

function wrapBlock(block) {
  const trimmed = block.trim();
  const tagMatch = trimmed.match(/^<([a-z0-9]+)\b/i);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "";

  if (tag === "h2") {
    return `<!-- wp:heading -->\n${withClass(trimmed, "wp-block-heading")}\n<!-- /wp:heading -->`;
  }
  if (tag === "h3") {
    return `<!-- wp:heading {"level":3} -->\n${withClass(trimmed, "wp-block-heading")}\n<!-- /wp:heading -->`;
  }
  if (tag === "p") {
    return `<!-- wp:paragraph -->\n${trimmed}\n<!-- /wp:paragraph -->`;
  }
  if (tag === "ul" || tag === "ol") {
    return `<!-- wp:list -->\n${withClass(trimmed, "wp-block-list")}\n<!-- /wp:list -->`;
  }
  if (tag === "figure" && /<table\b/i.test(trimmed)) {
    return `<!-- wp:table -->\n${trimmed}\n<!-- /wp:table -->`;
  }
  if (tag === "table") {
    return `<!-- wp:table -->\n<figure class="wp-block-table">${trimmed}</figure>\n<!-- /wp:table -->`;
  }
  return `<!-- wp:paragraph -->\n<p>${escapeHtml(stripTags(trimmed))}</p>\n<!-- /wp:paragraph -->`;
}

function wrapPlainHtmlAsBlocks(html) {
  const blocks = [];
  const pattern = /<(h2|h3|p|ul|ol|figure|table)\b[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    blocks.push(wrapBlock(match[0]));
  }
  if (blocks.length > 0) return blocks.join("\n\n");

  const text = stripTags(html);
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<!-- wp:paragraph -->\n<p>${escapeHtml(paragraph)}</p>\n<!-- /wp:paragraph -->`)
    .join("\n\n");
}

// 마크다운 표를 HTML 표로 바꾼다.
//
//   | 항목 | 금액 |        <table><thead><tr><th>항목</th><th>금액</th></tr></thead>
//   |---|---|         →     <tbody><tr><td>통신비</td><td>4만원</td></tr></tbody></table>
//   | 통신비 | 4만원 |
//
// 이 변환이 없으면 워드프레스가 파이프 문자를 그대로 본문에 찍는다(표가 통째로 사라진 것처럼 보인다).
function markdownTablesToHtml(html) {
  const tablePattern = /(^|\n)((?:[ \t]*\|.*\|[ \t]*\n)+)/g;
  return html.replace(tablePattern, (whole, lead, block) => {
    const rows = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|") && line.endsWith("|"));
    if (rows.length < 2) return whole;

    // 두 번째 줄이 |---|---| 형태여야 표로 본다
    const isDivider = /^\|[\s:\-|]+\|$/.test(rows[1]) && rows[1].includes("-");
    if (!isDivider) return whole;

    const cells = (row) => row.slice(1, -1).split("|").map((cell) => cell.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    if (head.length === 0) return whole;

    const thead = `<thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>`;
    const tbody = body.length
      ? `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`
      : "";
    return `${lead}<table>${thead}${tbody}</table>\n`;
  });
}

// 표를 워드프레스가 아는 한 가지 모양으로 다시 씌운다.
//
// AI 가 보내는 모양이 제각각이다 — 주석만 있는 것, figure 만 있는 것, 맨 <table> 뿐인 것.
// 껍데기를 일단 전부 벗기고 다시 씌우면 어느 쪽으로 와도 결과가 같아진다.
// 표 '안쪽'은 한 글자도 건드리지 않는다. 굵게·병합(colspan)·링크가 그대로 살아야 한다.
function normalizeTableBlocks(html) {
  let out = html;
  // 1) 표를 감싼 wp:table 주석을 걷어낸다 (여는 것·닫는 것 모두)
  out = out.replace(/<!--\s*\/?\s*wp:table(?:\s+\{[^}]*\})?\s*-->/gi, "");
  // 2) figure 껍데기를 걷어낸다 — 표를 감싼 figure 만 (다른 figure 는 두어야 이미지가 산다)
  out = out.replace(
    /<figure\b[^>]*>\s*(<table\b[\s\S]*?<\/table>)\s*<\/figure>/gi,
    (_m, table) => table,
  );
  // 3) 남은 맨몸 표에 표준 껍데기를 씌운다.
  //    <table> 하나씩만 잡으므로, 닫는 주석이 없어도 뒤쪽 본문을 삼키지 않는다.
  out = out.replace(
    /<table\b[\s\S]*?<\/table>/gi,
    (table) => `<!-- wp:table -->\n<figure class="wp-block-table">${table}</figure>\n<!-- /wp:table -->`,
  );
  return out.replace(/\n{3,}/g, "\n\n");
}

function normalizeArticleHtml(rawHtml, title) {
  let html = cleanHtml(rawHtml)
    .replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi, (_match, attrs, inner) => `<h2${attrs}>${inner}</h2>`)
    .trim();

  // 블록으로 감싸기 전에 마크다운 표를 먼저 HTML 로 바꿔 둔다
  html = markdownTablesToHtml(html);

  if (!/<!--\s*wp:/i.test(html)) {
    html = wrapPlainHtmlAsBlocks(html);
  }

  html = html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi, (_match, _attrs, inner) => {
    const text = stripTags(inner);
    return `<h2 class="wp-block-heading">${escapeHtml(text || introHeadingForTitle(title))}</h2>`;
  });

  const firstHeadingPattern = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/i;
  const firstHeading = html.match(firstHeadingPattern);
  if (!firstHeading) {
    html = `${headingBlock(2, introHeadingForTitle(title))}\n\n${html}`;
  } else {
    const level = Number(firstHeading[1]);
    const text = stripTags(firstHeading[3]);
    const replacementText = comparableText(text) === comparableText(title) ? introHeadingForTitle(title) : text;
    if (level !== 2 || replacementText !== text || !/\bwp-block-heading\b/.test(firstHeading[2])) {
      html = html.replace(firstHeadingPattern, `<h2 class="wp-block-heading">${escapeHtml(replacementText)}</h2>`);
    }
  }

  if (!/<!--\s*wp:/i.test(html)) {
    html = wrapPlainHtmlAsBlocks(html);
  }

  // 표 정리는 반드시 이 자리에서 한다.
  // 위 두 갈래(블록으로 감싼 경우 / 이미 감싸져 온 경우)가 여기서 합쳐지므로,
  // 한 줄이라도 위에서 하면 한쪽 경로의 표만 고쳐지거나 본문이 통째로 맨몸이 된다.
  html = normalizeTableBlocks(html);

  return html.trim();
}

function validateArticleHtml(html, title, {minChars = 0, focusKeyword = ""} = {}) {
  if (/<h1\b/i.test(html)) throw new Error("본문에 h1 태그가 남아 있음");
  if (!/<!--\s*wp:/i.test(html)) throw new Error("본문에 Gutenberg 블록 주석이 없음");
  const firstH2 = html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (!firstH2) throw new Error("본문 첫 소제목 h2를 찾지 못함");
  const firstH2Text = stripTags(firstH2[1]);
  if (comparableText(firstH2Text) === comparableText(title)) {
    throw new Error("제목과 첫 h2 소제목이 같음");
  }

  const keyword = normalizeSpaces(focusKeyword);
  if (keyword) {
    const firstParagraphIndex = html.search(/<p\b/i);
    const firstHeadingIndex = html.search(/<h[23]\b/i);
    if (firstParagraphIndex < 0 || (firstHeadingIndex >= 0 && firstParagraphIndex > firstHeadingIndex)) {
      throw new Error("제목 바로 아래 첫 블록에 요약글 문단이 없음");
    }
    const firstParagraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const summary = stripTags(firstParagraph?.[1] || "").replace(/\s+/g, " ").trim();
    const summaryLength = [...summary].length;
    if (summaryLength < 140 || summaryLength > 160) {
      throw new Error(`요약글 글자 수가 조건과 다름 (${summaryLength}자 / 140~160자)`);
    }
    if (!summary.includes(keyword)) throw new Error("요약글에 메인키워드가 없음");
    if (!/[가-힣]/.test(summary)) throw new Error("요약글이 한국어 문장 형식이 아님");
    if (!["왜", "어떻게", "할까요", "이유는", "이러한 경우에는"].some((phrase) => summary.includes(phrase))) {
      throw new Error("요약글에 친근한 작성 계기 표현이 없음");
    }
    const boldKeyword = [...html.matchAll(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi)]
      .some((match) => stripTags(match[1]).includes(keyword));
    if (boldKeyword) throw new Error("메인키워드가 굵게 표시됨");
  }
  const headings = [...html.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)]
    .map((match) => stripTags(match[1]).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (headings.some((heading) => heading.includes("마무리"))) {
    throw new Error("소제목에 마무리가 포함됨");
  }
  const finalHeading = headings.at(-1) || "";
  if (!/(핵심|기억|포인트|정리)/.test(finalHeading)) {
    throw new Error("마지막 소제목이 핵심 포인트를 한 줄로 정리하지 않음");
  }

  // ── 아래는 "조용히 망가진 글"을 잡기 위한 검사다.
  //    예전에는 글자수도, 표 모양도, 끊긴 태그도 보지 않아서
  //    반쪽짜리 글이 화면에 "완료"로 찍힌 채 워드프레스에 쌓였다.

  // 글자수 — 프롬프트로 부탁만 하고 확인은 안 하고 있었다
  if (minChars > 0) {
    const textLength = stripTags(html).replace(/\s/g, "").length;
    if (textLength < minChars) {
      throw new Error(`본문이 너무 짧음 (${textLength}자 / 최소 ${minChars}자)`);
    }
  }

  // 마크다운 표가 남아 있으면 워드프레스에 파이프 문자가 그대로 찍힌다
  if (/^[ \t]*\|.*\|[ \t]*$/m.test(html)) {
    throw new Error("본문에 마크다운 표가 남아 있음 (| 로 그린 표)");
  }

  // 표 껍데기가 짝이 맞는지 — 하나라도 어긋나면 편집기에서 오류 덩어리로 뜬다
  const tableOpen = (html.match(/<table\b/gi) || []).length;
  const tableClose = (html.match(/<\/table>/gi) || []).length;
  if (tableOpen !== tableClose) {
    throw new Error(`표 태그가 닫히지 않음 (여는 것 ${tableOpen} / 닫는 것 ${tableClose})`);
  }
  if (tableOpen > 0) {
    const tableComments = (html.match(/<!--\s*wp:table/gi) || []).length;
    if (tableComments !== tableOpen) {
      throw new Error(`표 블록 껍데기 누락 (표 ${tableOpen}개 / 블록주석 ${tableComments}개)`);
    }
    // 행마다 칸 수가 다르면 표가 어긋나 보인다
    for (const table of html.match(/<table\b[\s\S]*?<\/table>/gi) || []) {
      const counts = (table.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map(
        (row) => (row.match(/<t[dh]\b/gi) || []).length,
      );
      const uneven = counts.filter((n) => n > 0);
      if (uneven.length > 1 && new Set(uneven).size > 1) {
        throw new Error(`표의 행마다 칸 수가 다름 (${uneven.join(", ")})`);
      }
    }
  }
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
      if (typeof content.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}

function extractJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) throw new Error("JSON 객체를 찾지 못함");
  return JSON.parse(raw.slice(first, last + 1));
}

function safeFilename(input) {
  return input
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function titleKey(title) {
  return normalizeSpaces(title)
    .normalize("NFC")
    .toLowerCase();
}

function selectRandomUnusedTitleEntries(entries, usedTitleKeys, limit, randomIndex = randomInt) {
  const seen = new Set(usedTitleKeys);
  const available = [];
  for (const entry of entries) {
    const key = titleKey(entry.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    available.push(entry);
  }
  const availableCount = available.length;
  const count = limit > 0 ? Math.min(limit, availableCount) : availableCount;
  // 부분 Fisher–Yates: 중복 없이 추첨하며 제목의 카테고리 정보도 함께 유지한다.
  for (let i = 0; i < count; i += 1) {
    const j = i + randomIndex(availableCount - i);
    [available[i], available[j]] = [available[j], available[i]];
  }
  return {entries: available.slice(0, count), availableCount};
}

function readJsonArray(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compactDraftHistoryEntry(item) {
  if (!item?.ok || !normalizeSpaces(item.title)) return null;
  return {
    // ok 를 반드시 담아야 한다.
    //
    // 예전에는 이 줄이 없어서, 저장할 때는 ok 를 빼고 읽을 때는 ok 를 요구했다.
    // 그래서 다음 실행에서 이전 기록이 전부 걸러져 누적이 쌓이지 않았고,
    // "지금까지 몇 개 만들었다" 가 항상 마지막 실행분만 가리켰다.
    // 덤으로, 이제 예전 제목을 제대로 기억하므로 중복 발행도 한 겹 더 막힌다.
    ok: true,
    site: Number(item.site || 1),
    title: normalizeSpaces(item.title),
    postId: Number(item.postId || 0),
    status: item.status || "draft",
    slug: normalizeSpaces(item.slug || ""),
    categoryId: Number(item.categoryId || 0),
    parentCategoryId: Number(item.parentCategoryId || 0),
    categoryIds: Array.isArray(item.categoryIds) ? item.categoryIds.map((id) => Number(id)).filter((id) => id > 0) : [],
    createdAt: item.createdAt || new Date().toISOString(),
  };
}

function mergeDraftHistory(...entryGroups) {
  const merged = new Map();
  for (const entries of entryGroups) {
    for (const entry of entries || []) {
      const compact = compactDraftHistoryEntry(entry);
      if (!compact) continue;
      merged.set(titleKey(compact.title), compact);
    }
  }
  return Array.from(merged.values());
}

function readDraftHistory(outputDir, visibleOutputDir) {
  return mergeDraftHistory(
    readJsonArray(join(outputDir, "draft-history.json")),
    readJsonArray(join(outputDir, "last-run.json")),
    readJsonArray(join(visibleOutputDir, "draft-history.json")),
    readJsonArray(join(visibleOutputDir, "last-run.json")),
  );
}

function parseDate(input) {
  if (!input) return null;
  const match = String(input).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`날짜 형식은 YYYY-MM-DD 여야 함: ${input}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 9, 0, 0));
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function defaultStartDate(mode) {
  const now = new Date();
  // 한국 날짜 기준으로 그날 정오(UTC 03:00)를 잡아 둔다.
  // 시간은 아래 postDateForIndex 에서 따로 정하므로 여기서는 날짜만 의미가 있다.
  const utc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0));
  if (mode === "future-daily") return utc; // 오늘부터
  utc.setUTCDate(utc.getUTCDate() - 30);
  return utc;
}

// 사람이 글을 올림직한 시간대 (한국 시간 기준)
const HUMAN_HOUR_FROM = 7;
const HUMAN_HOUR_TO = 23;

// 날짜는 그대로 두고 '시분초'만 정한다.
//
// 기본은 무작위다. 예전에는 매일 같은 시각(한국시간 오후 6시)에 박혔는데,
// 그렇게 정한 사람이 없었고 글이 줄지어 같은 시간에 올라가 부자연스러웠다.
//
// KST 를 UTC 로 쓸 때 9를 뺀다. 7시라면 UTC 로는 전날 22시가 되지만,
// 그게 곰 한국시간 오전 7시라 날짜는 그대로 유지된다.
function applyTimeOfDay(date, fixedTime) {
  if (fixedTime) {
    const [hour, minute] = String(fixedTime).split(":").map((v) => Number(v));
    if (Number.isInteger(hour)) {
      date.setUTCHours(hour - 9, Number.isInteger(minute) ? minute : 0, 0, 0);
      return date;
    }
  }
  const kstHour = HUMAN_HOUR_FROM + Math.floor(Math.random() * (HUMAN_HOUR_TO - HUMAN_HOUR_FROM + 1));
  date.setUTCHours(kstHour - 9, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
  return date;
}

// 기본 배치 "spread" — 하루에 perDay개, 슬롯 사이 최소 minGapHours 시간, 시각은 슬롯 안에서 무작위.
//
// 2026-09-21 실측: 기본이 '지금 시각' 이라 3개가 00:13·00:14·00:14 로 붙어 나왔다 (진현님: "따닥따닥").
// 슬롯 = 08:00(KST) + k × (최소간격+1)시간 + 0~60분 무작위 → 이웃 글 사이가 항상 최소간격 이상 벌어진다.
// 오늘 이미 지나간 슬롯은 건너뛴다(지금+10분보다 앞이면 예약이 안 걸림). 날짜는 KST 기준.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function spreadDate(index, {perDay = 3, minGapHours = 3, startDate = null, 피할시각들 = [], slotStartTime = "", slotGapMinutes = 0} = {}) {
  const per = Math.max(1, Math.floor(perDay));
  const startMatch = /^(\d{1,2}):(\d{2})$/.exec(String(slotStartTime));
  const startHour = startMatch ? Math.max(0, Math.min(23, Number(startMatch[1]))) : 8;
  const startMinute = startMatch ? Math.max(0, Math.min(59, Number(startMatch[2]))) : 0;
  const customGapMs = slotGapMinutes > 0 ? slotGapMinutes * 60 * 1000 : 0;
  const gapMs = customGapMs || (Math.max(1, minGapHours) + 1) * 60 * 60 * 1000;
  const now = Date.now();
  const 최소 = now + 10 * 60 * 1000;
  // 기준 날(KST 자정, UTC 로는 전날 15:00)
  const kstNow = new Date((startDate ? startDate.getTime() : now) + KST_OFFSET_MS);
  const dayStartUtc = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - KST_OFFSET_MS;
  const slotStart = (day, k) => dayStartUtc + day * 24 * 60 * 60 * 1000 + (startHour * 60 + startMinute) * 60 * 1000 + k * gapMs;
  // 오늘 이미 지난 슬롯 수만큼 앞으로 민다 (startDate 를 미래로 준 경우엔 0)
  let skipped = 0;
  for (let k = 0; k < per; k += 1) if (slotStart(0, k) < 최소) skipped += 1;
  // 워드프레스에 이미 잡혀 있는 시각(예약·임시글)과 최소 간격 안에 드는 슬롯은 건너뛴다.
  // 그래서 수강생 폴더 기록이 없어도, 글을 1개씩 따로 만들어도 하루 3개·3시간 간격이 지켜진다 (2026-09-21 실측: 10개가 전부 12시대에 몰림).
  const 간격ms = customGapMs ? Math.max(60, slotGapMinutes - 59) * 60 * 1000 : Math.max(1, minGapHours) * 60 * 60 * 1000;
  const 겹침 = (t) => 피할시각들.some((x) => Math.abs(x - t) < 간격ms);
  let i = index + skipped;
  for (let 시도 = 0; 시도 < 400; 시도 += 1) {
    const day = Math.floor(i / per);
    const k = i % per;
    const t = slotStart(day, k);
    if (!겹침(t) && !겹침(t + 59 * 60 * 1000)) {
      const jitter = Math.floor(Math.random() * 60) * 60 * 1000; // 0~59분
      return new Date(t + jitter).toISOString();
    }
    i += 1;
  }
  return new Date(slotStart(Math.floor(i / per), i % per)).toISOString();
}

function postDateForIndex(index, mode, startDate, {randomDays = 30, fixedTime = "", stepDays = 1, hourGap = 0, perDay = 3, minGapHours = 3, 피할시각들 = [], slotStartTime = "", slotGapMinutes = 0} = {}) {
  // 날짜를 아예 보내지 않으면 워드프레스가 지금 시각으로 저장한다 (--date-mode=now 로만).
  if (mode === "now" || mode === "none") return null;
  // 기본값: 하루 3개, 최소 3시간 간격, 시각 무작위, 이미 잡힌 시각은 피함
  if (mode === "spread") return spreadDate(index, {perDay, minGapHours, startDate: startDate && startDate.getTime() > Date.now() ? startDate : null, 피할시각들, slotStartTime, slotGapMinutes});

  // 시간 간격 모드 — 글마다 N시간씩 미룬다.
  //
  // 앞날짜(미래)로 저장해 두면, 수강생이 평소처럼 '발행' 을 눌러도 워드프레스가
  // 알아서 '예약' 으로 바꿔 준다(실측으로 확인). 그래서 조작이 늘지 않으면서
  // 글이 2시간 간격으로 하나씩 공개된다.
  //
  // 반대로 날짜 없이 올린 글은 발행을 누르는 순간 그 시각으로 덮어써져서,
  // 아무리 예쁘게 흩어 놔도 전부 같은 시각에 공개된다.
  if (hourGap > 0) {
    const base = startDate ? new Date(startDate.getTime()) : new Date();
    const at = new Date(base.getTime() + index * hourGap * 60 * 60 * 1000);
    // 지금보다 앞이면 예약이 안 걸리므로 최소 10분 뒤로 민다
    const 최소 = Date.now() + 10 * 60 * 1000;
    if (at.getTime() < 최소) at.setTime(최소 + index * hourGap * 60 * 60 * 1000);
    return at.toISOString();
  }

  // 날짜까지 무작위로 흩는다
  if (mode === "random") {
    const spanMs = Math.max(1, randomDays) * 24 * 60 * 60 * 1000;
    const at = new Date(Date.now() - Math.floor(Math.random() * spanMs));
    return applyTimeOfDay(at, fixedTime).toISOString();
  }

  // past-daily / future-daily — 간격은 stepDays 만큼 (기본 1일, 0 이면 전부 같은 날)
  const date = new Date(startDate.getTime());
  date.setUTCDate(date.getUTCDate() + index * stepDays);
  return applyTimeOfDay(date, fixedTime).toISOString();
}

function extractUsage(data) {
  const usage = data.usage || {};
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  return {inputTokens, outputTokens, totalTokens};
}

// 모델별 100만 토큰당 단가(달러). 표에 없는 모델은 기본값으로 어림잡고 그렇다고 알린다.
//
// 예전 코드는 if 문 양쪽에 같은 값을 넣어 두어서, 어떤 모델을 쓰든 항상 같은 단가로
// 계산했다. 모델을 바꾸면 화면의 "약 N원"이 조용히 틀린 값이 된다.
const MODEL_PRICE_PER_1M = {
  "gpt-5.4-mini": {input: GPT54_MINI_INPUT_PER_1M, output: GPT54_MINI_OUTPUT_PER_1M},
};

function estimateCost({model, inputTokens, outputTokens, usdKrw}) {
  const modelName = String(model || "").toLowerCase();
  const known = Object.keys(MODEL_PRICE_PER_1M).find((name) => modelName.includes(name));
  const price = known ? MODEL_PRICE_PER_1M[known] : {input: GPT54_MINI_INPUT_PER_1M, output: GPT54_MINI_OUTPUT_PER_1M};
  const inputPer1m = price.input;
  const outputPer1m = price.output;
  const usd = (inputTokens / 1_000_000) * inputPer1m + (outputTokens / 1_000_000) * outputPer1m;
  return {
    estimatedUsd: Number(usd.toFixed(6)),
    estimatedKrw: Number((usd * usdKrw).toFixed(1)),
    inputPer1m,
    outputPer1m,
    usdKrw,
  };
}

// 한 단계가 끝날 때마다 한 줄씩 찍는다.
//
// 글 하나를 만드는 데 1~3분이 걸리는데 예전에는 시작·끝 두 줄뿐이라
// 그 사이가 통째로 침묵이었다. 수강생은 멈춘 줄 알고 창을 닫는다.
// 자주 찍으면 AI 비서 화면이 그 줄로 가득 차므로 단계가 바뀔 때만 찍는다.
// 이제는 게이지가 그 줄을 대신한다 (lib/usage.mjs 진행표시). 문구로 단계 번호를 정한다.
const 단계번호표 = {"같은 글이 있는지 확인 중": 1, "제목·키워드 정리하는 중": 2, "본문 쓰는 중 (보통 1~2분)": 3, "그림 만드는 중 (20~40초)": 4, "워드프레스에 올리는 중": 5};
let 진행 = null;
function 단계(글번호, 전체, 문구, 제목 = "") {
  if (진행) 진행.단계(글번호, 단계번호표[문구] || 0, 문구, 제목);
  else console.log(`[${글번호}/${전체}] ${문구}`);
}

function openAiResponsesUrl() {
  return env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
}

function openAiImagesUrl() {
  return env.OPENAI_IMAGES_URL || "https://api.openai.com/v1/images/generations";
}

function mergeUsage(...items) {
  return items.reduce(
    (acc, item) => {
      acc.inputTokens += Number(item?.inputTokens || 0);
      acc.outputTokens += Number(item?.outputTokens || 0);
      acc.totalTokens += Number(item?.totalTokens || 0);
      return acc;
    },
    {inputTokens: 0, outputTokens: 0, totalTokens: 0},
  );
}

const KOREAN_STOPWORDS = new Set([
  "방법",
  "가이드",
  "정리",
  "정보",
  "핵심",
  "초보자",
  "완벽",
  "알아보기",
  "알아야",
  "필요한",
  "그리고",
  "비교",
  "이해",
  "체크리스트",
  "주의사항",
  "뜻",
  "의미",
  "기본",
  "활용",
  "사용법",
]);

function normalizeSpaces(value) {
  return String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();
}

// 대주제 키워드 — 제목 목록 대부분에 공통으로 들어 있는 앞부분 문구.
// 예: "온라인 사칭과 피싱 예방을 위해 …", "온라인 사칭과 피싱 예방에서 …" → "온라인 사칭과 피싱 예방"
// 랭크매스 포커스 키워드로 이걸 쓴다 (2026-09-21 진현님: 대주제로 넣어야 함). 제목·본문에 그대로 들어 있어 SEO 점검이 통과된다.
function 대주제키워드(titles) {
  const 목록 = (titles || []).map((t) => normalizeSpaces(t)).filter(Boolean);
  if (목록.length < 2) return "";
  // 어절로 나누고, 비교용으로만 끝의 조사를 뗀다 ("공간의/공간으로" → "공간"). 2~5어절 연속 구를 세어
  // 제목의 70% 이상에 들어 있는 것 중 가장 긴 구를 고른다. 제목 앞이 아니라 중간에 있어도 잡힌다.
  // 최종 문구는 원문 어절 그대로 쓰고(“사칭과” 유지) 마지막 어절의 조사만 뗀다 — 그래야 제목에 실제로 들어 있는 문구가 된다.
  const 조사 = /(으로부터|에서는|에서|으로|로서|로써|에게|한테|까지|부터|처럼|보다|이라|이란|라는|을|를|이|가|은|는|의|에|로|과|와|도|만|나|랑)$/;
  const 뗀다 = (w) => (w.length > 2 ? w.replace(조사, "") : w);
  const 원문어절 = 목록.map((t) => t.replace(/[()[\]{}"'“”‘’!?.,:;|/\\]+/g, " ").split(/\s+/).filter(Boolean));
  const 비교어절 = 원문어절.map((ws) => ws.map(뗀다));
  const 카운트 = new Map();
  for (const ws of 비교어절) {
    const 본것 = new Set();
    for (let n = 2; n <= 5; n += 1) for (let i = 0; i + n <= ws.length; i += 1) {
      const key = ws.slice(i, i + n).join(" ");
      if (본것.has(key)) continue;
      본것.add(key);
      카운트.set(key, (카운트.get(key) || 0) + 1);
    }
  }
  const 기준 = Math.ceil(목록.length * 0.7);
  let bestKey = "";
  for (const [key, c] of 카운트) {
    if (c < 기준 || key.length < 4 || key.length > 30) continue;
    const n = key.split(" ").length, bn = bestKey.split(" ").length;
    if (!bestKey || n > bn || (n === bn && key.length > bestKey.length)) bestKey = key;
  }
  if (!bestKey) return "";
  // 원문 복원: 첫 매칭 제목에서 그 위치의 원문 어절을 가져오고 마지막 어절 조사만 뗀다
  const 부분 = bestKey.split(" ");
  for (let t = 0; t < 비교어절.length; t += 1) {
    const ws = 비교어절[t];
    for (let i = 0; i + 부분.length <= ws.length; i += 1) {
      if (부분.every((w, j) => ws[i + j] === w)) {
        const 원 = 원문어절[t].slice(i, i + 부분.length);
        원[원.length - 1] = 뗀다(원[원.length - 1]);
        const 후보 = 원.join(" ");
        // 실제로 제목 70% 이상에 그대로 들어 있는지 확인. 아니면 마지막 어절을 하나씩 줄여 본다
        for (let k = 원.length; k >= 2; k -= 1) {
          const 문구 = 원.slice(0, k).join(" ");
          if (목록.filter((x) => x.includes(문구)).length >= 기준 && 문구.length >= 4) return 문구;
        }
        return 후보.length >= 4 ? 후보 : "";
      }
    }
  }
  return "";
}

function normalizeFocusKeyword(value, title) {
  const cleaned = normalizeSpaces(value)
    .replace(/[()[\]{}"'“”‘’!?.,:;|/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && cleaned.length <= 30 && !/^\d+$/.test(cleaned)) return cleaned;

  const words =
    normalizeSpaces(title)
      .replace(/[()[\]{}"'“”‘’!?.,:;|/\\]+/g, " ")
      .match(/[\p{L}\p{N}]{2,}/gu) || [];
  const filtered = words
    .map((word) => word.trim())
    .filter((word) => word && !KOREAN_STOPWORDS.has(word) && !/^\d+$/.test(word))
    .slice(0, 2);
  if (filtered.length > 0) return filtered.join(" ").slice(0, 30).trim();

  return compactKoreanPhrase(title).replace(/\s*정리$/, "").slice(0, 30).trim() || "핵심 주제";
}

function ensureKeywordInAlt(altText, focusKeyword, title) {
  const keyword = normalizeFocusKeyword(focusKeyword, title);
  const cleanedAlt = normalizeSpaces(altText);
  if (cleanedAlt && cleanedAlt.includes(keyword) && cleanedAlt.length <= 120) return cleanedAlt;
  return `${keyword} 핵심 내용을 설명하는 ${compactKoreanPhrase(title).replace(/\s*정리$/, "")} 대표 이미지`.slice(0, 120).trim();
}

function ensureMetaDefaults(meta, title) {
  const focusKeyword = normalizeFocusKeyword(meta?.focusKeyword, title);
  const slug = sanitizeEnglishSlug(meta?.slug) || fallbackSlug(title);
  const excerpt = normalizeSpaces(meta?.excerpt || `${title}에 대해 핵심 개념과 확인할 점을 정리한 글입니다.`).slice(0, 180);
  const categoryHint = normalizeSpaces(meta?.categoryHint || focusKeyword).slice(0, 40) || focusKeyword;
  const featuredImageAlt = ensureKeywordInAlt(meta?.featuredImageAlt, focusKeyword, title);
  const featuredImageCaption = normalizeSpaces(meta?.featuredImageCaption || `${focusKeyword}의 핵심 내용을 시각적으로 정리한 이미지입니다.`).slice(0, 140);
  // 이미지 장면은 영어만 받는다. 한글이 섞이면 모델이 글자로 그리므로(2026-09-21 진현님: 이미지에 어떤 언어 글자도 금지) 한글이 있으면 버린다.
  const imageScene = /[\u3131-\uD79D]/.test(String(meta?.imageScene || "")) ? "" : normalizeSpaces(meta?.imageScene || "").slice(0, 400);

  return {
    slug,
    excerpt,
    focusKeyword,
    categoryHint,
    featuredImageAlt,
    featuredImageCaption,
    imageScene,
  };
}

function wordpressBaseUrl(siteUrl) {
  let url = String(siteUrl || "").trim().replace(/^["']+|["']+$/g, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

function wordpressCredentials(username, appPassword) {
  return Buffer.from(`${String(username || "").trim()}:${String(appPassword || "").trim()}`).toString("base64");
}

// 워드프레스에 이미 올라가 있는 글 제목을 통째로 가져온다 (임시글·비공개 포함).
//
// 왜 필요한가: 다른 기수에서 이미 쓴 글은 이 키트의 로컬 기록(draft-history.json)에 없다.
// 그래서 제목별 중복 확인만 있으면 "5개 만들어줘"가 앞의 5개를 뽑아 놓고 그중 3개를
// 건너뛰어 2개만 만들게 된다. 시작 전에 한 번 훑어 두면 처음부터 새 제목 5개를 고를 수 있다.
async function fetchAllPostTitles({siteUrl, username, appPassword}) {
  const credentials = wordpressCredentials(username, appPassword);
  const base = wordpressBaseUrl(siteUrl);
  const perPage = 100;
  const titles = [];
  const dates = [];
  for (let page = 1; page <= 30; page += 1) {
    const url = `${base}/wp-json/wp/v2/posts?context=edit&status=draft,pending,future,publish,private&per_page=${perPage}&page=${page}&orderby=id&order=asc&_fields=title,date_gmt,status`;
    let response;
    try {
      response = await wpFetch(url, {headers: {Authorization: `Basic ${credentials}`, Accept: "application/json"}});
    } catch (error) {
      return {titles, dates, complete: false, reason: error instanceof Error ? error.message : String(error)};
    }
    // 마지막 페이지를 넘어서면 워드프레스가 400을 준다 — 정상 종료로 본다
    if (response.status === 400) {
      const error = await response.json().catch(() => null);
      if (page > 1 && error?.code === "rest_post_invalid_page_number") return {titles, dates, complete: true};
      return {titles, dates, complete: false, reason: "워드프레스 글 목록 요청 오류 (400)"};
    }
    if (!response.ok) return {titles, dates, complete: false, reason: `상태 코드 ${response.status}`};
    let data;
    try {
      data = await response.json();
    } catch {
      return {titles, dates, complete: false, reason: "응답을 해석하지 못함"};
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const post of data) {
      const raw = stripTags(post?.title?.raw || post?.title?.rendered || "");
      if (raw) titles.push(raw);
      // 앞으로 공개될 글의 시각 — 새 글의 날짜를 잡을 때 이 시각들과 겹치지 않게 피한다
      if (post?.date_gmt && (post.status === "future" || post.status === "draft" || post.status === "pending")) {
        const t = Date.parse(post.date_gmt.endsWith("Z") ? post.date_gmt : post.date_gmt + "Z");
        if (Number.isFinite(t) && t > Date.now() - 60 * 60 * 1000) dates.push(t);
      }
    }
    if (data.length < perPage) return {titles, dates, complete: true};
  }
  return {titles, dates, complete: false, reason: "글 목록 조회 한도(3000개)를 넘었습니다"};
}

async function findExistingPostByTitle({siteUrl, username, appPassword, title}) {
  const credentials = wordpressCredentials(username, appPassword);
  const url = `${wordpressBaseUrl(siteUrl)}/wp-json/wp/v2/posts?context=edit&status=draft,pending,future,publish,private&search=${encodeURIComponent(title)}&per_page=50&_fields=id,title,status`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await wpFetch(url, {
        headers: {Authorization: `Basic ${credentials}`, Accept: "application/json"},
      });
      if (!response.ok) throw new Error(`상태 코드 ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("응답 형식이 목록이 아님");
      const key = titleKey(title);
      return (
        data.find((post) => {
          const postTitle = stripTags(post?.title?.raw || post?.title?.rendered || "");
          return titleKey(postTitle) === key;
        }) || null
      );
    } catch (error) {
      if (attempt === 3) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`중복 확인 실패로 이 제목의 생성을 중단합니다: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return null;
}

function categoryIsDefault(category) {
  const label = `${category?.slug || ""} ${category?.name || ""}`.toLowerCase();
  return label.includes("uncategorized") || label.includes("미분류");
}

function categoryMatchText(category) {
  return normalizeSpaces(`${stripTags(category?.name || "")} ${stripTags(category?.description || "")} ${category?.slug || ""}`).toLowerCase();
}

function categoryTokens({title, meta}) {
  const raw = normalizeSpaces(`${title} ${meta.focusKeyword || ""} ${meta.categoryHint || ""}`);
  const tokens = raw.match(/[\p{L}\p{N}]{2,}/gu) || [];
  const filtered = tokens
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token && !KOREAN_STOPWORDS.has(token) && !/^\d+$/.test(token));
  const keyword = normalizeFocusKeyword(meta.focusKeyword, title).toLowerCase();
  const categoryHint = normalizeSpaces(meta.categoryHint).toLowerCase();
  return Array.from(new Set([keyword, categoryHint, ...filtered].filter(Boolean)));
}

function scoreCategory(category, context) {
  const text = categoryMatchText(category);
  const name = normalizeSpaces(category?.name || "").toLowerCase();
  const tokens = categoryTokens(context);
  const focusKeyword = normalizeFocusKeyword(context.meta.focusKeyword, context.title).toLowerCase();
  const categoryHint = normalizeSpaces(context.meta.categoryHint).toLowerCase();
  const isChildCategory = Number(category?.parent || 0) > 0;
  let score = 0;

  if (focusKeyword) {
    if (name.includes(focusKeyword)) score += 30;
    if (text.includes(focusKeyword)) score += 24;
    if (isChildCategory && text.includes(focusKeyword)) score += 30;
  }

  if (categoryHint && categoryHint !== focusKeyword) {
    if (name.includes(categoryHint)) score += 10;
    if (text.includes(categoryHint)) score += 6;
  }

  for (const token of tokens) {
    if (!token) continue;
    if (name.includes(token)) score += 8;
    if (text.includes(token)) score += Math.min(8, token.length + 2);
  }

  if (isChildCategory) score += 2;
  if (normalizeSpaces(category?.description || "")) score += 1;
  if (categoryIsDefault(category)) score -= 50;
  return score;
}

function selectBestCategory(categories, context) {
  const valid = (Array.isArray(categories) ? categories : []).filter((category) => Number(category?.id || 0) > 0 && normalizeSpaces(category?.name));
  if (valid.length === 0) return null;

  const nonDefault = valid.filter((category) => !categoryIsDefault(category));
  const candidates = nonDefault.length > 0 ? nonDefault : valid;
  const scored = candidates
    .map((category) => ({category, score: scoreCategory(category, context)}))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (Number(b.category.parent || 0) !== Number(a.category.parent || 0)) return Number(b.category.parent || 0) - Number(a.category.parent || 0);
      return String(a.category.name || "").localeCompare(String(b.category.name || ""), "ko");
    });

  const best = scored[0];
  if (!best) return null;
  return {
    id: Number(best.category.id),
    name: normalizeSpaces(best.category.name),
    slug: normalizeSpaces(best.category.slug),
    parentId: Number(best.category.parent || 0),
    score: best.score,
  };
}

function comparableCategoryName(value) {
  return normalizeSpaces(stripTags(value || ""))
    .normalize("NFC")
    .toLowerCase();
}

function categoryResult(category, {score, source}) {
  return {
    id: Number(category.id),
    name: normalizeSpaces(category.name),
    slug: normalizeSpaces(category.slug),
    parentId: Number(category.parent || 0),
    score,
    source,
  };
}

function titleEntryHasCategory(titleEntry) {
  return Boolean(normalizeSpaces(titleEntry?.parentCategory || "") || normalizeSpaces(titleEntry?.childCategory || ""));
}

function categoryIdsForPayload(selectedCategory) {
  const ids = [];
  const parentId = Number(selectedCategory?.parentId || 0);
  const categoryId = Number(selectedCategory?.id || 0);

  if (parentId > 0) ids.push(parentId);
  if (categoryId > 0 && !ids.includes(categoryId)) ids.push(categoryId);

  return ids;
}

function selectMappedCategory(categories, titleEntry) {
  if (!titleEntry?.childCategory && !titleEntry?.parentCategory) return null;

  const valid = (Array.isArray(categories) ? categories : []).filter((category) => Number(category?.id || 0) > 0 && normalizeSpaces(category?.name));
  if (valid.length === 0) return null;

  const parentName = comparableCategoryName(titleEntry.parentCategory);
  const childName = comparableCategoryName(titleEntry.childCategory);
  const parentCategory = parentName
    ? valid.find((category) => Number(category.parent || 0) === 0 && comparableCategoryName(category.name) === parentName)
    : null;

  if (childName) {
    const childCandidates = valid.filter((category) => Number(category.parent || 0) > 0 && comparableCategoryName(category.name) === childName);
    const childUnderParent = parentCategory
      ? childCandidates.find((category) => Number(category.parent || 0) === Number(parentCategory.id))
      : null;
    const selectedChild = childUnderParent || childCandidates[0];
    if (selectedChild) return categoryResult(selectedChild, {score: 999, source: "title-file-child"});
  }

  if (parentCategory) return categoryResult(parentCategory, {score: 700, source: "title-file-parent"});
  return null;
}

async function createWordPressCategory({siteUrl, username, appPassword, name, description = "", parentId = 0}) {
  const credentials = wordpressCredentials(username, appPassword);
  const payload = {
    name: normalizeSpaces(name),
    description: normalizeSpaces(description),
  };
  if (Number(parentId || 0) > 0) payload.parent = Number(parentId);

  const response = await wpFetch(`${wordpressBaseUrl(siteUrl)}/wp-json/wp/v2/categories`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`워드프레스 카테고리 생성 응답을 해석하지 못함: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.message || body.slice(0, 300);
    throw new Error(`워드프레스 카테고리 생성 실패: ${message}`);
  }

  return data;
}

async function ensureMappedCategory({categories, titleEntry, siteUrl, username, appPassword}) {
  if (!titleEntryHasCategory(titleEntry)) return null;

  const valid = Array.isArray(categories) ? categories : [];
  const parentName = normalizeSpaces(titleEntry.parentCategory || "");
  const childName = normalizeSpaces(titleEntry.childCategory || "");
  const parentDescription = normalizeSpaces(titleEntry.parentCategoryDescription || "");
  const childDescription = normalizeSpaces(titleEntry.childCategoryDescription || "");
  const parentComparableName = comparableCategoryName(parentName);
  const childComparableName = comparableCategoryName(childName);

  let parentCategory = parentComparableName
    ? valid.find((category) => Number(category.parent || 0) === 0 && comparableCategoryName(category.name) === parentComparableName)
    : null;

  if (!parentCategory && parentName) {
    parentCategory = await createWordPressCategory({
      siteUrl,
      username,
      appPassword,
      name: parentName,
      description: parentDescription,
    });
    valid.push(parentCategory);
  }

  if (childComparableName) {
    let childCategory = valid.find((category) => {
      if (Number(category.parent || 0) <= 0) return false;
      if (comparableCategoryName(category.name) !== childComparableName) return false;
      if (parentCategory) return Number(category.parent || 0) === Number(parentCategory.id);
      return true;
    });

    if (!childCategory && childName) {
      childCategory = await createWordPressCategory({
        siteUrl,
        username,
        appPassword,
        name: childName,
        description: childDescription,
        parentId: Number(parentCategory?.id || 0),
      });
      valid.push(childCategory);
    }

    if (childCategory) return categoryResult(childCategory, {score: 999, source: "title-file-child"});
  }

  if (parentCategory) return categoryResult(parentCategory, {score: 700, source: "title-file-parent"});
  return null;
}

async function fetchWordPressCategories({siteUrl, username, appPassword}) {
  const credentials = wordpressCredentials(username, appPassword);
  const collected = [];
  let page = 1;

  while (true) {
    const url = `${wordpressBaseUrl(siteUrl)}/wp-json/wp/v2/categories?per_page=100&page=${page}&hide_empty=false&orderby=name&order=asc&_fields=id,name,slug,description,parent`;
    const response = await wpFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
      },
    });

    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`워드프레스 카테고리 응답을 해석하지 못함: ${body.slice(0, 200)}`);
    }

    if (!response.ok) {
      const message = data.message || body.slice(0, 300);
      throw new Error(`워드프레스 카테고리 조회 실패: ${message}`);
    }

    if (!Array.isArray(data) || data.length === 0) break;
    collected.push(...data);

    const totalPages = Number(response.headers.get("x-wp-totalpages") || 0);
    if (totalPages > 0 && page >= totalPages) break;
    if (data.length < 100) break;
    page += 1;
  }

  return collected;
}

async function generatePostMeta({apiKey, model, title, 고정키워드 = ""}) {
  const systemPrompt = [
    "너는 한국어 글 제목을 보고 워드프레스 발행 메타를 만드는 편집자다.",
    "반드시 JSON 객체만 출력한다. 설명, 코드블록, 마크다운은 출력하지 않는다.",
    "slug는 제목의 핵심 의미를 영어로 옮긴 소문자 영문 slug여야 한다.",
    "slug는 한국어 로마자 표기가 아니라 의미 번역이어야 하며, 3~6개 영어 단어와 하이픈만 사용한다.",
    "focusKeyword는 제목에서 가장 중요한 한국어 대표키워드 1개 또는 짧은 키워드구여야 한다.",
    "categoryHint는 글을 넣을 워드프레스 카테고리를 고르기 위한 한국어 주제 힌트여야 한다.",
    "imageScene은 대표이미지로 그릴 장면을 영어로 1~2문장 묘사한 것이어야 한다. 사물·상황·분위기만 쓰고, 글자·간판·문서·화면·책 등 읽을 수 있는 텍스트가 나올 만한 장면은 피한다. 사람 얼굴은 넣지 않는다.",
  ].join("\n");

  const userPrompt = [
    `글 제목: ${title}`,
    고정키워드 ? `포커스 키워드는 "${고정키워드}" 로 정해져 있다. focusKeyword 에 그대로 쓰고, excerpt 와 featuredImageAlt 에 이 문구를 자연스럽게 1회 포함해라.` : "",
    "아래 JSON 형식으로만 답해.",
    "{",
    '  "slug": "semantic-english-slug",',
    '  "excerpt": "120자 안팎의 한국어 요약문",',
    '  "focusKeyword": "대표키워드 한국어 1개",',
    '  "categoryHint": "카테고리 선택용 한국어 주제 힌트",',
    '  "featuredImageAlt": "대표키워드를 자연스럽게 1회 포함한 대표이미지 대체 텍스트 한국어 1문장",',
    '  "featuredImageCaption": "대표이미지 캡션 한국어 1문장",',
    '  "imageScene": "English description of a text-free scene for the featured image, 1-2 sentences"',
    "}",
  ].join("\n");

  const response = await fetch(openAiResponsesUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {role: "system", content: systemPrompt},
        {role: "user", content: userPrompt},
      ],
      max_output_tokens: 2000,
    }),
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`OpenAI 메타 응답을 해석하지 못함: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.error?.message || body.slice(0, 300);
    throw new Error(`OpenAI 메타 생성 실패: ${message}`);
  }

  const parsed = extractJsonObject(extractOutputText(data));

  return {
    meta: ensureMetaDefaults(parsed, title),
    usage: extractUsage(data),
  };
}

function fallbackPostMeta(title) {
  return ensureMetaDefaults({
    slug: fallbackSlug(title),
    excerpt: `${title}에 대해 핵심 개념과 확인할 점을 정리한 글입니다.`,
    featuredImageAlt: `${title} 주제를 설명하는 대표 이미지`,
    featuredImageCaption: `${title}의 핵심 내용을 시각적으로 정리한 이미지입니다.`,
    imageScene: "",
  }, title);
}

function imageMimeType(outputFormat) {
  if (outputFormat === "png") return "image/png";
  if (outputFormat === "webp") return "image/webp";
  return "image/jpeg";
}

function imageExtensionFromMimeType(mimeType, fallback) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  return fallback === "jpeg" ? "jpg" : fallback;
}

function estimateImageCostUsd({model, quality, size}) {
  const table = {
    "gpt-image-1-mini": {
      low: {"1024x1024": 0.005, "1024x1536": 0.006, "1536x1024": 0.006},
      medium: {"1024x1024": 0.011, "1024x1536": 0.015, "1536x1024": 0.015},
      high: {"1024x1024": 0.036, "1024x1536": 0.052, "1536x1024": 0.052},
    },
    "gpt-image-1": {
      low: {"1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016},
      medium: {"1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063},
      high: {"1024x1024": 0.167, "1024x1536": 0.25, "1536x1024": 0.25},
    },
  };
  return table[model]?.[quality]?.[size] || 0;
}

function buildImagePrompt({title, meta}) {
  // 2026-09-21 진현님 지시: 대표이미지·본문 이미지에 어떤 언어의 글자도 넣지 않는다.
  // 그래서 한글 제목·키워드는 프롬프트에 아예 넣지 않는다 (한글이 있으면 모델이 그 글자를 그려 넣는다). 장면은 영어 묘사(imageScene)만 쓴다.
  const topic = String(meta.slug || "").replace(/-/g, " ").trim();
  const scene = meta.imageScene || `A calm, realistic editorial scene that visually represents the topic "${topic}", shown through objects, places and everyday situations only`;
  return [
    "Create one original editorial thumbnail image for a blog article.",
    `Scene: ${scene}`,
    "Style: clean, trustworthy, calm educational mood, realistic lighting, simple uncluttered background, one strong focal point.",
    "Composition: landscape 3:2 featured image, main subject centered, clean margins on all sides, clearly readable as a small thumbnail.",
    "STRICT RULE - NO TEXT AT ALL: the image must contain absolutely no text of any kind in any language or script. No Korean, no English, no numbers, no letters, no words, no signs, no labels, no captions, no subtitles, no watermarks, no logos, no UI text, no writing on paper, screens, boards, packaging, clothing or walls. If the scene would naturally include a sign, screen, document, book or label, render it blank, blurred or turned away so that nothing readable appears anywhere.",
    "Also do not include real person faces, copyrighted characters, fake official documents, brand marks, medical, legal or financial claims, before-and-after imagery, or clickbait elements.",
  ].join("\n");
}

async function generateFeaturedImage({apiKey, title, meta, usdKrw}) {
  const imageModel = env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const imageQuality = env.IMAGE_QUALITY || DEFAULT_IMAGE_QUALITY;
  const imageSize = env.IMAGE_SIZE || DEFAULT_IMAGE_SIZE;
  const imageOutputFormat = env.IMAGE_OUTPUT_FORMAT || DEFAULT_IMAGE_OUTPUT_FORMAT;

  const response = await fetch(openAiImagesUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: imageModel,
      prompt: buildImagePrompt({title, meta}),
      n: 1,
      size: imageSize,
      quality: imageQuality,
      output_format: imageOutputFormat,
    }),
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`OpenAI 이미지 응답을 해석하지 못함: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.error?.message || body.slice(0, 300);
    throw new Error(`OpenAI 대표이미지 생성 실패: ${message}`);
  }

  const imageItem = data.data?.[0] || {};
  let buffer;
  let mimeType = imageMimeType(imageOutputFormat);
  let extension = imageOutputFormat === "jpeg" ? "jpg" : imageOutputFormat;

  if (imageItem.b64_json) {
    buffer = Buffer.from(imageItem.b64_json, "base64");
  } else if (imageItem.url) {
    const imageResponse = await fetch(imageItem.url);
    if (!imageResponse.ok) {
      throw new Error(`OpenAI 이미지 URL 다운로드 실패: HTTP ${imageResponse.status}`);
    }
    mimeType = imageResponse.headers.get("content-type") || mimeType;
    extension = imageExtensionFromMimeType(mimeType, imageOutputFormat);
    buffer = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    throw new Error("OpenAI 이미지 API가 b64_json 또는 url 이미지를 반환하지 않음");
  }

  const estimatedUsd = estimateImageCostUsd({model: imageModel, quality: imageQuality, size: imageSize});
  return {
    buffer,
    mimeType,
    extension,
    imageModel,
    imageQuality,
    imageSize,
    imageOutputFormat,
    usage: data.usage || null,
    estimatedUsd,
    estimatedKrw: Number((estimatedUsd * usdKrw).toFixed(1)),
  };
}

async function uploadFeaturedImage({siteUrl, username, appPassword, title, meta, generatedImage}) {
  const credentials = wordpressCredentials(username, appPassword);
  const mediaUrl = `${wordpressBaseUrl(siteUrl)}/wp-json/wp/v2/media`;
  const uploadResponse = await wpFetch(mediaUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": generatedImage.mimeType,
      "Content-Disposition": `attachment; filename="${meta.slug}.${generatedImage.extension}"`,
      Accept: "application/json",
    },
    body: generatedImage.buffer,
  });

  const uploadBody = await uploadResponse.text();
  let uploadData;
  try {
    uploadData = JSON.parse(uploadBody);
  } catch {
    throw new Error(`대표이미지 업로드 응답을 해석하지 못함: ${uploadBody.slice(0, 200)}`);
  }
  if (!uploadResponse.ok) {
    const message = uploadData.message || uploadBody.slice(0, 300);
    throw new Error(`대표이미지 업로드 실패: ${message}`);
  }

  const mediaId = Number(uploadData.id);
  if (!mediaId) throw new Error("대표이미지 업로드 후 미디어 ID를 받지 못함");

  const updateResponse = await wpFetch(`${mediaUrl}/${mediaId}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      title: `${title} 대표이미지`,
      alt_text: meta.featuredImageAlt,
      caption: meta.featuredImageCaption,
      description: meta.featuredImageCaption,
    }),
  });

  const updateBody = await updateResponse.text();
  let updateData = {};
  if (updateBody) {
    try {
      updateData = JSON.parse(updateBody);
    } catch {
      // 원본 업로드는 성공했으므로 응답 내용만 오류 메시지에 포함한다.
    }
  }

  if (!updateResponse.ok) {
    const message = updateData.message || updateBody.slice(0, 300);
    throw new Error(`대표이미지 정보 저장 실패: ${message}`);
  }

  if (normalizeSpaces(updateData.alt_text || "") !== normalizeSpaces(meta.featuredImageAlt)) {
    throw new Error("대표이미지 alt 텍스트 저장 확인 실패");
  }

  const sourceUrl = normalizeSpaces(updateData.source_url || uploadData.source_url || updateData.guid?.rendered || uploadData.guid?.rendered || "");
  if (!sourceUrl) {
    throw new Error("대표이미지 URL을 받지 못해 본문 이미지 블록을 만들 수 없음");
  }

  return {
    id: mediaId,
    sourceUrl,
    altText: meta.featuredImageAlt,
    caption: meta.featuredImageCaption,
  };
}

function buildArticleImageBlock({media}) {
  const caption = normalizeSpaces(media.caption);
  const escapedCaption = escapeHtml(caption);
  const escapedAlt = escapeHtml(media.altText);
  const escapedSrc = escapeHtml(media.sourceUrl);

  return [
    `<!-- wp:image {"id":${media.id},"sizeSlug":"large","linkDestination":"none","className":"makeit-adsense-inline-featured-image"} -->`,
    `<figure class="wp-block-image size-large makeit-adsense-inline-featured-image"><img src="${escapedSrc}" alt="${escapedAlt}" class="wp-image-${media.id}">${caption ? `<figcaption class="wp-element-caption">${escapedCaption}</figcaption>` : ""}</figure>`,
    "<!-- /wp:image -->",
  ].join("\n");
}

function insertImageBlockIntoArticle(html, imageBlock) {
  const blocks = String(html || "")
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return imageBlock;
  const insertIndex = blocks.length <= 4 ? Math.min(2, blocks.length) : Math.min(Math.max(3, Math.floor(blocks.length / 2)), blocks.length - 1);
  blocks.splice(insertIndex, 0, imageBlock);
  return blocks.join("\n\n").trim();
}

function validateInlineImageBlock(html, media) {
  if (!html.includes(`<!-- wp:image {"id":${media.id},`)) {
    throw new Error("본문 이미지 블록 삽입 확인 실패");
  }
  if (!html.includes(`wp-image-${media.id}`)) {
    throw new Error("본문 이미지 미디어 ID 연결 확인 실패");
  }
  if (!html.includes(`alt="${escapeHtml(media.altText)}"`)) {
    throw new Error("본문 이미지 alt 텍스트 삽입 확인 실패");
  }
}

function postContentText(post) {
  const content = post?.content;
  if (typeof content === "string") return content;
  if (typeof content?.raw === "string") return content.raw;
  if (typeof content?.rendered === "string") return content.rendered;
  return "";
}

function postHasInlineImage(post, media) {
  const content = postContentText(post);
  return content.includes(`wp-image-${media.id}`) || content.includes(`"id":${media.id}`);
}

async function generateApprovalSummary({apiKey, model, title, keyword}) {
  const requiredPhrases = ["왜", "어떻게", "할까요", "이유는", "이러한 경우에는"];
  let lastLength = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(openAiResponsesUrl(), {
      method: "POST",
      headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
      body: JSON.stringify({
        model,
        input: [
          {role: "system", content: "너는 한국어 블로그 요약글만 작성한다. 설명, 제목, HTML, 따옴표, 마크다운 없이 요약글 한 문단만 출력한다."},
          {role: "user", content: [
            `글 제목: ${title}`,
            `메인키워드: ${keyword}`,
            "공백 포함 정확히 140~160자의 한국어 요약글을 작성한다.",
            "한국인이 직접 겪은 경험을 한 번 넣고, 이 글을 쓰는 이유와 다룰 내용을 소개한다.",
            `메인키워드 "${keyword}"를 문장 안에 1회 이상 그대로 넣는다.`,
            "왜, 어떻게, 할까요, 이유는, 이러한 경우에는 중 하나를 자연스럽게 포함한다.",
          ].join("\n")},
        ],
        max_output_tokens: 300,
      }),
    });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { throw new Error(`OpenAI 응답을 해석하지 못함: ${body.slice(0, 200)}`); }
    if (!response.ok) throw new Error(`OpenAI API 실패: ${data.error?.message || body.slice(0, 300)}`);
    const summary = stripTags(extractOutputText(data)).replace(/[“”"'`]/g, "").replace(/\s+/g, " ").trim();
    lastLength = [...summary].length;
    const valid = lastLength >= 140 && lastLength <= 160 &&
      summary.includes(keyword) &&
      /[가-힣]/.test(summary) &&
      requiredPhrases.some((phrase) => summary.includes(phrase));
    if (valid) return {summary, usage: extractUsage(data)};
  }
  throw new Error(`요약글을 140~160자로 만들지 못함 (마지막 ${lastLength}자)`);
}

function summaryPlanForSite(site) {
  const plans = {
    1: {reader: "일상 물건의 역사가 궁금한 독자", outcome: "발명품의 역사와 변화를 이해하는 정보"},
    2: {reader: "별자리 관측 입문자와 경험자", outcome: "계절별 별자리를 쉽게 관측하는 방법"},
    3: {reader: "농업용 센서를 처음 다루는 농업인", outcome: "센서 오류 대응과 자동화 방법"},
    4: {reader: "집단 속 내 행동이 궁금한 독자", outcome: "개인과 집단에서 다르게 행동할 때 대응하는 방법"},
    5: {reader: "외래생물이 낯선 독자와 관찰 기록자", outcome: "주변 외래생물의 의미와 기록이 필요한 이유"},
    6: {reader: "덴마크 여행·건축·문화에 관심 있는 독자", outcome: "여행 전에 알면 좋은 덴마크 철도와 문화 이야기"},
  };
  return plans[Number(site)] || {reader: "관련 정보를 처음 확인하는 독자", outcome: "핵심을 이해하는 데 필요한 관점"};
}

function situationForTitle(title, site) {
  const text = normalizeSpaces(title).toLowerCase();
  const situations = {
    1: [
      [["유리"], "창문 너머를 보거나 유리컵을 사용할 때에는 투명한 재료가 당연하게 느껴집니다."],
      [["도자기", "그릇"], "밥그릇이나 찻잔을 사용할 때에는 단단한 그릇이 만들어진 과정을 떠올리기 어렵습니다."],
      [["전화", "통신", "전신"], "누군가에게 바로 연락할 수 있는 일은 익숙하지만 통신 기술에는 긴 변화의 시간이 담겨 있습니다."],
      [["전구", "조명"], "해가 진 뒤 불을 켜는 짧은 순간에도 조명 기술이 바꾼 생활의 모습이 담겨 있습니다."],
      [["주판", "계산"], "금액을 계산하거나 숫자를 정리할 때에는 계산 도구가 어떻게 달라졌는지 생각해 볼 수 있습니다."],
      [["도르래", "크랭크", "기계"], "엘리베이터와 자전거처럼 힘과 움직임이 바뀌는 장면에는 기계 장치의 원리가 숨어 있습니다."],
      [["가전"], "세탁기나 청소기로 집안일을 할 때에는 생활을 바꾼 발명품의 역할을 확인할 수 있습니다."],
    ],
    2: [
      [["망원경"], "망원경으로 별자리를 찾을 때에는 넓은 하늘에서 어느 범위를 먼저 볼지 막막할 수 있습니다."],
      [["날씨", "관측 조건"], "별을 보려는 날에는 날씨와 시야가 관측 결과를 크게 바꿀 수 있습니다."],
      [["붉은 조명"], "어두운 곳에서 별을 관측할 때에는 눈이 어둠에 적응한 상태를 지키는 일이 중요합니다."],
      [["북쪽", "여름"], "계절에 따라 달라지는 북쪽 하늘을 보면 같은 별자리도 전혀 다르게 느껴질 수 있습니다."],
      [["사진", "비교"], "같은 하늘을 다른 계절에 찍은 사진을 비교하면 별자리의 위치 변화를 더 분명히 볼 수 있습니다."],
    ],
    3: [
      [["전기전도도"], "양액이나 관수용 물의 수치를 비교할 때에는 숫자 하나만 보고 재배 환경을 판단하기 어렵습니다."],
      [["기준선", "그래프"], "재배 기록 그래프에 기준선을 표시하면 평소와 다른 변화를 더 빨리 알아차릴 수 있습니다."],
      [["비가", "토양 수분"], "비가 그친 뒤에는 토양이 젖어 보여도 실제 수분 변화는 시간에 따라 달라질 수 있습니다."],
      [["자연광", "조명"], "해가 짧거나 흐린 날에는 자연광 부족 시간을 확인해 보조 조명을 조절할 필요가 있습니다."],
      [["오래된", "기록"], "지난 재배 기록과 새 측정값을 비교할 때에는 측정 조건이 같은지부터 확인해야 합니다."],
    ],
    4: [
      [["회의", "아이디어"], "회의에서 먼저 나온 의견이 뒤의 생각까지 흔드는 경험은 누구에게나 있을 수 있습니다."],
      [["운영진", "회원"], "운영진끼리 결론을 서두르다 보면 조용한 회원의 의견이 빠지는 순간이 생길 수 있습니다."],
      [["육아용품", "가정"], "다른 가정이 많이 고른 육아용품을 보면 나도 같은 선택이 더 안전해 보일 수 있습니다."],
      [["규범", "상황"], "같은 사람도 모임의 분위기와 상황이 달라지면 평소와 다른 기준을 따르곤 합니다."],
      [["아파트", "주민"], "같은 아파트 동에 산다는 이유만으로 낯선 이웃에게도 더 친밀감을 느끼는 경우가 있습니다."],
    ],
    5: [
      [["뉴스"], "뉴스에서 외래생물을 접하면 위험하다는 인상만 먼저 남기기 쉽습니다."],
      [["하천", "공원"], "하천과 공원에서 낯선 생물을 발견하면 우리 주변 생태계와 어떤 관계인지 궁금해집니다."],
      [["반려", "유기"], "반려동물이나 식물이 자연으로 들어가는 문제는 일상 선택과 생태계 변화를 함께 생각하게 합니다."],
      [["생태계", "확산"], "한 종의 확산은 다른 생물과 서식 환경에 예상보다 넓은 영향을 남길 수 있습니다."],
    ],
    6: [
      [["역", "환승"], "낯선 도시를 여행할 때에는 역의 동선과 환승 방식이 첫인상을 크게 바꿀 수 있습니다."],
      [["자전거"], "덴마크의 철도시설을 볼 때에는 자전거 이동과 열차 이용이 어떻게 이어지는지 눈여겨볼 만합니다."],
      [["건축", "디자인"], "역 건축과 안내 디자인을 살펴보면 한 도시가 이동하는 사람을 배려하는 방식을 알 수 있습니다."],
      [["도시", "연결"], "철도는 도시와 도시를 잇는 수단을 넘어 생활권을 연결하는 공간이 되기도 합니다."],
    ],
  };
  const found = (situations[Number(site)] || []).find(([tokens]) => tokens.every((token) => text.includes(token)));
  if (found) return found[1];
  const topic = compactKoreanPhrase(title);
  const fallback = {
    1: topic + "을 살펴보면 오늘의 생활 속 물건에도 발명의 역사가 남아 있음을 발견하게 됩니다.",
    2: topic + "을 관측할 때에는 계절과 시간, 하늘 상태를 함께 확인할 필요가 있습니다.",
    3: topic + "을 확인할 때에는 한 번의 수치보다 기록과 측정 조건을 함께 봐야 합니다.",
    4: topic + "과 관련된 상황에서는 주변의 분위기와 다른 사람의 선택이 내 판단에 영향을 줄 수 있습니다.",
    5: topic + "을 살펴보면 외래생물이 생활과 생태계에 어떻게 연결되는지 생각해 볼 수 있습니다.",
    6: topic + "을 보면 덴마크의 철도시설이 여행과 도시 생활에 어떤 역할을 하는지 알 수 있습니다.",
  };
  return fallback[Number(site)] || topic + "을 이해하려면 실제 상황과 핵심 내용을 함께 살펴볼 필요가 있습니다.";
}

function buildCompliantApprovalSummary({title, keyword, site = 0}) {
  const cleanedTitle = normalizeSpaces(title).replace(/[.?!]/g, "");
  const plan = summaryPlanForSite(site);
  const situation = situationForTitle(title, site);
  const seed = Number.parseInt(hashText(cleanedTitle, 2), 16) || 0;
  const suffixes = [
    " 필요한 내용을 차근차근 살펴보겠습니다.",
    " 실제 상황에 적용할 수 있게 정리해 보겠습니다.",
    " 핵심을 쉬운 말로 알아보겠습니다.",
  ];
  const templates = [
    (topic) => situation + " " + plan.reader + "라면 " + keyword + "이 " + topic + "와 어떤 관련이 있는지 왜 알아야 할까요? 이 글에서는 " + plan.outcome + "를 쉽게 정리합니다.",
    (topic) => situation + " " + plan.reader + "에게 " + keyword + "는 " + topic + "을 이해하는 출발점이 됩니다. 어떤 점을 확인하면 좋을까요? 이 글에서 " + plan.outcome + "를 살펴봅니다.",
    (topic) => situation + " " + plan.reader + "이 " + topic + "을 살펴볼 때 " + keyword + "의 의미를 실제 판단으로 어떻게 이어 갈 수 있을까요? 이 글에서는 " + plan.outcome + "를 정리합니다.",
  ];
  const blocked = /출퇴근길이나 공연장|익숙한 모습 뒤에|마트에서 채소와 과일|당연하게 여기던 장면/;
  for (let offset = 0; offset < templates.length; offset += 1) {
    const opening = templates[(seed + offset) % templates.length];
    for (let size = Math.min(34, cleanedTitle.length); size >= 6; size -= 1) {
      const topic = cleanedTitle.slice(0, size).trim();
      let summary = opening(topic);
      if (!["왜", "어떻게", "할까요", "이유는", "이러한 경우에는"].some((phrase) => summary.includes(phrase))) summary += " 왜 그런지 함께 살펴보겠습니다.";
      for (const suffix of suffixes) {
        if ([...summary].length >= 140) break;
        if ([...summary + suffix].length <= 160) summary += suffix;
      }
      if (blocked.test(summary)) throw new Error("제목과 무관하거나 반복된 고정 도입문이 요약글에 포함됨");
      if ([...summary].length >= 140 && [...summary].length <= 160) return summary;
    }
  }
  throw new Error("조건에 맞는 요약글을 만들지 못함");
}

function repairApprovalSummary({title, keyword, site}) {
  const plan = summaryPlanForSite(site);
  const situation = situationForTitle(title, site);
  const topic = compactKoreanPhrase(title);
  let summary = situation + " " + topic + "과 관련해 " + keyword + "는 왜 중요하고 어떻게 살펴봐야 할까요? 이 글에서는 " + plan.outcome + "을 중심으로 실제 상황에서 확인할 점을 쉽게 정리합니다.";
  const additions = [" 필요한 내용을 차근차근 살펴보겠습니다.", " 실제로 적용할 수 있게 설명하겠습니다."];
  for (const addition of additions) {
    if ([...summary].length >= 140) break;
    if ([...summary + addition].length <= 160) summary += addition;
  }
  if ([...summary].length > 160) summary = summary.slice(0, 157).replace(/[ ,.]?$/, "") + "...";
  return summary;
}

function summaryParagraphBlock(summary) {
  return `<!-- wp:paragraph -->\n<p>${escapeHtml(summary)}</p>\n<!-- /wp:paragraph -->`;
}

function applyApprovalSummary(html, summary) {
  const openingParagraph = /^\s*<!--\s*wp:paragraph\s*-->\s*<p\b[^>]*>[\s\S]*?<\/p>\s*<!--\s*\/wp:paragraph\s*-->/i;
  if (openingParagraph.test(html)) return html.replace(openingParagraph, summaryParagraphBlock(summary));
  return `${summaryParagraphBlock(summary)}\n\n${html.trim()}`;
}

async function generateArticle({apiKey, model, title, minChars, 키워드 = "", site = 0}) {
  const systemPrompt = [
    "너는 애드센스 승인용 정보성 글을 작성하는 한국어 에디터다.",
    "허위 정보, 과장, 출처 없는 단정, 의료/법률/금융 확정 조언을 피한다.",
    "검색 의도에 맞는 실용적인 정보, 구체적인 체크리스트, 주의사항, 단계별 설명을 포함한다.",
    "출력은 워드프레스 블록편집기가 개별 블록으로 인식할 수 있는 Gutenberg-compatible HTML 본문만 작성한다.",
    "반드시 Gutenberg 블록 주석을 사용한다. 예: <!-- wp:heading -->, <!-- wp:paragraph -->, <!-- wp:list -->, <!-- wp:table -->.",
    "h1은 절대 쓰지 않는다. 글 제목 바로 아래의 첫 본문 블록은 요약글 p이고, 그 다음 블록부터 h2를 쓴다.",
    "첫 h2 소제목은 글 제목과 같으면 안 된다. 제목을 복사하지 말고, 핵심 정리형 소제목으로 다르게 쓴다.",
    "h2, h3, p, ul, ol, li, figure/table 태그를 자연스럽게 사용한다. strong 또는 b 태그는 쓰지 않는다.",
    "코드블록, 마크다운, 설명문, JSON-LD, script, iframe은 출력하지 않는다.",
    "광고 클릭 유도 문구, 구매 강요 문구, 애드센스 정책 위반 가능 문구는 넣지 않는다.",
  ].join("\n");

  const userPrompt = [
    `제목: ${title}`,
    `최소 글자수: 한국어 기준 ${minChars}자 이상`,
    키워드 ? `포커스 키워드: "${키워드}" — 첫 문단 안에 그대로 1회, h2 소제목 중 하나에 1회, 본문 곳곳에 자연스럽게 3~5회 포함한다. 억지로 반복하지 않는다.` : "",
    "요청:",
    "- 초보자가 실제로 이해하고 따라할 수 있게 작성",
    "- 글 제목 바로 아래 첫 블록은 p 요약글로 작성한다. 공백 포함 140~160자의 한국어 한 문단이며, 한국인이 직접 겪은 경험을 섞어 이 글을 쓰는 이유와 다룰 내용을 소개한다.",
    키워드 ? `- 요약글에 포커스 키워드 "${키워드}"를 정확히 1회 이상 포함한다.` : "- 요약글에 제목의 핵심 키워드를 1회 이상 포함한다.",
    "- 요약글에는 왜, 어떻게, 할까요, 이유는, 이러한 경우에는 중 하나 이상의 친근한 표현을 자연스럽게 포함한다.",
    "- 중간에 체크리스트 또는 단계별 절차 포함",
    "- 본문을 정리하는 마지막 소제목에는 마무리라는 말을 쓰지 않는다. 독자가 기억할 핵심 포인트를 한 줄로 나타낸 소제목을 쓴다.",
    "- 제목은 출력하지 않고, 요약글부터 본문으로 출력",
    "- 첫 h2는 제목과 다른 문구로 작성",
    "- 본문 전체를 워드프레스 블록 주석으로 감싼 HTML로 출력",
    "- 표가 필요하면 아래 모양을 그대로 따라 쓸 것. 마크다운 표(| 로 그린 표)는 쓰지 말 것:",
    '  <!-- wp:table -->\n  <figure class="wp-block-table"><table><thead><tr><th>항목</th><th>내용</th></tr></thead><tbody><tr><td>가</td><td>나</td></tr></tbody></table></figure>\n  <!-- /wp:table -->',
    "- 표는 모든 행의 칸 수가 같아야 함",
  ].join("\n");

  const response = await fetch(openAiResponsesUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {role: "system", content: systemPrompt},
        {role: "user", content: userPrompt},
      ],
      max_output_tokens: Number(env.ARTICLE_MAX_OUTPUT_TOKENS || 12000),
    }),
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`OpenAI 응답을 해석하지 못함: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.error?.message || body.slice(0, 300);
    throw new Error(`OpenAI API 실패: ${message}`);
  }

  // 글이 중간에 끊겼는지 확인한다.
  //
  // 예전에는 이걸 한 번도 보지 않아서, 문장 중간에 뚝 끊긴 글이 그대로 워드프레스에 올라갔다.
  // 표를 그리다 끊기면 </table> 이 없는 채로 저장되고, 화면에는 "완료"만 찍힌다.
  // 지금 모델은 생각하는 데도 출력 한도를 같이 쓰기 때문에 한도에 걸리는 일이 드물지 않다.
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason || "이유 미상";
    const error = new Error(`본문이 중간에 끊겼어요 (${reason})`);
    error.truncated = true;
    throw error;
  }

  let html = normalizeArticleHtml(extractOutputText(data), title);
  if (!html) throw new Error("OpenAI가 빈 본문을 반환함");
  if (키워드) {
    let summary;
    try {
      summary = buildCompliantApprovalSummary({title, keyword: 키워드, site});
      html = applyApprovalSummary(html, summary);
      validateArticleHtml(html, title, {minChars: 0, focusKeyword: 키워드});
    } catch {
      summary = repairApprovalSummary({title, keyword: 키워드, site});
      html = applyApprovalSummary(html, summary);
      validateArticleHtml(html, title, {minChars: 0, focusKeyword: 키워드});
    }
    const 글자수 = stripTags(html).replace(/\s/g, "").length;
    return {html, summary, usage: extractUsage(data), 글자수, 짧음: minChars > 0 && 글자수 < minChars};
  }
  validateArticleHtml(html, title, {minChars: 0});
  const 글자수 = stripTags(html).replace(/\s/g, "").length;
  return {html, usage: extractUsage(data), 글자수, 짧음: minChars > 0 && 글자수 < minChars};
}

// 짧은 본문에 새 소제목 단락을 이어 붙여 분량을 채운다. 기존 내용은 그대로 두고 뒤에만 덧붙인다.
// 수강생에게는 알리지 않는다 — 로그도 한 줄로만.
async function extendArticle({apiKey, model, title, html, 부족자수}) {
  const 목표 = Math.max(600, Math.ceil(부족자수 * 1.3));
  const systemPrompt = [
    "너는 애드센스 승인용 정보성 글을 작성하는 한국어 에디터다.",
    "이미 쓰인 글의 뒤에 이어 붙일 새 단락만 쓴다. 이미 있는 내용을 반복하거나 요약하지 않는다.",
    "출력은 Gutenberg 블록 주석으로 감싼 HTML 본문만 쓴다. h1은 쓰지 않는다. 마크다운·설명문·코드블록은 쓰지 않는다.",
    "표는 <!-- wp:table --> 블록으로만 쓰고, 마크다운 표(|)는 쓰지 않는다.",
  ].join("\n");
  const userPrompt = [
    `글 제목: ${title}`,
    `아래는 이미 쓰인 본문이다. 이 뒤에 이어 붙일 새 h2 소제목 단락을 2~3개 써라. 합쳐서 한국어 기준 ${목표}자 이상.`,
    "새 단락 예: 자주 하는 실수, 상황별 적용 예시, 더 알아두면 좋은 점, 자주 묻는 질문(Q&A 형식의 h3 + p).",
    "기존 소제목과 같은 주제는 다시 쓰지 않는다. 첫 블록은 h2로 시작한다.",
    "",
    "----- 이미 쓰인 본문 -----",
    stripTags(html).slice(0, 6000),
  ].join("\n");
  const response = await fetch(openAiResponsesUrl(), {
    method: "POST",
    headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
    body: JSON.stringify({model, input: [{role: "system", content: systemPrompt}, {role: "user", content: userPrompt}], max_output_tokens: Number(env.ARTICLE_MAX_OUTPUT_TOKENS || 12000)}),
  });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`OpenAI 응답을 해석하지 못함: ${body.slice(0, 200)}`); }
  if (!response.ok) throw new Error(`OpenAI API 실패: ${data.error?.message || body.slice(0, 300)}`);
  if (data.status === "incomplete") throw new Error("보충 본문이 중간에 끊겼어요");
  let 추가 = cleanHtml(extractOutputText(data) || "").replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, "").trim();
  if (!추가) throw new Error("보충 본문이 비어 있음");
  // 블록 주석이 없으면 태그 단위로 감싼다 (normalizeArticleHtml 이 하는 일과 같은 규칙)
  if (!/<!--\s*wp:/i.test(추가)) 추가 = normalizeArticleHtml(추가, title);
  return {추가, usage: extractUsage(data)};
}

async function createDraftPost({siteUrl, username, appPassword, title, html, date, meta, featuredMediaId, selectedCategory}) {
  const credentials = wordpressCredentials(username, appPassword);
  const payload = {
    title,
    content: html,
    status: "draft",
    slug: meta.slug,
    excerpt: meta.excerpt,
  };
  if (date) payload.date = date;
  if (featuredMediaId) payload.featured_media = featuredMediaId;
  const categoryIds = categoryIdsForPayload(selectedCategory);
  if (categoryIds.length > 0) payload.categories = categoryIds;

  const response = await wpFetch(`${wordpressBaseUrl(siteUrl)}/wp-json/wp/v2/posts?context=edit`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`워드프레스 응답을 해석하지 못함: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.message || body.slice(0, 300);
    throw new Error(`워드프레스 임시글 생성 실패: ${message}`);
  }

  return data;
}

// 랭크매스(Rank Math SEO) 포커스 키워드를 글에 넣는다.
//
// 함정이 하나 있다 — 워드프레스 표준 경로(글 만들 때 meta 필드)로 보내면
// 오류도 안 나고 조용히 무시된다. 랭크매스가 그 칸을 REST 로 열어두지 않았기 때문이다.
// 실측(b.sciencehax.com)으로 확인했고, 전용 창구로 보내면 제대로 저장된다.
// 수강생이 플러그인을 더 깔 필요는 없다.
//
// 랭크매스가 없는 사이트면 그냥 건너뛴다. 요가(Yoast)는 쓰기용 창구가 없어 지원하지 않는다.
async function applyRankMathKeyword({siteUrl, username, appPassword, postId, meta}) {
  const keyword = normalizeSpaces(meta?.focusKeyword || "");
  if (!keyword || !postId) return {ok: false, reason: "키워드 없음"};

  const credentials = wordpressCredentials(username, appPassword);
  const payload = {
    objectID: Number(postId),
    objectType: "post",
    meta: {
      rank_math_focus_keyword: keyword,
      ...(meta?.metaDescription ? {rank_math_description: normalizeSpaces(meta.metaDescription)} : {}),
    },
  };

  try {
    const response = await wpFetch(`${siteUrl.replace(/\/$/, "")}/wp-json/rankmath/v1/updateMeta`, {
      method: "POST",
      headers: {Authorization: `Basic ${credentials}`, "Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    if (response.status === 404) return {ok: false, reason: "랭크매스가 설치돼 있지 않음"};
    if (!response.ok) {
      const body = await response.text();
      return {ok: false, reason: `저장 실패 (${response.status}) ${body.slice(0, 80)}`};
    }
    return {ok: true, keyword};
  } catch (error) {
    return {ok: false, reason: error instanceof Error ? error.message : String(error)};
  }
}

async function updateDraftPostContent({siteUrl, username, appPassword, postId, html, featuredMediaId, selectedCategory}) {
  const credentials = wordpressCredentials(username, appPassword);
  const payload = {content: html};
  if (featuredMediaId) payload.featured_media = featuredMediaId;
  const categoryIds = categoryIdsForPayload(selectedCategory);
  if (categoryIds.length > 0) payload.categories = categoryIds;

  const response = await wpFetch(`${wordpressBaseUrl(siteUrl)}/wp-json/wp/v2/posts/${postId}?context=edit`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`워드프레스 본문 재확인 응답을 해석하지 못함: ${body.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data.message || body.slice(0, 300);
    throw new Error(`워드프레스 본문 이미지 복구 실패: ${message}`);
  }

  return data;
}

// 라이센스 게이트(수강 코드 확인) 통과 후, process.env 우선 + .env.local 보조로 설정을 읽는다 (PRD D8·D9)
const env = requireLicense({scriptLabel: "애드센스 승인글 만들기"});
const site = Number(argValue("site", "1"));
const limit = Number(argValue("limit", "0"));
const includeUsedTitles = ["1", "true", "yes"].includes(argValue("include-used", "0").toLowerCase());
const dryRun = ["1", "true", "yes"].includes(argValue("dry-run", "0").toLowerCase());
const prefix = sitePrefix(site);
const model = env.ARTICLE_MODEL || "gpt-5.4-mini";
const minChars = Number(env.ARTICLE_MIN_CHARS || 3000);
const titlesPath = resolveTitleFile(projectRoot, site, argValue("titles", ""));
const outputDir = join(programRoot, "makeit-adsense", "outputs", `site-${String(site).padStart(2, "0")}`);
const visibleOutputDir = join(
  projectRoot,
  "애드센스 승인글",
  "02_생성결과_확인용",
  `site-${String(site).padStart(2, "0")}`,
);
// 기본은 'now' — 수강생이 돌리는 그 시각으로 저장된다.
// 예전 기본값은 past-daily(30일 전부터 하루 1개)였는데, 아무도 그렇게 설정한 적이
// 없는데 갑자기 한 달 전 날짜가 찍혀 나와 혼란스러웠다.
const dateMode = argValue("date-mode", "spread"); // 기본: 하루 3개 · 최소 3시간 간격 · 무작위 시각 (예전 기본 now 는 --date-mode=now)
const perDay = Math.max(1, Number(argValue("per-day", "3")) || 3);
const minGapHours = Math.max(1, Number(argValue("min-gap-hours", "3")) || 3);
const slotStartTime = argValue("slot-start-time", "");
const slotGapMinutes = Math.max(0, Number(argValue("slot-gap-minutes", "0")) || 0);
const randomDays = Number(argValue("random-days", "30")) || 30;
// 시간은 기본적으로 무작위다. 굳이 고정하려면 --fixed-time=18:00 처럼 붙인다.
const fixedTime = argValue("fixed-time", "");
// 날짜 간격(일). 1 이면 하루씩, 2 면 이틀씩, 0 이면 전부 같은 날에 들어간다.
// 몇 개를 어떻게 나눠 올릴지는 수강생이 정할 일이라, 프로그램은 강요하지 않는다.
const stepDays = (() => {
  const raw = argValue("date-step", "1");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();

// 글 사이 시간 간격(시간 단위). 예: --hour-gap=2 면 2시간씩 벌려 예약한다.
const hourGap = Math.max(0, Number(argValue("hour-gap", "0")) || 0);
// 앱 판은 글을 1개씩 따로 부른다. 그러면 index 가 매번 0 이라 "하루에 1개씩" 이 전부 같은 날이 된다.
// 그래서 지금까지 만든 개수를 --date-offset 으로 받아 날짜 순번을 이어 간다. 코드스페이스 판은 0.
const dateOffset = Math.max(0, Number(argValue("date-offset", "0")) || 0);
const startDate = parseDate(argValue("start-date", "")) || defaultStartDate(dateMode);
const usdKrw = Number(env.ARTICLE_USD_KRW || DEFAULT_USD_KRW);

if (!dryRun && !ready(env.OPENAI_API_KEY, ["sk-your"])) {
  console.error(keysGuideMessage("OpenAI API 키"));
  process.exit(1);
}

const siteUrl = env[`${prefix}_URL`];
const username = env[`${prefix}_USER`];
const appPassword = env[`${prefix}_APP_PASSWORD`];

if (!dryRun && (!ready(siteUrl, ["example.com", "example-"]) || !ready(username, ["your-admin-id"]) || !ready(appPassword, ["xxxx"]))) {
  console.error(`${prefix} 연결 정보가 부족합니다. 워드프레스 주소, 관리자 아이디, 애플리케이션 비밀번호가 필요해요.`);
  console.error(keysGuideMessage(`사이트${site} 워드프레스 연결 정보`));
  process.exit(1);
}

const titleCatalog = readTitleEntries(titlesPath);
const allTitleEntries = titleCatalog.entries;
const previousDraftHistory = readDraftHistory(outputDir, visibleOutputDir);

// 이미 쓴 글 걸러내기 ① 이 키트로 만든 기록  ② 워드프레스에 실제로 올라가 있는 글
const existingOnWordPress = includeUsedTitles
  ? {titles: [], complete: true}
  : await fetchAllPostTitles({siteUrl, username, appPassword});
if (!includeUsedTitles) {
  if (existingOnWordPress.complete) {
    console.log(`워드프레스에 이미 있는 글 ${existingOnWordPress.titles.length}개 확인 — 같은 제목은 빼고 진행합니다.`);
  } else {
    console.error(`워드프레스 글 목록을 다 읽지 못해 중복 방지를 위해 중단합니다: ${existingOnWordPress.reason}`);
    process.exit(1);
  }
}

const usedTitleKeys = new Set([
  ...previousDraftHistory.map((entry) => titleKey(entry.title)),
  ...existingOnWordPress.titles.map((title) => titleKey(title)),
]);
const selection = selectRandomUnusedTitleEntries(
  allTitleEntries, includeUsedTitles ? new Set() : usedTitleKeys, limit,
);
const titleEntries = selection.entries;
const titles = titleEntries.map((entry) => entry.title);
if (titles.length === 0) {
  if (allTitleEntries.length > 0 && usedTitleKeys.size > 0 && !includeUsedTitles) {
    console.error(`새로 만들 제목이 없어요. 제목 파일 ${allTitleEntries.length}개가 이미 전부 사용됐습니다.`);
    console.error("제목 파일에 새 제목을 더 넣어주세요. 이미 쓴 글을 일부러 다시 만들려면 --include-used=1 을 붙이면 됩니다.");
  } else {
    console.error("제목 목록이 비어 있음. titles.txt에 제목을 한 줄에 하나씩 넣어야 함.");
  }
  process.exit(1);
}

let wordpressCategories = [];
if (!dryRun) {
  try {
    wordpressCategories = await fetchWordPressCategories({siteUrl, username, appPassword});
  } catch (categoryError) {
    const message = categoryError instanceof Error ? categoryError.message : String(categoryError);
    console.log(`카테고리 자동 선택 준비 실패: ${message}`);
  }
}

mkdirSync(outputDir, {recursive: true});
mkdirSync(visibleOutputDir, {recursive: true});

console.log(`애드센스 사이트 ${site}번 임시글 생성 시작`);
console.log(`제목 파일: ${titlesPath}`);
console.log(`제목 ${titles.length}개 무작위 선택 / 전체 ${allTitleEntries.length}개 / 이전 성공 ${previousDraftHistory.length}개 자동 제외 / 모델 ${model} / 본문 ${minChars}자 이상 목표`);
if (limit > 0) {
  console.log(`제목 ${allTitleEntries.length}개 중 아직 안 쓴 제목 ${selection.availableCount}개 / 이번에 ${titles.length}개를 만듭니다.`);
}
if (titleCatalog.categories.length > 0) {
  console.log(`제목 파일 카테고리 매핑: 대표 ${titleCatalog.categories.length}개 / 세부 ${titleCatalog.categories.reduce((sum, category) => sum + category.children.length, 0)}개`);
}
if (titleCatalog.warnings.length > 0) {
  console.log("제목 파일 점검 경고:");
  titleCatalog.warnings.forEach((warning) => console.log(`- ${warning}`));
}
console.log(`워드프레스 카테고리 ${wordpressCategories.length}개 확인 / 글마다 제목에 맞춰 자동 선택`);
console.log("본문 전체는 화면에 출력하지 않고, 워드프레스 임시글과 outputs 폴더에만 저장함.");
if (dateMode === "spread") {
  console.log(`임시글 날짜: 하루 ${perDay}개 · 최소 ${minGapHours}시간 간격 · 시각 무작위 (오늘 지난 시간대는 건너뜀) — 발행을 누르면 그 시각에 예약 공개됩니다`);
}
if (dateMode === "random") {
  console.log(`임시글 날짜: 최근 ${randomDays}일 안에서 무작위${fixedTime ? ` / 시각 ${fixedTime} 고정` : " (시간도 무작위)"}`);
} else if (dateMode !== "now" && dateMode !== "none") {
  const gap = stepDays === 0 ? "같은 날에 모두" : stepDays === 1 ? "하루씩" : `${stepDays}일씩`;
  console.log(
    `임시글 날짜: ${dateOnly(startDate)} 부터 ${gap}` +
      (fixedTime ? ` / 시각 ${fixedTime} 고정` : " / 시간은 매번 다르게"),
  );
}
console.log("=".repeat(44));

if (dryRun) {
  console.log("DRY RUN: 실제 글/이미지 생성과 워드프레스 업로드는 하지 않음.");
  titles.forEach((title, index) => console.log(`[${index + 1}/${titles.length}] ${title}`));
  process.exit(0);
}

// 돈 계산 준비 — 글마다 토큰·비용·남은 돈을 무조건 보여 준다.
let 예산 = 예산상태({env, usdKrw});
if (예산.있음) {
  console.log(`충전액 ${천단위(예산.예산krw)}원(${예산.예산usd}달러) 기준 · 지금까지 ${예산.쓴글수}개 · 약 ${천단위(예산.쓴krw)}원 씀 · 남은 돈 약 ${천단위(예산.남은krw)}원 (${퍼센트문구(예산.남은퍼센트)})`);
} else {
  void 0; // 충전액 안내 문구 제거 (2026-09-21 진현님 지시)
}
console.log("진행 게이지는 화면과 '애드센스 승인글/02_생성결과_확인용/지금_진행상황.md' 파일에 같이 표시됩니다.");
console.log("");
진행 = new 진행표시({전체: titles.length, 라벨: `사이트${site} · 글 ${titles.length}개 만드는 중`});
const 이번실행 = {글수: 0, krw: 0, usd: 0, total_tokens: 0};

const 잡힌시각들 = Array.isArray(existingOnWordPress.dates) ? [...existingOnWordPress.dates] : [];
// 랭크매스 포커스 키워드 = 제목 파일의 대주제 (제목 대부분에 공통으로 든 문구). 없으면 글마다 OpenAI 가 고른 키워드를 쓴다.
const 대주제 = argValue("focus-keyword", "") || 대주제키워드(allTitleEntries.map((e) => e.title));
if (대주제) console.log(`포커스 키워드(대주제): ${대주제}`);
const results = [];
for (let index = 0; index < titles.length; index += 1) {
  const titleEntry = titleEntries[index];
  const title = titleEntry.title;
  try {
    console.log(`[${index + 1}/${titles.length}] 생성 중: ${title}`);
    단계(index + 1, titles.length, "같은 글이 있는지 확인 중", title);
    const existingPost = await findExistingPostByTitle({siteUrl, username, appPassword, title});
    if (existingPost) {
      results.push({site, title, ok: true, skipped: true, reason: "duplicate-on-wordpress", postId: existingPost.id, status: existingPost.status});
      console.log(`  건너뜀: 워드프레스에 같은 제목의 글이 이미 있음 (ID ${existingPost.id} / 상태 ${existingPost.status})`);
      진행.글건너뜀();
      continue;
    }
    단계(index + 1, titles.length, "제목·키워드 정리하는 중");
    let meta = fallbackPostMeta(title);
    let metaUsage = {inputTokens: 0, outputTokens: 0, totalTokens: 0};
    try {
      const 이글키워드 = 대주제 && normalizeSpaces(title).includes(대주제) ? 대주제 : "";
      const generatedMeta = await generatePostMeta({apiKey: env.OPENAI_API_KEY, model, title, 고정키워드: 이글키워드});
      meta = generatedMeta.meta;
      if (이글키워드) meta = {...meta, focusKeyword: 이글키워드};
      metaUsage = generatedMeta.usage;
    } catch (metaError) {
      const message = metaError instanceof Error ? metaError.message : String(metaError);
      console.log(`  메타 보정: ${message}`);
    }

    // 글이 끊기거나 점검에 걸리면 한 번만 더 만들어 본다.
    // 두 번 다 실패하면 이 제목은 올리지 않고 넘어간다 — 반쪽짜리 글을 올리는 것보다 낫다.
    // (다음에 다시 실행하면 이 제목부터 자동으로 다시 만든다)
    단계(index + 1, titles.length, "본문 쓰는 중 (보통 1~2분)");
    let html;
    let articleUsage;
    let articleSummary = "";
    let 짧음 = false;
    for (let 시도 = 1; 시도 <= 2; 시도 += 1) {
      try {
        const made = await generateArticle({apiKey: env.OPENAI_API_KEY, model, title, minChars, 키워드: meta.focusKeyword, site});
        html = made.html;
        articleSummary = made.summary || "";
        articleUsage = made.usage;
        짧음 = made.짧음;
        break;
      } catch (articleError) {
        const message = articleError instanceof Error ? articleError.message : String(articleError);
        // 키가 틀렸거나 요청 자체가 거부된 경우는 다시 해도 같다. 바로 멈춘다.
        if (/OpenAI API 실패|응답을 해석하지 못함/.test(message)) throw articleError;
        if (시도 === 2) {
          throw new Error(`두 번 만들어 봤지만 점검을 통과하지 못했어요: ${message}`);
        }
        console.log("  본문을 다시 쓰는 중");
      }
    }
    // 분량이 모자라면 실패시키지 않고 이어 써서 채운다 (최대 2번). 그래도 모자라면 그대로 올린다 — 임시글은 무조건 만든다.
    for (let 보충 = 1; 보충 <= 2 && 짧음; 보충 += 1) {
      const 현재 = stripTags(html).replace(/\s/g, "").length;
      try {
        const 더 = await extendArticle({apiKey: env.OPENAI_API_KEY, model, title, html, 부족자수: minChars - 현재});
        const 합침 = `${html.trim()}\n\n${더.추가}`;
        validateArticleHtml(합침, title, {minChars: 0, focusKeyword: meta.focusKeyword}); // 표·끊긴 태그 검사만 (분량은 따지지 않는다)
        html = 합침;
        articleUsage = mergeUsage(articleUsage, 더.usage);
        짧음 = stripTags(html).replace(/\s/g, "").length < minChars;
      } catch (extendError) {
        const message = extendError instanceof Error ? extendError.message : String(extendError);
        if (/OpenAI API 실패|응답을 해석하지 못함/.test(message)) throw extendError;
        break; // 보충이 안 되면 지금 본문 그대로 올린다
      }
    }
    const usage = mergeUsage(metaUsage, articleUsage);
    let selectedCategory = null;
    if (titleEntryHasCategory(titleEntry)) {
      selectedCategory = await ensureMappedCategory({categories: wordpressCategories, titleEntry, siteUrl, username, appPassword});
      if (!selectedCategory) {
        console.log("  카테고리 매핑: 제목 파일의 대표/세부 카테고리를 찾지 못해 자동 점수 선택을 건너뜀");
      }
    } else {
      selectedCategory = selectBestCategory(wordpressCategories, {title, meta});
    }
    단계(index + 1, titles.length, "그림 만드는 중 (20~40초)");
    const generatedImage = await generateFeaturedImage({apiKey: env.OPENAI_API_KEY, title, meta, usdKrw});
    단계(index + 1, titles.length, "워드프레스에 올리는 중");
    const featuredMedia = await uploadFeaturedImage({siteUrl, username, appPassword, title, meta, generatedImage});
    const htmlWithImage = insertImageBlockIntoArticle(html, buildArticleImageBlock({media: featuredMedia}));
    validateArticleHtml(htmlWithImage, title, {focusKeyword: meta.focusKeyword});
    validateInlineImageBlock(htmlWithImage, featuredMedia);
    const localPath = join(outputDir, `${String(index + 1).padStart(3, "0")}_${safeFilename(title)}.html`);
    const visiblePath = join(visibleOutputDir, `${String(index + 1).padStart(3, "0")}_${safeFilename(title)}.html`);
    writeFileSync(localPath, htmlWithImage, "utf8");
    writeFileSync(visiblePath, htmlWithImage, "utf8");

    const postDate = postDateForIndex(index + dateOffset, dateMode, startDate, {randomDays, fixedTime, stepDays, hourGap, perDay, minGapHours, 피할시각들: 잡힌시각들, slotStartTime, slotGapMinutes});
    if (postDate) 잡힌시각들.push(Date.parse(postDate)); // 이번 실행에서 잡은 시각도 다음 글이 피하게
    let post = await createDraftPost({siteUrl, username, appPassword, title, html: htmlWithImage, date: postDate, meta, featuredMediaId: featuredMedia.id, selectedCategory});
    if (!postHasInlineImage(post, featuredMedia)) {
      post = await updateDraftPostContent({siteUrl, username, appPassword, postId: post.id, html: htmlWithImage, featuredMediaId: featuredMedia.id, selectedCategory});
    }
    if (!postHasInlineImage(post, featuredMedia)) {
      throw new Error("워드프레스 임시글 본문에 이미지 블록이 저장되지 않았습니다.");
    }

    // 랭크매스 포커스 키워드. 없는 사이트면 조용히 건너뛰되, 화면에는 왜 안 됐는지 남긴다.
    // (조용히 넘어가면 "됐다고 나오는데 실제로는 비어 있는" 사고가 난다)
    const rankMath = await applyRankMathKeyword({siteUrl, username, appPassword, postId: post.id, meta});
    if (!rankMath.ok && rankMath.reason !== "키워드 없음") {
      console.log(`     (랭크매스 키워드는 넣지 못했어요: ${rankMath.reason})`);
    }

    const textCost = estimateCost({model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usdKrw});
    const estimatedUsd = Number((textCost.estimatedUsd + generatedImage.estimatedUsd).toFixed(6));
    const estimatedKrw = Number((textCost.estimatedKrw + generatedImage.estimatedKrw).toFixed(1));
    results.push({
      site,
      title,
      ok: true,
      postId: post.id,
      date: post.date || postDate,
      status: "draft",
      slug: post.slug || meta.slug,
      focusKeyword: meta.focusKeyword,
      summary: articleSummary,
      featuredImageAlt: meta.featuredImageAlt,
      featuredMediaId: featuredMedia.id,
      featuredImageUrl: featuredMedia.sourceUrl,
      inlineImageInserted: true,
      inlineImageMediaId: featuredMedia.id,
      postContentImageVerified: true,
      inlineImageAlt: featuredMedia.altText,
      inlineImageCaption: featuredMedia.caption,
      mappedParentCategory: titleEntry.parentCategory || "",
      mappedChildCategory: titleEntry.childCategory || "",
      mappedChildCategoryDescription: titleEntry.childCategoryDescription || "",
      categoryId: selectedCategory?.id || 0,
      parentCategoryId: selectedCategory?.parentId || 0,
      categoryIds: categoryIdsForPayload(selectedCategory),
      categoryName: selectedCategory?.name || "",
      categoryScore: selectedCategory?.score ?? null,
      categorySelectionSource: selectedCategory?.source || "none",
      imageModel: generatedImage.imageModel,
      imageQuality: generatedImage.imageQuality,
      imageSize: generatedImage.imageSize,
      imageOutputFormat: generatedImage.imageOutputFormat,
      editLink: post.link || "",
      localPath,
      visiblePath,
      model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      text_estimated_usd: textCost.estimatedUsd,
      text_estimated_krw: textCost.estimatedKrw,
      image_estimated_usd: generatedImage.estimatedUsd,
      image_estimated_krw: generatedImage.estimatedKrw,
      estimated_usd: estimatedUsd,
      estimated_krw: estimatedKrw,
    });
    const categorySourceLabel = selectedCategory?.source ? `(${selectedCategory.source})` : "";
    const categoryLabel = selectedCategory ? ` / 카테고리 ${selectedCategory.name}${categorySourceLabel}` : " / 카테고리 미지정";
    // 이 글은 위에서 results 에 이미 담겼다. 여기서 또 더하면 두 배로 세어진다.
    // (실측에서 1개를 만들었는데 "지금까지 2개 · 약 73원" 으로 찍혔다)
    const 지금까지완료 = results.filter((item) => item.ok && !item.skipped).length;
    const 지금까지비용 = results.reduce((sum, item) => sum + Number(item.estimated_krw || 0), 0);
    // 원장에 적고, 남은 돈을 다시 계산한다. 이 두 줄은 실패해도 글은 이미 올라갔으니 조용히 넘어가지 않고 이유를 남긴다.
    const 이글 = {input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens, usd: estimatedUsd, krw: estimatedKrw};
    이번실행.글수 += 1;
    이번실행.krw += estimatedKrw;
    이번실행.usd += estimatedUsd;
    이번실행.total_tokens += usage.totalTokens;
    try {
      원장기록({site, title, model, ...이글});
      예산 = 예산상태({env, usdKrw});
    } catch (ledgerError) {
      console.log(`     (사용량 기록 실패: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)})`);
    }
    console.log(`  ✅ 완료 · 이 글 약 ${estimatedKrw}원 · 지금까지 ${지금까지완료}개 · 약 ${Math.round(지금까지비용)}원`);
    console.log(`     (임시글 ID ${post.id} / 키워드 ${meta.focusKeyword}${categoryLabel} / 날짜 ${post.date || postDate || "기본값"})`);
    const [돈1, 돈2] = 돈줄({이글, 이번실행, 예산});
    console.log(돈1);
    console.log(돈2);
    진행.글완료(예산.있음 ? `지금까지 ${예산.쓴글수}개 · 약 ${천단위(예산.쓴krw)}원 (${퍼센트문구(예산.쓴퍼센트)}) · 남은 돈 약 ${천단위(예산.남은krw)}원 (${퍼센트문구(예산.남은퍼센트)})` : `이번 실행 ${이번실행.글수}개 · 약 ${천단위(이번실행.krw)}원`);
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|certificate/i.test(message)) {
      message += " → 사이트 주소를 확인해주세요. https:// 를 포함한 전체 도메인(예: https://example.com)인지, 오타가 없는지 확인한 뒤 다시 실행하면 됩니다.";
    }
    results.push({site, title, ok: false, error: message});
    console.log(`  실패: ${message}`);
    if (진행) 진행.글실패();
  }
}
if (진행) 진행.끝(results.filter((item) => item.ok && !item.skipped).length > 0 ? "다 됐어요 ✅" : "끝 (새로 만든 글 없음)");

writeFileSync(join(outputDir, "last-run.json"), JSON.stringify(results, null, 2), "utf8");
writeFileSync(join(visibleOutputDir, "last-run.json"), JSON.stringify(results, null, 2), "utf8");
const draftHistory = mergeDraftHistory(previousDraftHistory, results);
writeFileSync(join(outputDir, "draft-history.json"), JSON.stringify(draftHistory, null, 2), "utf8");
writeFileSync(join(visibleOutputDir, "draft-history.json"), JSON.stringify(draftHistory, null, 2), "utf8");

const costSummary = results.reduce(
  (acc, item) => {
    if (!item.ok || item.skipped) return acc;
    acc.success += 1;
    acc.input_tokens += Number(item.input_tokens || 0);
    acc.output_tokens += Number(item.output_tokens || 0);
    acc.total_tokens += Number(item.total_tokens || 0);
    acc.text_estimated_usd += Number(item.text_estimated_usd || 0);
    acc.text_estimated_krw += Number(item.text_estimated_krw || 0);
    acc.image_estimated_usd += Number(item.image_estimated_usd || 0);
    acc.image_estimated_krw += Number(item.image_estimated_krw || 0);
    acc.estimated_usd += Number(item.estimated_usd || 0);
    acc.estimated_krw += Number(item.estimated_krw || 0);
    return acc;
  },
  {
    site,
    model,
    imageModel: env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
    imageQuality: env.IMAGE_QUALITY || DEFAULT_IMAGE_QUALITY,
    imageSize: env.IMAGE_SIZE || DEFAULT_IMAGE_SIZE,
    success: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    text_estimated_usd: 0,
    text_estimated_krw: 0,
    image_estimated_usd: 0,
    image_estimated_krw: 0,
    estimated_usd: 0,
    estimated_krw: 0,
    usd_krw: usdKrw,
  },
);
costSummary.text_estimated_usd = Number(costSummary.text_estimated_usd.toFixed(6));
costSummary.text_estimated_krw = Number(costSummary.text_estimated_krw.toFixed(1));
costSummary.image_estimated_usd = Number(costSummary.image_estimated_usd.toFixed(6));
costSummary.image_estimated_krw = Number(costSummary.image_estimated_krw.toFixed(1));
costSummary.estimated_usd = Number(costSummary.estimated_usd.toFixed(6));
costSummary.estimated_krw = Number(costSummary.estimated_krw.toFixed(1));
writeFileSync(join(outputDir, "cost-summary.json"), JSON.stringify(costSummary, null, 2), "utf8");
writeFileSync(join(visibleOutputDir, "cost-summary.json"), JSON.stringify(costSummary, null, 2), "utf8");

const success = results.filter((item) => item.ok && !item.skipped).length;
const skippedCount = results.filter((item) => item.skipped).length;
const failedCount = results.length - success - skippedCount;

console.log("");
console.log("============================================");
if (success > 0) {
  console.log(`  ✅ 다 됐어요! 새 글 ${success}개를 저장했어요`);
  console.log("     워드프레스 임시글에 들어 있어요. 글을 확인한 뒤 발행하세요");
  console.log(`     이번에 든 돈: 약 ${Math.round(costSummary.estimated_krw)}원 · 토큰 ${천단위(costSummary.total_tokens)}개 (글 1개 평균 약 ${천단위(costSummary.estimated_krw / success)}원, 토큰 ${천단위(costSummary.total_tokens / success)}개)`);
  if (예산.있음) {
    console.log(`     💰 충전액 ${천단위(예산.예산krw)}원 중 ${퍼센트문구(퍼센트(costSummary.estimated_usd, 예산.예산usd))} 를 이번에 씀 · 지금까지 ${예산.쓴글수}개 · 약 ${천단위(예산.쓴krw)}원 (${퍼센트문구(예산.쓴퍼센트)})`);
    console.log(`     💰 남은 돈 약 ${천단위(예산.남은krw)}원 (${퍼센트문구(예산.남은퍼센트)} 남음)${예산.남은usd > 0 ? ` → 지금 속도면 약 ${Math.floor(예산.남은usd / (costSummary.estimated_usd / success))}개 더 만들 수 있어요` : " → 충전이 필요해요"}`);
  } else {
    console.log(`     💰 전체 누적 ${예산.전체.글수}개 · 약 ${천단위(예산.전체.krw)}원`);
  }
} else {
  console.log("  새로 만든 글이 없어요");
}
console.log("============================================");
if (skippedCount > 0) console.log(`이미 있어서 건너뛴 제목 ${skippedCount}개 (같은 글을 두 번 만들지 않아요)`);
if (failedCount > 0) {
  console.log(`점검을 통과하지 못한 제목 ${failedCount}개 — 워드프레스에 올리지 않았어요.`);
  console.log("다시 실행하면 그 제목부터 다시 만듭니다.");
}
console.log("");

// 작업이 끝났다고 소리로 알린다. 다른 탭을 보고 있어도 들리게.
// (브라우저나 기기를 음소거해 두면 안 들리므로 위 배너가 본체다)
if (process.stdout.isTTY) process.stdout.write("");

// 중복 건너뜀은 실패가 아니다.
//
// 예전에는 건너뛴 게 하나만 있어도 종료코드 1 이 되었고, 여러 사이트를 도는 스크립트가
// 그걸 실패로 읽어 사이트2 부터는 아예 실행하지 않고 조용히 끝났다.
if (failedCount > 0) process.exitCode = 1;
