import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface Point {
  label: string;
  value: number;
}

const DEFAULT_W = 640;

/** Charts are drawn at the pixel width of their container, so axis text stays readable on a phone. */
function useWidth(): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_W);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.round(el.clientWidth) || DEFAULT_W));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
const PAD = { top: 12, right: 12, bottom: 24, left: 46 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function Axis({ max, height, format, W }: { max: number; height: number; format: (v: number) => string; W: number }) {
  const innerH = height - PAD.top - PAD.bottom;
  return (
    <g className="chart-axis">
      {[0, 0.5, 1].map((t) => {
        const y = PAD.top + innerH * (1 - t);
        return (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} />
            <text x={PAD.left - 6} y={y + 3.5} textAnchor="end">{format(max * t)}</text>
          </g>
        );
      })}
    </g>
  );
}

/** Which x labels to print so they never collide: first, last and an even spread between. */
function labelEvery(n: number, W: number): number {
  return Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));
}

function Readout({ point, format }: { point: Point | null; format: (v: number) => string }) {
  return <p className="chart-readout" aria-live="off">{point ? `${point.label}: ${format(point.value)}` : ' '}</p>;
}

export function BarChart({ data, format, label, height = 180 }: { data: Point[]; format: (v: number) => string; label: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(28, slot - 3));
  const every = labelEvery(data.length, W);
  return (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        <Axis max={max} height={height} format={format} W={W} />
        {data.map((d, i) => {
          const h = (d.value / max) * innerH;
          const x = PAD.left + slot * i + (slot - barW) / 2;
          return (
            <g key={d.label}>
              <rect className="chart-hit" x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
              <rect className={`chart-bar${hover === i ? ' on' : ''}`} x={x} y={PAD.top + innerH - h} width={barW} height={Math.max(h, d.value > 0 ? 1.5 : 0)} rx={1.5} pointerEvents="none">
                <title>{`${d.label}: ${format(d.value)}`}</title>
              </rect>
              {i % every === 0 ? <text className="chart-x" x={PAD.left + slot * i + slot / 2} y={height - 7} textAnchor="middle">{d.label}</text> : null}
            </g>
          );
        })}
      </svg>
      <Readout point={hover === null ? null : (data[hover] ?? null)} format={format} />
    </figure>
  );
}

export function LineChart({ data, format, label, height = 160, max: fixedMax }: { data: Point[]; format: (v: number) => string; label: string; height?: number; max?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const max = fixedMax ?? niceMax(Math.max(0, ...data.map((d) => d.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (data.length <= 1 ? innerW / 2 : (innerW * i) / (data.length - 1));
  const y = (v: number) => PAD.top + innerH * (1 - Math.min(1, v / max));
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const every = labelEvery(data.length, W);
  return (
    <figure className="chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        <Axis max={max} height={height} format={format} W={W} />
        {data.length > 1 ? <path className="chart-line" d={path} /> : null}
        {data.map((d, i) => (
          <g key={`${d.label}-${i}`}>
            <rect className="chart-hit" x={x(i) - innerW / Math.max(1, data.length) / 2} y={PAD.top} width={innerW / Math.max(1, data.length)} height={innerH} onMouseEnter={() => setHover(i)} />
            <circle className={`chart-dot${hover === i ? ' on' : ''}`} cx={x(i)} cy={y(d.value)} r={hover === i ? 4.5 : 3} pointerEvents="none">
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </circle>
            {i % every === 0 ? <text className="chart-x" x={x(i)} y={height - 7} textAnchor="middle">{d.label}</text> : null}
          </g>
        ))}
      </svg>
      <Readout point={hover === null ? null : (data[hover] ?? null)} format={format} />
    </figure>
  );
}
