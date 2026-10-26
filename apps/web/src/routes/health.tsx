/** デーモンの状態（/health。M0 の health 画面を枠の中に移したもの） */
import { useHealth } from "../data/queries.ts";
import { type MessageKey, useT } from "../i18n/index.tsx";

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function HealthScreen() {
  const t = useT();
  const q = useHealth();
  const h = q.data;
  const rows: [MessageKey, string][] = h
    ? [
        ["health.version", h.version],
        ["health.port", String(h.port)],
        ["health.schema", `${h.db.userVersion} / ${h.db.schemaVersion}`],
        [
          "health.db",
          `${bytes(h.db.sizeBytes)} · ${h.db.journalMode} · SQLite ${h.db.sqliteVersion}`,
        ],
        ["health.backup", `${h.backup.lastDate ?? "-"} (${h.backup.count})`],
        ["health.sources", String(h.sources.length)],
      ]
    : [];
  return (
    <div className="mx-auto max-w-[640px] px-6 py-6">
      <h1 className="mb-4 font-semibold text-title">{t("health.title")}</h1>
      {q.isError ? <p className="text-body text-fg2">{t("common.error")}</p> : null}
      <table data-testid="health" className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-line border-b">
              <th className="py-1.5 pr-3 text-left font-medium text-body text-fg2">{t(k)}</th>
              <td className="py-1.5 font-mono text-meta">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
