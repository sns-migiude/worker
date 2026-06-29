// スパム防御 Layer 1（ツール内蔵フィルタ・生成の床）。設計書08章。
//
// ⚠️ 禁止パターンの最終的な項目・線引きは「和佐さん確定」（08章）。
//    以下は差し替え前提の叩き台（機械チェック）。確定後にこの配列を置き換える。
//    将来は Hub から配信される禁止パターン（改ざん検知付き）に置き換わる（05・08章）。
//
// ここで止めるのは「スパムの仕組み」であって、意見・主張・文体（個性）ではない（08章）。

export interface FilterViolation {
  pattern: string;
  reason: string;
}

interface Rule {
  pattern: string;
  reason: string;
  test: (t: string) => boolean;
}

// 叩き台の禁止パターン（要・和佐さん確定）
const DEFAULT_RULES: Rule[] = [
  {
    pattern: "スパム挙動：ハッシュタグ過多",
    reason: "ハッシュタグが4個以上",
    test: (t) => (t.match(/[#＃]/g) ?? []).length > 3,
  },
  {
    pattern: "スパム挙動：リンク過多",
    reason: "URLが2個以上",
    test: (t) => (t.match(/https?:\/\//g) ?? []).length > 1,
  },
  {
    pattern: "誇大・効果保証",
    reason: "根拠なき断定・効果保証の表現",
    test: (t) => /必ず儲か|100[%％]|絶対に稼げ|誰でも稼げ|確実に儲か/.test(t),
  },
  {
    pattern: "煽り・恐怖訴求",
    reason: "恐怖あおり・二択煽りの表現",
    test: (t) => /知らないと損|今すぐ.{0,8}しないと手遅れ|これを見ないと損/.test(t),
  },
];

// 投稿テキストを検査し、触れた禁止パターンの一覧を返す（空なら合格）。
export function checkPost(text: string, rules: Rule[] = DEFAULT_RULES): FilterViolation[] {
  return rules
    .filter((r) => r.test(text))
    .map((r) => ({ pattern: r.pattern, reason: r.reason }));
}

export function passesFilter(text: string): boolean {
  return checkPost(text).length === 0;
}
