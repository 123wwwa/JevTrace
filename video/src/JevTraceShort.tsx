import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Easing, Html5Audio, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import timeline from './timeline.json';

const { fontFamily: sans } = loadInter('normal', { weights: ['400', '600', '800'], subsets: ['latin'] });
const { fontFamily: mono } = loadMono('normal', { weights: ['400', '700'], subsets: ['latin'] });

export type ShortProps = {
  demo: {
    repository: string;
    task: string;
    scannedFiles: number;
    declarations: number;
    leads: Array<{ name: string; file: string; score: number }>;
    passedOver: Array<{ name: string; file: string }>;
    focus: { name: string; file: string; line: number };
    edges: Array<{ label: string; name: string; file: string }>;
    returned: { symbols: number; tokens: number; budget: number };
  };
  /** Agent context and searches with and without JevTrace (agent benchmark) and needed code found (retrieval benchmark). */
  metrics: { agentTasks: number; agentTokensWithout: number; agentTokensWith: number; searchesWithout: number; searchesWith: number; recallTasks: number; recall: number };
};

const color = {
  bg: '#0a0c10', card: '#141821', line: '#262b36', ink: '#f5f5f2', ink2: '#c3c2b7', muted: '#7d7b75', accent: '#3987e5', accentSoft: 'rgba(57,135,229,0.16)',
};
const ease = Easing.out(Easing.cubic);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** 0 → 1 between two frames, eased. */
const progress = (frame: number, from: number, to: number) => interpolate(frame, [from, to], [0, 1], { ...clamp, easing: ease });
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const fmt = (value: number) => Math.round(value).toLocaleString('en-US');
const k = (value: number) => `${Math.round(value / 1000)}k`;
const [hookStart, hookEnd] = timeline.hook;
const [taskStart] = timeline.task;
const [parseStart, parseEnd] = timeline.parse;
const [jevStart] = timeline.jev;
const [compilerStart] = timeline.compiler;
const [budgetStart, budgetEnd] = timeline.budget;
const [resultsStart, resultsEnd] = timeline.results;
const [outroStart] = timeline.outro;

/** Text that rises into place in 8 frames and, optionally, leaves the same way. */
const Rise = ({ at, out, children, style }: { at: number; out?: number; children: ReactNode; style?: CSSProperties }) => {
  const frame = useCurrentFrame();
  const inT = progress(frame, at, at + 8);
  const outT = out === undefined ? 0 : progress(frame, out, out + 8);
  return <div style={{ ...style, opacity: inT * (1 - outT), transform: `translateY(${(1 - inT) * 28 - outT * 28}px)` }}>{children}</div>;
};

const Card = ({ name, file, x, y, width = 400, scale = 1, opacity = 1, blur = 0, highlight = 0, badge }: {
  name: string; file: string; x: number; y: number; width?: number; scale?: number; opacity?: number; blur?: number; highlight?: number; badge?: ReactNode;
}) => (
  <div style={{
    position: 'absolute', left: x - width / 2, top: y - 58, width, height: 116, boxSizing: 'border-box', padding: '18px 24px',
    borderRadius: 18, background: color.card, border: `2px solid ${highlight ? color.accent : color.line}`,
    boxShadow: highlight ? `0 0 ${40 * highlight}px ${color.accentSoft}` : 'none',
    transform: `scale(${scale})`, opacity, filter: blur ? `blur(${blur}px)` : undefined,
  }}>
    {/* Long names shrink to the card instead of being cut (monospace glyphs are about 0.6 em wide). */}
    <div style={{ fontFamily: mono, fontSize: Math.min(32, (width - 52) / (name.length * 0.6)), fontWeight: 700, color: color.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
    <div style={{ fontFamily: mono, fontSize: 21, color: color.muted, marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</div>
    {badge}
  </div>
);

/** The explanation, readable with the sound off: a step headline and one line of detail. */
const Caption = ({ at, out, title, detail }: { at: number; out: number; title: ReactNode; detail?: ReactNode }) => (
  <Rise at={at} out={out} style={{ position: 'absolute', left: 60, right: 60, top: 1630, textAlign: 'center', fontFamily: sans, color: color.ink }}>
    <div style={{ fontWeight: 800, fontSize: 54, lineHeight: 1.15 }}>{title}</div>
    {detail && <div style={{ fontWeight: 600, fontSize: 32, lineHeight: 1.35, color: color.ink2, marginTop: 14 }}>{detail}</div>}
  </Rise>
);

// ---- the four steps, shown throughout ----------------------------------------------------------------
const steps = [
  { label: 'Parse', from: parseStart },
  { label: 'Jev', from: jevStart },
  { label: 'Compiler', from: compilerStart },
  { label: 'Budget', from: budgetStart },
];
const StepBar = () => {
  const frame = useCurrentFrame();
  const shown = progress(frame, parseStart, parseStart + 10) * (1 - progress(frame, budgetEnd - 6, budgetEnd + 4));
  const active = steps.reduce((current, step, index) => (frame >= step.from ? index : current), 0);
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: 64, display: 'flex', gap: 14, opacity: shown }}>
      {steps.map((step, index) => {
        const on = index === active;
        const done = index < active;
        return (
          <div key={step.label} style={{
            flex: 1, padding: '14px 0', borderRadius: 14, textAlign: 'center', fontFamily: sans, fontWeight: 700, fontSize: 28,
            background: on ? color.accent : color.card, color: on ? '#fff' : done ? color.ink2 : color.muted, border: `2px solid ${on ? color.accent : color.line}`,
          }}>{index + 1} {step.label}</div>
        );
      })}
    </div>
  );
};

// ---- 0–3 s: the problem -------------------------------------------------------------------------------
// Illustrative: the kind of search a coding agent runs without a context tool.
const searches = ['Grep  "token"', 'Read  utils/jwt/jwt.ts', 'Grep  "expired"', 'Read  middleware/jwt/jwt.ts', 'Glob  **/*.test.ts', 'Read  src/context.ts', 'Grep  "exp"', 'Read  src/request.ts', 'Grep  "nbf"', 'Read  utils/jwt/types.ts', 'Glob  src/**/*.ts', 'Read  src/hono-base.ts'];
const Hook = ({ metrics }: { metrics: ShortProps['metrics'] }) => {
  const frame = useCurrentFrame();
  const leave = progress(frame, hookEnd - 12, hookEnd);
  return (
    <AbsoluteFill style={{ opacity: 1 - leave }}>
      <div style={{ position: 'absolute', left: 90, top: 260 - frame * 5, fontFamily: mono, fontSize: 38, lineHeight: '78px', color: color.muted, opacity: 0.45 }}>
        {[...searches, ...searches].map((line, index) => <div key={index}>{line}</div>)}
      </div>
      <AbsoluteFill style={{ background: `linear-gradient(180deg, ${color.bg} 0%, rgba(10,12,16,0.35) 18%, rgba(10,12,16,0.94) 34%, rgba(10,12,16,0.94) 70%, rgba(10,12,16,0.35) 84%, ${color.bg} 100%)` }} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 700, fontFamily: sans, fontWeight: 800, color: color.ink }}>
        <Rise at={4} style={{ fontSize: 56, color: color.ink2, letterSpacing: 2 }}>CODING AGENTS</Rise>
        <Rise at={12} style={{ fontSize: 100, lineHeight: 1.02, marginTop: 12 }}>READ TOO<br />MUCH CODE.</Rise>
        <Rise at={30} style={{ fontFamily: mono, fontSize: 40, fontWeight: 700, color: color.ink2, marginTop: 40 }}>
          {fmt(metrics.agentTokensWithout * progress(frame, 30, 80))} tokens to find it
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

// ---- 3–24 s: task, parse, Jev, compiler, budget --------------------------------------------------------
const TaskCard = ({ demo }: { demo: ShortProps['demo'] }) => {
  const frame = useCurrentFrame();
  const typed = Math.round(demo.task.length * progress(frame, taskStart + 6, taskStart + 60));
  const dock = progress(frame, parseStart - 4, parseStart + 16);
  const dim = progress(frame, compilerStart, compilerStart + 20) * 0.6;
  const leave = progress(frame, budgetEnd - 6, budgetEnd + 4);
  return (
    <div style={{
      position: 'absolute', left: 60, right: 60, top: mix(700, 180, dock), padding: mix(34, 22, dock) + 'px 34px', borderRadius: 24,
      background: color.card, border: `2px solid ${color.line}`, opacity: progress(frame, taskStart, taskStart + 8) * (1 - dim) * (1 - leave),
    }}>
      <div style={{ fontFamily: sans, fontSize: 24, fontWeight: 700, color: color.accent, letterSpacing: 2 }}>TASK · {demo.repository.toUpperCase()}</div>
      <div style={{ fontFamily: mono, fontSize: mix(44, 30, dock), lineHeight: 1.35, color: color.ink, marginTop: 10, minHeight: mix(180, 120, dock) }}>
        {demo.task.slice(0, typed)}<span style={{ opacity: typed < demo.task.length ? 1 : 0, color: color.accent }}>▍</span>
      </div>
    </div>
  );
};

const Parse = ({ demo }: { demo: ShortProps['demo'] }) => {
  const frame = useCurrentFrame();
  const columns = 24;
  const tiles = Math.min(demo.scannedFiles, columns * 19);
  const lit = progress(frame, parseStart + 10, parseStart + 80);
  const leave = progress(frame, parseEnd - 14, parseEnd);
  return (
    <AbsoluteFill style={{ opacity: progress(frame, parseStart, parseStart + 10) * (1 - leave) }}>
      <div style={{ position: 'absolute', left: 150, top: 470, width: 780, display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 8, transform: `scale(${1 - leave * 0.3})` }}>
        {Array.from({ length: tiles }, (_, index) => (
          <div key={index} style={{ height: 24, borderRadius: 5, background: index / tiles < lit ? color.accent : color.line, opacity: index / tiles < lit ? 0.35 + ((index * 37) % 10) / 16 : 1 }} />
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 1130, textAlign: 'center', fontFamily: mono, fontSize: 44, fontWeight: 700, color: color.ink }}>
        {fmt(demo.scannedFiles * lit)} files → {fmt(demo.declarations * progress(frame, parseStart + 40, parseStart + 100))} declarations
      </div>
      <Caption at={parseStart + 12} out={parseEnd - 12} title="1. Parse the repository" detail={<>TypeScript&apos;s parser lists every function and type.<br />No embeddings, nothing to train.</>} />
    </AbsoluteFill>
  );
};

const Graph = ({ demo }: { demo: ShortProps['demo'] }) => {
  const frame = useCurrentFrame();
  const leadNames = new Set(demo.leads.map(lead => lead.name));
  // Candidates: Jev's leads interleaved with the keyword matches it passed over.
  const order = [demo.passedOver[0], demo.leads[0], demo.passedOver[1], demo.leads[1], demo.passedOver[2], demo.leads[2], demo.passedOver[3], demo.passedOver[4]]
    .filter(Boolean)
    .map(item => ({ name: item.name, file: item.file, lead: leadNames.has(item.name) }));
  const slot = (index: number) => ({ x: index % 2 ? 790 : 290, y: 760 + Math.floor(index / 2) * 150 });
  const narrow = ['folders', 'files', 'declarations'];

  const judge = progress(frame, jevStart + 96, jevStart + 122);
  const focusMove = progress(frame, compilerStart, compilerStart + 26);
  const collapse = progress(frame, budgetStart, budgetStart + 24);
  const focusIndex = order.findIndex(item => item.name === demo.focus.name);
  const center = { x: 540, y: 960 };
  const places = [{ x: 540, y: 600 }, { x: 830, y: 740 }, { x: 250, y: 740 }, { x: 250, y: 1200 }, { x: 830, y: 1200 }, { x: 540, y: 1370 }];
  const edges = demo.edges.slice(0, places.length).map((edge, index) => ({ ...edge, ...places[index], start: compilerStart + 30 + index * 12 }));
  const fill = progress(frame, budgetStart + 30, budgetStart + 70);

  return (
    <AbsoluteFill style={{ opacity: progress(frame, jevStart, jevStart + 10) * (1 - progress(frame, budgetEnd - 6, budgetEnd + 4)) }}>
      {/* Jev narrows the search the way a person would: folders, then files, then declarations */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 420, textAlign: 'center', opacity: 1 - focusMove }}>
        <span style={{ display: 'inline-block', padding: '16px 48px', borderRadius: 999, background: color.accent, fontFamily: sans, fontWeight: 800, fontSize: 52, color: '#fff', verticalAlign: 'middle' }}>Jev</span>
        <div style={{ marginTop: 26, fontFamily: mono, fontSize: 32, color: color.muted }}>
          {narrow.map((step, index) => {
            const on = progress(frame, jevStart + 14 + index * 16, jevStart + 24 + index * 16);
            return (
              <span key={step}>
                <span style={{ color: on ? color.ink : color.muted, opacity: 0.4 + on * 0.6 }}>{step}</span>
                {index < narrow.length - 1 && <span style={{ margin: '0 18px', color: color.accent, opacity: on }}>→</span>}
              </span>
            );
          })}
        </div>
      </div>

      {/* Compiler edges, drawn under the cards */}
      <svg width={1080} height={1920} style={{ position: 'absolute', inset: 0, opacity: 1 - collapse }}>
        {edges.map(edge => {
          const length = Math.hypot(edge.x - center.x, edge.y - center.y);
          const drawn = progress(frame, edge.start, edge.start + 14);
          return <line key={edge.name + edge.label} x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} stroke={color.accent} strokeWidth={4} strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - drawn)} />;
        })}
      </svg>
      {edges.map(edge => {
        const shown = progress(frame, edge.start + 10, edge.start + 18);
        return (
          <div key={`${edge.name}-${edge.label}`}>
            <Card name={edge.name} file={edge.file} x={mix(edge.x, center.x, collapse)} y={mix(edge.y, center.y, collapse)} width={380} opacity={shown * (1 - collapse)} scale={0.9 + shown * 0.1} />
            <div style={{
              position: 'absolute', left: mix(center.x, edge.x, 0.5) - 70, top: mix(center.y, edge.y, 0.5) - 22, width: 140, textAlign: 'center',
              fontFamily: sans, fontWeight: 600, fontSize: 24, color: color.accent, opacity: shown * (1 - collapse),
            }}><span style={{ background: color.bg, padding: '2px 10px', borderRadius: 8 }}>{edge.label}</span></div>
          </div>
        );
      })}

      {/* Candidates: Jev keeps the leads and drops keyword matches; the top lead moves to the centre */}
      {order.map((item, index) => {
        const appear = progress(frame, jevStart + 56 + index * 5, jevStart + 64 + index * 5);
        const home = slot(index);
        const isFocus = index === focusIndex;
        const x = isFocus ? mix(home.x, center.x, focusMove) : home.x;
        const y = isFocus ? mix(home.y, center.y, focusMove) : home.y;
        const opacity = appear * (item.lead ? 1 : 1 - judge * 0.85) * (isFocus ? 1 - collapse : 1 - focusMove);
        const lead = demo.leads.find(candidate => candidate.name === item.name);
        return (
          <Card key={item.name + index} name={item.name} file={item.file} x={x} y={y} width={440}
            opacity={opacity} blur={item.lead ? 0 : judge * 8} highlight={item.lead ? judge : 0}
            scale={(0.92 + appear * 0.08) * (isFocus ? 1 + focusMove * 0.18 : 1) * (1 - collapse * 0.4)}
            badge={lead && (
              <div style={{ position: 'absolute', right: 18, top: 16, fontFamily: mono, fontSize: 24, fontWeight: 700, color: color.accent, opacity: judge }}>{lead.score.toFixed(2)}</div>
            )} />
        );
      })}

      {/* Everything connected, fit to the token budget */}
      <div style={{
        position: 'absolute', left: 90, width: 900, top: center.y - 170, height: 340, borderRadius: 28, boxSizing: 'border-box', padding: '40px 48px',
        background: color.accentSoft, border: `3px solid ${color.accent}`, opacity: progress(frame, budgetStart + 8, budgetStart + 20),
        transform: `scale(${0.6 + progress(frame, budgetStart + 8, budgetStart + 26) * 0.4})`, fontFamily: sans, color: color.ink,
      }}>
        <div style={{ fontWeight: 800, fontSize: 56 }}>One context packet</div>
        <div style={{ fontFamily: mono, fontSize: 32, color: color.ink2, marginTop: 12 }}>{demo.returned.symbols} symbols, bodies included</div>
        <div style={{ marginTop: 34, height: 26, borderRadius: 13, background: color.line, overflow: 'hidden' }}>
          <div style={{ width: `${(demo.returned.tokens / demo.returned.budget) * 100 * fill}%`, height: '100%', background: color.accent }} />
        </div>
        <div style={{ fontFamily: mono, fontSize: 28, color: color.ink2, marginTop: 14 }}>{fmt(demo.returned.tokens * fill)} / {fmt(demo.returned.budget)} token budget</div>
      </div>

      <Caption at={jevStart + 8} out={compilerStart - 10} title="2. Jev picks what matters"
        detail={<>A decision model reads the task and scores folders,<br />files, then declarations. Keyword matches drop out.</>} />
      <Caption at={compilerStart + 14} out={budgetStart - 8} title="3. The compiler follows real links"
        detail={<>Callers, callees, types, thrown errors and tests,<br />resolved by TypeScript, not guessed.</>} />
      <Caption at={budgetStart + 10} out={budgetEnd - 8} title="4. Fit to a token budget"
        detail={<>Ranked, trimmed and handed to the agent<br />in one MCP call.</>} />
    </AbsoluteFill>
  );
};

// ---- 24–28 s: results ---------------------------------------------------------------------------------
const Results = ({ metrics }: { metrics: ShortProps['metrics'] }) => {
  const frame = useCurrentFrame();
  const count = progress(frame, resultsStart + 6, resultsStart + 36);
  const reduction = Math.round((1 - metrics.agentTokensWith / metrics.agentTokensWithout) * 100);
  const row: CSSProperties = { position: 'absolute', left: 80, right: 80, fontFamily: sans, color: color.ink };
  return (
    <AbsoluteFill style={{ opacity: progress(frame, resultsStart, resultsStart + 10) * (1 - progress(frame, resultsEnd - 10, resultsEnd)) }}>
      <div style={{ ...row, top: 300, fontSize: 36, fontWeight: 600, color: color.ink2 }}>The same agent, with JevTrace</div>
      <Rise at={resultsStart + 4} style={{ ...row, top: 380 }}>
        <div style={{ fontSize: 150, fontWeight: 800, lineHeight: 1, color: color.accent }}>{Math.round(reduction * count)}%</div>
        <div style={{ fontSize: 52, fontWeight: 800, marginTop: 8 }}>less context</div>
        <div style={{ fontFamily: mono, fontSize: 32, color: color.muted, marginTop: 10 }}>{k(mix(metrics.agentTokensWithout, metrics.agentTokensWith, count))} tokens · {k(metrics.agentTokensWithout)} without</div>
      </Rise>
      <Rise at={resultsStart + 40} style={{ ...row, top: 820 }}>
        <div style={{ fontSize: 150, fontWeight: 800, lineHeight: 1, color: color.accent }}>{metrics.searchesWith}</div>
        <div style={{ fontSize: 52, fontWeight: 800, marginTop: 8 }}>repository searches</div>
        <div style={{ fontFamily: mono, fontSize: 32, color: color.muted, marginTop: 10 }}>{metrics.searchesWithout} Grep/Read calls without</div>
      </Rise>
      <Rise at={resultsStart + 64} style={{ ...row, top: 1260 }}>
        <div style={{ fontSize: 150, fontWeight: 800, lineHeight: 1, color: color.accent }}>{Math.round(metrics.recall)}%</div>
        <div style={{ fontSize: 52, fontWeight: 800, marginTop: 8 }}>of the code a task needs, found</div>
      </Rise>
      <Rise at={resultsStart + 72} style={{ ...row, top: 1720, fontSize: 26, color: color.muted, lineHeight: 1.5 }}>
        Claude Code agent, median over {metrics.agentTasks} JS/TS tasks (pilot).<br />Code found: {metrics.recallTasks} JS/TS tasks.
      </Rise>
    </AbsoluteFill>
  );
};

// ---- 28–30 s: the name ---------------------------------------------------------------------------------
const Outro = () => (
  <AbsoluteFill style={{ fontFamily: sans, color: color.ink, alignItems: 'center' }}>
    <Rise at={outroStart + 2} style={{ position: 'absolute', top: 680, fontSize: 150, fontWeight: 800, letterSpacing: -3 }}>
      Jev<span style={{ color: color.accent }}>Trace</span>
    </Rise>
    <Rise at={outroStart + 8} style={{ position: 'absolute', top: 880, fontSize: 48, fontWeight: 600, color: color.ink2, textAlign: 'center', lineHeight: 1.3 }}>
      Jev + TypeScript compiler<br />for coding-agent context
    </Rise>
    <Rise at={outroStart + 14} style={{ position: 'absolute', top: 1100, fontFamily: mono, fontSize: 36, color: color.accent }}>
      MCP · JS/TS · Open source
    </Rise>
    <Rise at={outroStart + 18} style={{ position: 'absolute', top: 1560, fontFamily: mono, fontSize: 34, color: color.muted }}>
      github.com/123wwwa/JevTrace
    </Rise>
  </AbsoluteFill>
);

const within = (frame: number, [from, to]: number[]) => frame >= from - 2 && frame < to + 2;

export const JevTraceShort = ({ demo, metrics }: ShortProps) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: color.bg }}>
      {/* scripts/generate-music.mjs: music and effects on the same timeline, regenerated before every render */}
      <Html5Audio src={staticFile('audio/music.wav')} volume={0.9} />
      {within(frame, [hookStart, hookEnd]) && <Hook metrics={metrics} />}
      {within(frame, [taskStart, budgetEnd]) && <TaskCard demo={demo} />}
      {within(frame, [parseStart, budgetEnd]) && <StepBar />}
      {within(frame, timeline.parse) && <Parse demo={demo} />}
      {within(frame, [jevStart, budgetEnd]) && <Graph demo={demo} />}
      {within(frame, timeline.results) && <Results metrics={metrics} />}
      {frame >= outroStart - 2 && <Outro />}
    </AbsoluteFill>
  );
};
