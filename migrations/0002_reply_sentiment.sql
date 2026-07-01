-- 0002: リプの内容判定（ポジ/中立/ネガ）を保存する列。成績の弱補正に使う（会員ローカル・本部には送らない）。
ALTER TABLE replies ADD COLUMN sentiment TEXT;
