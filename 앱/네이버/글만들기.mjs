// 글만들기.mjs — OpenAI API 로 원고(JSON)와 사진을 만들어 01_원고넣는곳 / 02_사진넣는곳 에 넣는다.
//
//   앱 판: 로더가 GitHub 에서 임시 폴더로 받아 오고, 앱/네이버.mjs 가 부른다.
//   await 글.만들기({ 키: "sk-...", 키워드: "…", 저장폴더: "<수강생 폴더>/네이버 승인글/03_쓴글/날짜_키워드" });
//
// 원칙
//   · 벤치마크 글의 문장은 절대 그대로 쓰지 않는다. 섹션 흐름 · 표 구성 · 사진 배치만 가져온다.
//   · 사실(제도 이름, 금액, 신청처)은 벤치마크에서 정리해 넘긴 '사실 요약' 안에서만 쓴다. 지어내지 않는다.
//   · 사진은 정사각형 파스텔 일러스트. 사람이 들어가면 얼굴이 안 보이게(뒷모습·옆모습).
//   · 사진에는 어떤 언어의 글자도 넣지 않는다 (2026-09-21 진현님 지시). 그래서 글 모델이 준 장면 묘사에서 한글을 지우고,
//     최종 그림 프롬프트는 이 파일의 최종그림프롬프트() 가 만든다. 글 모델에게 맡기지 않는다.
//   · process 전역을 쓰지 않는다 (Codex REPL 에서도 돌아야 한다).

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 고칠 때마다 올린다 (앱/배포.sh 가 커밋에 고정해 배포한다).
export const 버전 = "2026-09-23e";

const 여기 = path.dirname(fileURLToPath(import.meta.url));
const 프로젝트 = path.resolve(여기, "..");
const 정보이미지기준파일 = path.join(여기, "이미지프롬프트_기준.md");
let 정보이미지기준캐시 = "";
async function 정보이미지기준읽기() {
  if (정보이미지기준캐시) return 정보이미지기준캐시;
  try { 정보이미지기준캐시 = await readFile(정보이미지기준파일, "utf8"); } catch {}
  return 정보이미지기준캐시 || "Use a clean Korean presentation-style information graphic: bright background, generous whitespace, navy purple and light blue accents, large readable Korean type, only verified facts from the related section.";
}

// 2026-09-23 진현님: 글 1개 50원 이하 (승인글처럼). 예전 gpt-5.2 + gpt-image-2 보통 화질은 약 390원이었고 그중 사진 3장이 85%.
// 그래서 글은 승인글과 같은 gpt-5.4-mini. 사진은 진현님 결정으로 한 단계 위 gpt-image-2 저화질 (장당 약 10원, 1-mini 저화질은 약 4원이지만 품질 차이가 큼).
// 글 1개 약 64원 (글 약 33원 + 사진 3장 약 31원, 2026-09-23 실측).
const 글모델 = "gpt-5.4-mini";
const 그림모델 = "gpt-image-2";
const 그림화질 = "low";

async function 오픈AI(키, 경로, body) {
  const r = await fetch("https://api.openai.com/v1" + 경로, {
    method: "POST",
    headers: { Authorization: `Bearer ${키}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${경로} ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// 원고 JSON 의 형식 (naver-typing.mjs 가 읽는 그대로) + 사진 블록에 '프롬프트' 를 더 받는다
const 원고형식 = {
  type: "object",
  additionalProperties: false,
  properties: {
    제목: { type: "string" },
    블록: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          종류: { type: "string", enum: ["문단", "소제목", "인용구", "표", "구분선", "사진"] },
          글: { type: "array", items: { type: "string" }, description: "문단은 줄 배열, 소제목·인용구는 한 줄짜리 배열, 나머지는 빈 배열" },
          칸: { type: "array", items: { type: "string" }, description: "표만. 3열 기준으로 왼쪽→오른쪽, 위→아래. 최대 9칸. 나머지는 빈 배열" },
          프롬프트: { type: "string", description: "사진만. 일러스트는 영어 장면 묘사, 정보 이미지는 시각 요소와 레이아웃을 영어로 묘사. 나머지는 빈 문자열" },
          이미지유형: { type: "string", enum: ["일러스트", "정보"], description: "사진만. 신청·대상·조건·서류·기한·금액·혜택·주의처럼 한눈에 정리할 소제목만 정보, 나머지는 일러스트" },
          정보문구: { type: "array", items: { type: "string" }, description: "정보 사진만. 소제목 질문에 직접 답하는 한글 문구: 제목 1개와 핵심 항목 3~5개. 본문에서 확인된 사실만. 일러스트와 나머지는 빈 배열" },
        },
        required: ["종류", "글", "칸", "프롬프트", "이미지유형", "정보문구"],
      },
    },
  },
  required: ["제목", "블록"],
};

// 네이버 블로그 글 주소를 주면 뼈대(제목·인용구 제목·표·사진 개수·문단 요지)를 뽑는다. 모바일 페이지가 파싱하기 쉽다.
export async function 벤치마크가져오기(주소) {
  const m = /blog\.naver\.com\/([^/?#]+)\/(\d+)/.exec(주소) || /blogId=([^&]+).*logNo=(\d+)/.exec(주소);
  if (!m) throw new Error("네이버 블로그 글 주소가 아닙니다: " + 주소);
  const r = await fetch(`https://m.blog.naver.com/${m[1]}/${m[2]}`, {
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`벤치마크 글을 못 읽음: HTTP ${r.status}`);
  const h = await r.text();
  const 풀기 = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|​/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  const 제목 = 풀기((/<title>(.*?)<\/title>/s.exec(h) || [, ""])[1]).replace(/\s*:\s*네이버 블로그$/, "");
  const 컴포넌트 = [...h.matchAll(/<div class="se-component se-([a-zA-Z]+)/g)].map((x) => x[1]).filter((x) => x !== "documentTitle");
  const 인용구 = [...h.matchAll(/<div class="se-component se-quotation.*?<\/div>\s*<\/div>\s*<\/div>/gs)].map((x) => 풀기(x[0]).slice(0, 60)).filter(Boolean);
  const 표들 = [...h.matchAll(/<div class="se-component se-table.*?<\/table>/gs)].map((t) => [...t[0].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => 풀기(c[1])));
  const 문단 = [...h.matchAll(/<(?:p|span) class="se-text-paragraph[^"]*"[^>]*>(.*?)<\/(?:p|span)>/gs)].map((x) => 풀기(x[1])).filter((x) => x.length > 15);
  // 도입부(첫 인용구 제목이 나오기 전까지의 본문 문단) — 후킹을 참고하려고 따로 뽑는다
  const 첫인용 = h.search(/<div class="se-component se-quotation/);
  const 앞부분 = 첫인용 > 0 ? h.slice(0, 첫인용) : h.slice(0, Math.floor(h.length / 4));
  const 도입부 = [...앞부분.matchAll(/<(?:p|span) class="se-text-paragraph[^"]*"[^>]*>(.*?)<\/(?:p|span)>/gs)]
    .map((x) => 풀기(x[1])).filter((x) => x.length > 8 && x !== 제목).slice(0, 6);
  return {
    출처: 주소, 원문제목: 제목,
    도입부_후킹참고: 도입부,
    컴포넌트순서: 컴포넌트,
    섹션순서_인용구제목: 인용구,
    표: 표들.filter((t) => t.length >= 6).map((t) => t.slice(0, 24)),
    사진수: 컴포넌트.filter((c) => c === "image").length,
    // 문장을 베끼지 않도록 '요지' 로만 넘긴다: 문단 앞 80자
    문단요지: 문단.slice(0, 40).map((p) => p.slice(0, 80)),
  };
}

export async function 원고쓰기({ 키, 벤치마크, 키워드, 사진수 = 5 }) {
  const 뼈대설명 = 벤치마크
    ? `아래 '벤치마크 구조' 는 참고할 글의 뼈대다. 섹션 순서와 표 · 사진 배치는 그대로 따르되, 문장은 전부 새로 써라.
벤치마크 글의 문장을 기억하고 있더라도 절대 그대로 옮기지 마라. '문단요지' 는 어떤 내용을 다뤘는지 알기 위한 것이지 베낄 문장이 아니다. 제목도 새로 짓되 핵심 키워드는 유지한다.
사실(제도 이름, 금액, 조건, 신청처)은 벤치마크에 나온 것만 쓴다. 없는 수치는 만들지 않는다.`
    : `주제 키워드: "${키워드}". 이 키워드로 검색해 들어온 독자가 궁금해할 것을 순서대로 푼다.
소제목 5~6개, 그중 하나에 표 1개. 확실하지 않은 금액·날짜·기관명은 쓰지 말고 "주소지 관할 기관에 확인" 처럼 안내한다.`;
  const 후킹규칙 = `
[가장 중요: 첫 문단(후킹)]
- 첫 문단은 딱 3줄. 이 3줄이 글의 성패를 가른다.
  1줄: 독자의 지금 상황·걱정을 정확히 찌른다 (예: "부모님 생신이 두 달 남았는데 아직 아무것도 안 알아보셨다면").
  2줄: 이 글을 끝까지 읽으면 무엇을 얻는지 한 문장으로 요약한다 (대상·금액·방법 같은 핵심을 구체어로).
  3줄: 지금 바로 확인해야 하는 이유와 행동 유도 (기한·놓치면 손해·1분이면 확인 같은 말로).
- 3줄 사이에는 빈 줄("") 을 넣지 않는다. 그 다음 문단부터 평소대로.
${벤치마크 && 벤치마크.도입부_후킹참고 && 벤치마크.도입부_후킹참고.length ? `- '도입부_후킹참고' 는 참고 글의 도입부다. 어떤 순서로 독자를 끌어당기는지, 어느 정도 세게 말하는지, 무엇을 약속하는지를 배워라. 그 강도와 구조를 그대로 살리되 문장·표현·예시는 전부 새로 써라. 한 문장이라도 그대로 옮기면 실패다.` : ""}`;
  const 지시 = `당신은 한국 네이버 블로그 정보성 글을 쓰는 작가다. 존댓말, 짧은 문장, 40~60대 독자가 읽기 쉬운 말투.
${뼈대설명}
${후킹규칙}

[행동으로 이어지는 정보 글 규칙]
- 먼저 키워드가 정부정책·지역 지원·복지·공공 제도인지, 스타·연예·방송 이슈인지 구분하고 그 주제에 맞는 구조만 적용한다. 두 유형의 소제목과 안내를 섞지 않는다.
- 정부정책·지역 지원·복지·공공 제도 글은 독자가 "내가 대상인지", "얼마를 받는지", "어디에 무엇을 내는지", "언제까지 무엇을 해야 하는지", "무엇을 먼저 하면 안 되는지"를 스스로 판단하고 행동할 수 있게 쓴다.
- 스타·연예·방송 이슈 글은 독자가 사건의 핵심, 인물·방송의 배경, 확인된 시간 순서, 공식 발표와 반응의 구분, 이후 확인할 방송·공식 일정·출처를 이해하게 쓴다. 확인되지 않은 소문·추측·사생활·가짜 인용은 쓰지 않는다.
- 소제목은 정보 이름만 쓰지 말고 독자의 질문에 답하는 문장으로 쓴다. 각 소제목의 첫 문단은 결론부터 말하고, 그 뒤에 조건·예외·행동 순서를 구체적으로 설명한다.
- 정부정책 글의 소제목은 지원 내용과 최대 혜택, 대상·자격·제외 대상, 금액·한도·계산 예시, 실제 신청·발급 절차, 준비서류와 제출처, 기한·예산 소진·주의사항, 마지막 "지금 바로 할 일"을 빠짐없이 다룬다.
- 스타·연예·방송 이슈 글의 소제목은 핵심 이슈 요약, 인물·프로그램 배경, 확인된 사건 또는 방송 흐름, 공식 발표·방송 장면·반응의 구분, 앞으로 확인할 방송·공식 일정·출처 순서로 구성한다. 신청·지원금·서류·기한 같은 정부정책 소제목을 억지로 넣지 않는다.
- 정부정책 글의 대상·자격에는 거주지·연령·소득·세대·우선순위·제외 대상을, 신청·발급에는 확인 → 준비 → 신청 또는 발급 → 수령 또는 사용의 실제 순서를 쓴다.
- 정부정책 글의 준비서류는 서류 이름을 목록으로 적고, 공고마다 달라질 수 있는 항목은 "최신 공고 확인"이라고 분명히 표시한다.
- 정부정책 글의 금액은 최대 금액만 쓰지 말고 지원 비율·상한·계산 예시를 함께 쓴다.
- "확인하세요", "문의하세요"처럼 끝내지 않는다. 무엇을, 어디에, 어떤 순서로 확인해야 하는지 함께 쓴다.
- 정부정책 글의 주의사항에는 구매·신청·발급 전에 하면 안 되는 행동, 예산 소진·선착순·기한·환수·재신청 제한처럼 놓치기 쉬운 내용을 넣는다.
- 정부정책 글의 마지막 소제목 "지금 바로 할 일" 아래에는 최신 공고 확인, 남은 예산 확인, 준비서류 발급, 신청처 방문 또는 온라인 신청처럼 독자가 바로 할 행동을 2~4개로 정리한다.
- 날짜·금액·기관명·전화번호·자격 조건이 확실하지 않으면 지어내지 말고 최신 공고와 주소지 관할 기관 확인이 필요하다고 쓴다.

블록 규칙
- 문단: 3~4줄, 한 줄은 40~60자. 줄 사이 빈 줄("") 을 넣어 호흡을 준다.
- 분량이 가장 자주 모자란다. 각 소제목 아래에는 문단 블록을 반드시 2개 이상 둔다 (대상·조건·방법·주의·예시를 구체적으로). 첫 후킹 문단 뒤에도 도입 문단을 1개 더 둔다.
- 단락(섹션) 제목은 반드시 '소제목' 블록으로 넣는다 (검색 노출에 소제목이 유리하다). 벤치마크의 '섹션순서_인용구제목' 은 제목의 순서·내용만 참고하고, 블록 종류는 소제목으로 바꾼다. 소제목은 5~7개, 각 15자 안팎, 키워드가 자연스럽게 들어가게.
- '인용구' 블록은 강조용이다. 글 전체에서 2~3개만, 본문 중간에서 독자가 꼭 기억해야 할 한 문장(핵심 결론·주의·행동)을 넣는다. 소제목 자리에 인용구를 쓰지 않는다.
- 표는 정확히 9칸(3열×3행): 첫 줄은 열 이름, 그 다음 두 줄은 대표 사례 2개.
- 사진은 총 ${사진수}장. 각 사진의 '프롬프트' 는 그 섹션의 메시지를 상징하는 장면을 영어로 1~2문장 묘사한다. 원문 문장을 그리지 않는다.
  사물·장소·상황·분위기만 쓴다. 간판·문서·서류·화면·책·표지판·현수막·포스터처럼 글자가 들어갈 만한 것은 넣지 않는다. 한국어 단어·제도 이름·숫자는 쓰지 않는다.
  사람을 그릴 때는 "seen from behind or in profile, face not visible" 를 넣는다. 화풍·글자 금지 규칙은 프로그램이 붙이므로 쓰지 않는다.
- 사진은 총 ${사진수}장으로 고정한다. 모든 소제목에 사진을 넣지 않는다.
- 소제목이 지원 대상·자격·조건, 신청·발급 절차, 제출 서류, 기한, 지원 금액·한도·혜택, 사용처, 주의사항·유의사항이면 우선 '정보' 사진으로 고른다. 그 외의 소제목은 '일러스트'로 둔다.
- '정보' 사진은 정보 이미지를 써도 이해가 좋아지는 소제목에만 쓴다. 소제목 제목만 보여 주는 장식 이미지는 금지한다. '정보문구'에는 해당 소제목의 질문에 직접 답하는 한글을 제목 1개와 항목 3~5개로 넣는다.
- 대상·자격·조건은 가능한 사람·제외 대상·거주지·나이·소득·보유 조건을 나열한다. 신청·발급 방법은 신청처부터 수령·사용까지 실제 행동을 3~5단계로 표시한다. 제출 서류는 체크리스트로, 금액·한도·혜택은 큰 숫자나 비교표로, 기한·주의사항은 경고형 체크리스트로 구성한다.
- 본문의 확인된 내용만 쓰며, 확인되지 않은 숫자·날짜·금액·기관명·전화번호는 넣지 않는다. 공고마다 달라질 수 있는 서류나 기한은 '최신 공고 확인'으로 표시한다.
- '정보' 사진의 프롬프트는 해당 소제목에 맞는 레이아웃을 영어로 적는다. 절차는 순서도, 대상·조건은 카드형 요약, 금액·한도는 큰 숫자 중심, 주의사항은 체크형 요약처럼 가장 알맞은 구성을 고른다.
- '일러스트' 사진은 기존 규칙처럼 글자가 없는 영어 장면 묘사와 빈 '정보문구' 배열을 쓴다.
- 사진 블록은 선택된 소제목 바로 아래 첫 문단 다음에 하나씩 둔다. 글 끝에 몰아 넣지 않는다.
- 구분선은 마지막 문단 앞에 한 번.
- 전체 문단 글자 수(띄어쓰기 빼고)는 1,800~2,600자. 1,800자보다 짧으면 실패다.`;

  const 입력 = 벤치마크 ? `벤치마크 구조:\n${JSON.stringify(벤치마크, null, 1)}` : `주제 키워드: ${키워드}`;
  const j = await 오픈AI(키, "/responses", {
    model: 글모델,
    input: [{ role: "developer", content: 지시 }, { role: "user", content: 입력 }],
    text: { format: { type: "json_schema", name: "naver_post", schema: 원고형식, strict: true } },
    reasoning: { effort: "low" },
  });
  const 꺼내기 = (응답) => {
    const 본문 = (응답.output || []).flatMap((o) => o.content || []).find((c) => c.type === "output_text");
    if (!본문) throw new Error("글 모델이 본문을 안 돌려줌: " + JSON.stringify(응답).slice(0, 300));
    return JSON.parse(본문.text);
  };
  const 쓴돈 = [{ model: 글모델, input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0 }];
  let 원고 = 꺼내기(j);
  // 분량 보충 — 싼 모델은 글을 짧게 쓰는 버릇이 있다 (2026-09-23 실측 704자). 모자라면 한 번 늘려 쓰게 한다. 수강생에게는 알리지 않는다.
  const 글자수 = (w) => (w.블록 || []).filter((b) => b.종류 === "문단").flatMap((b) => b.글 || []).join("").replace(/\s/g, "").length;
  if (글자수(원고) < 1800) {
    const j2 = await 오픈AI(키, "/responses", {
      model: 글모델,
      input: [
        { role: "developer", content: 지시 },
        { role: "user", content: 입력 },
        { role: "assistant", content: JSON.stringify(원고) },
        { role: "user", content: `문단 글자 수가 ${글자수(원고)}자라 너무 짧다. 제목·소제목·표·인용구·사진·구분선의 순서와 내용은 그대로 두고, 각 소제목 아래 문단을 늘리거나 문단 블록을 더해 전체 문단 글자 수(띄어쓰기 빼고)를 2,000자 안팎으로 맞춘 전체 원고를 같은 JSON 형식으로 다시 줘라. 새 문장은 구체적인 정보(대상·조건·방법·주의)로 채운다.` },
      ],
      text: { format: { type: "json_schema", name: "naver_post", schema: 원고형식, strict: true } },
      reasoning: { effort: "low" },
    });
    쓴돈.push({ model: 글모델, input_tokens: j2.usage?.input_tokens || 0, output_tokens: j2.usage?.output_tokens || 0 });
    try { const 늘린 = 꺼내기(j2); if (글자수(늘린) > 글자수(원고)) 원고 = 늘린; } catch {}
  }
  // 사진 자리 채우기 — 싼 모델이 사진 블록을 통째로 빼먹을 때가 있다 (2026-09-23 실측: 33블록 중 사진 0).
  // 모자란 만큼 소제목에 맞는 영어 장면 묘사를 따로 받아, 소제목 사이에 고르게 넣는다. 수강생에게는 알리지 않는다.
  const 있는사진 = (원고.블록 || []).filter((b) => b.종류 === "사진").length;
  if (있는사진 < 사진수) {
    const 모자람 = 사진수 - 있는사진;
    const 소제목들 = (원고.블록 || []).map((b, i) => ({ i, b })).filter((x) => x.b.종류 === "소제목");
    const 고른 = 소제목들.length ? Array.from({ length: 모자람 }, (_, k) => 소제목들[Math.min(소제목들.length - 1, Math.floor(((k + 0.5) * 소제목들.length) / 모자람))]) : [];
    let 장면들 = [];
    try {
      const j3 = await 오픈AI(키, "/responses", {
        model: 글모델,
        input: [{ role: "user", content: `블로그 글 "${원고.제목}" 에 넣을 사진 ${모자람}장의 장면을 영어로 묘사해라. 각 사진은 아래 소제목 하나씩의 메시지를 상징하는 장면이다. 사물·장소·상황·분위기만, 글자가 들어갈 만한 것(간판·문서·화면·책)과 사람 얼굴은 넣지 않는다. 1~2문장씩.\n${고른.map((x, k) => `${k + 1}. ${[].concat(x.b.글).join(" ")}`).join("\n")}` }],
        text: { format: { type: "json_schema", name: "scenes", strict: true, schema: { type: "object", additionalProperties: false, properties: { scenes: { type: "array", items: { type: "string" } } }, required: ["scenes"] } } },
        reasoning: { effort: "low" },
      });
      쓴돈.push({ model: 글모델, input_tokens: j3.usage?.input_tokens || 0, output_tokens: j3.usage?.output_tokens || 0 });
      장면들 = 꺼내기(j3).scenes || [];
    } catch {}
    // 뒤에서부터 넣어야 앞 위치가 안 밀린다. 소제목 바로 다음 문단 뒤에 넣는다.
    const 넣을곳 = 고른.map((x, k) => {
      let 위치 = x.i + 1;
      if (원고.블록[위치] && 원고.블록[위치].종류 === "문단") 위치 += 1;
      return { 위치, 프롬프트: 장면들[k] || `A calm, warm everyday scene that suggests: ${원고.제목}` };
    }).sort((a, b) => b.위치 - a.위치);
    for (const x of 넣을곳) 원고.블록.splice(x.위치, 0, { 종류: "사진", 글: [], 칸: [], 프롬프트: x.프롬프트, 이미지유형: "일러스트", 정보문구: [] });
  }
  원고.블록 = await 정보이미지확정({키, 제목: 원고.제목, 블록들: 원고.블록 || [], 사진수, 사용량: 쓴돈});
  Object.defineProperty(원고, "_사용량", { value: 쓴돈, enumerable: false });
  return 원고;
}

// 소제목을 먼저 골라 정보 이미지로 확정한다. 글 모델이 사진 종류를 임의로 고르지 못하게 한다.
function 정보이미지소제목(블록들, 사진수) {
  const 섹션 = [];
  let 현재 = null;
  for (const b of 블록들 || []) {
    if (b?.종류 === "소제목") {
      현재 = {제목: (b.글 || []).join(" ").trim(), 본문: []};
      섹션.push(현재);
    } else if (현재 && b?.종류 === "문단") 현재.본문.push((b.글 || []).join(" ").trim());
  }
  const 점수 = (제목) => {
    const t = String(제목 || "");
    if (/(신청|발급|절차|방법)/.test(t)) return 100;
    if (/(서류|제출|준비물)/.test(t)) return 95;
    if (/(주의|유의|주의사항)/.test(t)) return 90;
    if (/(대상|자격|조건)/.test(t)) return 85;
    if (/(금액|한도|지원금|혜택)/.test(t)) return 80;
    if (/(기한|기간|사용처)/.test(t)) return 75;
    return 10;
  };
  return 섹션.map((s, 순서) => ({...s, 순서, 점수: 점수(s.제목)}))
    .sort((a, b) => b.점수 - a.점수 || a.순서 - b.순서).slice(0, 사진수);
}
async function 정보이미지확정({키, 제목, 블록들, 사진수, 사용량}) {
  const 대상 = 정보이미지소제목(블록들, 사진수);
  const 기존사진 = (블록들 || []).filter((b) => b?.종류 === "사진");
  const 본문 = (블록들 || []).filter((b) => b?.종류 !== "사진");
  if (!대상.length || !기존사진.length) return 사진고르게(블록들 || []);

  let 계획 = [];
  try {
    const j = await 오픈AI(키, "/responses", {
      model: 글모델,
      input: [{
        role: "developer",
        content: "당신은 한국 네이버 블로그의 정보 이미지를 기획한다. 아래에서 정한 소제목마다 한 장의 정보 이미지에 표시할 정확한 한글 문구를 작성한다. 소제목의 질문에 직접 답해야 한다. 첫 줄은 이미지 제목, 그 뒤에는 본문에서 확인되는 핵심 항목 3~5개를 쓴다. 대상·조건은 대상자·제외·자격을, 신청·발급 방법은 실제 행동 순서를, 서류는 준비물 목록을, 주의사항은 추가 확인 사항을 쓴다. 원문에 없는 숫자·날짜·금액·기관명·전화번호를 만들지 마라. 불확실한 항목은 '최신 공고 확인'으로만 쓴다. 제목만 반복하거나 추상적인 문구를 쓰지 마라."
      }, {
        role: "user",
        content: JSON.stringify({글제목: 제목, 이미지로만들소제목: 대상.map((x) => ({소제목: x.제목, 본문: x.본문}))})
      }],
      text: {format: {type: "json_schema", name: "info_image_plan", strict: true, schema: {
        type: "object", additionalProperties: false, properties: {images: {type: "array", items: {type: "object", additionalProperties: false, properties: {
          heading: {type: "string"}, layout: {type: "string"}, lines: {type: "array", items: {type: "string"}}
        }, required: ["heading", "layout", "lines"]}}}, required: ["images"]
      }}},
      reasoning: {effort: "low"},
    });
    사용량.push({model: 글모델, input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0});
    const 내용 = (j.output || []).flatMap((o) => o.content || []).find((c) => c.type === "output_text");
    계획 = 내용 ? JSON.parse(내용.text).images || [] : [];
  } catch {}

  const 계획별제목 = new Map(계획.map((x) => [String(x.heading || "").trim(), x]));
  const 삽입 = new Map();
  for (const [순번, x] of 대상.entries()) {
    const 계획한것 = 계획별제목.get(x.제목) || 계획[순번] || {};
    const 항목 = Array.isArray(계획한것.lines) ? 계획한것.lines.map((v) => String(v).trim()).filter(Boolean) : [];
    const 본문항목 = (x.본문 || []).flatMap((p) => String(p).split(/(?<=[.!?])\s+/).map((v) => v.trim()).filter((v) => v.length > 4));
    const 핵심 = 항목.filter((v) => v !== x.제목);
    for (const v of 본문항목) if (핵심.length < 5 && !핵심.includes(v)) 핵심.push(v);
    while (핵심.length < 3) 핵심.push("최신 공고 확인");
    const 문구 = [x.제목, ...핵심.slice(0, 5)];
    삽입.set(x.제목, {문구, 레이아웃: String(계획한것.layout || "clear Korean information graphic with a strong visual hierarchy")});
  }

  const 결과 = [];
  let 현재제목 = "";
  let 사진번호 = 0;
  const 넣음 = new Set();
  for (const b of 본문) {
    결과.push(b);
    if (b?.종류 === "소제목") 현재제목 = (b.글 || []).join(" ").trim();
    if (b?.종류 === "문단" && 삽입.has(현재제목) && !넣음.has(현재제목)) {
      const 정보 = 삽입.get(현재제목);
      const 바탕사진 = 기존사진[사진번호++] || {종류: "사진", 글: [], 칸: [], 프롬프트: ""};
      결과.push({...바탕사진, 종류: "사진", 이미지유형: "정보", 정보문구: 정보.문구, 프롬프트: 정보.레이아웃});
      넣음.add(현재제목);
    }
  }
  return 결과;
}

// 정보 이미지가 필요한 소제목만 정보형으로 남긴다. 나머지는 글자 없는 장면형으로 만든다.
function 정보이미지정리(블록들, 사진수) {
  const 중요소제목 = /(대상|자격|조건|신청|발급|제출|서류|기한|금액|한도|혜택|지원|사용처|주의|유의)/;
  let 현재소제목 = "";
  let 사진개수 = 0;
  return (블록들 || []).flatMap((b) => {
    if (b?.종류 === "소제목") 현재소제목 = (b.글 || []).join(" ");
    if (b?.종류 !== "사진") return [b];
    사진개수 += 1;
    if (사진개수 > 사진수) return [];
    const 문구 = Array.isArray(b.정보문구) ? b.정보문구.filter((x) => String(x).trim()).slice(0, 6) : [];
    const 정보 = b.이미지유형 === "정보" && 중요소제목.test(현재소제목) && 문구.length >= 4;
    return [{...b, 이미지유형: 정보 ? "정보" : "일러스트", 정보문구: 정보 ? 문구 : []}];
  });
}

// 사진 자리 고르기 — 글 모델이 사진을 글 끝에 몰아 넣을 때가 있다 (2026-09-23 실측: 사진 3장이 전부 맨 아래에 들어감).
// 모델이 어디에 두든 사진 순서는 그대로 두고, 소제목 아래 첫 문단 뒤에 고르게 다시 놓는다.
// 소제목이 사진보다 적으면 남는 사진은 다른 문단 뒤에 고르게 놓는다. (글만들기.mjs 와 naver-typing.mjs 에 같은 함수가 있다. 고치면 둘 다)
export function 사진고르게(블록들) {
  const 사진 = (블록들 || []).filter((b) => b && b.종류 === "사진");
  if (!사진.length) return 블록들 || [];
  const 나머지 = 블록들.filter((b) => b && b.종류 !== "사진");
  const 고르게 = (후보, n) => (후보.length && n > 0 ? Array.from({ length: n }, (_, k) => 후보[Math.floor(((k + 0.5) * 후보.length) / n)]) : []);
  // 자리 = 이 번호의 블록 '뒤'
  const 소제목뒤 = [];
  나머지.forEach((b, i) => { if (b.종류 === "소제목") 소제목뒤.push(나머지[i + 1] && 나머지[i + 1].종류 === "문단" ? i + 1 : i); });
  let 자리 = 고르게(소제목뒤, Math.min(소제목뒤.length, 사진.length));
  if (자리.length < 사진.length) {
    const 문단뒤 = 나머지.map((b, i) => (b.종류 === "문단" && i > 0 && i < 나머지.length - 1 && !자리.includes(i) ? i : -1)).filter((i) => i >= 0);
    자리 = 자리.concat(고르게(문단뒤, Math.min(문단뒤.length, 사진.length - 자리.length)));
  }
  자리 = [...new Set(자리)].sort((a, b) => a - b);
  const 결과 = [];
  let k = 0;
  나머지.forEach((b, i) => { 결과.push(b); if (자리.includes(i) && k < 사진.length) 결과.push(사진[k++]); });
  while (k < 사진.length) 결과.push(사진[k++]);
  return 결과;
}

async function 최종정보그림프롬프트(장면, 정보문구) {
  const 기준 = await 정보이미지기준읽기();
  const 표시문구 = 정보문구.map((x) => String(x).trim()).filter(Boolean).join("\n");
  return [
    "Create one polished Korean Naver-blog information graphic. Use only the exact Korean text below; do not add, remove, paraphrase, or invent any text, number, date, amount, institution, logo, or label.",
    "Exact Korean text to render, each line clearly and legibly:",
    표시문구,
    "Layout brief: " + String(장면 || "clear visual hierarchy with a single focused message"),
    "Design specification:",
    기준,
    "Do not include logos, brand marks, faces of real people, copyrighted characters, watermarks, or unrelated decorative icons.",
  ].join("\n");
}

// 최종 그림 프롬프트 — 어떤 언어의 글자도 나오지 않게 프로그램이 직접 만든다.
// 한글이 프롬프트에 있으면 모델이 그 글자를 그림에 그려 넣으므로 장면 묘사에서 한글·따옴표 안 문구를 지운다.
export function 최종그림프롬프트(장면) {
  const 깨끗한장면 = String(장면 || "")
    .replace(/["“”'‘’「」『』][^"“”'‘’「」『』]*["“”'‘’「」『』]/g, " ")
    .replace(/[\u3131-\u318E\uAC00-\uD7A3]+/g, " ")
    .replace(/\b(no text|no letters|no watermark|square 1:1|Korean)\b[,.]?/gi, " ")
    .replace(/\s+/g, " ").trim() || "a calm, warm everyday scene with simple objects";
  return [
    `Scene: ${깨끗한장면}`,
    "Style: square 1:1, soft pastel illustration, warm and friendly, simple uncluttered background, one clear focal point.",
    "People, if any, are seen from behind or in profile with faces not visible.",
    "STRICT RULE - NO TEXT AT ALL: the image must contain absolutely no text of any kind in any language or script. No Korean, no English, no numbers, no letters, no words, no signs, no labels, no captions, no watermarks, no logos, no UI text, no writing on paper, screens, boards, books, packaging, clothing or walls. If the scene would naturally include a sign, screen, document, book or label, render it blank, blurred or turned away so that nothing readable appears anywhere.",
  ].join("\n");
}

export async function 그림그리기({ 키, 프롬프트, 저장경로, 정보문구 = [] }) {
  const 그림프롬프트 = 정보문구.length ? await 최종정보그림프롬프트(프롬프트, 정보문구) : 최종그림프롬프트(프롬프트);
  const j = await 오픈AI(키, "/images/generations", {
    model: 그림모델,
    prompt: 그림프롬프트,
    size: "1024x1024",
    quality: 그림화질,
    n: 1,
  });
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("그림 모델이 이미지를 안 돌려줌");
  await writeFile(저장경로, Buffer.from(b64, "base64"));
  return { 저장경로, 사용량: { model: 그림모델, input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0 } };
}

// 파일명에 넣을 키워드. 한글·영문·숫자만 남기고 띄어쓰기는 '-' 로. (네이버는 이미지 파일명도 본다)
export function 슬러그(글자, 최대 = 40) {
  return String(글자 || "").normalize("NFC")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 최대).replace(/-$/, "") || "글";
}

// 글 하나 = 폴더 하나. 03_쓴글/2026-09-17_키워드/ 안에 원고.json 과 키워드-1.png … 가 들어간다.
export async function 만들기({ 키, 벤치마크, 벤치마크URL, 키워드, 사진수 = 5, 저장폴더 }) {
  if (!키) throw new Error("OpenAI 키가 없습니다");
  if (!벤치마크 && !벤치마크URL && !키워드) throw new Error("키워드나 벤치마크 글 주소가 필요합니다");
  const 기록 = [];
  if (!벤치마크 && 벤치마크URL) {
    벤치마크 = await 벤치마크가져오기(벤치마크URL);
    기록.push({ 단계: "벤치마크", 원문제목: 벤치마크.원문제목, 섹션수: 벤치마크.섹션순서_인용구제목.length, 사진수: 벤치마크.사진수 });
    if (!사진수) 사진수 = Math.min(6, Math.max(3, 벤치마크.사진수));
  }
  const 원고 = await 원고쓰기({ 키, 벤치마크, 키워드, 사진수 });
  기록.push({ 단계: "글", 제목: 원고.제목, 블록수: 원고.블록.length });

  // 폴더 이름: 날짜_키워드. 키워드가 없으면(벤치마크 모드) 새 제목의 앞부분을 쓴다.
  const 핵심 = 슬러그(키워드 || 원고.제목.split(/[,|(:·]/)[0], 30);
  const 날짜 = new Date().toISOString().slice(0, 10);
  const 폴더 = 저장폴더 || path.join(프로젝트, "03_쓴글", `${날짜}_${핵심}`);
  await mkdir(폴더, { recursive: true });

  let n = 0;
  const 사용량 = [...(원고._사용량 || [])];
  const 사진블록 = 원고.블록.filter((b) => b.종류 === "사진");
  // 그림은 동시에 만든다 (장당 30초~1분). 파일명에 키워드가 들어간다.
  await Promise.all(사진블록.map(async (b) => {
    const 번호 = ++n;
    const 파일 = `${핵심}-${번호}.png`;
    try {
      const 그림 = await 그림그리기({ 키, 프롬프트: b.프롬프트, 정보문구: b.이미지유형 === "정보" ? b.정보문구 : [], 저장경로: path.join(폴더, 파일) });
      사용량.push(그림.사용량);
      b.파일 = 파일;
      기록.push({ 단계: `사진${번호}`, 파일, 프롬프트: b.프롬프트.slice(0, 60) });
    } catch (e) {
      b.파일 = null;
      기록.push({ 단계: `사진${번호}`, 실패: String(e?.message || e).slice(0, 120) });
    }
  }));

  // naver-typing.mjs 가 읽는 모양으로 정리
  const 블록 = 원고.블록.map((b) => {
    if (b.종류 === "문단") return { 종류: "문단", 글: b.글 };
    if (b.종류 === "소제목" || b.종류 === "인용구") return { 종류: b.종류, 글: (b.글 || []).join(" ") };
    if (b.종류 === "표") return { 종류: "표", 칸: b.칸.slice(0, 9) };
    if (b.종류 === "구분선") return { 종류: "구분선" };
    if (b.종류 === "사진") return b.파일 ? { 종류: "사진", 파일: b.파일 } : null;
    return null;
  }).filter(Boolean);

  const 원고경로 = path.join(폴더, "원고.json");
  await writeFile(원고경로, JSON.stringify({ 제목: 원고.제목, 키워드: 키워드 || 핵심, 만든날: 날짜, 벤치마크: 벤치마크URL || null, 블록 }, null, 2), "utf8");
  // 사람이 읽기 편한 사본도 같이 둔다
  const 읽기용 = [`# ${원고.제목}`, ""].concat(블록.map((b) => b.종류 === "문단" ? b.글.join("\n") : b.종류 === "소제목" ? `\n## ${b.글}` : b.종류 === "인용구" ? `> ${b.글}` : b.종류 === "표" ? "[표] " + b.칸.join(" | ") : b.종류 === "사진" ? `[사진] ${b.파일}` : "---")).join("\n\n");
  await writeFile(path.join(폴더, "원고.md"), 읽기용, "utf8");
  기록.push({ 단계: "저장", 폴더, 원고: 원고경로, 사진: 블록.filter((b) => b.종류 === "사진").map((b) => b.파일) });
  const 사진실패 = 기록.filter((r) => /^사진\d/.test(r.단계) && r.실패).map((r) => r.실패);
  return { 제목: 원고.제목, 폴더, 원고: 원고경로, 사진수: 블록.filter((b) => b.종류 === "사진").length, 사진실패, 사용량, 기록 };
}
