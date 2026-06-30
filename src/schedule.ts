// 投稿スケジュール（基本配信時間・予約時刻の割当・±10分のゆらぎ）。
// cronは細かめ（*/10）に起動し、postNextは not_before<=now の「期限が来た予約」を出す方式。
import type { Env } from "./accounts";

// UTCミリ秒 → SQLiteの "YYYY-MM-DD HH:MM:00"（UTC）
export function sqlUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}

// JSTスロット("HH:MM")群から、afterMsより後の最初のスロットをUTC文字列で返す（ゆらぎ無しの基準時刻）
export function nextSlotAfter(slotsJst: string[], afterMs: number): string {
  const mins = slotsJst
    .map((s) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); })
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
  if (!mins.length) return sqlUtc(afterMs);
  const jst = new Date(afterMs + 9 * 3600_000); // JST壁時計をUTCフィールドで表現
  const y = jst.getUTCFullYear(), mo = jst.getUTCMonth(), da = jst.getUTCDate();
  const cur = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  let slot = mins.find((s) => s > cur);
  let dayOff = 0;
  if (slot === undefined) { slot = mins[0]; dayOff = 1; }
  const utcMs = Date.UTC(y, mo, da + dayOff, 0, 0, 0) + slot * 60_000 - 9 * 3600_000;
  return sqlUtc(utcMs);
}

// 基本スロット時刻に ±10分のゆらぎを足す（機械的な定時投稿を避ける）。過去にならないようクランプ。
export function jitter(slotUtc: string): string {
  const base = new Date(slotUtc.replace(" ", "T") + "Z").getTime();
  const off = Math.round(Math.random() * 20 - 10) * 60_000; // -10〜+10分
  let t = base + off;
  const floor = Date.now() + 60_000;
  if (t < floor) t = floor;
  return sqlUtc(t);
}

// 会員ごとの基本配信時間（individual_profile key='post_slots'。無ければ env のデフォルト）
// 1日の本数ごとの「基本の配信タイミング」プリセット（JST・1日に均等めに分散）。本数を変えても並びが崩れない基準。
const SLOT_PRESETS: Record<number, string[]> = {
  1: ["12:00"],
  2: ["08:00", "20:00"],
  3: ["07:30", "12:30", "21:00"],
  4: ["06:30", "11:30", "17:00", "21:00"],
  5: ["07:00", "11:00", "14:30", "18:00", "21:30"],
};
export function presetSlots(freq: number): string[] {
  const f = Math.max(1, Math.min(5, Math.round(freq) || 1));
  return (SLOT_PRESETS[f] || SLOT_PRESETS[4]).slice();
}

export async function getAccountSlots(env: Env, accountId: string): Promise<string[]> {
  const row = await env.DB.prepare(
    `SELECT value_json AS v FROM individual_profile WHERE account_id = ? AND key = 'post_slots'`
  )
    .bind(accountId)
    .first<{ v: string }>();
  let saved: string[] = [];
  if (row?.v) {
    try { saved = JSON.parse(row.v); } catch { saved = row.v.split(","); }
  }
  saved = saved.map((s) => String(s).trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  const acc = await env.DB.prepare(`SELECT daily_frequency FROM accounts WHERE id = ?`)
    .bind(accountId)
    .first<{ daily_frequency: number }>();
  const freq = acc?.daily_frequency ?? 0;
  // 本数が分かるなら、保存スロット数がちょうど本数と一致する時だけユーザー設定を採用。
  // 一致しない（本数を変えた直後など）＝本数ぶんのプリセットに揃える（並びの崩れ・過不足を防ぐ）。
  if (freq > 0) return saved.length === freq ? saved : presetSlots(freq);
  // 本数不明：保存があればそれ、無ければenv既定→プリセット4。
  if (saved.length) return saved;
  const envSlots = (env.POST_SLOTS_JST ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  return envSlots.length ? envSlots : presetSlots(4);
}

// 会員ごとの「準備」時刻（JST "HH:MM"）＝その日いちばん早い投稿スロットの leadMin 分前。
//   毎朝この時刻に メトリクス取得→学習→生成 を回し、初回投稿までに在庫を用意する。
//   投稿時刻を自由に設定しても（早朝でも）生成が間に合うように、固定時刻ではなく会員ごとに寄せる。
export async function accountPrepHHMM(env: Env, accountId: string, leadMin: number): Promise<string> {
  const slots = await getAccountSlots(env, accountId);
  let minM = 24 * 60;
  for (const s of slots) {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const mins = (parseInt(m[1], 10) % 24) * 60 + (parseInt(m[2], 10) % 60);
    if (mins < minM) minM = mins;
  }
  if (minM >= 24 * 60) minM = 6 * 60 + 30; // スロット不明時のフォールバック（06:30）
  const prep = (((minM - leadMin) % 1440) + 1440) % 1440; // 0時跨ぎは前日扱い（毎分cronなのでその時刻で発火）
  return String(Math.floor(prep / 60)).padStart(2, "0") + ":" + String(prep % 60).padStart(2, "0");
}

// 新規キュー投入1本の予約時刻＝既存queuedの最後の予約の次のスロット＋ゆらぎ（無ければ今の次）
export async function nextQueueSlot(env: Env, accountId: string): Promise<string> {
  const slots = await getAccountSlots(env, accountId);
  const row = await env.DB.prepare(
    `SELECT MAX(not_before) AS last FROM posts WHERE account_id = ? AND status = 'queued' AND not_before IS NOT NULL`
  )
    .bind(accountId)
    .first<{ last: string | null }>();
  let baseMs = Date.now();
  if (row?.last) {
    const lm = new Date(row.last.replace(" ", "T") + "Z").getTime();
    // not_before はゆらぎ込み(±10分)。素のスロットより前に振れていると同じスロットを再選択してしまうため、
    // ゆらぎ幅(10分)+1分だけ進めてから「次のスロット」を探す（＝同じ時間帯に2本入るのを防ぐ）。
    const cleared = lm + 11 * 60_000;
    if (cleared > baseMs) baseMs = cleared;
  }
  return jitter(nextSlotAfter(slots, baseMs));
}

// queued全件を、基本配信時間に沿って今から順に組み直す（各回ゆらぎ付き）
export async function reflowQueue(env: Env, accountId: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id FROM posts WHERE account_id = ? AND status = 'queued'
     ORDER BY (not_before IS NULL), not_before, id`
  )
    .bind(accountId)
    .all<{ id: number }>();
  const slots = await getAccountSlots(env, accountId);
  let baseMs = Date.now();
  for (const r of rows.results) {
    const canonical = nextSlotAfter(slots, baseMs);
    await env.DB.prepare(`UPDATE posts SET not_before = ? WHERE id = ?`).bind(jitter(canonical), r.id).run();
    baseMs = new Date(canonical.replace(" ", "T") + "Z").getTime() + 60_000; // 次のスロット基準は素のスロット
  }
}
