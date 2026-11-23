import { BackToSettings } from "../components/SettingsRows";
import { InfoButton } from "../components/InfoButton";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  featureInfo,
  formatTokens,
  formatUsd,
  groupBy,
  localDay,
  shiftDay,
  spendOver,
  totalOf,
  type SpendBucket,
  type UsageGroup,
  type UsageRow,
} from "../lib/aiCost";
import { loadUsageRows } from "../lib/aiUsage";
import { useTablesVersion } from "../lib/live";
import "./AiScreens.css";

/** The ranges the page can show; each scopes everything on it. */
const RANGES = [
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "1y", label: "Last 12 months", days: 365 },
  { key: "all", label: "All time", days: null },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/** Days per column, so the chart has at most about 30 of them. */
function bucketSize(days: number): number {
  if (days <= 31) return 1;
  if (days <= 120) return 7;
  return Math.ceil(days / 30);
}

function daysBetween(first: string, last: string): number {
  return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketLabel(b: SpendBucket): string {
  return b.start === b.end ? dayLabel(b.start) : `${dayLabel(b.start)} – ${dayLabel(b.end)}`;
}

// Spec: AI-4
export default function CostsPage() {
  const version = useTablesVersion(["ai_usage"]);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("30d");

  useEffect(() => {
    let live = true;
    loadUsageRows()
      .then((r) => {
        if (live) setRows(r);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [version]);

  const view = useMemo(() => {
    if (!rows) return null;
    const today = localDay();
    const spec = RANGES.find((r) => r.key === range) ?? RANGES[0];
    const earliest = rows[0]?.day ?? today;
    const first = spec.days === null ? (earliest < today ? earliest : today) : shiftDay(today, -(spec.days - 1));
    const inRange = rows.filter((r) => r.day >= first && r.day <= today);
    const size = bucketSize(daysBetween(first, today));
    return {
      total: totalOf(inRange),
      byFeature: groupBy(inRange, "feature"),
      byModel: groupBy(inRange, "model"),
      buckets: spendOver(inRange, first, today, size),
      unit: size === 1 ? "day" : size === 7 ? "week" : `${size} days`,
    };
  }, [rows, range]);

  return (
    <div className="screen ai-screen">
      <BackToSettings />
      <div className="with-info">
        <h1>AI costs</h1>
        {/* Spec: APP-9 */}
        <InfoButton title="AI costs">
          <p>What the assistant and the library have cost, from what OpenRouter reported for each answer, on all your devices.</p>
          <p>
            <Link to="/settings">Model and key</Link>
          </p>
        </InfoButton>
      </div>

      <div className="ai-filters" role="radiogroup" aria-label="Range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            role="radio"
            aria-checked={range === r.key}
            className={range === r.key ? "ai-filter active" : "ai-filter"}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <p className="ai-error">{error}</p>}
      {view && (
        <>
          <div className="cost-hero">
            <div className="cost-hero-value">{formatUsd(view.total.costUsd)}</div>
            <div className="muted">
              {view.total.requests} {view.total.requests === 1 ? "answer" : "answers"} ·{" "}
              {formatTokens(view.total.promptTokens)} tokens in · {formatTokens(view.total.completionTokens)} out
            </div>
          </div>

          <section className="ai-section">
            <h2>Spend per {view.unit}</h2>
            <SpendChart buckets={view.buckets} />
            <details className="cost-table-toggle">
              <summary>Show as a table</summary>
              <table className="cost-table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className="num">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {view.buckets.map((b) => (
                    <tr key={b.start}>
                      <td>{bucketLabel(b)}</td>
                      <td className="num">{formatUsd(b.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <section className="ai-section">
            <h2>By feature</h2>
            <Breakdown
              heading="Feature"
              groups={view.byFeature}
              total={view.total.costUsd}
              label={(k) => featureInfo(k).label}
              detail={(k) => featureInfo(k).detail}
            />
          </section>

          <section className="ai-section">
            <h2>By model</h2>
            <Breakdown heading="Model" groups={view.byModel} total={view.total.costUsd} label={(k) => k} detail={() => ""} />
          </section>
        </>
      )}
    </div>
  );
}

/** Rows of spend, each with a thin bar of its share. */
function Breakdown(props: {
  heading: string;
  groups: UsageGroup[];
  total: number;
  label: (key: string) => string;
  detail: (key: string) => string;
}) {
  const { heading, groups, total, label, detail } = props;
  if (groups.length === 0) return <p className="muted">Nothing spent in this range.</p>;
  return (
    <table className="cost-table">
      <thead>
        <tr>
          <th>{heading}</th>
          <th className="num">Answers</th>
          <th className="num">Tokens</th>
          <th className="num">Spend</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <tr key={g.key}>
            <td>
              <div className="cost-name">{label(g.key)}</div>
              {detail(g.key) && <div className="muted ai-small">{detail(g.key)}</div>}
              <div className="cost-share" aria-hidden="true">
                <div style={{ width: `${total > 0 ? Math.max(1, (g.costUsd / total) * 100) : 0}%` }} />
              </div>
            </td>
            <td className="num">{g.requests}</td>
            <td className="num">{formatTokens(g.promptTokens + g.completionTokens)}</td>
            <td className="num">{formatUsd(g.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Clean axis steps: 1, 2 or 5 times a power of ten. */
function niceStep(max: number, ticks: number): number {
  if (max <= 0) return 0.01;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

function axisUsd(v: number, step: number): string {
  if (v === 0) return "$0";
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return `$${v.toFixed(decimals)}`;
}

const CHART_HEIGHT = 180;
const PAD = { top: 18, right: 8, bottom: 24, left: 48 };

/**
 * Spend over time as columns: one series, one hue (so no legend; the heading
 * names it), 4px rounded tops on a square baseline, hairline gridlines, a
 * tooltip per column, and the largest column labelled.
 */
function SpendChart({ buckets }: { buckets: SpendBucket[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(0, ...buckets.map((b) => b.costUsd));
  const step = niceStep(max, 4);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);

  const plotW = width - PAD.left - PAD.right;
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const band = buckets.length > 0 ? plotW / buckets.length : plotW;
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const maxIndex = max > 0 ? buckets.findIndex((b) => b.costUsd === max) : -1;
  // Label every few columns along the axis, so the dates never collide.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 64))));

  const hovered = hover === null ? null : buckets[hover];

  return (
    <div className="spend-chart" ref={wrapRef}>
      <svg width={width} height={CHART_HEIGHT} role="img" aria-label="Spend over time">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.left - 6} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
              {axisUsd(t, step)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const cx = PAD.left + band * i + band / 2;
          const h = Math.max(0, y(0) - y(b.costUsd));
          const r = Math.min(4, h, barW / 2);
          const x0 = cx - barW / 2;
          const yTop = y(0) - h;
          // A column with a rounded top and a square foot on the baseline.
          const d =
            h <= 0
              ? ""
              : `M${x0},${y(0)} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + barW - r} Q${x0 + barW},${yTop} ${x0 + barW},${yTop + r} V${y(0)} Z`;
          return (
            <g key={b.start}>
              {d && <path d={d} className={hover === i ? "chart-bar hover" : "chart-bar"} />}
              {i === maxIndex && h > 0 && (
                <text x={cx} y={yTop - 5} className="chart-value" textAnchor="middle">
                  {formatUsd(b.costUsd)}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text x={cx} y={CHART_HEIGHT - 6} className="chart-tick" textAnchor="middle">
                  {dayLabel(b.start)}
                </text>
              )}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${bucketLabel(b)}: ${formatUsd(b.costUsd)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((h2) => (h2 === i ? null : h2))}
                onFocus={() => setHover(i)}
                onBlur={() => setHover((h2) => (h2 === i ? null : h2))}
              />
            </g>
          );
        })}
        <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} className="chart-axis" />
      </svg>
      {hovered && hover !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(width - 150, Math.max(0, PAD.left + band * hover + band / 2 - 70)),
            top: Math.max(0, y(hovered.costUsd) - 52),
          }}
        >
          <strong>{formatUsd(hovered.costUsd)}</strong>
          <span>{bucketLabel(hovered)}</span>
        </div>
      )}
    </div>
  );
}
