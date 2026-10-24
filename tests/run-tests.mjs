// tests/run-tests.mjs
// 저장소 안의 모든 *.html 파일을 헤드리스 Chromium으로 열어
//   (1) 콘솔 오류(JS 예외)가 없는지
//   (2) window.__selfTest()가 있으면 pass === true인지
// 확인한다. 하나라도 실패하면 종료 코드 1 (→ Claude가 커밋하지 않는다).
//
// 사용법:  node tests/run-tests.mjs            (저장소 루트에서)
//          node tests/run-tests.mjs path/a.html path/b.html   (특정 파일만)
// 준비:    npm install   (package.json의 playwright)  후  npx playwright install chromium
//
// 테스트 대상에서 빼고 싶은 파일은 아래 EXCLUDE에 적는다.

import { chromium } from "playwright";
import { readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.cwd());
const EXCLUDE = [/node_modules/, /[\\/]dist[\\/]/, /[\\/]\.git[\\/]/, /tests[\\/]/];
const TIMEOUT_MS = 15000;

function findHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (EXCLUDE.some((re) => re.test(p + "/"))) continue;
    if (statSync(p).isDirectory()) findHtml(p, out);
    else if (/\.html?$/i.test(name)) out.push(p);
  }
  return out;
}

const targets = process.argv.length > 2 ? process.argv.slice(2).map((p) => resolve(p)) : findHtml(ROOT);
if (targets.length === 0) {
  console.log("검사할 HTML 파일이 없습니다. (통과)");
  process.exit(0);
}

const browser = await chromium.launch();
let failed = 0;

for (const file of targets) {
  const rel = relative(ROOT, file);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

  let selfTest = null;
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: TIMEOUT_MS });
    await page.waitForTimeout(300); // 초기 렌더링 대기
    selfTest = await page.evaluate(async () => {
      if (typeof window.__selfTest !== "function") return { skipped: true };
      try { return await window.__selfTest(); }
      catch (e) { return { pass: false, failures: ["__selfTest threw: " + (e && e.message)] }; }
    });
  } catch (e) {
    errors.push(`load failed: ${e.message}`);
  }
  await page.close();

  const stOk = !selfTest || selfTest.skipped || selfTest.pass === true;
  const ok = errors.length === 0 && stOk;
  if (!ok) failed++;

  const tag = ok ? "PASS" : "FAIL";
  const stNote = !selfTest || selfTest.skipped ? "(__selfTest 없음)" : selfTest.pass ? "(__selfTest 통과)" : "(__selfTest 실패)";
  console.log(`[${tag}] ${rel} ${stNote}`);
  for (const e of errors) console.log(`       - ${e}`);
  if (selfTest && selfTest.failures) for (const f of selfTest.failures) console.log(`       - ${f}`);
}

await browser.close();
console.log(`\n${targets.length}개 파일 중 ${targets.length - failed}개 통과, ${failed}개 실패`);
process.exit(failed ? 1 : 0);
