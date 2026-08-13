import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport:{width:900,height:1400} });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type()==='error') errs.push('console: ' + m.text()); });
await p.goto('file:///home/user/isekai-rpg-assets/index.html');

const sp = process.env.SP;
await p.screenshot({ path: sp + '/01-title.png' });
await p.click('#start');
await p.waitForSelector('.person');
console.log('面会者:', await p.$$eval('.person .nm', els => els.map(e=>e.textContent)));
await p.screenshot({ path: sp + '/02-meeting.png', fullPage:true });

// 1人目を選ぶ → 支持 → カード3枚
await p.click('.person');
await p.waitForSelector('[data-stance], [data-own]');
if (await p.$('[data-own]')) await p.click('[data-own]');
await p.click('[data-stance="support"]');
await p.waitForSelector('.card');
await p.screenshot({ path: sp + '/03-cards.png', fullPage:true });
for (const cat of [0,1,2]) await p.click(`.card[data-cat="${cat}"]`);
console.log('組み上がった論証:', ((await p.$$eval('.quote', els=>els[els.length-1].textContent))).slice(0,40)+'…');
await p.click('#go');
await p.waitForSelector('.result');
console.log('判定:', await p.$eval('.verdict', e=>e.textContent));
await p.screenshot({ path: sp + '/04-result.png', fullPage:true });

// 残りのターンを機械的に消化してエンディングまで
for (let i=0;i<12;i++){
  const next = await p.$('#next'); if (!next) break;
  await next.click();
  if (await p.$('.ending')) break;
  // 第8ターンの幕間を消化する
  if (await p.$('.interlude')) {
    console.log('幕間:', await p.$eval('.interlude .title', e=>e.textContent));
    await p.click('[data-pick="0"]');
    await p.click('#ilnext');
  }
  await p.waitForSelector('.person');
  await p.click('.person');
  if (await p.$('[data-own]')) await p.click('[data-own]');
  await p.click('[data-stance="support"]');
  await p.waitForSelector('.card');
  for (const cat of [0,1,2]) await p.click(`.card[data-cat="${cat}"]`);
  await p.click('#go');
  await p.waitForSelector('.result');
}
await p.waitForSelector('.ending');
console.log('エンディング:', await p.$eval('.ending .title', e=>e.textContent));
console.log('見出し:', await p.$$eval('.ending h3', e=>e.map(x=>x.textContent).join(' / ')));
const code = await p.$eval('textarea', e=>e.value);
console.log('保存コード:', code.slice(0,70)+'…');
await p.screenshot({ path: sp + '/05-ending.png', fullPage:true });

// 保存コードから復元できるか
await p.click('#again');
await p.fill('#code', code);
await p.click('#load');
await p.waitForSelector('.ending');
console.log('復元後のエンディング:', await p.$eval('.ending .title', e=>e.textContent));

console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'JSエラーなし');
await b.close();
process.exit(errs.length ? 1 : 0);
