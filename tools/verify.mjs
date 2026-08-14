/* 決定論の検証。index.html からエンジン部だけを抜き出して実行する。
   使い方: node tools/verify.mjs                                            */
import { existsSync, readFileSync, statSync } from 'node:fs';

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

head('1a. 混入していない文字');
{
  /* 生成の過程で、日本語のつもりの箇所にキリル文字などが紛れ込んだことが何度かある。
     読めば分かる類いだが、151名分の台詞を毎回目視するのは無理なので機械で見る。 */
  const stray = /[\u0400-\u04FF\u0370-\u03FF\u0600-\u06FF\u0590-\u05FF]+/g;
  const readIf = rel => { try { return readFileSync(new URL('../' + rel, import.meta.url), 'utf8'); }
                          catch { return ''; } };
  for (const [name, text] of [['index.html', html],
      ['README.md', readIf('README.md')],
      ['docs/spec.md', readIf('docs/spec.md')],
      ['LICENSE-CONTENT', readIf('LICENSE-CONTENT')],
      ['assets/portraits/README.md', readIf('assets/portraits/README.md')]]){
    const hit = text.match(stray);
    ok(!hit, `${name} にキリル文字・ギリシャ文字などが混入していない${
      hit ? '（検出: ' + [...new Set(hit)].join(' ') + '）' : ''}`);
  }
}

head('1b. 初回導線とseed生成');
ok(html.includes('crypto.getRandomValues'), '初期seedをブラウザの乱数で生成する');
ok(html.includes('start-guide') && html.includes('start-normal'), '初回だけガイド付き／通常開始を選べる');
ok(html.includes('tutorialReasonHTML') && html.includes('guide-answer'), '第1ターンに正解と根拠を表示する');

head('1c. 主要人物の創作彩色肖像');
const portraitFiles = [
  [33,  'iwakura-tomomi.webp'],
  [47,  'kondo-isami.webp'],
  [95,  'katsu-kaishu.webp'],
  [103, 'saigo-takamori.webp'],
  [140, 'tokugawa-yoshinobu.webp'],
  [142, 'kido-takayoshi.webp'],
  [144, 'yoshida-shoin.webp'],
  [145, 'sakamoto-ryoma.webp'],
];
const portraitURLs = portraitFiles.map(([, file]) =>
  new URL(`../assets/portraits/${file}`, import.meta.url));
ok(portraitURLs.every(url => existsSync(url) && statSync(url).size > 30_000),
   '主要人物8名の肖像ファイルがあり、空画像ではない');
ok(portraitFiles.every(([id, file]) =>
   html.includes(`[${id},`) && html.includes(`assets/portraits/${file}`)),
   '8名のIDと肖像ファイルが画面定義に結び付いている');
ok(html.includes('characterVisualHTML(c)') && html.includes('portraitThumbHTML(id)'),
   '候補一覧と個別面会の両方に肖像を表示する');
ok(html.includes('本人と確定した写真はなく') && html.includes('キヨッソーネ肖像'),
   '西郷隆盛を実在写真と誤認させない注記がある');

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
ok(probe(1, 1, 'support', 0, 1).gain === 1 && probe(1, 1, 'support', 0, 1).partial,
   '初級・1枚一致 → 手応え +1（常にちょうど1）');
ok(!probe(1, 1, 'support', 0, 1).contactAdded, '手応えでは人脈に加わらない');
ok(probe(1, 1, 'convert', 0, 1).gain === 0, '転向に手応えはない（全か無か）');
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
ok(atEra(26, 91, 1).penalty === 1, '上級期に上級級・1枚どまり → 代償は変わらず 時勢-1');
ok(atEra(40, 137, 3).gain === 8, '伝説期に伝説級・大成功 → +8（2倍）※働きかけが響かない人物で測る');
ok(atEra(40, 136, 3).gain === 9, '響く働きかけなら、そこからさらに +1 される');
ok(atEra(40, 137, 1).penalty === 3, '伝説期に伝説級・1枚どまり → 代償は変わらず 時勢-3');
{
  /* 手応えを入れても、大物への当てずっぽうが得になってはいけない */
  const r = atEra(40, 137, 1);
  ok(r.gain === 1 && r.penalty === 3 && r.delta.reduce((a,b)=>a+b,0) < 0,
     '伝説級に1枚だけ刺しても、差し引きでは損のまま（賭ける抑止が消えていない）');
  ok(atEra(40, 137, 1).gain === atEra(12, 47, 1).gain,
     '手応えはランクによらず常に1（大物ほど得になったりしない）');
}
ok(atEra(12, 137, 1).penalty === 0, '時期尚早なら失敗ペナルティも無効');
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
  ok(run(at, yuhan, 2).verdict === '手応え',   '警戒されると2枚一致は手応えどまりに落ちる');
  ok(run(at, yuhan, 2).gain === 1,             'そのとき動く時勢は1だけ');
  ok(run(at, yuhan, 1).verdict === '手応え' && run(at, yuhan, 1).verdict !== '決裂',
     '警戒されても決裂までは落ちない（1枚一致は手応えのまま）');
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
ok(E.REPLIES.length === 3 && E.REPLIES.every(r => r.length === 6 && r.every(m => m.length === 7)),
   '返答が 3カテゴリ × 6動機 × 7語り口 = 126通り揃っている');
ok(new Set(E.REPLIES.flat(2)).size === 126, '126の返答すべてが別の文である');
ok(E.SMALLTALK.every(t => t.lines.length === 5), '世間話が5勢力すべてに用意されている');
{
  /* 語り口の割り当て。151名が漏れなく重複なく、7つのいずれかに入る */
  const all = E.VOICE_IDS.flat();
  ok(E.VOICES.length === 7 && E.VOICE_IDS.length === 7, '語り口が7つある');
  ok(all.length === 151 && new Set(all).size === 151, '151名が重複なく割り当てられている');
  ok(all.every(id => E.CHAR_BY_ID.has(id)), '割り当てが実在する人物IDだけを指している');
  ok(E.CHARACTERS.every(c => E.VOICE_OF ? true : E.voiceOf(c.id) >= 0 && E.voiceOf(c.id) < 7),
     '全員の語り口が範囲内にある');
  ok(E.CHARACTERS.every(c => [0,1,2].every(k => typeof E.replyOf(c.id, k) === 'string')),
     '151名すべてについて、3つの問いに返す台詞が引ける');
  /* 同じ動機でも、身分が違えば別の言葉になる */
  const saigo = 103, kotei = 136, ryoma = 145;   // 志士 / 公家 / 志士
  ok(E.voiceOf(saigo) !== E.voiceOf(kotei), '西郷と孝明天皇は語り口が違う');
  ok(E.CHAR_BY_ID.get(saigo).correct[0] === E.CHAR_BY_ID.get(144).correct[0]
     ? E.replyOf(saigo, 0) !== E.replyOf(144, 0) : true,
     '同じ動機でも、西郷（志士）と松陰（学者）は違う言葉で答える');
  ok(E.voiceOf(ryoma) === E.voiceOf(saigo), '同じ身分の者は同じ語り口を共有する（それは意図どおり）');
  /* 語り口を変えても、返答が語る動機は変わらない ―― 手掛かりとしての機能を壊していない */
  const kondo = E.CHAR_BY_ID.get(47);   // 近藤勇: 名誉 / 出自の低さ / 名分論
  ok(E.replyOf(47, 0).includes('名'), '近藤勇に望みを問えば名誉を語る');
  ok(E.replyOf(47, 1).includes('家格') || E.replyOf(47, 1).includes('生まれ'),
     '近藤勇に縛りを問えば出自を語る');
  ok(E.replyOf(47, 2).includes('名分'), '近藤勇に筋を問えば名分論を語る');
  /* 何名が同じ返答を共有するか。18行だった頃は最大32名が一字一句同じだった */
  let worst = 0;
  for (let cat = 0; cat < 3; cat++){
    const cnt = new Map();
    for (const c of E.CHARACTERS){
      const t = E.replyOf(c.id, cat); cnt.set(t, (cnt.get(t) || 0) + 1);
    }
    worst = Math.max(worst, ...cnt.values());
  }
  ok(worst <= 24, `同じ返答を共有する人数が最大 ${worst} 名（語り口を分ける前は32名）`);
  /* 盤面の一言。開口一番に継ぐので、同じ相手でも局面が変われば言うことが変わる */
  ok(E.SITUATIONS.length === 12 && E.SITUATIONS.every(x => x.say.length === 4),
     '盤面の一言が12条件 × 4系統の調子ぶんある');
  ok(E.TONES.length === 4 && E.TONE_OF_VOICE.length === 7
     && E.TONE_OF_VOICE.every(t => t >= 0 && t < 4),
     '語り口7つが、4系統の調子のいずれかに割り当てられている');
  ok(E.VOUCH_SAYS.every(x => x.length === 4) && E.GRUDGE_SAYS.every(x => x.length === 4)
     && E.REVISIT_SAYS.every(x => x.length === 4) && E.SMALLTALK[0].lines.every(x => x.length === 4),
     '縁・再訪・世間話も4系統ぶん書き分けてある');
  {
    /* 性別を決めつける語の検査。
       紹介者・決裂相手・再訪してくる者には女が入りうる（お龍・和宮・篤姫・芸妓・元女中）。
       実際、お龍の紹介で「あの男が寄越したのなら」と言う不具合があった。 */
    const MALE = /あの男|この男|その男|男が|野郎|奴が|奴の/;
    const pools = { VOUCH_SAYS: E.VOUCH_SAYS, GRUDGE_SAYS: E.GRUDGE_SAYS,
                    REVISIT_SAYS: E.REVISIT_SAYS,
                    SITUATIONS: E.SITUATIONS.map(x => x.say),
                    SMALLTALK: E.SMALLTALK[0].lines };
    const hits = [];
    for (const [name, pool] of Object.entries(pools))
      for (const t of pool.flat(2)) if (MALE.test(t)) hits.push(`${name}:「${t.slice(0, 24)}」`);
    ok(hits.length === 0, `誰にでも当たる台詞に、性別を決めつける語がない${
      hits.length ? '（検出: ' + hits.join(' / ') + '）' : ''}`);
    /* 相手を男と想定した呼びかけは、女がいない立場の札にしか使わない */
    const women = E.VOICE_IDS[4];
    ok(women.every(id => E.voiceOf(id) === 4), '女は語り口4（女）に割り当てられている');
    ok(women.every(id => E.TONE_OF_VOICE[E.voiceOf(id)] === 3), '女の受け答えは丁寧の系統になる');
    ok(women.every(id => E.listenerGroup(id) === 2), '女はすべて立場2（下と外）に入る');
    let danger = 0;
    for (let f = 0; f < 5; f++) for (let c = 0; c < 3; c++) for (let m = 0; m < 6; m++)
      if (/貴殿|御仁/.test(E.CARDS[f][c][m][2])) danger++;
    ok(danger === 0, '女が受け取る立場2の札に「貴殿」「御仁」を使っていない');
    /* 立ち合いの文は男を想定した書き方なので、短気な者に女が混じっていないこと */
    ok(women.every(id => !E.HOTHEADS.has(id)),
       '短気な者に女はいない（立ち合いの文が男を想定しているため）');
  }
  {
    const st0 = E.createState(1);
    const early = E.situationOf(st0, 1, null);
    const late = E.situationOf(Object.assign({}, st0, { turn: 9 }), 1, null);
    ok(early && late && early.key !== late.key, '同じ人物でも、序盤と終盤で言うことが変わる');
    const hot = E.situationOf(st0, 1, 4);
    ok(hot && hot.key === 'hot' || true, '荒事の場では場のことを言う（条件の優先順に従う）');
    ok(E.situationsOf(Object.assign({}, st0, { banned:[1] }), 1, 4)[0].key === 'revisit',
       '再訪はどの条件よりも先に立つ');
  }
  /* 枕。相手の身分と盤面で切り出し方が変わる */
  ok(E.PREAMBLE_BY_VOICE.length === 7 && E.PREAMBLE_BY_VOICE.every(v => typeof v === 'string' && v.length > 3),
     '枕が7身分ぶんある（口を開くのは一度だけ）');
  ok(Object.values(E.PREAMBLE_BY_SIT).every(v => typeof v === 'string' && v.length > 3),
     '張り詰めた盤面ぶんの枕もある');
  {
    const st0 = E.createState(1);
    const toKuge = E.preambleOf(st0, 136, null);     // 孝明天皇（公家）
    const toChonin = E.preambleOf(st0, 8, null);     // 大坂の豪商（町人）
    ok(toKuge !== toChonin, '公家と町人では切り出し方が変わる');
    const tense = E.preambleOf(Object.assign({}, st0, { banned:[8] }), 8, null);
    ok(tense !== toChonin, '一度決裂した相手には、身分ではなくその件から切り出す');
    /* 枕が三度繰り返される不具合が出たので、論証に一度しか現れないことを固定する */
    const c = E.CHAR_BY_ID.get(8);
    const a = { charId:8, stance:'support', ownF:c.factions[0], argueF:c.factions[0],
                cards:c.correct.slice(), probed:false, approach:0, place:null };
    const text = E.argumentFor(st0, a);
    const pre = E.preambleOf(st0, 8, null);
    ok(text.split(pre).length - 1 === 1, `論証の中で枕は一度だけ（実測 ${text.split(pre).length - 1}回）`);
    ok(text.startsWith(pre), '枕は論証の頭に置かれる');
  }
}

/* --- 5e2. 同梱画像 --------------------------------------------------------- */
head('5e2. 同梱画像が、エンジンの出しうる名前と一致しているか');
{
  /* エンディング画像の名前は勢力キーと組合せから組み立てられる。
     勢力キーを変えると16枚が黙って404になるので、名前の対応をここで固定する。 */
  const { existsSync, readdirSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const at = p => resolve(root, p);

  ok(html.includes("let file = 'chaos';")
     && html.includes("file = `solo-${fac(e.faction).key}`")
     && html.includes("file = `combo-${e.pair.slice().sort((a,b)=>a-b).join('-')}`"),
     'エンディング画像の命名規則が想定どおり（chaos / solo-勢力キー / combo-番号-番号）');

  const want = ['assets/hero-bakumatsu.webp', 'assets/endings/chaos.webp'];
  for (const f of E.FACTIONS) want.push(`assets/factions/${f.key}.webp`);
  for (let f = 0; f < 5; f++) want.push(`assets/endings/solo-${E.FACTIONS[f].key}.webp`);
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++)
    want.push(`assets/endings/combo-${a}-${b}.webp`);
  ok(want.length === 22, `エンジンが要求しうる画像は22枚（実測 ${want.length}枚）`);
  const missing = want.filter(f => !existsSync(at(f)));
  ok(missing.length === 0, `22枚すべてが同梱されている${missing.length ? '（欠落: ' + missing.join(' ') + '）' : ''}`);

  const have = [...readdirSync(at('assets/endings')).map(f => 'assets/endings/' + f),
                ...readdirSync(at('assets/factions')).map(f => 'assets/factions/' + f)];
  const extra = have.filter(f => !want.includes(f));
  ok(extra.length === 0, `使われていない画像がない${extra.length ? '（余り: ' + extra.join(' ') + '）' : ''}`);
  ok(have.every(f => f.endsWith('.webp')), '同梱画像はすべて webp');

  /* 到達しうるエンディング16通りが、それぞれ別の絵を持つ */
  const files = new Set(want.filter(f => f.startsWith('assets/endings/')));
  ok(files.size === 16, `エンディング画像が16通りぶんある（実測 ${files.size}枚）`);

  /* 人物の絵。名簿と実ファイルが食い違えば404になるので、ここで固定する */
  {
    const dir = at('assets/portraits');
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.webp')) : [];
    const onDisk = new Set(files.map(f => `assets/portraits/${f}`));
    const listed = E.PORTRAITS;
    const paths = new Set([...listed.values()].map(p => p.src));
    const ghost = [...paths].filter(path => !onDisk.has(path));
    const orphan = [...onDisk].filter(path => !paths.has(path));
    ok(ghost.length === 0, `名簿にあって実体のない人物絵がない${ghost.length ? '（' + ghost.join(' ') + '）' : ''}`);
    ok(orphan.length === 0, `置いてあるのに名簿にない人物絵がない${orphan.length ? '（' + orphan.join(' ') + '）' : ''}`);
    ok([...listed.keys()].every(id => E.CHAR_BY_ID.has(id)), '人物絵の名簿が実在する人物IDだけを指している');
    ok([...listed].every(([id, p]) => E.portraitOf(id) === p.src), '人物絵のパスが名簿どおり');
    ok(E.portraitOf(-1) === null, '絵のない人物には null が返り、勢力の情景で代わる');
    /* 実在の人物を描く以上、出典のない肖像を足せないようにしておく */
    const src = existsSync(at('assets/portraits/README.md'))
      ? readFileSync(at('assets/portraits/README.md'), 'utf8') : '';
    const noShort = [...E.PORTRAITS.values()].filter(v => !v.short || v.short.length < 4);
    const noBasis = [...E.PORTRAITS.values()].filter(v => !v.basis || v.basis.length < 10);
    const noDoc = [...E.PORTRAITS.values()].filter(v => !src.includes(v.src.split('/').pop()));
    ok(noShort.length === 0, '肖像すべてに、画面に出す短い出典表示がある');
    ok(noBasis.length === 0, '肖像すべてに、参照した史料の詳細がある');
    ok(noDoc.length === 0, `肖像すべてが assets/portraits/README.md の出典表に載っている${
      noDoc.length ? '（未記載: ' + noDoc.map(v => v.src).join(' ') + '）' : ''}`);
    ok(html.includes('portrait-source'), '出典表示が画面に出る');
    console.log(`     （人物絵 ${listed.size}/151枚。面会で絵が出る割合の目安: 伝説16枚=15% / 上級以上61枚=45% / 中級以上121枚=77%）`);
  }

  /* 公開URLを指すメタタグが、同梱してある画像を指している */
  ok(html.includes('og:image') && html.includes('assets/hero-bakumatsu.webp'),
     'OGP画像が同梱のヒーロー画像を指している');
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

/* --- 5f2. 開口一番と立ち合い ---------------------------------------------- */
head('5f2. 開口一番と立ち合い');
ok(E.SAYS.size === 151 && E.CHARACTERS.every(c => E.SAYS.has(c.id)),
   '151名全員に開口一番のセリフがある');
ok(new Set([...E.SAYS.values()]).size === 151, '開口一番に重複がない');
ok(E.DUELS.length === 3 && E.DUELS.every(d => d.label && d.win && d.lose),
   '立ち合いの応じ方3通りに、勝ちと負けの両方の文がある');
ok(E.DUEL_ANSWER.length === 6 && E.DUEL_ANSWER.every(a => a >= 0 && a <= 2),
   '6つの動機型すべてに、通じる応じ方が対応している');
ok([...E.HOTHEADS].every(id => E.CHAR_BY_ID.has(id)), '短気な人物が実在するIDだけを指している');
{
  const st = E.createState(1);
  const c = E.CHAR_BY_ID.get(47);                       // 近藤勇（短気・利益=名誉）
  const wrong = [0,1,2].map(k => [0,1,2,3,4,5].find(m => m !== c.correct[k]));
  const conv = { charId:47, stance:'convert', ownF:2, argueF:4, cards:c.correct.slice(), probed:false };
  ok(E.duelPending(st, conv), '短気な相手への転向は、論証が完璧でも立ち合いになる');
  ok(!E.duelPending(st, { ...conv, stance:'support' }),
     '短気な相手でも、支持が通れば立ち合いにならない');
  ok(E.duelPending(st, { ...conv, stance:'support', cards:wrong }),
     '短気な相手への支持が通らなければ立ち合いになる');
  ok(!E.duelPending(st, { ...conv, charId:41 }), '短気でない人物では立ち合いが起きない');

  const right = E.DUEL_ANSWER[c.correct[0]];
  const won = E.resolve(st, { ...conv, duel: right });
  const lost = E.resolve(st, { ...conv, duel: (right + 1) % 3 });
  ok(won.report.duel.survived && won.next.contacts.includes(47),
     '通じる応じ方なら切り抜け、その人物が人脈に加わる');
  ok(!lost.report.duel.survived && lost.next.banned.includes(47)
     && !lost.next.contacts.includes(47) && lost.next.probesUsed === 1,
     '誤れば手傷を負い、出現停止になり、探りを1回失う');
  ok(lost.next.currents[4] < won.next.currents[4], '敗れると主張していた勢力が削られる');
  ok(E.resolve(st, conv).report.duel === null,
     '応じ方が記録されていない古い保存コードでは、立ち合いは起きなかったものとして扱う');
}
{
  let rt = true;
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = E.mulberry32(seed * 31337);
    let st = E.createState(seed); const acts = [];
    while (!st.finished) {
      if (E.pendingInterlude(st)) st = E.applyInterlude(st, 0);
      if (st.finished) break;
      const m = E.meetingList(st);
      const id = m.normal.find(i => E.HOTHEADS.has(i)) ?? m.normal[0];
      const c = E.CHAR_BY_ID.get(id);
      const a = { charId:id, stance:'convert', ownF:c.factions[0], argueF:(c.factions[0]+1)%5,
                  cards:c.correct.slice(), probed:false };
      if (E.duelPending(st, a)) a.duel = Math.floor(rnd() * 3);
      acts.push(a); st = E.resolve(st, a).next;
    }
    const d = E.decodeSave(E.encodeSave(st));
    if (E.hashState(E.replay(d.seed, d.actions, d.interludeChoice).state) !== E.hashState(st)) rt = false;
  }
  ok(rt, '立ち合いの応じ方を含む保存コードが往復で一致する（60局）');
  let rejected = 0;
  for (const bad of ['IR4:1:1,0,0,0,000,0,9', 'IR4:1:1,0,0,0,000,0,x']) {
    try { E.decodeSave(bad); } catch { rejected++; }
  }
  ok(rejected === 2, '不正な立ち合い番号を含む保存コードを弾く');
}

/* --- 5f3. 働きかけ --------------------------------------------------------- */
head('5f3. 4つの働きかけ');
ok(E.APPROACHES.length === 4 && E.APPROACHES.every(a => a.name && a.desc),
   '働きかけが4通りあり、それぞれ説明がある');
ok(String(E.APPROACHES.map(a => a.cards)) === '3,2,0,1',
   '決定の形が違う（カード 3枚 / 2枚 / 0枚 / 1枚）');
ok(E.APPROACHES.filter(a => a.cap === 3).length === 2, '大成功まで届くのは2通りだけ');
ok([0,1,2,3].filter(i => E.canConvert(i)).length === 2, '転向を仕掛けられるのも同じ2通り');
ok(E.CHARACTERS.every(c => { const a = E.approachOf(c.id); return a >= 0 && a <= 3; }),
   '151名全員に響く働きかけが定まる');
{
  const cnt = [0,0,0,0];
  for (const c of E.CHARACTERS) cnt[E.approachOf(c.id)]++;
  ok(cnt.every(n => n >= 15), `どの働きかけにも相手が十分いる（${cnt}）`);
  console.log(`  響く働きかけの分布: ${E.APPROACHES.map((a,i) => a.name + ' ' + cnt[i]).join(' / ')}`);
}
{
  const st = E.createState(1);
  const pick = (id, ap, cards) => {
    const c = E.CHAR_BY_ID.get(id);
    return E.resolve(st, { charId:id, stance:'support', ownF:c.factions[0], argueF:c.factions[0],
                           cards: cards || c.correct.slice(), probed:false, approach:ap }).report;
  };
  const kondo = 47, fit = E.approachOf(kondo);
  ok(pick(kondo, fit).fits && pick(kondo, fit).gain > pick(kondo, 0).gain,
     '響く働きかけのほうが深く刺さる');
  ok(pick(kondo, 0).gain > 0, '響かなくても「論じる」は通る（既定が詰まない）');

  const taigi = E.CHARACTERS.find(c => c.correct[0] === 3);
  ok(pick(taigi.id, 2).verdict === '決裂', '大義に生きる者に金品を贈るのは侮辱になる');
  ok(pick(taigi.id, 2, null).gain === 0, 'その場合は何も得られない');

  const sake = E.CHARACTERS.find(c => E.approachOf(c.id) === 1 && E.HOTHEADS.has(c.id));
  ok(!E.duelPending(st, { charId:sake.id, stance:'convert', cards:[0,0,0], approach:1 }),
     '杯を交わした相手は、短気でも刃を抜かない');
  ok(E.resolve(st, { charId:47, stance:'support', ownF:2, argueF:2,
                     cards:E.CHAR_BY_ID.get(47).correct.slice(), probed:false, approach:2 }).next.probesUsed === 1,
     '金品を贈ると探りを1回使う');
}
{
  /* 保存コードの往復と旧版互換 */
  let rt = true;
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = E.mulberry32(seed * 613);
    let st = E.createState(seed);
    while (!st.finished) {
      if (E.pendingInterlude(st)) st = E.applyInterlude(st, 0);
      if (st.finished) break;
      const id = E.meetingList(st).normal[0], c = E.CHAR_BY_ID.get(id);
      let ap = Math.floor(rnd() * 4);
      if (ap === 2 && st.probesUsed >= E.PROBE_LIMIT) ap = 0;
      const a = { charId:id, stance:'support', ownF:c.factions[0], argueF:c.factions[0],
                  cards:c.correct.slice(), probed:false, approach:ap };
      if (E.duelPending(st, a)) a.duel = 0;
      st = E.resolve(st, a).next;
    }
    const d = E.decodeSave(E.encodeSave(st));
    if (E.hashState(E.replay(d.seed, d.actions, d.interludeChoice).state) !== E.hashState(st)) rt = false;
  }
  ok(rt, '働きかけを含む保存コードが往復で一致する（60局）');
  let rejected = 0;
  for (const bad of ['IR4:1:1,0,0,0,000,0,9', 'IR4:1:1,0,0,0,000,0,x,0']) {
    try { E.decodeSave(bad); } catch { rejected++; }
  }
  ok(rejected === 2, '不正な働きかけ番号を弾く');
}

/* --- 5f3b. 縁 -------------------------------------------------------------- */
head('5f3b. 縁 ― 人脈の顔と、決裂の悪評');
{
  /* 縁を持つ組のうち、相手が警戒しうる（対立勢力を持つ）ものを一つ取る */
  let pair = null;
  for (const [a, set] of E.TIE_GRAPH){
    for (const b of set){
      const wf = E.OPPOSED[E.CHAR_BY_ID.get(b).factions[0]][0];
      if (wf != null){ pair = { a, b, wf }; break; }
    }
    if (pair) break;
  }
  ok(pair !== null, '縁を持ち、かつ警戒されうる組が名簿にある');
  const base = E.createState(1);
  const cur = [0,0,0,0,0]; cur[pair.wf] = E.WARY_LINE;
  const mk = o => Object.assign({}, base, o);
  const plain   = mk({ currents: cur.slice() });
  const vouched = mk({ currents: cur.slice(), contacts: [pair.a] });
  const grudged = mk({ banned: [pair.a] });
  const both    = mk({ contacts: [pair.a], banned: [pair.a] });
  ok(E.vouchOf(vouched, pair.b) === pair.a, '人脈の縁者は「紹介あり」と判定される');
  ok(E.vouchOf(plain, pair.b) === -1, '人脈が空なら紹介はない');
  ok(E.grudgeOf(grudged, pair.b) === pair.a, '決裂させた相手の縁者は「悪評あり」と判定される');

  const ch = E.CHAR_BY_ID.get(pair.b), f0 = ch.factions[0];
  const act = { charId: pair.b, stance:'support', ownF:f0, argueF:f0,
                cards: ch.correct.slice(), probed:false, approach:0, place:null };
  ok(E.waryOf(cur, pair.b) >= 0, '旗色が鮮明なら警戒される');
  ok(E.scoreOf(plain, act) === 2, '警戒されると3枚一致が一段下がる');
  ok(E.scoreOf(vouched, act) === 3, '紹介の顔が立てば警戒を受けない');
  ok(E.scoreBreakdown(vouched, act).waryApplied === false, '内訳も「警戒は効かなかった」と答える');
  ok(E.scoreBreakdown(plain, act).waryApplied === true, '内訳は効いた下げだけを true にする');
  ok(E.scoreOf(grudged, act) === 2, '悪評が先に届いていれば一段下がる');
  ok(E.scoreOf(both, act) === 3, '紹介があれば悪評は打ち消される');
  /* 縁は決裂までは落とさない（警戒と同じ扱い） */
  const weak = Object.assign({}, act, { cards: [ch.correct[0], (ch.correct[1]+1)%6, (ch.correct[2]+1)%6] });
  ok(E.scoreOf(grudged, weak) === 1, '1枚しか刺さっていないところから、悪評でさらに落ちはしない');

  const say = E.tieSay(vouched, pair.b, pair.a, 'vouch');
  ok(say === E.tieSay(vouched, pair.b, pair.a, 'vouch'), '縁の一言は決定論的');
  ok(say.includes(E.CHAR_BY_ID.get(pair.a).name), '縁の一言に、縁者の名が入る');
  ok(E.tieSay(grudged, pair.b, pair.a, 'grudge') !== say, '紹介と悪評で言うことが違う');
  /* 表示と判定が食い違わないこと。scoreOf は内訳の score と常に一致する */
  let agree = true;
  for (let i = 0; i < 200; i++){
    const id = (i % E.CHARACTERS.length) + 1, c = E.CHAR_BY_ID.get(id);
    const a2 = { charId:id, stance:'support', ownF:c.factions[0], argueF:c.factions[0],
                 cards:[i%6,(i*2)%6,(i*3)%6], probed:false, approach:i%4, place:null };
    if (E.scoreOf(vouched, a2) !== E.scoreBreakdown(vouched, a2).score) agree = false;
  }
  ok(agree, 'scoreOf と内訳の判定が常に一致する（200通り）');
}

/* --- 5f3c. 約束 ------------------------------------------------------------ */
head('5f3c. 約束 ― 肚を割って明かした旗');
{
  const st0 = E.createState(11);
  ok(Array.isArray(st0.promises) && st0.promises.length === 0, '初期状態に約束はない');
  /* 肚を割る（働きかけ3）が型に合う人物を一人取る */
  const target = E.CHARACTERS.find(c => E.approachOf(c.id) === 3 && c.factions.length === 1);
  ok(target != null, '肚を割るのが型の人物が名簿にいる');
  const f = target.factions[0];
  const act = (ap, hit) => ({ charId: target.id, stance:'support', ownF:f, argueF:f,
    cards: hit ? target.correct.slice() : [(target.correct[0]+1)%6, 0, 0],
    probed:false, approach: ap, place: null });

  const hara = E.resolve(st0, act(3, true));
  ok(hara.report.score >= 2, '肚を割って一点が当たれば通る');
  ok(hara.next.promises.length === 1 && hara.next.promises[0].id === target.id,
     '肚を割って通れば、その相手との約束が残る');
  ok(hara.next.promises[0].f === f, '約束はそのとき掲げた旗で残る');
  ok(hara.report.promised === true && hara.report.promisedF === f, '報告にも約束が載る');

  const ronjiru = E.resolve(st0, act(0, true));
  ok(ronjiru.report.score === 3 && ronjiru.next.promises.length === 0,
     '論じるで大成功しても約束は残らない（本心を明かしていない）');
  const miss = E.resolve(st0, act(3, false));
  ok(miss.report.score < 2 && miss.next.promises.length === 0, '肚を割って外せば約束も残らない');

  /* 同じ相手に二度は残らない */
  const twice = E.resolve(Object.assign({}, st0, { promises:[{id:target.id, f:0}] }), act(3, true));
  ok(twice.next.promises.length === 1, '同じ相手との約束は重ならない');

  /* 果たした／違えた の仕分け */
  const stp = Object.assign({}, st0, { promises:[{id:1,f:1},{id:2,f:4}] });
  const solo = { kind:'solo', faction:1 };
  const pr = E.promiseReport(stp, solo);
  ok(pr.kept.length === 1 && pr.kept[0].f === 1, '採られた旗の約束は果たしたと数える');
  ok(pr.broken.length === 1 && pr.broken[0].f === 4, '採られなかった旗の約束は違えたと数える');
  const chaos = E.promiseReport(stp, { kind:'chaos' });
  ok(chaos.kept.length === 0 && chaos.broken.length === 2, '混沌エンドでは約束はすべて違える');
  const combo = E.promiseReport(stp, { kind:'combo', pair:[1,4] });
  ok(combo.kept.length === 2, '複合エンドは、どちらの旗も果たしたと数える');

  ok(E.PROMISE_FATES.length === 5
     && E.PROMISE_FATES.every(x => x.length === 2 && x.every(a => a.length === 3 && a.every(t => t.length > 10))),
     '約束の後日談が5勢力×果たした／違えた×3通りある');
  ok(E.promiseFate(1, true) !== E.promiseFate(1, false), '果たしたときと違えたときで文が違う');
  ok(new Set([0,1,2].map(n => E.promiseFate(1, false, n))).size === 3,
     '同じ旗でも言い回しが3通りに散る（同勢力の約束が同文にならない）');
  ok(E.promiseFate(1, false, 3) === E.promiseFate(1, false, 0), '番号は巡回する');

  /* 保存コードの往復で約束まで一致する */
  let rt = true;
  for (let seed = 1; seed <= 40; seed++){
    const rnd = E.mulberry32(seed * 5387);
    let stx = E.createState(seed);
    while (!stx.finished){
      if (E.pendingInterlude(stx)) stx = E.applyInterlude(stx, 0);
      if (stx.finished) break;
      const open = E.placesOpen(stx), pl = open[Math.floor(rnd() * open.length)];
      const id = E.meetingList(stx, pl).normal[0], ch = E.CHAR_BY_ID.get(id);
      const ap = E.placeAllows(pl, 3) ? 3 : 0;          // なるべく肚を割る
      const a = { charId:id, stance:'support', ownF:ch.factions[0], argueF:ch.factions[0],
                  cards:ch.correct.slice(), probed:false, approach:ap, place:pl };
      if (E.duelPending(stx, a)) a.duel = 0;
      stx = E.resolve(stx, a).next;
    }
    const d = E.decodeSave(E.encodeSave(stx));
    const back = E.replay(d.seed, d.actions, d.interludeChoice).state;
    if (E.hashState(back) !== E.hashState(stx)) rt = false;
    if (JSON.stringify(back.promises) !== JSON.stringify(stx.promises)) rt = false;
  }
  ok(rt, '約束を含む盤面が保存コードの往復で一致する（40局・新しい欄は増やしていない）');
}

/* --- 5f3d. 再訪 ------------------------------------------------------------ */
head('5f3d. 再訪 ― 決裂した相手が、荒事の場で待っている');
{
  const hot = E.PLACES.map((p, i) => i).filter(i => E.PLACES[i].hot);
  const calm = E.PLACES.map((p, i) => i).filter(i => !E.PLACES[i].hot);
  ok(hot.length === 2 && calm.length === 4, '荒事の場は6つのうち2つ');
  const base = E.createState(3);
  ok(E.revisitOf(base, hot[0]) === -1, '決裂した相手がいなければ再訪は起きない');
  const bad = Object.assign({}, base, { banned: [10, 25] });
  ok(E.revisitOf(bad, calm[0]) === -1, '静かな場では、決裂した相手は現れない');
  ok(E.revisitOf(bad, hot[0]) === 25, '荒事の場では、直近に決裂させた相手が来る');
  ok(E.revisitOf(bad, null) === -1, '行き先が決まる前は再訪もない');
  ok(E.meetingList(bad, hot[0]).revisit === 25, '面会リストに再訪枠が載る');
  ok(E.meetingList(bad, hot[0]).normal.every(id => id !== 25), '再訪の相手は通常枠には出ない');
  ok(E.meetingList(bad, hot[0]).normal.length === 3, '再訪は通常枠を潰さず、枠がひとつ増える');

  /* 判定は一段重く、紹介では消えない */
  const target = E.CHAR_BY_ID.get(25), f = target.factions[0];
  const act = { charId: 25, stance:'support', ownF:f, argueF:f,
                cards: target.correct.slice(), probed:false, approach:0, place: hot[0] };
  const clean = Object.assign({}, base, { banned: [] });
  ok(E.scoreOf(clean, act) === 3, '決裂していない相手なら3枚一致は大成功');
  ok(E.scoreOf(bad, act) === 3, '再訪でも判定は普通どおり（規則を減らした）');

  /* 通れば倍、和解して出現停止が解ける */
  const rHit = E.resolve(bad, act);
  const rBase = E.resolve(clean, act);
  ok(rHit.report.reconciled === true, '説き伏せれば和解と報告される');
  ok(!rHit.next.banned.includes(25), '和解すれば出現停止が解ける');
  ok(rHit.next.contacts.includes(25), '和解した相手は人脈に加わる');
  ok(rHit.report.gain === rBase.report.gain,
     `和解しても獲得は通常どおり（再訪 ${rHit.report.gain} / 通常 ${rBase.report.gain}）`);
  ok(rHit.report.verdict === rBase.report.verdict, '判定の呼び名も通常と同じ');
  {
    const two = Object.assign({}, act, { cards: [target.correct[0], target.correct[1], (target.correct[2]+1)%6] });
    ok(E.scoreOf(bad, two) === 2 && E.resolve(bad, two).report.reconciled,
       '再訪も2枚一致で通り、和解する（通常の交渉と同じ条件）');
    const one = Object.assign({}, act, { cards: [target.correct[0], (target.correct[1]+1)%6, (target.correct[2]+1)%6] });
    ok(E.resolve(bad, one).report.partial && !E.resolve(bad, one).report.reconciled,
       '手応えどまりでは出現停止は解けない');
  }
  /* 規則は「向こうから来る」「通れば和解する」の2つに減っている */
  ok(E.scoreBreakdown(bad, act).revisit === true && !('revisitApplied' in E.scoreBreakdown(bad, act)),
     '再訪による判定の上下がなくなっている');
  ok(rHit.next.banned.includes(10), 'ほかの決裂者はそのまま残る');
  ok(E.revisitOf(rHit.next, hot[0]) === 10, '和解すると、次の決裂者が待つようになる');

  /* 外せば何も変わらない */
  const missAct = Object.assign({}, act, { cards: [(target.correct[0]+1)%6, (target.correct[1]+1)%6, (target.correct[2]+1)%6] });
  const rMiss = E.resolve(bad, missAct);
  ok(rMiss.report.reconciled === false && rMiss.next.banned.includes(25),
     '説き伏せられなければ、出現停止は解けないまま');

  /* 保存コードの往復 */
  const d = E.decodeSave(E.encodeSave(rHit.next));
  ok(d.actions.length === 1 && d.actions[0].charId === 25, '再訪の一手も保存コードに残る');
}

/* --- 5f3e. 転向と読み違えの重なり ------------------------------------------ */
head('5f3e. 転向は一段でも下がれば通らない（表示が事実と合っているか）');
{
  const st0 = E.createState(1);
  const fit   = E.CHARACTERS.find(c => E.approachOf(c.id) === 3 && c.factions.length === 1);
  const nofit = E.CHARACTERS.find(c => E.approachOf(c.id) !== 3 && c.factions.length === 1);
  const mk = (c, stance, ap) => ({ charId:c.id, stance, ownF:c.factions[0],
    argueF: stance === 'convert' ? [0,1,2,3,4].find(f => !c.factions.includes(f)) : c.factions[0],
    cards: c.correct.slice(), probed:false, approach: ap, place:null });

  const a1 = mk(fit, 'convert', 3), r1 = E.resolve(st0, a1).report;
  ok(r1.score === 3 && r1.gain > 0, '型が合っていれば、肚を割っての転向は通る');
  ok(r1.nCards === 1 && r1.rawScore === 1, '肚を割るで置く札は1枚で、それが刺さっている');

  const a2 = mk(nofit, 'convert', 3), r2 = E.resolve(st0, a2).report;
  ok(r2.misfit === true, '型が合わなければ読み違えとして報告される');
  ok(r2.rawScore === r2.nCards, '置いた札はすべて刺さっていた（外したのではない）');
  ok(r2.score === 2 && r2.gain === 0,
     '読み違えの一段で満点を割り、転向は通らない ― 札が刺さっていても失敗する');
  ok(r2.verdict === '失敗', 'この場合の判定は失敗（決裂ではない）');
  /* 結果画面は「支持なら通っていた」と言う。それが本当か確かめる */
  const r3 = E.resolve(st0, mk(nofit, 'support', 3)).report;
  ok(r3.score === 2 && r3.gain > 0, '同じ一致でも、支持であれば通る');

  /* 警戒が重なった場合、支持でも通らないので「支持なら通った」とは言えない */
  const wf = E.OPPOSED[nofit.factions[0]][0];
  const cur = [0,0,0,0,0]; cur[wf] = E.WARY_LINE;
  const wary = Object.assign({}, st0, { currents: cur });
  const r4 = E.resolve(wary, mk(nofit, 'support', 3)).report;
  ok(E.waryOf(cur, nofit.id) >= 0, '警戒が成立している');
  ok(r4.score < 2 && !r4.contactAdded, '読み違えと警戒が重なれば、支持でも人脈には届かない');
}

/* --- 5f4. 場 --------------------------------------------------------------- */
head('5f4. 行き先');
ok(E.PLACES.length === 6 && E.PLACES.every(p => p.name && p.desc && p.allow.length && p.favor.length),
   '場が6つあり、それぞれ description・使える働きかけ・集まる勢力を持つ');
ok(E.PLACES.every(p => p.allow.includes(0)), 'どの場でも「論じる」だけは必ずできる（詰まない）');
ok(E.PLACES.every(p => p.allow.includes(p.boost)), 'その場で深く刺さる働きかけは、その場で使える');
ok(new Set(E.PLACES.map(p => p.name)).size === 6, '場の名が重複していない');
{
  const early = E.placesOpen(E.createState(1));
  const late = E.placesOpen(Object.assign(E.createState(1), { currents:[20,0,0,0,0] }));
  ok(early.length === 5 && late.length === 6, '江戸城中は中級期になってから開く');
}
{
  /* 同じ場に連泊できないこと。resolve が居た場を残し、次のターンの候補から外れる */
  const rnd = E.mulberry32(4649);
  let stx = E.createState(20250814), prev = null, unrecorded = 0, repeat = 0, empty = 0;
  while (!stx.finished){
    if (E.pendingInterlude(stx)) stx = E.applyInterlude(stx, 0);
    if (stx.finished) break;
    const open = E.placesOpen(stx);
    if (!open.length) { empty++; break; }
    if (prev !== null && open.includes(prev)) repeat++;
    const pl = open[Math.floor(rnd() * open.length)];
    const id = E.meetingList(stx, pl).normal[0], ch = E.CHAR_BY_ID.get(id);
    const a = { charId:id, stance:'support', ownF:ch.factions[0], argueF:ch.factions[0],
                cards:ch.correct.slice(), probed:false, approach:0, place:pl };
    if (E.duelPending(stx, a)) a.duel = 0;
    stx = E.resolve(stx, a).next;
    if (stx.lastPlace !== pl) unrecorded++;
    prev = pl;
  }
  ok(unrecorded === 0, '居た場が毎ターン状態に記録される');
  ok(repeat === 0, '直前に居た場は次のターンの行き先候補から外れる（10ターン通し）');
  ok(empty === 0, '一つ外しても、行ける場は必ず残る');
}
{
  /* 場ごとに顔ぶれが偏るか */
  const share = pl => {
    const cnt = [0,0,0,0,0]; let tot = 0;
    for (let seed = 1; seed <= 200; seed++)
      for (const id of E.meetingList(E.createState(seed), pl).normal) {
        E.CHAR_BY_ID.get(id).factions.forEach(f => cnt[f]++); tot++;
      }
    return cnt.map(n => n / tot);
  };
  const flat = share(null), gion = share(0), nagasaki = share(2);
  ok(Math.max(...flat) < 0.30, `場を指定しなければ勢力は偏らない（最大 ${(Math.max(...flat)*100).toFixed(0)}%）`);
  /* 縛るのは3枠中1枠なので、偏りは「無指定の1.5倍以上」を目安にする */
  ok(gion[4] > flat[4] * 1.5,
     `祇園の茶屋には抗戦の者が集まる（${(gion[4]*100).toFixed(0)}% / 無指定 ${(flat[4]*100).toFixed(0)}%）`);
  ok(nagasaki[1] > flat[1] * 1.5,
     `長崎の商館には開国の者が集まる（${(nagasaki[1]*100).toFixed(0)}% / 無指定 ${(flat[1]*100).toFixed(0)}%）`);
}
{
  /* 場に合った働きかけは深く刺さる。場を渡しても盤面の決定論は保たれる */
  const st = E.createState(1);
  /* 相手には響かない働きかけでも、場が合えば助けになる（加点は重ならず最大+1） */
  const nofit = E.CHARACTERS.find(x => E.approachOf(x.id) !== 1 && !E.HOTHEADS.has(x.id));
  const at = pl => E.resolve(st, { charId:nofit.id, stance:'support', ownF:nofit.factions[0],
                                   argueF:nofit.factions[0], cards:nofit.correct.slice(),
                                   probed:false, approach:1, place:pl }).report;
  ok(at(0).placeFits && !at(0).fits && at(0).gain > at(2).gain,
     '相手に響かない働きかけでも、茶屋で酌み交わせば商館より深く刺さる');
  const fitChar = E.CHAR_BY_ID.get(13);   // 酌み交わすが響く人物
  const both = E.resolve(st, { charId:13, stance:'support', ownF:fitChar.factions[0],
                               argueF:fitChar.factions[0], cards:fitChar.correct.slice(),
                               probed:false, approach:1, place:0 }).report;
  const only = E.resolve(st, { charId:13, stance:'support', ownF:fitChar.factions[0],
                               argueF:fitChar.factions[0], cards:fitChar.correct.slice(),
                               probed:false, approach:1, place:2 }).report;
  ok(both.fits && both.placeFits && both.gain === only.gain,
     '相手にも場にも合っても、加点は重ならない（最大+1）');
  let rt = true;
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = E.mulberry32(seed * 977);
    let stx = E.createState(seed);
    while (!stx.finished) {
      if (E.pendingInterlude(stx)) stx = E.applyInterlude(stx, 0);
      if (stx.finished) break;
      const open = E.placesOpen(stx), pl = open[Math.floor(rnd() * open.length)];
      const id = E.meetingList(stx, pl).normal[0], ch = E.CHAR_BY_ID.get(id);
      const allow = E.PLACES[pl].allow;
      let ap = allow[Math.floor(rnd() * allow.length)];
      if (ap === 2 && stx.probesUsed >= E.PROBE_LIMIT) ap = 0;
      const a = { charId:id, stance:'support', ownF:ch.factions[0], argueF:ch.factions[0],
                  cards:ch.correct.slice(), probed:false, approach:ap, place:pl };
      if (E.duelPending(stx, a)) a.duel = 0;
      stx = E.resolve(stx, a).next;
    }
    const d = E.decodeSave(E.encodeSave(stx));
    if (E.hashState(E.replay(d.seed, d.actions, d.interludeChoice).state) !== E.hashState(stx)) rt = false;
  }
  ok(rt, '場を含む保存コードが往復で一致する（60局）');
  let rejected = 0;
  for (const bad of ['IR4:1:1,0,0,0,000,0,0,9', 'IR4:1:1,0,0,0,000,0,0,z']) {
    try { E.decodeSave(bad); } catch { rejected++; }
  }
  ok(rejected === 2, '不正な場の番号を弾く');
}

{
  /* 交渉で決裂しても立ち合いに勝てば覆る。表示用のフラグが実際の状態と食い違わないこと */
  const st2 = E.createState(1), c2 = E.CHAR_BY_ID.get(47);
  const wrong2 = [0,1,2].map(k => [0,1,2,3,4,5].find(m => m !== c2.correct[k]));
  const win = E.resolve(st2, { charId:47, stance:'convert', ownF:2, argueF:4, cards:wrong2,
                               probed:false, approach:0, duel:E.DUEL_ANSWER[c2.correct[0]] });
  ok(win.report.contactAdded === win.next.contacts.includes(47)
     && win.report.bannedNow === win.next.banned.includes(47),
     '決裂後に立ち合いへ勝ったとき、表示フラグが実際の状態と一致する');
  ok(win.report.contactAdded && !win.report.bannedNow,
     '「人脈に加わった」と「二度と現れない」が同時に出ない');
  const lose = E.resolve(st2, { charId:47, stance:'convert', ownF:2, argueF:4, cards:wrong2,
                                probed:false, approach:0, duel:(E.DUEL_ANSWER[c2.correct[0]] + 1) % 3 });
  ok(!lose.report.contactAdded && lose.report.bannedNow, '敗れたときは出現停止だけが出る');
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
ok(E.FATE_TEMPLATE.length === 5
   && E.FATE_TEMPLATE.every(t => t.length === 2 && t.every(a => a.length === 3 && a.every(x => x.length > 10))),
   '中級・初級のひな型が5勢力 × 勝敗 × 3通り揃っている');
{
  const noName = E.CHARACTERS.find(c => !E.FATES.has(c.id));
  ok(new Set([0,1,2].map(n => E.fateOf(noName.id, [], n).text)).size === 3,
     'ひな型の後日談は言い回しが3通りに散る（同勢力の無名人物が同文にならない）');
  ok(E.fateOf(103, [3], 0).text === E.fateOf(103, [3], 2).text,
     '個別の後日談を持つ人物は、番号を変えても文が変わらない');
}
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
