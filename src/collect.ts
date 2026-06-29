// 成果収集（メトリクス＋リプ）と、公平な数字への正規化。
// 設計書: 04章（自リプ除外・正規化＝平常比）／06章（安定フラグ＝settled）。
//
// ・er_raw  … 生のエンゲージメント率（自リプは除外して算出）
// ・er_norm … アカウント自身の最近の中央値で割った「平常比」。大小アカを同じ土俵に乗せる
// ・settled … 投稿から一定時間が過ぎ、数字が安定したとみなすフラグ（学習はこれが立った投稿だけ）

import {
  fetchTweetMetrics,
  fetchAccountMetrics,
  fetchReplies,
  type XCreds,
  type TweetMetrics,
} from "./xapi";
import { loadActiveAccounts, xCreds, type Account, type Env } from "./accounts";

// この時間が過ぎたら成果が安定したとみなす（初速の過大評価を避ける・06章）
const SETTLE_HOURS = 48;

function median(nums: number[]): number {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// SQLiteの "YYYY-MM-DD HH:MM:SS"(UTC) を Date に直す
function parseSqlUtc(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

interface PostRow {
  id: number;
  platform_post_id: string;
  posted_at: string;
}

async function collectMetricsForAccount(
  env: Env,
  account: Account,
  creds: XCreds
): Promise<number> {
  const windowDays = parseInt(env.METRICS_WINDOW_DAYS, 10) || 14;
  // 既に settled=1 のスナップショットを取れた投稿は再取得しない（API節約＝Xの読み取りコスト削減）。
  // 48h(SETTLE_HOURS)で数字は安定するので、各投稿は「安定前は毎日＋確定の1回」で打ち止め。
  // 確定値は必ず1回記録するのでデータ欠落はない（14日窓×毎日 → 約3回に）。
  const posts = await env.DB.prepare(
    `SELECT p.id, p.platform_post_id, p.posted_at FROM posts p
     WHERE p.account_id = ? AND p.platform = 'x' AND p.status = 'posted'
       AND p.platform_post_id IS NOT NULL AND p.deleted_at IS NULL
       AND p.posted_at >= datetime('now', ?)
       AND NOT EXISTS (
         SELECT 1 FROM post_metrics m WHERE m.post_id = p.id AND m.settled = 1
       )`
  )
    .bind(account.id, `-${windowDays} days`)
    .all<PostRow>();
  if (posts.results.length === 0) return 0;

  const byTweet = new Map<string, PostRow>();
  for (const p of posts.results) byTweet.set(p.platform_post_id, p);

  // 自リプ数（集計から除外する・04章の公平な集計）
  const selfReplies = new Map<number, number>();
  const sr = await env.DB.prepare(
    `SELECT post_id, COUNT(*) AS n FROM replies
     WHERE account_id = ? AND is_self = 1 GROUP BY post_id`
  )
    .bind(account.id)
    .all<{ post_id: number; n: number }>();
  for (const row of sr.results) if (row.post_id != null) selfReplies.set(row.post_id, row.n);

  // メトリクス取得（100件ずつ）→ er_raw と settled を計算
  const ids = posts.results.map((p) => p.platform_post_id);
  const collected: Array<{ post: PostRow; m: TweetMetrics; erRaw: number; settled: number }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const metrics = await fetchTweetMetrics(creds, chunk, true);
    for (const m of metrics) {
      const post = byTweet.get(m.tweetId);
      if (!post) continue;
      const imp = m.impressions ?? 0;
      const selfN = selfReplies.get(post.id) ?? 0;
      const adjReplies = Math.max(0, (m.replies ?? 0) - selfN); // 自リプを引く
      const engagements =
        (m.likes ?? 0) +
        (m.retweets ?? 0) +
        (m.quotes ?? 0) +
        (m.bookmarks ?? 0) +
        adjReplies;
      const erRaw = imp > 0 ? engagements / imp : 0;
      const ageHours = (Date.now() - parseSqlUtc(post.posted_at)) / 3600_000;
      const settled = ageHours >= SETTLE_HOURS ? 1 : 0;
      collected.push({ post, m, erRaw, settled });
    }
  }
  if (collected.length === 0) return 0;

  // 平常比の基準＝このアカウント自身の最近のER中央値。
  // これで割ることで「その人にとって平常比どれだけ伸びたか」に揃う（大小アカ公平・04章）。
  const baseline = median(
    collected.filter((c) => (c.m.impressions ?? 0) > 0).map((c) => c.erRaw)
  );

  let saved = 0;
  for (const c of collected) {
    const erNorm = baseline > 0 ? c.erRaw / baseline : null;
    await env.DB.prepare(
      `INSERT INTO post_metrics
        (post_id, account_id, impressions, likes, reposts, replies, quotes, bookmarks,
         url_link_clicks, profile_clicks, er_raw, er_norm, settled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        c.post.id,
        account.id,
        c.m.impressions,
        c.m.likes,
        c.m.retweets,
        c.m.replies,
        c.m.quotes,
        c.m.bookmarks,
        c.m.urlLinkClicks,
        c.m.userProfileClicks,
        c.erRaw,
        erNorm,
        c.settled
      )
      .run();
    saved++;
  }

  // アカウント日次スナップショット（フォロワー等・正規化の文脈）。失敗しても投稿成果は守る。
  try {
    const a = await fetchAccountMetrics(creds);
    await env.DB.prepare(
      `INSERT INTO account_metrics (account_id, platform, followers, following, posts_count)
       VALUES (?, 'x', ?, ?, ?)`
    )
      .bind(account.id, a.followers, a.following, a.tweets)
      .run();
  } catch (e) {
    console.error(
      `[${account.id}] アカウントメトリクス取得失敗: ${e instanceof Error ? e.message : e}`
    );
  }
  return saved;
}

export async function collectMetrics(
  env: Env
): Promise<Array<{ account: string; saved: number }>> {
  const accounts = await loadActiveAccounts(env);
  const out: Array<{ account: string; saved: number }> = [];
  for (const acc of accounts) {
    if (!acc.platforms.includes("x")) continue;
    const creds = await xCreds(env, acc.id);
    if (!creds) continue;
    try {
      out.push({ account: acc.id, saved: await collectMetricsForAccount(env, acc, creds) });
    } catch (e) {
      console.error(`[${acc.id}] メトリクス収集失敗: ${e instanceof Error ? e.message : e}`);
      out.push({ account: acc.id, saved: 0 });
    }
  }
  return out;
}

// ── リプ収集（is_self判定。自リプを集計除外するためのマーク・04章） ──────────
async function collectRepliesForAccount(
  env: Env,
  account: Account,
  creds: XCreds
): Promise<number> {
  let selfUsername: string | null = account.handle;
  if (!selfUsername) {
    try {
      selfUsername = (await fetchAccountMetrics(creds)).username;
    } catch {
      /* is_self判定が効かなくなるだけ。収集は続行 */
    }
  }

  const rows = await env.DB.prepare(
    `SELECT id, platform_post_id FROM posts
     WHERE account_id = ? AND platform = 'x' AND status = 'posted'
       AND platform_post_id IS NOT NULL AND posted_at >= datetime('now', '-7 days')
     ORDER BY posted_at DESC`
  )
    .bind(account.id)
    .all<{ id: number; platform_post_id: string }>();

  let newReplies = 0;
  for (const r of rows.results) {
    try {
      const replies = await fetchReplies(creds, r.platform_post_id);
      for (const rep of replies) {
        const isSelf = selfUsername && rep.authorUsername === selfUsername ? 1 : 0;
        const res = await env.DB.prepare(
          `INSERT OR IGNORE INTO replies
            (account_id, post_id, platform_post_id, reply_id, author_id, author_username,
             is_self, text, reply_likes, reply_created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            account.id,
            r.id,
            r.platform_post_id,
            rep.replyId,
            rep.authorId,
            rep.authorUsername,
            isSelf,
            rep.text,
            rep.likes,
            rep.createdAt
          )
          .run();
        if ((res.meta.changes ?? 0) > 0) newReplies++;
      }
    } catch (e) {
      console.error(
        `[${account.id}] リプ取得失敗 post#${r.id}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  return newReplies;
}

export async function collectReplies(
  env: Env
): Promise<Array<{ account: string; newReplies: number }>> {
  const accounts = await loadActiveAccounts(env);
  const out: Array<{ account: string; newReplies: number }> = [];
  for (const acc of accounts) {
    if (!acc.platforms.includes("x")) continue;
    const creds = await xCreds(env, acc.id);
    if (!creds) continue;
    out.push({ account: acc.id, newReplies: await collectRepliesForAccount(env, acc, creds) });
  }
  return out;
}
