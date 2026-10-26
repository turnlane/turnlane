/**
 * 設定 > キーボード（D-077。ux-mvp 6.2）: 全ショートカットの一覧（カテゴリ別・検索）、各行の変更（キーを押して記録）・
 * キーを外す・既定に戻す、すべて既定に戻す。変えるとすぐ保存して効く（ほかの設定と同じ）。衝突（同じ画面で同じキー、2打鍵の
 * 接頭辞、OS・ブラウザの予約）があれば保存せず、その行の横に相手を出す。保存に失敗したら元の値に戻して行の横に出す。
 * アプリ内のキーは設定 `ui.keybindings`（PUT /api/settings/ui）、クイック入力のグローバルホットキーは
 * `desktop.quick_add_shortcut`（PUT /api/config/:key）に保存する。どちらも端末ごと。
 * D-083: 設定画面の節（`/settings#keyboard`）になったので、D-080 のアコーディオンは外した（いつも開いている）。
 */
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Kbd } from "../components/ui.tsx";
import { usePrefs, useSavePrefs } from "../data/prefs.tsx";
import { useDesktopStatus, useQuickAddShortcut } from "../data/queries.ts";
import { type Params, useI18n } from "../i18n/index.tsx";
import { keyRowMatches, SCOPE_LABEL } from "../keys/KeyHelp.tsx";
import {
  accelFromEvent,
  type Conflict,
  compactOverrides,
  defsOf,
  findConflicts,
  getKeyOverrides,
  KEYMAP,
  type KeyDef,
  keyLabel,
  keyName,
  keysOf,
  normalizeAccel,
  recordable,
  recordStroke,
  SCOPE_ORDER,
} from "../keys/keymap.ts";
import { api, unwrap } from "../lib/api.ts";
import { DEFAULT_QUICK_ADD_SHORTCUT, shortcutLabel } from "../lib/desktop.ts";
import { isImeKey } from "../lib/ime.ts";

type Overrides = Readonly<Record<string, readonly string[]>>;

/** 衝突の文（行の下に出す）。id の行から見た文にする */
export function conflictText(
  c: Conflict,
  id: string,
  t: (
    k:
      | "settings.keyboard.conflict.same"
      | "settings.keyboard.conflict.prefix"
      | "settings.keyboard.conflict.reserved",
    p?: Params,
  ) => string,
  labelOf: (id: string) => string,
  quickAddLabel: (accel: string) => string = shortcutLabel,
): string {
  if (c.kind === "reserved")
    return t("settings.keyboard.conflict.reserved", {
      key: c.a === "quickAdd" ? quickAddLabel(c.key) : keyLabel(c.key),
    });
  const other = labelOf(c.a === id ? c.b : c.a);
  if (c.kind === "same")
    return t("settings.keyboard.conflict.same", { key: keyLabel(c.key), other });
  return t("settings.keyboard.conflict.prefix", {
    prefix: keyLabel(c.prefix),
    key: keyLabel(c.key),
    other,
  });
}

export function KeyboardSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const desktop = useDesktopStatus().data;
  const savedQuick = useQuickAddShortcut().data ?? null;
  const saved = compactOverrides(prefs.keybindings);
  const quickEff = savedQuick ?? DEFAULT_QUICK_ADD_SHORTCUT;
  const [q, setQ] = useState("");
  // 記録中の行と、2打鍵の1打目（表示用。記録の処理は effect の中の変数で持つ）
  const [rec, setRec] = useState<{ id: string } | null>(null);
  const [recPending, setRecPending] = useState<string | null>(null);
  const recId = rec?.id ?? null;
  const [badAccel, setBadAccel] = useState(false);
  // 行の横に出す1行（保存しなかった衝突・保存の失敗）。次の変更で消える
  const [rowMsg, setRowMsg] = useState<{ id: string; texts: string[] } | null>(null);
  const labelOf = (id: string) => {
    const d = defsOf(id);
    return d ? t(d.label) : id;
  };

  /** 割り当てを変えてすぐ保存する。衝突があれば保存せずに相手を行の横に出す。失敗したら元に戻して行の横に出す */
  const apply = (id: string, next: Overrides, nextQuick: string = quickEff) => {
    setRowMsg(null);
    const conflicts = findConflicts(next, nextQuick).filter(
      (c) => c.a === id || ("b" in c && c.b === id),
    );
    if (conflicts.length > 0) {
      setRowMsg({ id, texts: conflicts.map((c) => conflictText(c, id, t, labelOf)) });
      return;
    }
    const compact = compactOverrides(next);
    const fail = () => setRowMsg({ id, texts: [t("settings.saveFailed")] });
    if (JSON.stringify(compact) !== JSON.stringify(saved))
      save.mutateAsync({ keybindings: compact }).catch(fail);
    if (normalizeAccel(nextQuick) !== normalizeAccel(quickEff)) {
      const key = ["settings", "config", "desktop.quick_add_shortcut"];
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, nextQuick);
      unwrap(
        api.api.config[":key"].$put({
          param: { key: "desktop.quick_add_shortcut" },
          json: { value: nextQuick },
        }),
      )
        .then(() => {
          // アプリが登録し直して状態を送るまで少し待つ
          setTimeout(() => void qc.invalidateQueries({ queryKey: ["desktop"] }), 500);
        })
        .catch(() => {
          qc.setQueryData(key, prev);
          fail();
        });
    }
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // 記録: 窓の keydown を先取りして、画面のキーを動かさない。確定したらすぐ保存する
  useEffect(() => {
    if (recId === null) return;
    const id = recId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: string | null = null;
    setRecPending(null);
    const commit = (k: string) => {
      setRec(null);
      const o = getKeyOverrides();
      const cur = [...keysOf(id, o)];
      if (!cur.includes(k)) applyRef.current(id, { ...o, [id]: [...cur, k] });
    };
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRec(null);
        return;
      }
      if (id === "quickAdd") {
        if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
        const a = accelFromEvent(e);
        setBadAccel(a === null);
        if (a) {
          setRec(null);
          applyRef.current(id, { ...getKeyOverrides() }, a);
        }
        return;
      }
      const name = keyName(e);
      if (!recordable(name)) return;
      if (timer) clearTimeout(timer);
      const r = recordStroke(pending, name);
      if (r.done !== null) commit(r.done);
      else {
        pending = r.pending;
        setRecPending(pending);
        const first = r.pending;
        timer = setTimeout(() => commit(first), 1000);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      if (timer) clearTimeout(timer);
    };
  }, [recId]);

  const current = prefs.keybindings;
  const keyTexts = (d: KeyDef) =>
    d.scope === "desktop" ? [shortcutLabel(quickEff)] : keysOf(d.id, current).map(keyLabel);

  return (
    <section className="flex flex-col gap-3" data-testid="keyboard" data-setting="keyboard">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-section">{t("settings.keyboard")}</h2>
          <p className={`text-meta ${rowMsg?.id === "" ? "text-error" : "text-fg3"}`}>
            {rowMsg?.id === "" ? rowMsg.texts.join(" ") : t("settings.keyboard.hint")}
          </p>
        </div>
        <button
          type="button"
          className="h-7 shrink-0 rounded-card border border-line px-3 text-body hover:border-fg3"
          onClick={() => apply("", {}, DEFAULT_QUICK_ADD_SHORTCUT)}
        >
          {t("settings.keyboard.resetAll")}
        </button>
      </div>
      <div className="flex flex-col gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("settings.keyboard.search")}
          aria-label={t("settings.keyboard.search")}
          className="h-7 rounded-card border border-line bg-bg px-2 text-body outline-none placeholder:text-fg3 focus:border-accent"
        />
        <div className="flex flex-col gap-3">
          {SCOPE_ORDER.map((scope) => {
            const defs = KEYMAP.filter(
              (d) => d.scope === scope && keyRowMatches(q, d.label, keyTexts(d).join(" "), t),
            );
            if (defs.length === 0) return null;
            return (
              <div key={scope}>
                <h3 className="border-line border-b pb-1 text-meta text-fg3">
                  {t(SCOPE_LABEL[scope])}
                </h3>
                {defs.map((d) => (
                  <KeyRow
                    key={d.id}
                    def={d}
                    keys={keysOf(d.id, current)}
                    quick={quickEff}
                    recording={recId === d.id ? { pending: recPending } : null}
                    conflicts={rowMsg?.id === d.id ? rowMsg.texts : []}
                    note={
                      d.scope !== "desktop"
                        ? null
                        : recId === d.id && badAccel
                          ? { text: t("settings.keyboard.badAccel"), error: true }
                          : !desktop?.connected || !desktop.app
                            ? { text: t("settings.keyboard.desktopOff"), error: false }
                            : !desktop.app.shortcut.registered
                              ? {
                                  text: t("settings.desktop.shortcut.inUse", {
                                    key: shortcutLabel(desktop.app.shortcut.accelerator),
                                  }),
                                  error: true,
                                }
                              : null
                    }
                    onRecord={() => {
                      setBadAccel(false);
                      setRowMsg(null);
                      setRec({ id: d.id });
                    }}
                    onRemove={(k) =>
                      apply(d.id, {
                        ...current,
                        [d.id]: keysOf(d.id, current).filter((y) => y !== k),
                      })
                    }
                    onReset={() => {
                      if (d.scope === "desktop") apply(d.id, current, DEFAULT_QUICK_ADD_SHORTCUT);
                      else {
                        const { [d.id]: _, ...rest } = current;
                        apply(d.id, rest);
                      }
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function KeyRow({
  def,
  keys,
  quick,
  recording,
  conflicts,
  note,
  onRecord,
  onRemove,
  onReset,
}: {
  def: KeyDef;
  keys: readonly string[];
  quick: string;
  recording: { pending: string | null } | null;
  conflicts: string[];
  note: { text: string; error: boolean } | null;
  onRecord: () => void;
  onRemove: (k: string) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const desktop = def.scope === "desktop";
  const changed = desktop
    ? normalizeAccel(quick) !== normalizeAccel(DEFAULT_QUICK_ADD_SHORTCUT)
    : keys.length !== def.keys.length || keys.some((k, i) => k !== def.keys[i]);
  const btn =
    "flex h-[18px] items-center rounded-chip px-1 text-micro text-fg3 hover:bg-raised hover:text-fg";
  return (
    <div className="border-line border-b py-1.5" data-testid={`key-${def.id}`}>
      <div className="flex min-h-7 items-center justify-between gap-3">
        <span className="min-w-0 text-body">{t(def.label)}</span>
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {desktop ? (
            <Kbd className={conflicts.length > 0 ? "border-error text-error" : ""}>
              {shortcutLabel(quick)}
            </Kbd>
          ) : keys.length === 0 && !recording ? (
            <span className="text-fg3 text-meta">{t("settings.keyboard.none")}</span>
          ) : (
            keys.map((k) => (
              <span key={k} className="flex items-center">
                <Kbd className={conflicts.length > 0 ? "border-error text-error" : ""}>
                  {keyLabel(k)}
                </Kbd>
                {def.fixed ? null : (
                  <button
                    type="button"
                    aria-label={t("settings.keyboard.remove", { key: keyLabel(k) })}
                    title={t("settings.keyboard.remove", { key: keyLabel(k) })}
                    className="ml-0.5 flex size-[18px] items-center justify-center rounded-chip text-fg3 hover:bg-raised hover:text-fg"
                    onClick={() => onRemove(k)}
                  >
                    <X size={10} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                )}
              </span>
            ))
          )}
          {recording ? (
            <Kbd className="border-accent text-accent">
              {recording.pending
                ? `${keyLabel(recording.pending)} …`
                : t("settings.keyboard.recording")}
            </Kbd>
          ) : null}
          {def.fixed ? (
            <span className="text-fg3 text-micro">{t("settings.keyboard.fixed")}</span>
          ) : recording ? null : (
            <button
              type="button"
              className={btn}
              aria-label={t(desktop ? "settings.keyboard.change" : "settings.keyboard.add")}
              title={t(desktop ? "settings.keyboard.change" : "settings.keyboard.add")}
              onClick={onRecord}
              data-testid={`record-${def.id}`}
            >
              {desktop ? t("settings.keyboard.change") : <Plus size={12} strokeWidth={1.5} />}
            </button>
          )}
          {changed && !def.fixed ? (
            <button type="button" className={btn} onClick={onReset}>
              {t("settings.keyboard.reset")}
            </button>
          ) : null}
        </span>
      </div>
      {conflicts.map((c) => (
        <p key={c} className="text-error text-meta">
          {c}
        </p>
      ))}
      {note ? (
        <p className={`text-meta ${note.error ? "text-error" : "text-fg3"}`}>{note.text}</p>
      ) : null}
    </div>
  );
}
