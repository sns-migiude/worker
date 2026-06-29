// Claude利用の記録（モデル別の料金目安用）。1回のAPI呼び出しごとに実トークンを残す。
// テーブル未作成でも本処理は止めない（best-effort）。

import type { Env } from "./accounts";

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export async function logClaudeUsage(
  env: Env,
  accountId: string,
  model: string,
  usage: ClaudeUsage | undefined,
  kind: string
): Promise<void> {
  if (!usage) return;
  const inTok = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const cached = usage.cache_read_input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  try {
    await env.DB.prepare(
      `INSERT INTO claude_usage (account_id, model, kind, in_tokens, cached_tokens, out_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(accountId, model, kind, inTok, cached, outTok)
      .run();
  } catch (e) {
    console.error(`[${accountId}] claude_usage記録失敗（テーブル未作成?）: ${e instanceof Error ? e.message : e}`);
  }
}
