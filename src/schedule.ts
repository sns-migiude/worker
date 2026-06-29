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
export async function getAccountSlots(env: Env, accountId: string): Promise<string[]> {
  const row = await env.DB.prepare(
    `SELECT value_json AS v FROM individual_profile WHERE account_id = ? AND key = 'post_slots'`
  )
    .bind(accountId)
    .first<{ v: string }>();
  let slots: string[] = [];
  if (row?.v) {
    try { slots = JSON.parse(row.v); } catch { slots = row.v.split(","); }
  }
  slots = slots.map((s) => String(s).trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  if (!slots.length) {
    slots = (env.POST_SLOTS_JST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  // 時刻の数は「1日の投稿本数」に揃える（本数を超える時刻は持たない）
  const acc = await env.DB.prepare(`SELECT daily_frequency FROM accounts WHERE id = ?`)
    .bind(accountId)
    .first<{ daily_frequency: number }>();
  const freq = acc?.daily_frequency ?? slots.length;
  if (freq > 0 && slots.length > freq) slots = slots.slice(0, freq);
  return slots;
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
