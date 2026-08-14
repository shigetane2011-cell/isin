/* ブラウザでの通しプレイ確認。
   第1ターンからエンディングまで実際に操作し、保存コードからの復元まで見る。

   使い方:
     npm install --no-save playwright
     npx playwright install chromium
     node tools/smoke.mjs

   環境変数（任意）:
     CHROME_BIN  既存の Chromium を使う場合にその実行ファイルを指定する
     SP          スクリーンショットの出力先（既定はリポジトリ直下の .smoke/） */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sp = process.env.SP || resolve(root, '.smoke');
await mkdir(sp, { recursive: true });
const shot = name => resolve(sp, name);

const b = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
const p = await b.newPage({ viewport: { width: 900, height: 1400 } });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto(pathToFileURL(resolve(root, 'index.html')).href);

await p.screenshot({ path: shot('01-title.png') });
/* 初回は「ガイド付き／通常どおり」の2択、2回目以降は #start が出る */
if (await p.$('#start-normal')) await p.click('#start-normal');
else await p.click('#start');
/* 毎ターン必ず行き先選択を通る。前ターンの場が候補に残っていたら連泊できてしまう */
const visited = [];
const pickPlace = async shotName => {
  await p.waitForSelector('[data-place]');
  const names = await p.$$eval('[data-place] .nm', e => e.map(x => x.textContent));
  const prev = visited[visited.length - 1];
  if (prev && names.includes(prev)) errs.push(`連泊できる: 前ターンの「${prev}」が行き先候補に残っている`);
  if (shotName) await p.screenshot({ path: shot(shotName), fullPage: true });
  await p.click('[data-place]');
  await p.waitForSelector('.here .nm');
  const here = await p.$eval('.here .nm', e => e.textContent);
  if (here === prev) errs.push(`同じ場に連泊した: ${here}`);
  visited.push(here);
  return names;
};
console.log('行き先:', await pickPlace('01b-place.png'));
/* 縁（人脈の顔・決裂の悪評）が実際に画面に出るか。人脈は2ターン目から溜まる */
let tieSeen = 0, tieSample = '';
const noteTies = async () => {
  const n = await p.$$eval('.tie', e => e.length);
  if (n && !tieSample) tieSample = await p.$eval('.tie .who', e => e.textContent);
  tieSeen += n;
};
await p.waitForSelector('.person[data-id]');
console.log('面会者:', await p.$$eval('.person .nm', els => els.map(e => e.textContent)));
await noteTies();
await p.screenshot({ path: shot('02-meeting.png'), fullPage: true });

/* 1人目を選ぶ → 支持 → カード3枚 */
await p.click('.person[data-id]');
await p.waitForSelector('[data-stance], [data-own]');
if (await p.$('[data-own]')) await p.click('[data-own]');
await p.click('[data-stance="support"]');
await p.waitForSelector('[data-approach]');
await p.screenshot({ path: shot('02b-approach.png'), fullPage: true });
await p.click('[data-approach]:not([disabled])');
await p.waitForSelector('.card, #go');
await p.screenshot({ path: shot('03-cards.png'), fullPage: true });
for (const el of await p.$$('.card[data-cat="0"], .card[data-cat="1"], .card[data-cat="2"]')) { }
for (const cat of [0, 1, 2]) { const el = await p.$(`.card[data-cat="${cat}"]`); if (el) await el.click(); }
console.log('組み上がった論証:', (await p.$$eval('.quote', els => els[els.length - 1].textContent)).slice(0, 40) + '…');
await p.click('#go');
if (await p.$('.duel')) {
  console.log('立ち合い:', await p.$eval('.duel .title', e => e.textContent));
  await p.screenshot({ path: shot('04-duel.png'), fullPage: true });
  await p.click('[data-duel="0"]');
}
await p.waitForSelector('.result');
console.log('判定:', await p.$eval('.verdict', e => e.textContent));
await p.screenshot({ path: shot('04b-result.png'), fullPage: true });

/* 残りのターンを機械的に消化してエンディングまで */
for (let i = 0; i < 12; i++) {
  const next = await p.$('#next'); if (!next) break;
  await next.click();
  if (await p.$('.ending')) break;
  /* 第8ターンの幕間を消化する */
  if (await p.$('.interlude')) {
    console.log('幕間:', await p.$eval('.interlude .title', e => e.textContent));
    await p.screenshot({ path: shot('05-interlude.png'), fullPage: true });
    await p.click('[data-pick="0"]');
    await p.click('#ilnext');
    if (await p.$('.ending')) break;
  }
  await pickPlace();
  await p.waitForSelector('.person[data-id]');
  await noteTies();
  await p.click('.person[data-id]');
  if (await p.$('[data-own]')) await p.click('[data-own]');
  await p.click('[data-stance="support"]');
  await p.waitForSelector('[data-approach]');
  await p.click('[data-approach]:not([disabled])');
  await p.waitForSelector('.card, #go');
  if (await p.$('#tutok')) await p.click('#tutok');
  for (const cat of [0, 1, 2]) { const el = await p.$(`.card[data-cat="${cat}"]`); if (el) await el.click(); }
  await p.click('#go');
  if (await p.$('.duel')) await p.click('[data-duel="0"]');
  await p.waitForSelector('.result');
}
await p.waitForSelector('.ending');
console.log('エンディング:', await p.$eval('.ending .title', e => e.textContent));
console.log('見出し:', await p.$$eval('.ending h3', e => e.map(x => x.textContent).join(' / ')));
const code = await p.$eval('#savebox', e => e.value);
console.log('保存コード:', code.slice(0, 70) + '…');
await p.screenshot({ path: shot('06-ending.png'), fullPage: true });

/* 保存コードから復元できるか */
await p.click('#again');
await p.fill('#code', code);
await p.click('#load');
await p.waitForSelector('.ending');
const restored = await p.$eval('.ending .title', e => e.textContent);
console.log('復元後のエンディング:', restored);

console.log('滞在した場:', visited.join(' → '));
console.log('縁の表示:', tieSeen ? `${tieSeen}件（例: ${tieSample}）` : 'なし');
if (!tieSeen) errs.push('縁（紹介・悪評）の表示が通しプレイで一度も出なかった');
console.log('スクリーンショット:', sp);
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'JSエラーなし');
await b.close();
process.exit(errs.length ? 1 : 0);
