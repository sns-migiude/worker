// .wasm を静的importするとwranglerがデプロイ時にコンパイル済みWebAssembly.Moduleとして同梱する。
// （Workersは実行時のwasm生成＝WebAssembly.instantiate(バイト列)を禁止しているため、バンドルが必須）
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
