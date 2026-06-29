// 簡易暗号（AES-256-GCM）。会員がUIから入れた鍵(creds)を、D1に保存する前に暗号化する。
// D1には「暗号文」だけが載る。復号鍵の素材は env.CREDS_KEY（無ければ API_TOKEN で代用）。
// ※ Phase 1の現実解。将来は会員ごと/環境ごとの専用CREDS_KEYにする。

const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFrom(material: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(material || "fallback-key"));
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

export async function encryptString(plain: string, material: string): Promise<string> {
  const key = await keyFrom(material);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  const buf = new Uint8Array(iv.length + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), iv.length);
  return toB64(buf);
}

export async function decryptString(b64: string, material: string): Promise<string> {
  const key = await keyFrom(material);
  const raw = fromB64(b64);
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(pt);
}
