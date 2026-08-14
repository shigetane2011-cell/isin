/* 決定論の検証。index.html からエンジン部だけを抜き出して実行する。
   使い方: node tools/verify.mjs                                            */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const S = '/* ==ENGINE START== */', T = '/* ==ENGINE END== */';
const i = html.indexOf(S), j = html.indexOf(T);
if (i < 0 || j < 0) { console.error('エンジン区間が見つかりません'); process.exit(1); }
const src = html.slice(i + S.length, j);

let pass = 0, fail = 0;
const ok  = (c, m) => { c ? (pass++, console.log('  \x1b[32m✓\x1b[0m ' + m))
                          : (fail++, console.log('  \x1b[31m✗\x1b[0m ' + m)); };
const head = m => console.log('\n\x1b[1m' + m + '\x1b[0m');

/* --- 1. エンジンへの非決定的APIの混入検査 ------------------------------- */
head('1. 決定論エンジンに非決定的APIが混入していないか');
// コメントと文字列リテラルを除いた「実際に動くコード」だけを見る
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
for (const bad of ['Math.random', 'Date.now', 'new Date(', 'performance.now', 'crypto.getRandomValues']) {
  ok(!code.includes(bad), `${bad} を使用していない`);
}

head('1b. 初回導線とseed生成');
ok(html.includes('crypto.getRandomValues'), '初期seedをブラウザの乱数で生成する');
ok(html.includes('start-guide') && html.includes('start-normal'), '初回だけガイド付き／通常開始を選べる');
ok(html.includes('tutorialReasonHTML') && html.includes('guide-answer'), '第1ターンに正解と根拠を表示する');

/* --- エンジン読み込み ---------------------------------------------------- */
await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const E = globalThis.ENGINE;

/* テスト自身も決定論的に動かすための PRNG */
const trnd = E.mulberry32(0xC0FFEE);
const pick = arr => arr[Math.floor(trnd() * arr.length)];

function autoPlay(seed, rnd) {
  let st = E.createState(seed);
  const actions = [];
  let interludeChoice = null;
  while (!st.finished) {
    if (E.pendingInterlude(st)) {
      interludeChoice = Math.floor(rnd() * 3);
      st = E.applyInterlude(st, interludeChoice);
    }
    const m = E.meetingList(st);
    const slots = m.intro ? [...m.normal, m.intro] : m.normal;
    const charId = slots[Math.floor(rnd() * slots.length)];
    const c = E.CHAR_BY_ID.get(charId);
    const ownF = c.factions[Math.floor(rnd() * c.factions.length)];
    const stance = rnd() < 0.6 ? 'support' : 'convert';
    const others = [0, 1, 2, 3, 4].filter(f => f !== ownF);
    const argueF = stance === 'support' ? ownF : others[Math.floor(rnd() * others.length)];
    const opts = E.cardOptions(st, charId, argueF);
    const cards = opts.map((o, k) => rnd() < 0.55 ? c.correct[k] : o[Math.floor(rnd() * o.length)].motive);
    const a = { charId, stance, ownF, argueF, cards, probed: rnd() < 0.4 };
    actions.push(a);
    st = E.resolve(st, a).next;
  }
  return { st, actions, interludeChoice };
}

/* --- 2. 完全リプレイ性 --------------------------------------------------- */
head('2. 同じ seed + 同じ選択列 → 常に同じ盤面');
let replayOk = true, endingSeen = new Map();
for (let s = 1; s <= 300; s++) {
  const { st, actions, interludeChoice } = autoPlay(s, E.mulberry32(s * 7919));
  const again = E.replay(s, actions, interludeChoice).state;
  if (E.hashState(st) !== E.hashState(again)) { replayOk = false; console.log('    seed', s, '不一致'); break; }
  const third = E.replay(s, actions, interludeChoice).state;
  if (E.hashState(st) !== E.hashState(third)) { replayOk = false; break; }
  const e = E.evaluateEnding(st);
  endingSeen.set(e.t, (endingSeen.get(e.t) || 0) + 1);
}
ok(replayOk, '300 seed × 3回実行で state hash が完全一致');

/* --- 3. セーブコードの往復 ----------------------------------------------- */
head('3. 保存コードの往復');
let saveOk = true;
for (let s = 1; s <= 60; s++) {
  const { st } = autoPlay(s, E.mulberry32(s * 31337));
  const dec = E.decodeSave(E.encodeSave(st));
  if (E.hashState(E.replay(dec.seed, dec.actions, dec.interludeChoice).state) !== E.hashState(st)) { saveOk = false; break; }
}
ok(saveOk, '60局を encode → decode → replay して一致');

/* --- 4. ルール不変条件 --------------------------------------------------- */
head('4. ルールの不変条件');
let inv = { range: true, dup: true, rank: true, intro: true, turns: true, correct: true, len: true };
for (let s = 1; s <= 200; s++) {
  let st = E.createState(s);
  const rnd = E.mulberry32(s * 104729);
  let n = 0;
  while (!st.finished) {
    n++;
    const era = E.eraOf(st), m = E.meetingList(st);
    if (new Set(m.normal).size !== 3) inv.dup = false;
    for (const id of m.normal) {
      if (E.rankOfId(id) > era) inv.rank = false;                    // 通常枠はランク補正で必ず解禁済み
      if (st.contacts.includes(id) || st.banned.includes(id)) inv.dup = false;
    }
    if (st.contacts.length === 0 && m.intro !== null) inv.intro = false;   // 人脈が空なら紹介枠なし
    if (m.intro !== null && m.normal.includes(m.intro)) inv.dup = false;

    const slots = m.intro ? [...m.normal, m.intro] : m.normal;
    const charId = slots[Math.floor(rnd() * slots.length)];
    const c = E.CHAR_BY_ID.get(charId);
    const ownF = c.factions[Math.floor(rnd() * c.factions.length)];
    const stance = rnd() < 0.5 ? 'support' : 'convert';
    const others = [0, 1, 2, 3, 4].filter(f => f !== ownF);
    const argueF = stance === 'support' ? ownF : others[Math.floor(rnd() * others.length)];
    const opts = E.cardOptions(st, charId, argueF);
    for (let k = 0; k < 3; k++) {                                    // 正解は必ず1枚だけ含まれる
      const hit = opts[k].filter(o => o.motive === c.correct[k]).length;
      if (hit !== 1 || opts[k].length !== 3 || new Set(opts[k].map(o => o.motive)).size !== 3) inv.correct = false;
    }
    const cards = opts.map(o => o[Math.floor(rnd() * o.length)].motive);
    const r = E.resolve(st, { charId, stance, ownF, argueF, cards });
    if (r.report.len <= 0) inv.len = false;
    st = r.next;
    if (st.currents.some(v => v < 0 || v > E.CAP)) inv.range = false;
    if (n > E.MAX_TURN) inv.turns = false;
  }
}
ok(inv.range,   '時勢値が常に 0〜40 の範囲に収まる');
ok(inv.dup,     '面会リストに重複・既獲得・決裂済みが出ない');
ok(inv.rank,    '通常枠に未解禁ランクが出ない（強制変換が効いている）');
ok(inv.intro,   '人脈が空のとき紹介枠は必ず出ない');
ok(inv.turns,   'ゲームは必ず10ターン以内に終わる');
ok(inv.correct, '各カテゴリの提示3枚に正解がちょうど1枚含まれる');
ok(inv.len,     '論証文の文字数が必ず正の値になる');

/* --- 5. 判定表の一致 ----------------------------------------------------- */
head('5. 判定表どおりの増減になっているか');
function probe(seed, charId, stance, argueF, score) {
  const st = E.createState(seed);
  const c = E.CHAR_BY_ID.get(charId);
  const cards = c.correct.slice();
  const wrong = k => [0,1,2,3,4,5].find(m => m !== c.correct[k]);
  for (let k = score; k < 3; k++) cards[k] = wrong(k);
  return E.resolve(st, { charId, stance, ownF: c.factions[0], argueF, cards }).report;
}
ok(probe(1, 1, 'support', 0, 3).gain === 4, '初級・大成功 → +4');
ok(probe(1, 1, 'support', 0, 2).gain === 2, '初級・成功 → +2');
ok(probe(1, 1, 'support', 0, 1).gain === 0, '初級・失敗 → 変動なし');
ok(probe(1, 1, 'support', 0, 0).gain === 0 && probe(1, 1, 'support', 0, 0).bannedNow, '初級・決裂 → 出現停止');
const pre = probe(1, 145, 'support', 1, 3);
ok(pre.premature && pre.gain === 4, '初級期に伝説級 → 時期尚早でボーナス無効（+4のまま）');
const cv3 = atEra(8, 1, 3, 'convert', 4), cv2 = atEra(8, 1, 2, 'convert', 4);
ok(cv3.delta[4] === 4 && cv3.delta[0] === -2, '転向・3枚一致 → 主張属性+4 / 相手属性-2');
ok(cv2.gain === 0 && cv2.delta.every(v => v === 0), '転向・2枚一致 → 通らない（全か無かの賭け）');
ok(cv2.contactAdded === false, '転向・2枚一致では人脈にも加わらない');
ok(atEra(8, 1, 2, 'support', 0).gain === 2, '支持・2枚一致は通る（転向とは非対称）');
const floorTest = E.resolve(Object.assign(E.createState(1), { currents: [0,0,0,0,0] }),
  { charId: 1, stance: 'convert', ownF: 0, argueF: 4, cards: E.CHAR_BY_ID.get(1).correct });
ok(floorTest.next.currents[0] === 0, '相手属性が0のとき転向で減らしてもマイナスにならない');

/* ランク補正は時代が追いついている場合のみ */
function atEra(total, charId, score, stance = 'support', argueF = null) {
  const st = E.createState(1);
  st.currents = [total, 0, 0, 0, 0];
  const c = E.CHAR_BY_ID.get(charId);
  const cards = c.correct.slice();
  for (let k = score; k < 3; k++) cards[k] = [0,1,2,3,4,5].find(m => m !== c.correct[k]);
  return E.resolve(st, { charId, stance, ownF: c.factions[0], argueF: argueF ?? c.factions[0], cards }).report;
}
ok(atEra(12, 47, 3).gain === 5, '中級期に中級級・大成功 → +5（+1補正）');
ok(atEra(12, 47, 2).gain === 3, '中級期に中級級・成功 → +3（+1補正）');
ok(atEra(26, 91, 3).gain === 6, '上級期に上級級・大成功 → +6（+2補正）');
ok(atEra(26, 91, 1).penalty === 1, '上級期に上級級・失敗 → 時勢-1');
ok(atEra(40, 136, 3).gain === 8, '伝説期に伝説級・大成功 → +8（2倍）');
ok(atEra(40, 136, 1).penalty === 3, '伝説期に伝説級・失敗 → 時勢-3');
ok(atEra(12, 136, 1).penalty === 0, '時期尚早なら失敗ペナルティも無効');
ok(atEra(26, 103, 3).waryBy === 0 && atEra(26, 103, 3).gain === 4,
   '公武26を掲げていると雄藩の西郷は警戒し、上級の+2補正を受け取れない');

/* --- 5b. 警戒（対立勢力への旗色） ---------------------------------------- */
head('5b. 旗色を鮮明にすると対立勢力の人物が警戒するか');
ok(E.OPPOSED.every((foes, f) => foes.every(o => E.OPPOSED[o].includes(f))), '対立関係が対称になっている');
ok(E.OPPOSED.every((foes, f) => !foes.includes(f)), '自分自身を対立相手にしていない');
{
  const below = [0,0,0,0,0]; below[2] = E.WARY_LINE - 1;   // 佐幕を閾値の一歩手前まで
  const at    = [0,0,0,0,0]; at[2]    = E.WARY_LINE;       // 閾値ちょうど
  const yuhan = E.CHARACTERS.find(c => c.factions.length === 1 && c.factions[0] === 3).id; // 雄藩の人物
  ok(E.waryOf(below, yuhan) < 0, `佐幕が${E.WARY_LINE - 1}なら雄藩の人物はまだ警戒しない`);
  ok(E.waryOf(at, yuhan) === 2,  `佐幕が${E.WARY_LINE}に達すると雄藩の人物が警戒する`);
  const kobu = E.CHARACTERS.find(c => c.factions.length === 1 && c.factions[0] === 0).id;
  ok(E.waryOf(at, kobu) < 0, '対立関係にない勢力の人物は警戒しない（佐幕と公武は両立する）');

  const run = (cur, id, score, stance = 'support') => {
    const st = Object.assign(E.createState(1), { currents: cur.slice() });
    const c = E.CHAR_BY_ID.get(id), cards = c.correct.slice();
    for (let k = score; k < 3; k++) cards[k] = [0,1,2,3,4,5].find(m => m !== c.correct[k]);
    return E.resolve(st, { charId: id, stance, ownF: c.factions[0],
                           argueF: stance === 'support' ? c.factions[0] : 2, cards }).report;
  };
  ok(run(below, yuhan, 3).verdict === '大成功', '警戒されていなければ3枚一致は大成功');
  ok(run(at, yuhan, 3).verdict === '成功',     '警戒されると3枚一致でも成功どまり');
  ok(run(at, yuhan, 2).verdict === '失敗',     '警戒されると2枚一致は失敗に落ちる');
  ok(run(at, yuhan, 1).verdict === '失敗',     '警戒されても失敗より下（決裂）には落ちない');
  ok(run(at, yuhan, 0).verdict === '決裂',     '0枚一致は警戒の有無にかかわらず決裂');
}

/* --- 5c. 決裂すると縁筋も閉じる ------------------------------------------- */
head('5c. 決裂した人物の縁筋が紹介枠から外れるか');
{
  const hub = [...E.TIE_GRAPH].sort((a, b) => b[1].size - a[1].size)[0][0];  // 最も縁の多い人物
  const kin = [...E.TIE_GRAPH.get(hub)];
  const withHub    = Object.assign(E.createState(1), { contacts: kin.slice(0, 1), banned: [] });
  const hubBanned  = Object.assign(E.createState(1), { contacts: kin.slice(0, 1), banned: [hub] });
  const a = new Set(); const b = new Set();
  for (let t = 1; t <= 10; t++) {
    a.add(E.introPick(Object.assign({}, withHub,   { turn: t }), new Set()));
    b.add(E.introPick(Object.assign({}, hubBanned, { turn: t }), new Set()));
  }
  const blocked = [...E.TIE_GRAPH.get(hub)];
  ok([...b].every(id => id === null || !blocked.includes(id)),
     `決裂した人物(${E.CHAR_BY_ID.get(hub).name})の縁者が紹介枠に出てこない`);
  ok([...a].some(id => blocked.includes(id)), '決裂していなければ、その縁者は紹介枠に出る');
}

/* --- 5d. 探る（正解の開示と、その代償） ---------------------------------- */
head('5d. 探ると正解は分かるが影響力が落ちるか');
{
  const probe = (st, id, stance = 'support') => {
    const c = E.CHAR_BY_ID.get(id);
    return E.resolve(st, { charId: id, stance, ownF: c.factions[0],
                           argueF: c.factions[0], cards: c.correct.slice(), probed: true });
  };
  const plain = (st, id) => {
    const c = E.CHAR_BY_ID.get(id);
    return E.resolve(st, { charId: id, stance: 'support', ownF: c.factions[0],
                           argueF: c.factions[0], cards: c.correct.slice(), probed: false });
  };
  const s0 = E.createState(1);
  ok(plain(s0, 1).report.gain === 4 && probe(s0, 1).report.gain === 3,
     '初級で3枚一致：探らねば+4、探れば+3');
  ok(probe(s0, 1).report.verdict === '大成功', '探っても判定そのものは大成功のまま');
  ok(probe(s0, 1).next.probesUsed === 1 && plain(s0, 1).next.probesUsed === 0,
     '探った回数が状態に記録される');

  /* 大物ほど代償が相対的に軽い */
  const at = (total, id) => {
    const st = Object.assign(E.createState(1), { currents: [total, 0, 0, 0, 0] });
    return [plain(st, id).report.gain, probe(st, id).report.gain];
  };
  const [n1, p1] = at(0, 1), [n4, p4] = at(40, 136);
  ok(p1 / n1 < p4 / n4,
     `探る代償は大物ほど軽い（初級 ${n1}→${p1} = ${Math.round(p1/n1*100)}% / 伝説 ${n4}→${p4} = ${Math.round(p4/n4*100)}%）`);

  /* 回数制限 */
  let st = E.createState(1);
  for (let i = 0; i < E.PROBE_LIMIT; i++) st = probe(st, 1).next;
  ok(st.probesUsed === E.PROBE_LIMIT, `${E.PROBE_LIMIT}回まで探れる`);
  const over = probe(st, 1).report;
  ok(over.probed === false && over.gain === 4,
     '上限を超えて探ろうとしても無効になり、代償も課されない');
  ok(probe(st, 1).next.probesUsed === E.PROBE_LIMIT, '上限を超えて回数が増えない');
}

/* --- 5e. 対話（チップ式） -------------------------------------------------- */
head('5e. 対話の返答が動機型と正しく対応しているか');
ok(E.QUESTIONS.length === 3 && E.QUESTIONS.every((q, i) => q.cat === i),
   '踏み込んだ問いが3カテゴリに1対1で対応している');
ok(E.REPLIES.length === 3 && E.REPLIES.every(r => r.length === 6),
   '返答が 3カテゴリ × 6動機型 = 18通り揃っている');
ok(new Set(E.REPLIES.flat()).size === 18, '返答の本文に重複がない');
ok(E.SMALLTALK.every(t => t.lines.length === 5), '世間話が5勢力すべてに用意されている');
ok(E.CHARACTERS.every(c => c.correct.every((m, k) => typeof E.REPLIES[k][m] === 'string')),
   '151名すべてについて、3つの問いに返す台詞が存在する');
{
  /* 返答は「刺さる型」をそのまま語る。つまり返答から正解カードが一意に定まる。 */
  const c = E.CHAR_BY_ID.get(47);   // 近藤勇: 名誉 / 出自の低さ / 名分論
  ok(E.REPLIES[0][c.correct[0]].includes('名'), '近藤勇に望みを問えば名誉を語る');
  ok(E.REPLIES[1][c.correct[1]].includes('生まれ'), '近藤勇に縛りを問えば出自を語る');
  ok(E.REPLIES[2][c.correct[2]].includes('名分'), '近藤勇に筋を問えば名分論を語る');
}

/* --- 5f. 余話（史実の短評と関連作品） ------------------------------------- */
head('5f. 余話のデータ整合性');
ok([...E.NOTES.keys()].every(id => E.CHAR_BY_ID.has(id)), '余話が実在する人物IDだけを指している');
ok([...E.NOTES.values()].every(v => typeof v.note === 'string' && v.note.length > 20),
   'すべての余話に実体のある本文がある');
ok([...E.NOTES.keys()].filter(id => E.rankOfId(id) === 3).length === 16,
   '伝説級16名は全員に余話がある');
{
  const n = [...E.NOTES.keys()].length, w = [...E.NOTES.values()].filter(v => v.works).length;
  console.log(`  余話 ${n}/151名（実名の人物は全員）／ 関連作品つき ${w}名`);
  const spots = [...E.NOTES.values()].filter(v => v.spot).length;
  console.log(`  ゆかりの地つき ${spots}名`);
  ok(n >= 120, `実名の人物すべてに余話がある（${n}名）`);
  const anon = /下級公家|芸妓|住職|警衛|公家侍|師匠|豪商|蘭学医|通訳官|散髪師|少年|相撲取り|隊士|勘定方|町火消|同心|女中|密偵|足軽|郷士|陶芸家|留守居役|町衆|瓦版売り|若者|浪人|国学者の卵/;
  const missing = E.CHARACTERS.filter(c => !E.NOTES.has(c.id) && !anon.test(c.name));
  ok(missing.length === 0, `余話のない実名人物が残っていない${missing.length ? '（' + missing.map(c => c.name).join('・') + '）' : ''}`);
  ok([...E.NOTES.values()].every(v => !v.spot || v.spot.trim().length > 2), 'ゆかりの地の表記に空欄がない');
}

/* --- 5g. 幕間「政変」 ------------------------------------------------------ */
head('5g. 第8ターンの幕間');
{
  const pairs = [];
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) pairs.push(`${a}+${b}`);
  ok(pairs.every(k => E.INTERLUDES[k]), '2勢力の組合せ10通りすべてに幕間がある');
  ok(pairs.every(k => E.INTERLUDES[k].opts.length === 3), 'どの幕間も選択肢が3つある');
  ok(pairs.every(k => E.INTERLUDES[k].opts.every(o => o.d.length === 5 && o.res && o.tag)),
     'すべての選択肢に増減・結果文・後日談用のタグがある');
  ok(new Set(pairs.map(k => E.INTERLUDES[k].title)).size === 10, '幕間の題が10通りとも異なる');

  /* 発火位置 */
  let fired = 0, games = 0, before8 = 0;
  for (let seed = 1; seed <= 200; seed++) {
    let st = E.createState(seed); games++;
    let seen = false;
    while (!st.finished) {
      const iv = E.pendingInterlude(st);
      if (iv) { if (st.turn !== E.INTERLUDE_TURN) before8++; seen = true; st = E.applyInterlude(st, seed % 3); }
      const m = E.meetingList(st), c = E.CHAR_BY_ID.get(m.normal[0]);
      st = E.resolve(st, { charId: c.id, stance: 'support', ownF: c.factions[0],
                           argueF: c.factions[0], cards: c.correct.slice(), probed: false }).next;
    }
    if (seen) fired++;
  }
  ok(fired === games, `全${games}局で幕間がちょうど1回起きる`);
  ok(before8 === 0, `幕間が第${E.INTERLUDE_TURN}ターン以外で起きない`);
}
{
  /* 保存・復元と旧版互換 */
  const run = (seed, choice) => {
    let st = E.createState(seed);
    while (!st.finished) {
      if (choice != null && E.pendingInterlude(st)) st = E.applyInterlude(st, choice);
      const m = E.meetingList(st), c = E.CHAR_BY_ID.get(m.normal[0]);
      st = E.resolve(st, { charId: c.id, stance: 'support', ownF: c.factions[0],
                           argueF: c.factions[0], cards: c.correct.slice(), probed: false }).next;
    }
    return st;
  };
  let rt = true, compat = true, moved = 0;
  for (let seed = 1; seed <= 100; seed++) {
    for (const ch of [0, 1, 2]) {
      const st = run(seed, ch), d = E.decodeSave(E.encodeSave(st));
      if (E.hashState(E.replay(d.seed, d.actions, d.interludeChoice).state) !== E.hashState(st)) rt = false;
    }
    const off = run(seed, null);
    if (E.hashState(run(seed, 1)) !== E.hashState(off)) moved++;
    const d3 = E.decodeSave('IR3:' + E.encodeSave(off).slice(4));
    if (E.hashState(E.replay(d3.seed, d3.actions, d3.interludeChoice).state) !== E.hashState(off)) compat = false;
  }
  ok(rt, '幕間の選択を含む保存コードが往復で一致する（100局×3選択）');
  ok(compat, '旧版(IR3)の保存コードが、幕間なしのまま完全に再現される');
  ok(moved === 100, '幕間の選択は必ず盤面を動かす（飾りになっていない）');
}

{
  /* 上限到達と不正入力 */
  const st = Object.assign(E.createState(1), { turn: E.INTERLUDE_TURN, currents: [37,0,20,0,0] });
  const after = E.applyInterlude(st, 0);
  ok(after.currents.some(v => v >= E.CAP) && after.finished,
     '幕間の増減で上限40に達したら、その時点で終局になる');
  let threw = 0;
  for (const bad of [9, -1, 1.5, null, 'a']) { try { E.applyInterlude(st, bad); } catch { threw++; } }
  ok(threw === 5, '幕間の選択番号が不正なら例外を投げる');
  let rejected = 0;
  for (const code of ['IR4:1:1,0,0,0,000,0#9', 'IR4:1:1,0,0,0,000,0#x',
                      'IR4:1:1,0,0,0,000,0#-1', 'IR4:abc:1,0,0,0,000,0']) {
    try { E.decodeSave(code); } catch { rejected++; }
  }
  ok(rejected === 4, '不正な保存コード（幕間番号・seed）をすべて弾く');
  ok(Object.values(E.INTERLUDES).every(iv => iv.opts.every(o => o.after && o.after.length > 15)),
     '全30択に、結末で読まれる後日文（after）がある');
  ok(new Set(Object.values(E.INTERLUDES).flatMap(iv => iv.opts.map(o => o.after))).size === 30,
     '30通りの後日文に重複がない');
}

/* --- 5h. 後日談 ------------------------------------------------------------ */
head('5h. 後日談');
ok([...E.FATES.keys()].every(id => E.CHAR_BY_ID.has(id)), '後日談が実在する人物IDだけを指している');
ok(E.CHARACTERS.filter(c => E.rankOfId(c.id) >= 2).every(c => E.FATES.has(c.id)),
   `上級・伝説の61名は全員に個別の後日談がある`);
ok(E.CHARACTERS.every(c => {
  const w = E.fateOf(c.id, c.factions), l = E.fateOf(c.id, [9]);
  return w.text && l.text && w.text !== l.text && w.won === true && l.won === false;
}), '151名全員について、勝ち側と負け側で異なる後日談が引ける');
ok(!([...E.FATES.values()].flat().some(t =>
  /内閣総理大臣|明治政府|維新三傑|元老|大日本帝国憲法|日露戦争|司法卿|内務卿|太政大臣|開拓使長官|学習院長/.test(t))),
   '後日談に、代替史では成立しない明治固有の官職・事績が混じっていない');
ok(E.FATE_TEMPLATE.length === 5 && E.FATE_TEMPLATE.every(t => t.length === 2),
   '中級・初級のひな型が5勢力 × 勝敗の2通り揃っている');
{
  const solo = E.winningFactions({ kind:'solo', faction:2 });
  const combo = E.winningFactions({ kind:'combo', pair:[1,3] });
  const chaos = E.winningFactions({ kind:'chaos' });
  ok(String(solo) === '2' && String(combo) === '1,3' && chaos.length === 0,
     '採られた勢力が エンド種別ごとに正しく決まる（混沌では全員が負け側）');
  ok(E.fateOf(103, [3]).text !== E.fateOf(103, [2]).text,
     '西郷隆盛の後日談が、雄藩が採られたか否かで変わる');
}

/* --- 6. エンディング分岐 ------------------------------------------------- */
head('6. エンディング分岐');
const mk = cur => E.evaluateEnding({ currents: cur });
ok(mk([30,0,0,0,0]).t === '王政の千年王国', '公武30 → 王政の千年王国');
ok(mk([0,0,31,0,0]).t === '徳川の再臨', '佐幕31 → 徳川の再臨');
ok(mk([0,0,0,33,0]).t === '諸侯の連邦', '雄藩33 → 諸侯の連邦');
ok(mk([0,35,0,0,0]).t === '東洋の貿易都市', '開国35 → 東洋の貿易都市');
ok(mk([0,0,0,0,30]).t === '修羅の国', '抗戦30 → 修羅の国');
ok(mk([20,0,15,0,0]).t === '立憲君主幕府', '公武20+佐幕15 → 立憲君主幕府');
ok(mk([0,18,0,14,0]).t === '明治維新（史実改）', '開国18+雄藩14 → 明治維新（史実改）');
ok(mk([0,16,0,0,16]).t === '武装共和国', '開国16+抗戦16 → 武装共和国');
ok(mk([16,0,0,0,15]).t === '攘夷の詔', '公武16+抗戦15 → 攘夷の詔（対立軸の複合にも固有エンドがある）');
{
  const pairs = [];
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) pairs.push([a, b]);
  const got = pairs.map(([a, b]) => { const cur = [0,0,0,0,0]; cur[a] = 20; cur[b] = 10; return mk(cur).t; });
  ok(got.length === 10 && new Set(got).size === 10, '2勢力の組合せ10通りが、それぞれ別のエンディングになる');
  ok(!got.includes('野合の衆'), '『野合の衆』に落ちる組合せが残っていない（保険としてコードには残す）');
}
ok(mk([9,8,5,4,3]).t === '歴史の藻屑', '合計は多いが上位2つが30未満 → 歴史の藻屑');
ok(mk([20,0,10,0,0]).t === '立憲君主幕府', '20+10 → 二番目が下限ちょうどで複合革命が成立');
ok(mk([25,0,5,0,0]).t === '歴史の藻屑', '25+5 → 合計30でも二番目が薄いので複合革命にならない');
ok(mk([29,1,0,0,0]).t === '歴史の藻屑', '29+1 → 連立の実体がなく歴史の藻屑');
ok(mk([31,0,32,0,0]).t === '徳川の再臨', '複数が30超 → 最大値の単独覇権が優先');

/* --- 7. データ整合性 ----------------------------------------------------- */
head('7. データ整合性');
ok(E.CHARACTERS.length === 151, '登場人物がちょうど151名');
ok(new Set(E.CHARACTERS.map(c => c.id)).size === 151, 'IDに重複がない');
ok(E.CHARACTERS.every(c => c.id >= 1 && c.id <= 151), 'IDが1〜151に収まる');
const byRank = [0,1,2,3].map(r => E.CHARACTERS.filter(c => E.rankOfId(c.id) === r).length);
ok(String(byRank) === '30,60,45,16', `ランク構成が 初級30・中級60・上級45・伝説16（実測 ${byRank}）`);
ok([2,3,5,7,11].every(d => E.ROSTER % d !== 0), `名簿数 ${E.ROSTER} が素数（基点IDがターンごとに潰れないため）`);
ok(E.CHARACTERS.every(c => new Set(c.factions).size === c.factions.length), '同じ勢力を重複して持つ人物がいない');
ok([...E.TIE_GRAPH].every(([k, vs]) => [...vs].every(v => E.TIE_GRAPH.get(v)?.has(k))), '縁のグラフが双方向になっている');
ok(E.CHARACTERS.every(c => c.correct.every(v => v >= 0 && v <= 5)), '正解の動機型が0〜5に収まる');
ok(E.CHARACTERS.every(c => c.factions.every(f => f >= 0 && f <= 4)), '勢力が0〜4に収まる');
ok(E.CHARACTERS.every(c => c.name && c.nick && c.desc), '全員に名・二つ名・情勢描写がある');
ok(E.CARDS.length === 5 && E.CARDS.every(f => f.length === 3 && f.every(cat => cat.length === 6)),
   'カードプールが 5勢力 × 3カテゴリ × 6型 = 90枚');
ok(new Set(E.CARDS.flat(2)).size === 90, 'カード本文に重複がない');
ok(Object.keys(E.TIES).every(k => (E.TIES[k] || []).every(v => E.CHAR_BY_ID.has(+v) && +v !== +k)),
   '史実の結びつきが実在IDを指し、自己参照がない');

/* --- 7b. 名簿のカバー率 --------------------------------------------------- */
head('7b. 151名がどれだけ盤面に出てくるか（1000局）');
{
  const seen = new Set(); const per = []; const introSeen = new Map(); let introTurns = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const rnd = E.mulberry32(seed * 7919), target = Math.floor(rnd() * 5);
    let st = E.createState(seed); const mine = new Set();
    while (!st.finished) {
      const m = E.meetingList(st);
      const slots = m.intro ? [...m.normal, m.intro] : m.normal;
      if (m.intro) { introSeen.set(m.intro, (introSeen.get(m.intro) || 0) + 1); introTurns++; }
      for (const id of slots) { seen.add(id); mine.add(id); }
      const charId = slots.find(id => E.CHAR_BY_ID.get(id).factions.includes(target)) ?? slots[0];
      const c = E.CHAR_BY_ID.get(charId), isT = c.factions.includes(target);
      st = E.resolve(st, { charId, stance: isT ? 'support' : 'convert',
                           ownF: isT ? target : c.factions[0], argueF: target, cards: c.correct.slice() }).next;
    }
    per.push(mine.size);
  }
  const avg = per.reduce((a, b) => a + b, 0) / per.length;
  const top4 = [...introSeen].sort((a, b) => b[1] - a[1]).slice(0, 4).reduce((a, b) => a + b[1], 0) / introTurns;
  console.log(`  1局あたりの異なり人数 平均 ${avg.toFixed(1)} 名 / 1000局の延べ登場 ${seen.size} 名 / 紹介枠の異なり ${introSeen.size} 名`);
  ok(seen.size === 151, `1000局で151名全員が登場する（実測 ${seen.size}名）`);
  ok(introSeen.size >= 60, `紹介枠に60名以上が現れる（実測 ${introSeen.size}名）`);
  ok(top4 < 0.25, `紹介枠の上位4名の占有率が25%未満（実測 ${(top4 * 100).toFixed(0)}%）`);
}

/* --- 8. 熟練プレイでの到達可能性 ------------------------------------------ */
head('8. 全エンディングに到達できるか（正解を引き当て、警戒を避ける熟練プレイ）');
/* 目標勢力へ寄せ続ける戦略。相手が既に目標勢力なら支持、違えば転向させる。 */
function strategist(seed, targets) {
  let st = E.createState(seed), t = 0;
  while (!st.finished) {
    if (E.pendingInterlude(st)) st = E.applyInterlude(st, 0);
    const m = E.meetingList(st);
    const slots = m.intro ? [...m.normal, m.intro] : m.normal;
    const target = targets[t++ % targets.length];
    /* 目標勢力の人物がいればその人を優先（支持のほうが相手を削らない） */
    const unwary = slots.filter(id => E.waryOf(st.currents, id) < 0);
    const pool = unwary.length ? unwary : slots;
    let charId = pool.find(id => E.CHAR_BY_ID.get(id).factions.includes(target)) ?? pool[0];
    const c = E.CHAR_BY_ID.get(charId);
    const isTarget = c.factions.includes(target);
    const ownF = isTarget ? target : c.factions[0];
    const stance = isTarget ? 'support' : 'convert';
    st = E.resolve(st, { charId, stance, ownF, argueF: target, cards: c.correct.slice() }).next;
  }
  return st;
}
const reached = new Map();
for (let seed = 1; seed <= 80; seed++) {
  const allPairs = [];
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) allPairs.push([a, b]);
  for (const targets of [[0],[1],[2],[3],[4], ...allPairs, [0,1,2,3,4]]) {
    const e = E.evaluateEnding(strategist(seed, targets));
    if (!reached.has(e.t)) reached.set(e.t, `seed ${seed} / 目標 ${targets.map(f => E.FACTIONS[f].name).join('+')}`);
  }
}
/* 『野合の衆』は10通りすべてに固有エンドを与えた結果、到達不能になった。
   将来勢力を増やしたときの保険としてコードには残してあるので、到達性の対象からは外す。 */
const allEndings = [...Object.values(E.ENDINGS.solo),
                    ...Object.entries(E.ENDINGS.combo).filter(([k]) => k !== 'etc').map(([, v]) => v),
                    E.ENDINGS.chaos];
for (const e of allEndings) ok(reached.has(e.t), `『${e.t}』に到達できる${reached.has(e.t) ? `（${reached.get(e.t)}）` : ''}`);

head('9. 無作為プレイ300局の到達分布（下手に打つと何も成せないことの確認）');
for (const [k, v] of [...endingSeen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)} 局  ${k}`);

console.log(`\n\x1b[1m結果: ${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
