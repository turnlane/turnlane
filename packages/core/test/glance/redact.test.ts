import { describe, expect, test } from "bun:test";
import { MASK, redact } from "../../src/glance/redact.ts";

// 鍵の形をしたダミー（実在しない値）
const FAKE_GH = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const FAKE_SK = `sk-proj${"x9Y8z7W6".repeat(4)}`;

describe("伏せ字（spec-glance §5.2）", () => {
  test.each([
    [
      'curl -H "Authorization: Bearer abc.def-123" https://api.example.com/v1/charge',
      `curl -H "Authorization: Bearer ${MASK}" https://api.example.com/v1/charge`,
    ],
    [`export OPENAI_API_KEY=${FAKE_SK}`, `export OPENAI_API_KEY=sk-p${MASK}`],
    [
      `git remote add origin https://${FAKE_GH}@github.com/acme/web-app.git`,
      `git remote add origin https://${MASK}@github.com/acme/web-app.git`,
    ],
    [
      'psql "postgres://app:s3cret@db.internal:5432/main"',
      `psql "postgres://app:${MASK}@db.internal:5432/main"`,
    ],
    ["TOKEN=abc123 bun run deploy", `TOKEN=${MASK} bun run deploy`],
    // URL の資格情報（D-207 の確認）: パスワードだけ伏せ、名前に DATABASE_URL を含む代入は伏せた後の値を残す
    [
      "export DATABASE_URL=postgres://app:hunter2@db.internal:5432/main",
      `export DATABASE_URL=postgres://app:${MASK}@db.internal:5432/main`,
    ],
    [
      "DATABASE_URL=postgres://db.internal/main bun run migrate",
      `DATABASE_URL=${MASK} bun run migrate`,
    ],
    ["export STAGING_DSN=mysql://db/x", `export STAGING_DSN=${MASK}`],
    [
      "curl 'https://x.example.com/a?api_key=abc&password=hunter2'",
      `curl 'https://x.example.com/a?api_key=${MASK}&password=${MASK}'`,
    ],
    ["DB_PASSWORD='hunter two' make up", `DB_PASSWORD='${MASK}' make up`],
    ["gh auth login --with-token --token abcdef", `gh auth login --with-token --token ${MASK}`],
    ["deploy --password=hunter2", `deploy --password=${MASK}`],
    ["mysql -u root -ps3cr3t app", `mysql -u root -p${MASK} app`],
    [
      "curl 'https://x.example.com/a?token=abc&page=2'",
      `curl 'https://x.example.com/a?token=${MASK}&page=${MASK}'`,
    ],
    [
      'curl -H "X-Api-Key: abc123" https://x.example.com',
      `curl -H "X-Api-Key: ${MASK}" https://x.example.com`,
    ],
    [`echo ${FAKE_GH}`, `echo ghp_${MASK}`],
    ["xoxb-1234567890-abcdefghij", `xoxb${MASK}`],
    ["AKIAABCDEFGHIJKLMNOP", `AKIA${MASK}`],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl", MASK],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", MASK],
    ["openssl rand x9F2kQ7mZ1pL8vR3tY6wB0nC4", `openssl rand ${MASK}`],
  ])("%p", (input, want) => {
    const r = redact(input);
    expect(r.text).toBe(want);
    expect(r.masked).toBe(true);
    // 何度通しても同じ
    expect(redact(r.text).text).toBe(want);
  });

  test.each([
    "git push origin main",
    "bun test packages/core/test/glance",
    "rm -rf dist && bun run build",
    "mkdir -p apps/web/src/components",
    "ls -la ~/source/web-app",
    "bun run migrate --env staging",
    "apps/web/src/components/TurnRow.tsx",
    "docker run -p 8080:80 nginx",
  ])("伏せない: %p", (input) => {
    expect(redact(input)).toEqual({ text: input, masked: false });
  });
});
