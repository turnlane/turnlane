/**
 * 凡例（UX 監査 A9。5.P5「画面が自分を説明する」）: ボード・デイビューの右下の「凡例」ボタンから開くポップオーバー。
 * 種類（予定・タスク・時間に置いたタスク・自分の番・AI・完了）、状態の色とアイコン、線（稼働・猶予・放置・集計外・現在時刻）、
 * 記号（~ ↺ 8日前）。右下の丸い「?」のボタンから開く（確定デザインの部品シート）
 */
import type { WorkItemStatus } from "@turnlane/core/web";
import { CircleHelp } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { hideTip, tipProps } from "./Tooltip.tsx";
import { Check, Popover } from "./ui.tsx";

const STATES: WorkItemStatus[] = ["needs_input", "error", "your_turn", "running", "done"];

/** 線（稼働 = 3px の実線、猶予 = 1px 点線・50%、放置 = 3px 点線、集計外 = 灰色の点線、右端の稼働リボン、現在時刻） */
const LINES: { k: MessageKey; style: React.CSSProperties }[] = [
  { k: "legend.line.running", style: { borderTop: "3px solid var(--dl-running)" } },
  { k: "legend.line.grace", style: { borderTop: "1px dotted var(--dl-turn)", opacity: 0.5 } },
  { k: "legend.line.idle", style: { borderTop: "3px dotted var(--dl-turn)" } },
  { k: "legend.line.excluded", style: { borderTop: "2px dotted var(--dl-line-excluded)" } },
  { k: "legend.line.ribbon", style: { borderTop: "2px solid var(--dl-running)", opacity: 0.7 } },
  { k: "legend.line.now", style: { borderTop: "1px solid var(--dl-text-1)" } },
];

function Row({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3 text-body">
      <span className="flex w-12 shrink-0 items-center">{swatch}</span>
      <span className="min-w-0 text-fg">{children}</span>
    </div>
  );
}

function Section({ k, children }: { k: MessageKey; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="pb-1 font-semibold text-fg2 text-meta">{t(k)}</h3>
      {children}
    </section>
  );
}

/** 種類の見本の小さなカード（予定 = 塗り、タスク = チェック、自分の番 = ティールの左端、完了 = 薄く） */
function Pill({
  children,
  className = "",
  style,
}: {
  children?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`flex h-[18px] w-12 items-center rounded-control pl-1 ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}

/**
 * 凡例の中身（確定デザインの部品シート: 種類・状態・線・記号の4つを2列に）。白黒でも「予定 = 塗り、タスク = チェック、
 * AI = 線」が分かるよう、見本は実物と同じ形で描く
 */
export function LegendBody() {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-4 p-3" data-testid="legend">
      <Section k="legend.kinds">
        <Row
          swatch={<Pill className="dl-ev" style={{ ["--ev" as string]: "var(--dl-running)" }} />}
        >
          {t("legend.kind.event")}
        </Row>
        <Row
          swatch={
            <Pill className="border border-line bg-raised">
              <Check checked={false} label={t("legend.kind.task")} />
            </Pill>
          }
        >
          {t("legend.kind.task")}
        </Row>
        <Row swatch={<Pill className="border border-taskplan border-dashed bg-lane" />}>
          {t("legend.kind.planned")}
        </Row>
        <Row
          swatch={
            <Pill
              className="border border-line bg-raised"
              style={{ boxShadow: "inset 3px 0 0 var(--dl-turn)" }}
            >
              <span className="pl-0.5">
                <Check checked={false} label={t("legend.kind.turn")} />
              </span>
            </Pill>
          }
        >
          {t("legend.kind.turn")}
        </Row>
        <Row swatch={<span className="block h-5 w-[3px] rounded-full bg-running" />}>
          {t("legend.kind.ai")}
        </Row>
        <Row
          swatch={
            <Pill className="border border-line opacity-60">
              <Check checked label={t("legend.kind.done")} />
            </Pill>
          }
        >
          {t("legend.kind.done")}
        </Row>
      </Section>
      <Section k="legend.states">
        {STATES.map((s) => (
          <Row key={s} swatch={<StatusIcon status={s} size={16} />}>
            {t(`status.${s}`)}
          </Row>
        ))}
      </Section>
      <Section k="legend.lines">
        {LINES.map((l) => (
          <Row key={l.k} swatch={<span className="block w-9" style={l.style} />}>
            {t(l.k)}
          </Row>
        ))}
      </Section>
      <Section k="legend.symbols">
        {(["legend.sym.estimated", "legend.sym.carried", "legend.sym.stale"] as const).map((k) => (
          <div key={k} className="flex min-h-7 items-center text-body text-fg">
            {t(k)}
          </div>
        ))}
        <p className="pt-3 text-fg2 text-meta">{t("legend.hint")}</p>
      </Section>
    </div>
  );
}

/** 右下の「凡例」ボタン（置き場所は呼ぶ側。absolute の親の中に置く） */
export function LegendButton({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        {...tipProps(t("legend.open"), "", "top")}
        // 開いているときの押下はポップオーバーの「外側のクリック」にせず、このボタンで閉じる
        onMouseDown={(e) => {
          e.stopPropagation();
          hideTip();
        }}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-expanded={anchor !== null}
        data-testid="legend-button"
        className={`z-20 flex size-7 items-center justify-center rounded-full border border-line bg-raised text-fg shadow-pop hover:bg-sunken ${className}`}
      >
        <CircleHelp size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} align="end" className="w-[560px]">
          <LegendBody />
        </Popover>
      ) : null}
    </>
  );
}
