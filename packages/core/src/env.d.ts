// `import sql from "./0000_init.sql" with { type: "text" }` の型（Bun がバイナリに埋め込む）
declare module "*.sql" {
  const text: string;
  export default text;
}
