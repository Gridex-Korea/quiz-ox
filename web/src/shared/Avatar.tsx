// 조합형 미니미: 몸 색(12) × 얼굴(8) × 머리(10). 전부 SVG로 그려 저작권 걱정이 없다.
import type { AvatarSpec } from '@ox/shared';

export const BODY_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee',
  '#60a5fa', '#818cf8', '#c084fc', '#f472b6', '#a8a29e', '#e5e7eb',
];

const HAIR_COLORS = ['#1f2937', '#78350f', '#b45309', '#fde68a', '#6b21a8', '#dc2626', '#0f766e', '#1e3a8a', '#f3f4f6', '#111827'];

interface Props {
  spec: AvatarSpec;
  size?: number;
  /** 회색 처리(오답·연결 끊김) */
  dim?: boolean;
  className?: string;
}

/** 얼굴 8종: [눈, 입] */
function Face({ variant }: { variant: number }) {
  const eyes = [
    <g key="e0"><circle cx="21" cy="24" r="2.2" fill="#111" /><circle cx="35" cy="24" r="2.2" fill="#111" /></g>,
    <g key="e1"><path d="M17 24 q4 -4 8 0" stroke="#111" strokeWidth="2.2" fill="none" /><path d="M31 24 q4 -4 8 0" stroke="#111" strokeWidth="2.2" fill="none" /></g>,
    <g key="e2"><circle cx="21" cy="24" r="3" fill="#111" /><circle cx="35" cy="24" r="3" fill="#111" /><circle cx="22" cy="23" r="1" fill="#fff" /><circle cx="36" cy="23" r="1" fill="#fff" /></g>,
    <g key="e3"><line x1="17" y1="24" x2="25" y2="24" stroke="#111" strokeWidth="2.4" /><line x1="31" y1="24" x2="39" y2="24" stroke="#111" strokeWidth="2.4" /></g>,
    <g key="e4"><circle cx="21" cy="24" r="2.2" fill="#111" /><path d="M31 25 q4 -3 8 0" stroke="#111" strokeWidth="2.2" fill="none" /></g>,
    <g key="e5"><rect x="15" y="20" width="26" height="8" rx="3" fill="#111" /><rect x="17" y="22" width="9" height="4" fill="#60a5fa" /><rect x="30" y="22" width="9" height="4" fill="#60a5fa" /></g>,
    <g key="e6"><path d="M18 26 l3 -4 l3 4" stroke="#111" strokeWidth="2" fill="none" /><path d="M32 26 l3 -4 l3 4" stroke="#111" strokeWidth="2" fill="none" /></g>,
    <g key="e7"><circle cx="21" cy="24" r="2.2" fill="#111" /><circle cx="35" cy="24" r="2.2" fill="#111" /><circle cx="15" cy="29" r="2.5" fill="#fca5a5" opacity="0.8" /><circle cx="41" cy="29" r="2.5" fill="#fca5a5" opacity="0.8" /></g>,
  ];
  const mouths = [
    <path key="m0" d="M22 32 q6 5 12 0" stroke="#111" strokeWidth="2" fill="none" />,
    <path key="m1" d="M23 33 h10" stroke="#111" strokeWidth="2" />,
    <ellipse key="m2" cx="28" cy="33" rx="4" ry="3" fill="#111" />,
    <path key="m3" d="M22 34 q6 -5 12 0" stroke="#111" strokeWidth="2" fill="none" />,
    <path key="m4" d="M22 31 q6 7 12 0 z" fill="#ef4444" stroke="#111" strokeWidth="1.5" />,
    <path key="m5" d="M23 33 l3 2 l3 -2 l3 2 l3 -2" stroke="#111" strokeWidth="1.8" fill="none" />,
    <circle key="m6" cx="28" cy="33" r="2" fill="#111" />,
    <path key="m7" d="M21 32 q7 6 14 0" stroke="#111" strokeWidth="2.2" fill="none" />,
  ];
  return (
    <>
      {eyes[variant % eyes.length]}
      {mouths[variant % mouths.length]}
    </>
  );
}

/** 머리·모자 10종 */
function Hair({ variant }: { variant: number }) {
  const c = HAIR_COLORS[variant % HAIR_COLORS.length];
  switch (variant % 10) {
    case 0:
      return <path d="M12 22 q16 -20 32 0 v-4 q-16 -14 -32 0 z" fill={c} />;
    case 1:
      return <path d="M11 24 q4 -18 17 -18 q13 0 17 18 q-6 -10 -17 -10 q-11 0 -17 10 z" fill={c} />;
    case 2:
      return <g><path d="M11 26 q2 -22 17 -22 q15 0 17 22 l-4 6 q-13 -12 -26 0 z" fill={c} /></g>;
    case 3:
      return <g><rect x="9" y="12" width="38" height="6" rx="3" fill={c} /><path d="M14 13 q2 -10 14 -10 q12 0 14 10 z" fill={c} /></g>;
    case 4:
      return <g><path d="M12 22 q16 -16 32 0 z" fill={c} /><circle cx="28" cy="7" r="4" fill={c} /></g>;
    case 5:
      return <g><path d="M10 20 q18 -24 36 0 l-3 3 q-15 -12 -30 0 z" fill={c} /><path d="M10 20 q-2 12 4 18 M46 20 q2 12 -4 18" stroke={c} strokeWidth="5" fill="none" strokeLinecap="round" /></g>;
    case 6:
      return <g><path d="M13 21 l3 -9 l5 6 l4 -10 l3 10 l4 -10 l5 6 l3 -3 l1 10 z" fill={c} /></g>;
    case 7:
      return <g><path d="M8 22 q20 -14 40 0 l0 3 q-20 -10 -40 0 z" fill={c} /><path d="M18 9 h20 v13 h-20 z" fill={c} /></g>;
    case 8:
      return <g><circle cx="28" cy="10" r="9" fill={c} /><path d="M12 22 q16 -12 32 0 z" fill={c} /></g>;
    default:
      return <path d="M14 22 q14 -10 28 0 z" fill={c} />;
  }
}

export function Avatar({ spec, size = 64, dim = false, className }: Props) {
  const body = BODY_COLORS[spec.body % BODY_COLORS.length]!;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 56 64"
      style={{ filter: dim ? 'grayscale(1) opacity(0.55)' : undefined, display: 'block' }}
      aria-hidden="true"
    >
      {/* 몸 */}
      <path d="M14 62 v-14 q0 -10 14 -10 q14 0 14 10 v14 z" fill={body} />
      {/* 팔 */}
      <rect x="8" y="42" width="7" height="14" rx="3.5" fill={body} />
      <rect x="41" y="42" width="7" height="14" rx="3.5" fill={body} />
      {/* 머리 */}
      <circle cx="28" cy="26" r="17" fill="#ffe0c2" />
      <Face variant={spec.face} />
      <Hair variant={spec.hair} />
    </svg>
  );
}

export function randomAvatar(): AvatarSpec {
  return {
    body: Math.floor(Math.random() * BODY_COLORS.length),
    face: Math.floor(Math.random() * 8),
    hair: Math.floor(Math.random() * 10),
  };
}
