import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Freeze,
  Img,
  Series,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// MORE explainer. Every scene is built in code and appears part by part.
// No camera moves and no app footage.

const C = {
  bg: "#FBF4E8",
  ink: "#1B2141",
  muted: "#5B6178",
  blue: "#3346B8",
  orange: "#FF8A5C",
  sky: "#9DB8FF",
  gold: "#FFD166",
  goldSoft: "#FFE3A0",
  green: "#C5D97A",
  red: "#B03A2E",
  line: "#4A4F63",
  stripe: "#F1EADB",
};
const HEAD = '"Avenir Next", "Avenir", "Helvetica Neue", sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.4, 0, 0.2, 1);

// ---------- Atoms ----------
const Show: React.FC<{
  at: number;
  style?: React.CSSProperties;
  dist?: number;
  children: React.ReactNode;
}> = ({ at, style, dist = 24, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: { damping: 200 } });
  return (
    <div style={{ ...style, opacity: s, transform: `translateY(${(1 - s) * dist}px)` }}>
      {children}
    </div>
  );
};

const useTween = (a: number, b: number, from: number, to: number) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [a, b], [from, to], { ...clamp, easing: ease });
};

const usd = (v: number, d = 0) => `$${v.toFixed(d)}`;
const trim = (v: number) => Number(v.toFixed(3)).toString();

const Scene: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8, dur - 8, dur], [0, 1, 1, 0], clamp);
  return <AbsoluteFill style={{ backgroundColor: C.bg, opacity }}>{children}</AbsoluteFill>;
};

const Frame: React.FC<{
  kicker: string;
  right?: string;
  title: string;
  footer?: string;
  footAt?: number;
  children: React.ReactNode;
}> = ({ right, title, children }) => (
  <AbsoluteFill style={{ padding: "64px 108px 60px", fontFamily: HEAD, color: C.ink }}>
    <Show at={0}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 27,
          letterSpacing: 1,
          color: C.muted,
        }}
      >
        <span />
        <span style={{ fontWeight: 500, minHeight: 34 }}>
          {right && right.includes("= $100") ? right : ""}
        </span>
      </div>
    </Show>
    <Show at={3}>
      <div
        style={{
          fontSize: 78,
          fontWeight: 900,
          lineHeight: 1.08,
          marginTop: 18,
          letterSpacing: -1,
        }}
      >
        {title}
      </div>
    </Show>
    <Show at={6}>
      <div style={{ height: 3, background: C.line, marginTop: 28 }} />
    </Show>
    <div
      style={{
        flex: 1,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "10px 0 20px",
      }}
    >
      {children}
    </div>
    {/* Footer lines are hidden. The voice says them. */}
  </AbsoluteFill>
);

const Label: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <div style={{ fontSize: 28, fontWeight: 800, color: color ?? C.muted, letterSpacing: 0.5 }}>
    {children}
  </div>
);
const Big: React.FC<{ children: React.ReactNode; color?: string; size?: number }> = ({
  children,
  color,
  size = 84,
}) => (
  <div style={{ fontSize: size, fontWeight: 900, color: color ?? C.ink, lineHeight: 1.1 }}>
    {children}
  </div>
);
const Body: React.FC<{ children: React.ReactNode; bold?: boolean; size?: number }> = ({
  children,
  bold,
  size = 38,
}) => (
  <div style={{ fontSize: size, fontWeight: bold ? 800 : 500, lineHeight: 1.4 }}>{children}</div>
);
const Pill: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <div
    style={{
      display: "inline-block",
      background: color ?? C.green,
      border: `3px solid ${C.ink}`,
      borderRadius: 40,
      padding: "8px 26px",
      fontSize: 32,
      fontWeight: 800,
    }}
  >
    {children}
  </div>
);
const Banner: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      background: C.gold,
      border: `4px solid ${C.ink}`,
      borderRadius: 14,
      padding: "18px 30px",
      fontSize: 38,
      fontWeight: 900,
    }}
  >
    {children}
  </div>
);
const Box: React.FC<{ who: string; value: string; color: string }> = ({ who, value, color }) => (
  <div
    style={{
      flex: 1,
      background: color,
      border: `4px solid ${C.ink}`,
      borderRadius: 12,
      padding: "14px 24px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
    }}
  >
    <span style={{ fontSize: 24, fontWeight: 800 }}>{who}</span>
    <span style={{ fontSize: 50, fontWeight: 900 }}>{value}</span>
  </div>
);

// A crop of a storyboard image (portraits and the press illustration).
const Crop: React.FC<{
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  width: number;
}> = ({ file, x, y, w, h, width }) => {
  const k = width / w;
  return (
    <div style={{ width, height: h * k, overflow: "hidden", position: "relative", flexShrink: 0 }}>
      <Img
        src={staticFile(file)}
        style={{
          position: "absolute",
          width: 1920 * k,
          height: 1080 * k,
          left: -x * k,
          top: -y * k,
        }}
      />
    </div>
  );
};
const Alice: React.FC<{ width?: number }> = ({ width = 330 }) => (
  <Crop file="sb-04.png" x={113} y={344} w={463} h={555} width={width} />
);
const Bob: React.FC<{ width?: number }> = ({ width = 330 }) => (
  <Crop file="sb-05.png" x={113} y={344} w={463} h={555} width={width} />
);

// The pool, drawn in code so its content can change.
const Cert: React.FC<{ label: string; width: number; style?: React.CSSProperties }> = ({
  label,
  width,
  style,
}) => (
  <div
    style={{
      width,
      height: 84,
      background: C.green,
      border: `4px solid ${C.ink}`,
      borderRadius: 12,
      boxShadow: `5px 5px 0 ${C.ink}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 32,
      fontWeight: 900,
      whiteSpace: "nowrap",
      flexShrink: 0,
      ...style,
    }}
  >
    {label}
  </div>
);
const PoolBox: React.FC<{
  shares: number;
  usdc?: number;
  usdcIn?: number;
  width?: number;
  certIn?: number;
}> = ({ shares, usdc, usdcIn = 1, width = 720, certIn = 1 }) => (
  <div
    style={{
      width,
      height: 220,
      background: "#2B57B5",
      border: `5px solid ${C.ink}`,
      borderRadius: 20,
      padding: 20,
      boxShadow: `10px 10px 0 ${C.ink}`,
      flexShrink: 0,
    }}
  >
    <div
      style={{
        height: "100%",
        background: "#E3EEDD",
        border: `4px solid ${C.ink}`,
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 26,
        padding: "0 30px",
      }}
    >
      {shares > 0 ? (
        <Cert
          label={`${trim(shares)} bNVDA`}
          width={200 + 85 * shares}
          style={{ opacity: certIn, transform: `scale(${0.8 + 0.2 * certIn})` }}
        />
      ) : (
        <div style={{ fontSize: 30, fontWeight: 700, color: C.muted }}>empty pool</div>
      )}
      {usdc !== undefined ? (
        <div style={{ opacity: usdcIn, textAlign: "center", marginLeft: "auto" }}>
          <div style={{ position: "relative", width: 120, height: 62, margin: "0 auto" }}>
            {[30, 15, 0].map((t) => (
              <div
                key={t}
                style={{
                  position: "absolute",
                  top: t,
                  width: 120,
                  height: 34,
                  borderRadius: "50%",
                  background: C.gold,
                  border: `4px solid ${C.ink}`,
                }}
              />
            ))}
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, marginTop: 6 }}>
            {usd(usdc, usdc % 1 ? 2 : 0)} USDC
          </div>
        </div>
      ) : null}
    </div>
  </div>
);

// A table whose rows appear one by one.
const Table: React.FC<{
  cols: string[];
  rows: string[][];
  start: number;
  step: number;
  gold?: number[];
  size?: number;
  tags?: Record<number, string>;
}> = ({ cols, rows, start, step, gold = [], size = 31, tags }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const grid = tags ? `1.05fr repeat(${cols.length}, 1fr)` : `repeat(${cols.length}, 1fr)`;
  return (
    <div style={{ fontSize: size }}>
      <Show at={10}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: grid,
            fontWeight: 900,
            textAlign: "center",
            paddingBottom: 12,
          }}
        >
          {tags ? <div /> : null}
          {cols.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      </Show>
      {rows.map((r, i) => {
        const at = start + i * step;
        const s = spring({ frame: frame - at, fps, config: { damping: 200 } });
        const fresh = interpolate(frame - at, [0, step, step + 12], [1, 1, 0], clamp);
        const isGold = gold.includes(i);
        return (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: grid,
              textAlign: "center",
              padding: "9px 0",
              borderRadius: 8,
              fontWeight: isGold ? 900 : 500,
              background: isGold ? C.goldSoft : i % 2 ? "transparent" : C.stripe,
              opacity: s,
              transform: `translateY(${(1 - s) * 14}px)`,
              outline: `4px solid rgba(51,70,184,${fresh})`,
              outlineOffset: -2,
            }}
          >
            {tags ? (
              <div>
                {tags[i] ? (
                  <span
                    style={{
                      background: C.ink,
                      color: "#fff",
                      borderRadius: 20,
                      padding: "2px 16px",
                      fontSize: size * 0.82,
                      fontWeight: 900,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tags[i]}
                  </span>
                ) : null}
              </div>
            ) : null}
            {r.map((c, j) => (
              <div key={j}>{c}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

// ---------- Scenes ----------
const Problem: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const W = 980;
  const H = 400;
  const yOf = (p: number) => H - ((p - 50) / 60) * H;
  const pts: [number, number][] = [
    [0, 100],
    [130, 98],
    [270, 104],
    [410, 101],
    [540, 102],
  ];
  const path = pts.map(([x, p], i) => `${i ? "L" : "M"}${x},${yOf(p)}`).join(" ");
  const draw = interpolate(frame, [14, 55], [0, 1], { ...clamp, easing: ease });
  const lineIn = interpolate(frame, [60, 75], [0, 1], clamp);
  const gap = interpolate(frame, [90, 112], [0, 1], { ...clamp, easing: ease });
  const dot = interpolate(frame, [112, 122], [0, 1], clamp);
  return (
    <Scene dur={dur}>
      <Frame
        kicker="THE PROBLEM"
        right="Illustrative 2× margin loan"
        title="A Monday gap can force a sale."
        footer="A margin lender can close the position before the holder can act."
        footAt={138}
      >
        <div style={{ display: "flex", gap: 70 }}>
          <div>
            <svg width={W} height={H + 10} style={{ overflow: "visible" }}>
              <line
                x1={0}
                x2={W - 60}
                y1={yOf(62.5)}
                y2={yOf(62.5)}
                stroke={C.red}
                strokeWidth={4}
                strokeDasharray="18 14"
                opacity={lineIn}
              />
              <path
                d={path}
                fill="none"
                stroke={C.blue}
                strokeWidth={11}
                strokeLinejoin="round"
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - draw}
              />
              <line
                x1={540}
                y1={yOf(102)}
                x2={540 + 300 * gap}
                y2={yOf(102) + (yOf(60) - yOf(102)) * gap}
                stroke={C.line}
                strokeWidth={4}
                strokeDasharray="20 16"
                opacity={gap > 0 ? 1 : 0}
              />
              <g opacity={dot}>
                <line
                  x1={840}
                  y1={yOf(60)}
                  x2={920}
                  y2={yOf(61.5)}
                  stroke={C.red}
                  strokeWidth={9}
                  strokeLinecap="round"
                />
                <circle cx={840} cy={yOf(60)} r={13} fill={C.orange} stroke={C.ink} strokeWidth={4} />
              </g>
            </svg>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: W - 60,
                fontSize: 30,
                fontWeight: 800,
                marginTop: 12,
              }}
            >
              <span>FRIDAY &nbsp;$100</span>
              <span style={{ opacity: dot }}>MONDAY &nbsp;$60</span>
            </div>
          </div>
          <div style={{ paddingTop: 10 }}>
            <Show at={60}>
              <Label>Example liquidation level</Label>
              <Big color={C.red} size={96}>
                $62.50
              </Big>
            </Show>
            <Show at={122} style={{ marginTop: 16 }}>
              <Body size={42}>
                The stock reopens
                <br />
                below the trigger.
              </Body>
            </Show>
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

const Title: React.FC<{ dur: number; end?: boolean }> = ({ dur, end }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words: [string, string][] = [
    ["M", "argin"],
    ["O", "n"],
    ["R", "WA"],
    ["E", "xposure,"],
  ];
  return (
    <Scene dur={dur}>
      <AbsoluteFill
        style={{ fontFamily: HEAD, color: C.ink, alignItems: "center", justifyContent: "center" }}
      >
        <div style={{ display: "flex", gap: 10 }}>
          {"MORE".split("").map((ch, i) => {
            const s = spring({ frame: frame - 6 - i * 5, fps, config: { damping: 200 } });
            return (
              <span
                key={i}
                style={{
                  fontSize: 300,
                  fontWeight: 900,
                  letterSpacing: -6,
                  lineHeight: 1,
                  opacity: s,
                  transform: `translateY(${(1 - s) * 60}px)`,
                  display: "inline-block",
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>
        <Show at={36} style={{ marginTop: 26 }}>
          <div style={{ fontSize: 62, fontWeight: 600 }}>
            {words.map(([a, b], i) => (
              <span key={i}>
                <span style={{ fontWeight: 900, color: C.blue }}>{a}</span>
                {b}{" "}
              </span>
            ))}
            <span
              style={{ fontWeight: 900, background: C.gold, padding: "2px 16px", borderRadius: 10 }}
            >
              without liquidation.
            </span>
          </div>
        </Show>
        {end ? null : (
          <Show at={62} style={{ marginTop: 44 }}>
            <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 46 }}>
              About 2× on a tokenized stock. Nobody can force you out.
            </div>
          </Show>
        )}
      </AbsoluteFill>
    </Scene>
  );
};

const SharedPool: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="THE IDEA"
      right="bNVDA = tokenized NVDA stock"
      title="Leverage without a personal margin loan."
      footer="Nobody borrows from anybody. Both hold a token from the same pool."
      footAt={142}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Show at={15} style={{ textAlign: "center" }}>
          <Alice width={270} />
          <Big size={52}>Alice</Big>
          <Body size={30}>Leveraged token</Body>
        </Show>
        <Show at={70}>
          <Big size={70}>→</Big>
        </Show>
        <div style={{ textAlign: "center" }}>
          <Show at={40}>
            <PoolBox shares={2} width={640} />
          </Show>
          <Show at={95} style={{ marginTop: 34 }}>
            <Pill>One shared pool of stock</Pill>
          </Show>
        </div>
        <Show at={70}>
          <Big size={70}>←</Big>
        </Show>
        <Show at={55} style={{ textAlign: "center" }}>
          <Bob width={270} />
          <Big size={52}>Bob</Big>
          <Body size={30}>Stable token</Body>
        </Show>
      </div>
    </Frame>
  </Scene>
);

const Deposit: React.FC<{ dur: number; who: "alice" | "bob" }> = ({ dur, who }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const isAlice = who === "alice";
  const fly = interpolate(frame, [30, 62], [0, 1], { ...clamp, easing: ease });
  const flyOp = interpolate(frame, [28, 34, 58, 64], [0, 1, 1, 0], clamp);
  const landed = frame >= 62;
  const pop = spring({ frame: frame - 62, fps, config: { damping: 200 } });
  const shares = isAlice ? (landed ? 1 : 0) : landed ? 2 : 1;
  return (
    <Scene dur={dur}>
      <Frame
        kicker="HOW THE LEVERAGE STARTS"
        right="1 bNVDA = $100"
        title={isAlice ? "Alice deposits one bNVDA." : "Bob deposits another bNVDA."}
        footer={
          isAlice
            ? "Alice's token is the whole $100 while she is the only depositor."
            : "Bob receives a $100 stable claim. The other $100 belongs to Alice."
        }
        footAt={isAlice ? 115 : 175}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 60, position: "relative" }}>
          <Show at={10}>{isAlice ? <Alice /> : <Bob />}</Show>
          <div style={{ width: 240, position: "relative", height: 100 }}>
            <Cert
              label="1 bNVDA"
              width={230}
              style={{
                position: "absolute",
                left: -40 + fly * 360,
                top: 8,
                opacity: flyOp,
                zIndex: 2,
              }}
            />
          </div>
          <div>
            <Show at={18}>
              <PoolBox shares={shares} certIn={isAlice ? pop : 1} />
            </Show>
            {isAlice ? (
              <Show at={80} style={{ marginTop: 36 }}>
                <Big size={72}>Pool value &nbsp;$100</Big>
              </Show>
            ) : (
              <>
                <Show at={85} style={{ marginTop: 30 }}>
                  <div style={{ display: "flex", gap: 14, width: 720 }}>
                    <Box who="ALICE" value="$100" color={C.orange} />
                    <Box who="BOB" value="$100" color={C.sky} />
                  </div>
                </Show>
                <Show at={125} style={{ marginTop: 26 }}>
                  <Big size={60}>$200 stock ÷ $100 Alice = 2×</Big>
                </Show>
              </>
            )}
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

const PriceMove: React.FC<{ dur: number; to: number }> = ({ dur, to }) => {
  const up = to > 100;
  const price = useTween(25, 65, 100, to);
  const pool = price * 2;
  const alice = pool - 100;
  const endPool = to * 2;
  const endAlice = endPool - 100;
  return (
    <Scene dur={dur}>
      <Frame
        kicker="ALL-STOCK POOL"
        right={`bNVDA $100 to $${to}`}
        title={up ? "A 10% rise gives Alice a 20% gain." : "A 10% fall costs Alice 20%."}
        footer={
          up
            ? "The pool holds two shares. A $10 gain on each adds $20 to Alice's side."
            : "Alice still holds her tokens. Her smaller balance means higher leverage."
        }
        footAt={148}
      >
        <div style={{ display: "flex", gap: 90, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={12}>
              <Label>bNVDA PRICE</Label>
              <Big size={70} color={up ? C.blue : C.red}>
                {usd(price)}
              </Big>
            </Show>
            <Show at={20} style={{ marginTop: 14 }}>
              <Label>POOL VALUE, 2 bNVDA</Label>
              <Big size={110}>{usd(pool)}</Big>
            </Show>
            <Show at={80} style={{ marginTop: 8 }}>
              <Big size={60}>
                {usd(endPool)} − $100 = {usd(endAlice)}
              </Big>
            </Show>
            <Show at={105} style={{ marginTop: 26 }}>
              <Pill color={up ? C.green : C.goldSoft}>
                Stock {up ? "+10%" : "−10%"} → Alice {up ? "+20%" : "−20%"}
              </Pill>
            </Show>
            <Show at={125} style={{ marginTop: 14 }}>
              <Pill>
                Leverage now {usd(endPool)} ÷ {usd(endAlice)} = {(endPool / endAlice).toFixed(2)}×
              </Pill>
            </Show>
          </div>
          <Show at={20}>
            <div
              style={{
                width: 640,
                border: `4px solid ${C.ink}`,
                boxShadow: `10px 10px 0 ${C.ink}`,
                fontSize: 46,
                fontWeight: 900,
              }}
            >
              <div
                style={{
                  height: alice * 1.9,
                  background: C.orange,
                  display: "flex",
                  alignItems: "center",
                  padding: "0 30px",
                  gap: 24,
                  borderBottom: `4px solid ${C.ink}`,
                }}
              >
                <span>Alice</span>
                <span>{usd(alice)}</span>
              </div>
              <div
                style={{
                  height: 190,
                  background: C.sky,
                  display: "flex",
                  alignItems: "center",
                  padding: "0 30px",
                  gap: 24,
                }}
              >
                <span>Bob</span>
                <span style={{ marginLeft: 18 }}>$100</span>
              </div>
            </div>
          </Show>
        </div>
      </Frame>
    </Scene>
  );
};

const Cushion: React.FC<{ dur: number }> = ({ dur }) => {
  const cards = [
    { at: 20, head: "STOCK AT $50", pool: "$100 pool", a: "$0", b: "$100" },
    { at: 70, head: "STOCK AT $40", pool: "$80 pool", a: "$0", b: "$80" },
    { at: 120, head: "BACK TO $60", pool: "$120 pool", a: "$20", b: "$100" },
  ];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="ALL-STOCK POOL"
        right="The pool keeps both shares"
        title="At $40, even Bob takes a loss."
        footer="At zero, Alice still holds her tokens. A rebound gives them value again."
        footAt={160}
      >
        <div style={{ display: "flex", gap: 70 }}>
          {cards.map((c) => (
            <Show key={c.head} at={c.at} style={{ flex: 1 }}>
              <Label>{c.head}</Label>
              <Big size={92}>{c.pool}</Big>
              <div style={{ height: 3, background: C.line, margin: "18px 0 22px" }} />
              {[
                ["Alice", c.a],
                ["Bob", c.b],
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    fontSize: 38,
                    fontWeight: 500,
                    lineHeight: 1.7,
                  }}
                >
                  <span>{k}</span>
                  <span style={{ fontSize: 52, fontWeight: 900 }}>{v}</span>
                </div>
              ))}
            </Show>
          ))}
        </div>
      </Frame>
    </Scene>
  );
};

const TableAllStock: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="ALL-STOCK POOL"
      right="Before the sell rule"
      title="Two shares through the whole fall."
      footer="At $50 Alice's equity is zero. At $40 the pool backs only $80 of Bob's $100."
      footAt={212}
    >
      <Table
        cols={["bNVDA price", "Pool value", "Bob", "Alice", "Alice's loss", "Leverage"]}
        start={22}
        step={28}
        size={34}
        rows={[
          ["$100", "$200", "$100", "$100", "0%", "2.00×"],
          ["$90", "$180", "$100", "$80", "20%", "2.25×"],
          ["$80", "$160", "$100", "$60", "40%", "2.67×"],
          ["$70", "$140", "$100", "$40", "60%", "3.50×"],
          ["$60", "$120", "$100", "$20", "80%", "6.00×"],
          ["$50", "$100", "$100", "$0", "100%", "–"],
          ["$40", "$80", "$80", "$0", "100%", "–"],
        ]}
      />
    </Frame>
  </Scene>
);

const SellTrigger: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="REPLAY THE FALL"
      right="Before the first sale"
      title="At $80, leverage reaches the sell trigger."
      footer="Selling $40 of stock brings Alice's exposure back to 2×."
      footAt={162}
    >
      <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
        <div>
          <Show at={14}>
            <PoolBox shares={2} />
          </Show>
          <Show at={28} style={{ marginTop: 30 }}>
            <div style={{ display: "flex", gap: 14, width: 720 }}>
              <Box who="ALICE" value="$60" color={C.orange} />
              <Box who="BOB" value="$100" color={C.sky} />
            </div>
          </Show>
        </div>
        <div>
          <Show at={45}>
            <Label>STOCK VALUE ÷ ALICE'S EQUITY</Label>
          </Show>
          <Show at={60}>
            <Big size={100}>$160 ÷ $60</Big>
          </Show>
          <Show at={90}>
            <Big size={120} color={C.blue}>
              = 2.67×
            </Big>
          </Show>
          <Show at={135} style={{ marginTop: 20 }}>
            <Body bold size={40}>
              Target stock value &nbsp; 2 × $60 = $120
            </Body>
          </Show>
        </div>
      </div>
    </Frame>
  </Scene>
);

const Sale: React.FC<{
  dur: number;
  price: number;
  sold: number;
  got: number;
  sharesFrom: number;
  usdcFrom: number;
  stockFrom: number;
  alice: number;
}> = ({ dur, price, sold, got, sharesFrom, usdcFrom, stockFrom, alice }) => {
  const shares = useTween(70, 105, sharesFrom, sharesFrom - sold);
  const usdcV = useTween(100, 130, usdcFrom, usdcFrom + got);
  const usdcIn = useTween(usdcFrom ? 0 : 98, usdcFrom ? 1 : 112, usdcFrom ? 1 : 0, 1);
  const stockTo = stockFrom - got;
  return (
    <Scene dur={dur}>
      <Frame
        kicker="REBALANCING POOL"
        right="Sell trigger ≈ 2.67× / Target 2×"
        title={`At $${price}, the pool sells ${sold} bNVDA.`}
        footer={`Pool value stays the same at the sale. After it, $${stockTo} in stock ÷ $${alice} Alice = 2×.`}
        footAt={180}
      >
        <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={16}>
              <Label>SELL AT THE MARKET PRICE</Label>
              <Big size={96}>
                {sold} × ${price}
              </Big>
            </Show>
            <Show at={45}>
              <Big size={110} color={C.blue}>
                = ${got}
              </Big>
            </Show>
            <Show at={140} style={{ marginTop: 26 }}>
              <Label>STOCK EXPOSURE</Label>
              <Big size={64}>
                ${stockFrom} to ${stockTo}
              </Big>
            </Show>
          </div>
          <div>
            <Show at={16}>
              <Label>PROCEEDS STAY IN THE SAME POOL</Label>
            </Show>
            <Show at={24} style={{ marginTop: 20 }}>
              <PoolBox
                shares={shares}
                usdc={Math.round(usdcV * 100) / 100}
                usdcIn={usdcIn}
              />
            </Show>
            <Show at={125} style={{ marginTop: 34 }}>
              <Body bold size={42}>
                USDC reserve &nbsp; ${usdcFrom} + ${got} = ${usdcFrom + got}
              </Body>
            </Show>
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

const Between: React.FC<{ dur: number }> = ({ dur }) => {
  const price = useTween(20, 60, 80, 70);
  return (
    <Scene dur={dur}>
      <Frame
        kicker="BETWEEN SALES"
        right="bNVDA falls from $80 to $70"
        title="The next $10 drop costs Alice $15."
        footer="The $40 of USDC stays in the pool while the 1.5 shares fall in value."
        footAt={136}
      >
        <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
          <div>
            <Show at={10}>
              <Label>bNVDA PRICE</Label>
              <Big size={70} color={C.red}>
                {usd(price)}
              </Big>
            </Show>
            <Show at={10} style={{ marginTop: 16 }}>
              <PoolBox shares={1.5} usdc={40} />
            </Show>
          </div>
          <div>
            <Show at={62}>
              <Label>1.5 SHARES × $70</Label>
              <Big size={96}>$105 stock</Big>
            </Show>
            <Show at={90}>
              <Body bold size={46}>
                + $40 USDC = $145 pool
              </Body>
            </Show>
            <Show at={115}>
              <Body size={44}>$145 − $100 = $45 for Alice</Body>
            </Show>
            <Show at={138} style={{ marginTop: 22 }}>
              <Pill>Without the sale, this drop costs $20.</Pill>
            </Show>
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

const LaterSales: React.FC<{ dur: number }> = ({ dur }) => {
  const cols = [
    { at: 20, head: "bNVDA AT $51.20", a: "0.281 × $51.20", b: "= $14.40", c: "$64.00 + $14.40 = $78.40" },
    { at: 62, head: "bNVDA AT $40.96", a: "0.211 × $40.96", b: "= $8.64", c: "$78.40 + $8.64 = $87.04" },
  ];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="REBALANCING POOL"
        right="Later sales on the same fall"
        title="Two more sales build the reserve."
        footer="Each sale restores 2× leverage. A price gap can skip a trigger."
        footAt={110}
      >
        <div style={{ display: "flex", gap: 90 }}>
          {cols.map((c) => (
            <Show key={c.head} at={c.at} style={{ flex: 1 }}>
              <Label>{c.head}</Label>
              <Big size={72}>{c.a}</Big>
              <Big size={96} color={C.blue}>
                {c.b}
              </Big>
              <div style={{ marginTop: 30 }}>
                <Label>USDC IN THE POOL</Label>
                <Body bold size={44}>
                  {c.c}
                </Body>
              </div>
            </Show>
          ))}
        </div>
      </Frame>
    </Scene>
  );
};

const TableSales: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="REBALANCING POOL"
      right="Gold rows show a sale"
      title="Four sales move $87.04 into USDC."
      footer="Every sale takes stock exposure back to 2× Alice's equity. Fees and slippage are excluded."
      footAt={266}
    >
      <Table
        cols={["bNVDA price", "Shares", "Stock value", "USDC", "Pool value", "Bob", "Alice", "Leverage"]}
        start={20}
        step={25}
        gold={[2, 4, 6, 8]}
        tags={{ 2: "1st sale", 4: "2nd sale", 6: "3rd sale", 8: "4th sale" }}
        rows={[
          ["$100", "2.000", "$200", "$0", "$200", "$100", "$100", "2.00×"],
          ["$90", "2.000", "$180", "$0", "$180", "$100", "$80", "2.25×"],
          ["$80", "1.500", "$120", "$40", "$160", "$100", "$60", "2.00×"],
          ["$70", "1.500", "$105", "$40", "$145", "$100", "$45", "2.33×"],
          ["$64", "1.125", "$72", "$64", "$136", "$100", "$36", "2.00×"],
          ["$60", "1.125", "$67.50", "$64", "$131.50", "$100", "$31.50", "2.14×"],
          ["$51.20", "0.844", "$43.20", "$78.40", "$121.60", "$100", "$21.60", "2.00×"],
          ["$50", "0.844", "$42.19", "$78.40", "$120.59", "$100", "$20.59", "2.05×"],
          ["$40.96", "0.633", "$25.92", "$87.04", "$112.96", "$100", "$12.96", "2.00×"],
          ["$40", "0.633", "$25.31", "$87.04", "$112.35", "$100", "$12.35", "2.05×"],
        ]}
      />
    </Frame>
  </Scene>
);

const AtForty: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="THE SAME $40 STOCK PRICE"
      right="Before and after the sell rule"
      title="At $40: before and after the selling."
      footer="Bob's $100 is now covered by $87.04 in USDC plus $25.31 in stock."
      footAt={135}
    >
      <div style={{ display: "flex", gap: 90 }}>
        <Show at={16} style={{ flex: 1 }}>
          <Label>BEFORE: NO SELLING</Label>
          <Big size={130}>$80.00</Big>
          <Body size={36}>$80.00 stock + $0.00 USDC</Body>
          <div style={{ display: "flex", gap: 14, marginTop: 36 }}>
            <Box who="ALICE" value="$0" color={C.orange} />
            <Box who="BOB" value="$80" color={C.sky} />
          </div>
        </Show>
        <Show at={60} style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Label>AFTER: WITH SELLING</Label>
            <span
              style={{
                background: C.green,
                border: `3px solid ${C.ink}`,
                borderRadius: 20,
                padding: "0 14px",
                fontSize: 24,
                fontWeight: 900,
              }}
            >
              better for both
            </span>
          </div>
          <Big size={130} color={C.blue}>
            $112.35
          </Big>
          <Body size={36}>$25.31 stock + $87.04 USDC</Body>
          <div style={{ display: "flex", gap: 14, marginTop: 36 }}>
            <Box who="ALICE" value="$12.35" color={C.orange} />
            <Box who="BOB" value="$100" color={C.sky} />
          </div>
        </Show>
      </div>
    </Frame>
  </Scene>
);

const Buyback: React.FC<{ dur: number }> = ({ dur }) => {
  const shares = useTween(105, 140, 0.633, 0.791);
  const usdcV = useTween(105, 140, 87.04, 78.4);
  return (
    <Scene dur={dur}>
      <Frame
        kicker="THE REBOUND"
        right="Buy trigger 1.6× / Target 2×"
        title="When the price rises, the pool buys back."
        footer="With the same rule up to $100, Alice recovers to $63.60, not $100."
        footAt={160}
      >
        <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={16}>
              <Label>bNVDA REBOUNDS TO $54.61</Label>
              <Body bold size={38}>
                $34.56 stock ÷ $21.60 Alice = 1.6×
              </Body>
            </Show>
            <Show at={70} style={{ marginTop: 26 }}>
              <Label>USDC SPENT ON STOCK</Label>
              <Big size={130} color={C.blue}>
                $8.64
              </Big>
            </Show>
          </div>
          <div>
            <Show at={24}>
              <PoolBox shares={shares} usdc={Math.round(usdcV * 100) / 100} />
            </Show>
            <Show at={140} style={{ marginTop: 34 }}>
              <Body bold size={42}>
                USDC reserve &nbsp; $87.04 − $8.64 = $78.40
              </Body>
            </Show>
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

const Recovery: React.FC<{ dur: number }> = ({ dur }) => {
  const alice = useTween(60, 115, 12.35, 63.6);
  return (
    <Scene dur={dur}>
      <Frame
        kicker="THE REBOUND"
        right="Same buy rule on the way up"
        title="The stock recovers first."
        footer="The pool held less stock on the way up. That is the cost of the protection."
        footAt={135}
      >
        <div style={{ display: "flex", gap: 90 }}>
          <Show at={16} style={{ flex: 1 }}>
            <Label>bNVDA RETURNS TO</Label>
            <Big size={150}>$100</Big>
            <Body size={42}>Started at $100</Body>
          </Show>
          <Show at={50} style={{ flex: 1 }}>
            <Label>ALICE RECOVERS TO</Label>
            <Big size={150} color={C.blue}>
              {usd(alice, 2)}
            </Big>
            <Body size={42}>Started at $100</Body>
          </Show>
        </div>
      </Frame>
    </Scene>
  );
};

const FeeFlow: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [60, 110], [0, 1], { ...clamp, easing: ease });
  const coinOp = interpolate(frame, [56, 64, 108, 116], [0, 1, 1, 0], clamp);
  return (
    <Scene dur={dur}>
      <Frame
        kicker="FUNDING FEE"
        right="4% a year on the stable supply"
        title="Alice's funding fee pays Bob's yield."
        footer="For every $100 of stable tokens, Alice's side pays $4 a year to the Stability Pool."
        footAt={122}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Show at={14} style={{ textAlign: "center" }}>
            <Alice width={300} />
            <Body bold size={36}>
              Alice pays
            </Body>
          </Show>
          <div style={{ flex: 1, position: "relative", height: 160, margin: "0 50px" }}>
            <Show at={40}>
              <div style={{ textAlign: "center", fontSize: 64, fontWeight: 900 }}>$4 a year</div>
              <div style={{ height: 6, background: C.ink, marginTop: 20, position: "relative" }}>
                <div
                  style={{
                    position: "absolute",
                    right: -4,
                    top: -15,
                    borderLeft: `26px solid ${C.ink}`,
                    borderTop: "18px solid transparent",
                    borderBottom: "18px solid transparent",
                  }}
                />
              </div>
            </Show>
            <div
              style={{
                position: "absolute",
                top: 78,
                left: `${t * 90}%`,
                width: 64,
                height: 64,
                borderRadius: 32,
                background: C.gold,
                border: `4px solid ${C.ink}`,
                opacity: coinOp,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 34,
                fontWeight: 900,
              }}
            >
              $
            </div>
          </div>
          <Show at={24} style={{ textAlign: "center" }}>
            <Bob width={300} />
            <Body bold size={36}>
              Bob earns, in the Stability Pool
            </Body>
          </Show>
        </div>
      </Frame>
    </Scene>
  );
};

const WhyAlice: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="WHY ALICE JOINS"
      right="The leveraged side"
      title="Alice wants leverage she can hold."
      footer="Leverage floats. Alice can lose her entire deposit while she still holds the token."
      footAt={136}
    >
      <div style={{ display: "flex", gap: 70, alignItems: "center" }}>
        <Show at={10}>
          <Alice width={380} />
        </Show>
        <div style={{ flex: 1 }}>
          <Show at={24}>
            <Big size={72}>Margin without liquidation.</Big>
          </Show>
          <Show at={55} style={{ marginTop: 20 }}>
            <Body size={42}>One mint. About 2× NVDA exposure.</Body>
          </Show>
          <Show at={80}>
            <Body size={42}>She can hold through a drop. Nobody forces her out.</Body>
          </Show>
          <Show at={110}>
            <div style={{ height: 3, background: C.line, margin: "30px 0 22px" }} />
            <Label color={C.blue}>WHAT SHE PAYS</Label>
            <Body bold size={44}>
              Funding fees and a slower recovery after sales.
            </Body>
          </Show>
        </div>
      </div>
    </Frame>
  </Scene>
);

const LoanCompare: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="WHY ALICE PAYS A FUNDING FEE"
      right="Example: 80% threshold, 8% liquidator bonus"
      title="At $60, a loan is already liquidated."
    >
      <div style={{ display: "flex", gap: 60 }}>
        <div style={{ flex: 1 }}>
          <Show at={18}>
            <Label>BORROWING AGAINST STOCK TOKENS</Label>
            <Big size={72} color={C.red}>
              $54 of stock seized
            </Big>
          </Show>
          <Show at={50} style={{ marginTop: 14 }}>
            <Body>Below $62.50, the $100 loan crosses 80%.</Body>
          </Show>
          <Show at={72}>
            <Body>At $60, a $50 repayment can seize $54 of stock.</Body>
          </Show>
          <Show at={94}>
            <Body bold>$66 of stock − $50 of debt = $16 left.</Body>
          </Show>
        </div>
        <div style={{ width: 3, background: C.line, opacity: 0.4 }} />
        <div style={{ flex: 1 }}>
          <Show at={120}>
            <Label>HOLDING THE LEVERAGED TOKEN</Label>
            <Big size={72} color={C.blue}>
              $0 of tokens seized
            </Big>
          </Show>
          <Show at={150} style={{ marginTop: 14 }}>
            <Body>Earlier pool sales put $64 in reserve.</Body>
          </Show>
          <Show at={170}>
            <Body>1.125 × $60 + $64 = $131.50 in the pool.</Body>
          </Show>
          <Show at={190}>
            <Body bold>After Bob's $100, Alice still holds $31.50.</Body>
          </Show>
        </div>
      </div>
      <Show at={212} style={{ marginTop: 34 }}>
        <Banner>Alice pays for leverage she can keep through a drop.</Banner>
      </Show>
    </Frame>
  </Scene>
);

const WhyBob: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="WHY BOB JOINS"
      right="The Stability Pool"
      title="Bob earns the fee for taking gap risk."
      footer="Lending earns interest only on funds lent out. Here the fee accrues on all stable tokens."
      footAt={175}
    >
      <div style={{ display: "flex", gap: 70, alignItems: "center" }}>
        <Show at={10}>
          <Bob width={380} />
        </Show>
        <div style={{ flex: 1 }}>
          <Show at={24}>
            <Big size={60}>$100 stable tokens × 4% = $4 a year</Big>
          </Show>
          <Show at={62} style={{ marginTop: 20 }}>
            <Body size={42}>
              If $50 is deposited in the Stability Pool, depositors share the full $4.
            </Body>
          </Show>
          <Show at={100} style={{ marginTop: 22 }}>
            <Pill color={C.gold}>$4 ÷ $50 = 8% gross a year, as an example</Pill>
          </Show>
          <Show at={140} style={{ marginTop: 26 }}>
            <Body bold size={42}>
              If the stock gaps down before a sale, Bob can lose principal.
            </Body>
          </Show>
        </div>
      </div>
    </Frame>
  </Scene>
);

const BobVsLending: React.FC<{ dur: number }> = ({ dur }) => {
  const ladder: [string, string][] = [
    ["All of it deposited", "4%"],
    ["Half deposited", "8%"],
    ["One third deposited", "12%"],
    ["About 18% deposited", "22%"],
  ];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="WHY BOB JOINS"
        right="Observed lending rate and modeled fee yield"
        title="What could Bob earn for taking gap risk?"
      >
        <div style={{ display: "flex", gap: 70 }}>
          <Show at={18} style={{ flex: 1 }}>
            <Label>AAVE / USDC LENDING</Label>
            <Big size={150} color={C.blue}>
              4.33%
            </Big>
            <Body bold size={40}>
              Realized APY on Ethereum Core
            </Body>
            <Body size={32}>30 days ending November 23, 2026</Body>
            <div style={{ fontSize: 26, color: C.muted, marginTop: 14 }}>
              Source: Harvest Finance, USDC Yield Report
            </div>
          </Show>
          <div style={{ width: 3, background: C.line, opacity: 0.4 }} />
          <div style={{ flex: 1 }}>
            <Show at={60}>
              <Label>BOB / STABILITY POOL, MODELED GROSS YIELD</Label>
              <Body size={34}>The same $4 fee, shared by fewer deposits:</Body>
            </Show>
            {ladder.map(([k, v], i) => (
              <Show key={k} at={90 + i * 22}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    borderBottom: `2px solid ${C.stripe}`,
                    fontSize: 38,
                    fontWeight: 500,
                    lineHeight: 1.55,
                  }}
                >
                  <span>{k}</span>
                  <span style={{ fontSize: 56, fontWeight: 900, color: C.blue }}>{v}</span>
                </div>
              </Show>
            ))}
          </div>
        </div>
        <Show at={195} style={{ marginTop: 30 }}>
          <Banner>If NVDA gaps down before the pool sells, Bob's loss can exceed his fees.</Banner>
        </Show>
      </Frame>
    </Scene>
  );
};

const Launchpad: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <AbsoluteFill style={{ fontFamily: HEAD, color: C.ink, padding: "100px 108px" }}>
      <div style={{ display: "flex", gap: 70, height: "100%" }}>
        <div style={{ flex: 1 }}>
          <Show at={0}>
            <div style={{ fontSize: 27, fontWeight: 800, color: C.blue, letterSpacing: 1 }}>
              LAUNCHPAD / BNB CHAIN
            </div>
          </Show>
          <Show at={10}>
            <div style={{ fontSize: 110, fontWeight: 900, lineHeight: 1.04, marginTop: 50 }}>
              Open a market
              <br />
              for a stock.
            </div>
          </Show>
          <div style={{ marginTop: 50 }}>
            {[
              "Choose a supported stock.",
              "Set the funding fee.",
              "Pick a capped leverage target.",
            ].map((t, i) => (
              <Show key={t} at={45 + i * 22}>
                <div style={{ fontSize: 42, fontWeight: 500, lineHeight: 1.6, display: "flex", gap: 20 }}>
                  <span style={{ color: C.blue, fontWeight: 900 }}>•</span>
                  {t}
                </div>
              </Show>
            ))}
          </div>
          <Show at={125}>
            <div style={{ fontSize: 34, fontWeight: 500, color: C.muted, marginTop: 56 }}>
              Anyone can create a pool. Each market has its own stock and rebalancing rules.
            </div>
          </Show>
        </div>
        <Show at={24}>
          <Crop file="sb-27.png" x={992} y={96} w={824} h={842} width={760} />
        </Show>
      </div>
    </AbsoluteFill>
  </Scene>
);

const Opening: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <AbsoluteFill style={{ fontFamily: HEAD, color: C.ink }}>
      <Show at={4} dist={0} style={{ position: "absolute", left: 905, top: 0 }}>
        <Crop file="sb-01.png" x={905} y={0} w={1015} h={1080} width={1015} />
      </Show>
      <div style={{ position: "absolute", left: 105, top: 110, width: 780 }}>
        <Show at={0}>
          <div style={{ fontSize: 32, fontWeight: 800, color: C.blue, letterSpacing: 1 }}>
            FRIDAY CLOSE
          </div>
        </Show>
        <Show at={12}>
          <div
            style={{
              fontSize: 100,
              whiteSpace: "nowrap",
              fontWeight: 900,
              lineHeight: 1.08,
              marginTop: 110,
              letterSpacing: -2,
            }}
          >
            The stock
            <br />
            market closes.
          </div>
        </Show>
        <Show at={50}>
          <div
            style={{
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 72,
              lineHeight: 1.3,
              marginTop: 80,
            }}
          >
            The risk carries
            <br />
            through the weekend.
          </div>
        </Show>
      </div>
    </AbsoluteFill>
  </Scene>
);

const Choice: React.FC<{ dur: number }> = ({ dur }) => {
  const card = (color: string, name: string, a: string, b: string) => (
    <div
      style={{
        background: color,
        border: `4px solid ${C.ink}`,
        borderRadius: 16,
        boxShadow: `8px 8px 0 ${C.ink}`,
        padding: "22px 32px",
        width: 880,
      }}
    >
      <div style={{ fontSize: 50, fontWeight: 900 }}>{name}</div>
      <div style={{ fontSize: 36, fontWeight: 500, lineHeight: 1.35, marginTop: 6 }}>
        {a}
        <br />
        {b}
      </div>
    </div>
  );
  return (
    <Scene dur={dur}>
      <Frame
        kicker="ONE POOL, TWO TOKENS"
        right="The depositor chooses the side"
        title="Every deposit is a choice."
        footer="Stable deposits create the leverage. Leveraged deposits share it."
        footAt={135}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 50 }}>
          <Show at={15} style={{ textAlign: "center" }}>
            <Label>ANYONE DEPOSITS STOCK</Label>
            <div style={{ marginTop: 18 }}>
              <Cert label="1 bNVDA" width={300} />
            </div>
            <div style={{ fontSize: 34, fontWeight: 500, marginTop: 22 }}>and picks one token</div>
          </Show>
          <div style={{ fontSize: 90, fontWeight: 900, lineHeight: 1.9 }}>
            <Show at={55}>↗</Show>
            <Show at={95}>↘</Show>
          </div>
          <div>
            <Show at={60}>
              {card(C.orange, "Leveraged token", "About 2× the stock move.", "Pays the funding fee.")}
            </Show>
            <Show at={100} style={{ marginTop: 30 }}>
              {card(C.sky, "Stable token", "A fixed dollar claim.", "Earns the fee in the Stability Pool.")}
            </Show>
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

// ---------- Second pass: simpler flow for the leverage part ----------
const Tag: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <div
    style={{
      display: "inline-block",
      background: color,
      border: `4px solid ${C.ink}`,
      borderRadius: 14,
      padding: "8px 18px",
      fontSize: 27,
      fontWeight: 800,
      lineHeight: 1.25,
      textAlign: "center",
      boxShadow: `5px 5px 0 ${C.ink}`,
    }}
  >
    {children}
  </div>
);

const SideBox: React.FC<{ who: string; sub: string; value: string; color: string }> = ({
  who,
  sub,
  value,
  color,
}) => (
  <div
    style={{
      flex: 1,
      background: color,
      border: `4px solid ${C.ink}`,
      borderRadius: 12,
      padding: "12px 20px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    }}
  >
    <span>
      <div style={{ fontSize: 26, fontWeight: 900 }}>{who}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{sub}</div>
    </span>
    <span style={{ fontSize: 50, fontWeight: 900 }}>{value}</span>
  </div>
);

const Deposit2: React.FC<{ dur: number; who: "alice" | "bob" }> = ({ dur, who }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const isAlice = who === "alice";
  const o = isAlice ? 62 : 0;
  // "Let's assume" line: big in the centre, then it moves to the top right.
  const m = interpolate(frame, [44, 68], [0, 1], { ...clamp, easing: ease });
  const noteOp = interpolate(frame, [0, 10], [0, 1], clamp);
  const fly = interpolate(frame, [o + 30, o + 62], [0, 1], { ...clamp, easing: ease });
  const flyOp = interpolate(frame, [o + 28, o + 34, o + 58, o + 64], [0, 1, 1, 0], clamp);
  const landed = frame >= o + 62;
  const pop = spring({ frame: frame - o - 62, fps, config: { damping: 200 } });
  const shares = isAlice ? (landed ? 1 : 0) : landed ? 2 : 1;
  return (
    <Scene dur={dur}>
      <Frame
        kicker="HOW THE LEVERAGE STARTS"
        right={isAlice ? undefined : "1 bNVDA = $100"}
        title={isAlice ? "Alice deposits one bNVDA." : "Bob deposits another bNVDA."}
        footer={
          isAlice
            ? "Alice is the only depositor, so her tokens are the whole $100."
            : "Bob's stock is in the pool, but its price moves now go to Alice."
        }
        footAt={o + (isAlice ? 118 : 178)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 60, position: "relative" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ height: 96, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <Show at={o + 78}>
                <Tag color={isAlice ? C.orange : C.sky}>
                  {isAlice ? "Minted to Alice:" : "Minted to Bob:"}
                  <br />
                  {isAlice ? "100 leveraged tokens = $100" : "100 stable tokens = $100"}
                </Tag>
              </Show>
            </div>
            <Show at={o + 10} style={{ marginTop: 14 }}>
              {isAlice ? <Alice width={300} /> : <Bob width={300} />}
            </Show>
          </div>
          <div style={{ width: 200, position: "relative", height: 100 }}>
            <Cert
              label="1 bNVDA"
              width={230}
              style={{
                position: "absolute",
                left: -60 + fly * 340,
                top: 60,
                opacity: flyOp,
                zIndex: 2,
              }}
            />
          </div>
          <div>
            <Show at={o + 18}>
              <PoolBox shares={shares} certIn={isAlice ? pop : 1} />
            </Show>
            {isAlice ? (
              <Show at={o + 90} style={{ marginTop: 36 }}>
                <Big size={72}>Pool value &nbsp;$100</Big>
              </Show>
            ) : (
              <>
                <Show at={95} style={{ marginTop: 30 }}>
                  <div style={{ display: "flex", gap: 14, width: 720 }}>
                    <SideBox who="ALICE" sub="leveraged = exposure" value="$100" color={C.orange} />
                    <SideBox who="BOB" sub="stable = fixed" value="$100" color={C.sky} />
                  </div>
                </Show>
                <Show at={135} style={{ marginTop: 26 }}>
                  <Big size={56}>$200 stock ÷ $100 Alice = 2×</Big>
                </Show>
              </>
            )}
          </div>
        </div>
      </Frame>
      {isAlice ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            transformOrigin: "top right",
            transform: `translate(${-230 + m * 122}px, ${470 - m * 406}px) scale(${3.3 - m * 2.3})`,
            fontFamily: HEAD,
            fontSize: 27,
            fontWeight: 700,
            color: m > 0.9 ? C.muted : C.ink,
            whiteSpace: "nowrap",
            opacity: noteOp,
            background: C.bg,
            padding: "0 6px",
          }}
        >
          Let's assume 1 bNVDA costs $100
        </div>
      ) : null}
    </Scene>
  );
};

const Story: React.FC<{ dur: number; to: number; intro?: string }> = ({ dur, to, intro }) => {
  const frame = useCurrentFrame();
  const up = to > 100;
  const t = up ? [12, 50, 88, 120, 155, 190, 235] : [57, 82, 107, 130, 155, 178, 208];
  const price = useTween(t[0] + 3, t[0] + 33, 100, to);
  const pool = price * 2;
  const alice = pool - 100;
  const endPool = to * 2;
  const endAlice = endPool - 100;
  const pct = up ? "+10%" : "−10%";
  const pct2 = up ? "+20%" : "−20%";
  const introOp = intro ? interpolate(frame, [0, 8, 40, 48], [0, 1, 1, 0], clamp) : 0;
  const rows: [string, string, string, string][] = [
    ["Pool", "$200", usd(endPool), pct],
    ["Bob", "$100", "$100", "0%"],
    ["Alice", "$100", usd(endAlice), pct2],
  ];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="HOW THE 2× WORKS"
        right={`bNVDA $100 to $${to}`}
        title={up ? "A 10% rise gives Alice a 20% gain." : "A 10% fall costs Alice 20%."}
      >
        <div style={{ display: "flex", gap: 70, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            <Show at={t[0]}>
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                <Body size={44} bold>
                  {up ? "Imagine NVDA is now $110." : "NVDA falls to $90."}
                </Body>
                <Pill color={up ? C.green : C.goldSoft}>{pct}</Pill>
              </div>
            </Show>
            <Show at={t[1]} style={{ marginTop: 16 }}>
              <Body size={40}>The pool holds 2 shares:</Body>
              <Big size={58}>
                2 × ${to} = {usd(endPool)}
              </Big>
            </Show>
            <Show at={t[2]} style={{ marginTop: 16 }}>
              <Body size={40}>Bob takes his fixed $100.</Body>
            </Show>
            <Show at={t[3]}>
              <Body size={40}>Alice gets the rest:</Body>
              <Big size={58} color={up ? C.blue : C.red}>
                {usd(endPool)} − $100 = {usd(endAlice)}
              </Big>
            </Show>
            <Show at={t[4]} style={{ marginTop: 18 }}>
              <Pill color={up ? C.green : C.goldSoft}>
                Stock {pct} → Alice {pct2}
              </Pill>
            </Show>
            <Show at={t[6]} style={{ marginTop: 16 }}>
              <Body size={34} bold>
                Leverage = pool value ÷ Alice's part
              </Body>
              <Body size={34}>
                {up
                  ? "At the start: $200 ÷ $100 = 2×"
                  : "Now: $180 ÷ $80 = 2.25×. It rises as she loses."}
              </Body>
            </Show>
          </div>
          <div style={{ width: 640 }}>
            <Show at={t[0]}>
              <Label>
                THE POOL: 2 bNVDA × {usd(price)} = {usd(pool)}
              </Label>
              <div
                style={{
                  marginTop: 12,
                  border: `4px solid ${C.ink}`,
                  boxShadow: `8px 8px 0 ${C.ink}`,
                  fontSize: 38,
                  fontWeight: 900,
                }}
              >
                <div
                  style={{
                    height: alice * 1.15,
                    background: C.orange,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0 26px",
                    borderBottom: `4px solid ${C.ink}`,
                  }}
                >
                  <span>Alice's part</span>
                  <span>{usd(alice)}</span>
                </div>
                <div
                  style={{
                    height: 115,
                    background: C.sky,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0 26px",
                  }}
                >
                  <span>Bob's part, fixed</span>
                  <span>$100</span>
                </div>
              </div>
            </Show>
            <Show at={t[5]} style={{ marginTop: 30 }}>
              <div style={{ fontSize: 30 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.1fr 1fr 1fr 1fr",
                    fontWeight: 900,
                    paddingBottom: 6,
                  }}
                >
                  <div />
                  <div>Before</div>
                  <div>After</div>
                  <div>Change</div>
                </div>
                {rows.map((r, i) => (
                  <div
                    key={r[0]}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1.1fr 1fr 1fr 1fr",
                      padding: "7px 10px",
                      borderRadius: 8,
                      fontWeight: i === 2 ? 900 : 500,
                      background: i === 2 ? C.goldSoft : i % 2 ? "transparent" : C.stripe,
                    }}
                  >
                    {r.map((c, j) => (
                      <div key={j}>{c}</div>
                    ))}
                  </div>
                ))}
              </div>
            </Show>
          </div>
        </div>
      </Frame>
      {intro ? (
        <AbsoluteFill
          style={{
            background: C.bg,
            opacity: introOp,
            alignItems: "center",
            justifyContent: "center",
            fontFamily: HEAD,
            color: C.ink,
            fontSize: 120,
            fontWeight: 900,
          }}
        >
          {intro}
        </AbsoluteFill>
      ) : null}
    </Scene>
  );
};

const Cushion2: React.FC<{ dur: number }> = ({ dur }) => {
  const cards = [
    { at: 20, head: "STOCK AT $50", drop: "−50%", pool: "$100 pool", a: "$0", b: "$100" },
    { at: 72, head: "STOCK AT $40", drop: "−60%", pool: "$80 pool", a: "$0", b: "$80" },
    { at: 124, head: "BACK TO $60", drop: "−40% from the start", pool: "$120 pool", a: "$20", b: "$100" },
  ];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="ALL-STOCK POOL"
        right="The pool keeps both shares"
        title="A bigger fall takes everything from Alice."
        footer="At zero, Alice still holds her tokens. A rebound gives them value again."
        footAt={165}
      >
        <div style={{ display: "flex", gap: 70 }}>
          {cards.map((c) => (
            <Show key={c.head} at={c.at} style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <Label>{c.head}</Label>
                <span
                  style={{
                    background: C.red,
                    color: "#fff",
                    borderRadius: 20,
                    padding: "2px 14px",
                    fontSize: 26,
                    fontWeight: 800,
                  }}
                >
                  {c.drop}
                </span>
              </div>
              <Big size={92}>{c.pool}</Big>
              <div style={{ height: 3, background: C.line, margin: "18px 0 22px" }} />
              {[
                ["Alice", c.a],
                ["Bob", c.b],
              ].map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    fontSize: 38,
                    fontWeight: 500,
                    lineHeight: 1.7,
                  }}
                >
                  <span>{k}</span>
                  <span style={{ fontSize: 52, fontWeight: 900 }}>{v}</span>
                </div>
              ))}
            </Show>
          ))}
        </div>
      </Frame>
    </Scene>
  );
};

const TableLeverage: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cols = ["bNVDA price", "Price drop", "Pool value", "Bob", "Alice", "Alice's loss", "Leverage"];
  const rows = [
    ["$100", "0%", "$200", "$100", "$100", "0%", "2.00×"],
    ["$90", "−10%", "$180", "$100", "$80", "20%", "2.25×"],
    ["$80", "−20%", "$160", "$100", "$60", "40%", "2.67×"],
    ["$70", "−30%", "$140", "$100", "$40", "60%", "3.50×"],
    ["$60", "−40%", "$120", "$100", "$20", "80%", "6.00×"],
    ["$50", "−50%", "$100", "$100", "$0", "100%", "–"],
    ["$40", "−60%", "$80", "$80", "$0", "100%", "–"],
  ];
  const grid = `repeat(${cols.length}, 1fr)`;
  const mark = spring({ frame: frame - 205, fps, config: { damping: 200 } });
  return (
    <Scene dur={dur}>
      <Frame
        kicker="ALL-STOCK POOL"
        right="Before the sell rule"
        title="The leverage rises as the price falls."
        footer="High leverage is the danger. Each next drop takes a larger part of what Alice has left."
        footAt={225}
      >
        <div style={{ fontSize: 32 }}>
          <Show at={10}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                fontWeight: 900,
                textAlign: "center",
                paddingBottom: 12,
              }}
            >
              {cols.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          </Show>
          {rows.map((r, i) => {
            const s = spring({ frame: frame - 22 - i * 24, fps, config: { damping: 200 } });
            const hot = i >= 2 && i <= 4;
            return (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: grid,
                  textAlign: "center",
                  padding: "9px 0",
                  borderRadius: 8,
                  background: i % 2 ? "transparent" : C.stripe,
                  opacity: s,
                  transform: `translateY(${(1 - s) * 14}px)`,
                }}
              >
                {r.map((c, j) => (
                  <div key={j}>
                    {j === 6 && hot ? (
                      <span
                        style={{
                          background: `rgba(176,58,46,${mark})`,
                          color: mark > 0.5 ? "#fff" : C.ink,
                          fontWeight: 900,
                          borderRadius: 8,
                          padding: "2px 14px",
                        }}
                      >
                        {c}
                      </span>
                    ) : (
                      c
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Frame>
    </Scene>
  );
};

const Control: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <AbsoluteFill
      style={{
        fontFamily: HEAD,
        color: C.ink,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <Show at={4}>
        <div style={{ fontSize: 100, fontWeight: 900, letterSpacing: -1 }}>
          How do we control the leverage?
        </div>
      </Show>
      <Show at={42} style={{ marginTop: 40 }}>
        <div style={{ fontSize: 68, fontWeight: 900, color: C.blue }}>
          The total pool sells some stock to bring it down.
        </div>
      </Show>
      <Show at={70} style={{ marginTop: 34 }}>
        <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 46 }}>
          The sale is from the total pool, not from one user.
        </div>
      </Show>
    </AbsoluteFill>
  </Scene>
);

// ---------- Third pass: the price move, one idea for each scene ----------
const PartBar: React.FC<{ alice: number; aliceIn: number; bobIn: number; head: string }> = ({
  alice,
  aliceIn,
  bobIn,
  head,
}) => (
  <div style={{ width: 660 }}>
    <Label>{head}</Label>
    <div
      style={{
        marginTop: 14,
        border: `4px solid ${C.ink}`,
        boxShadow: `8px 8px 0 ${C.ink}`,
        fontSize: 44,
        fontWeight: 900,
        background: "#E3EEDD",
      }}
    >
      <div
        style={{
          height: alice * 1.5,
          background: C.orange,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 30px",
          borderBottom: `4px solid ${C.ink}`,
          opacity: aliceIn,
        }}
      >
        <span>Alice's part</span>
        <span>{usd(alice)}</span>
      </div>
      <div
        style={{
          height: 150,
          background: C.sky,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 30px",
          opacity: bobIn,
        }}
      >
        <span>Bob's part, fixed</span>
        <span>$100</span>
      </div>
    </div>
  </div>
);

const Beat: React.FC<{
  dur: number;
  to: number;
  part: "pool" | "split" | "both" | "result";
  intro?: string;
}> = ({ dur, to, part, intro }) => {
  const frame = useCurrentFrame();
  const up = to > 100;
  const o = intro ? 45 : 0;
  const endPool = to * 2;
  const endAlice = endPool - 100;
  const pct = up ? "+10%" : "−10%";
  const pct2 = up ? "+20%" : "−20%";
  const tone = up ? C.green : C.goldSoft;
  const price = interpolate(frame, [o + 18, o + 50], [100, to], { ...clamp, easing: ease });
  const fade = (a: number) => interpolate(frame, [a, a + 12], [0, 1], clamp);
  const introOp = intro ? interpolate(frame, [0, 8, 40, 48], [0, 1, 1, 0], clamp) : 0;
  const titles = {
    pool: up ? "First, the price rises 10%." : "The price falls 10%.",
    split: "Bob is repaid first. Alice gets the rest.",
    both: "Bob takes $100. Alice gets the rest.",
    result: up ? "A 10% rise gives Alice a 20% gain." : "A 10% fall costs Alice 20%.",
  };
  const rows: [string, string, string, string][] = [
    ["Pool", "$200", usd(endPool), pct],
    ["Bob", "$100", "$100", "0%"],
    ["Alice", "$100", usd(endAlice), pct2],
  ];
  let body: React.ReactNode = null;
  if (part === "pool") {
    body = (
      <div style={{ display: "flex", gap: 90, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <Show at={12}>
            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              <Big size={52}>{up ? "Imagine NVDA is now $110." : "NVDA falls to $90."}</Big>
              <Pill color={tone}>{pct}</Pill>
            </div>
          </Show>
          <Show at={55} style={{ marginTop: 40 }}>
            <Body size={46}>The pool holds 2 shares:</Body>
          </Show>
          <Show at={78}>
            <Big size={110} color={C.blue}>
              2 × ${to} = {usd(endPool)}
            </Big>
          </Show>
        </div>
        <Show at={12}>
          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            {[0, 1].map((i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 26 }}>
                <Cert label="1 bNVDA" width={300} />
                <Big size={64} color={up ? C.blue : C.red}>
                  {usd(price)}
                </Big>
              </div>
            ))}
          </div>
        </Show>
      </div>
    );
  } else if (part === "split" || part === "both") {
    const both = part === "both";
    const a = both ? [o + 8, o + 26, o + 46, o + 64, o + 74] : [12, 12, 40, 75, 95];
    body = (
      <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          {both ? (
            <Show at={a[0]}>
              <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                <Big size={56}>NVDA falls to ${to}.</Big>
                <Pill color={tone}>{pct}</Pill>
              </div>
            </Show>
          ) : null}
          <Show at={a[1]} style={{ marginTop: both ? 20 : 0 }}>
            <Body size={46}>
              The pool is worth {both ? `2 × $${to} = ` : ""}
              <b>{usd(endPool)}</b>.
            </Body>
          </Show>
          <Show at={a[2]} style={{ marginTop: 22 }}>
            <Body size={46}>
              Bob is repaid first, like a lender: <b>$100</b>.
            </Body>
          </Show>
          <Show at={a[3]} style={{ marginTop: 22 }}>
            <Body size={46}>Alice gets the rest:</Body>
          </Show>
          <Show at={a[4]}>
            <Big size={72} color={up ? C.blue : C.red}>
              {usd(endPool)} − $100 = {usd(endAlice)}
            </Big>
          </Show>
        </div>
        <Show at={a[1]}>
          <PartBar
            alice={endAlice}
            aliceIn={fade(a[3])}
            bobIn={fade(a[2])}
            head={`THE POOL: 2 bNVDA × $${to} = ${usd(endPool)}`}
          />
        </Show>
      </div>
    );
  } else {
    body = (
      <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <Show at={55}>
            <div
              style={{
                display: "inline-block",
                background: tone,
                border: `4px solid ${C.ink}`,
                borderRadius: 50,
                padding: "12px 36px",
                fontSize: 54,
                fontWeight: 900,
              }}
            >
              Stock {pct} → Alice {pct2}
            </div>
          </Show>
          <Show at={82} style={{ marginTop: 40 }}>
            <Body size={42} bold>
              Leverage = pool value ÷ Alice's part
            </Body>
          </Show>
          <Show at={98}>
            <Body size={42}>
              {up ? "At the start: $200 ÷ $100 = 2×" : "Now: $180 ÷ $80 = 2.25×. It rises as she loses."}
            </Body>
          </Show>
        </div>
        <div style={{ width: 720, fontSize: 40 }}>
          <Show at={10}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr",
                fontWeight: 900,
                paddingBottom: 10,
              }}
            >
              <div />
              <div>Before</div>
              <div>After</div>
              <div>Change</div>
            </div>
          </Show>
          {rows.map((r, i) => (
            <Show key={r[0]} at={16 + i * 13}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr 1fr",
                  padding: "14px 16px",
                  borderRadius: 10,
                  fontWeight: i === 2 ? 900 : 500,
                  background: i === 2 ? C.goldSoft : i % 2 ? "transparent" : C.stripe,
                }}
              >
                {r.map((c, j) => (
                  <div key={j}>{c}</div>
                ))}
              </div>
            </Show>
          ))}
        </div>
      </div>
    );
  }
  return (
    <Scene dur={dur}>
      <Frame kicker="HOW THE 2× WORKS" right={`bNVDA $100 to $${to}`} title={titles[part]}>
        {body}
      </Frame>
      {intro ? (
        <AbsoluteFill
          style={{
            background: C.bg,
            opacity: introOp,
            alignItems: "center",
            justifyContent: "center",
            fontFamily: HEAD,
            color: C.ink,
            fontSize: 120,
            fontWeight: 900,
          }}
        >
          {intro}
        </AbsoluteFill>
      ) : null}
    </Scene>
  );
};

// ---------- Fourth pass: the fall, zero, and the first sale ----------
const Intro: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 8, 40, 48], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill
      style={{
        background: C.bg,
        opacity: op,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: HEAD,
        color: C.ink,
        fontSize: 120,
        fontWeight: 900,
      }}
    >
      {text}
    </AbsoluteFill>
  );
};

const StockPair: React.FC<{ price: number; color: string }> = ({ price, color }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
    {[0, 1].map((i) => (
      <div key={i} style={{ display: "flex", alignItems: "center", gap: 26 }}>
        <Cert label="1 bNVDA" width={300} />
        <Big size={64} color={color}>
          {usd(price)}
        </Big>
      </div>
    ))}
  </div>
);

const FallPool: React.FC<{ dur: number }> = ({ dur }) => {
  const o = 45;
  const price = useTween(o + 14, o + 44, 100, 90);
  return (
    <Scene dur={dur}>
      <Frame kicker="HOW THE 2× WORKS" right="bNVDA $100 to $90" title="Now the price falls 10%.">
        <div style={{ display: "flex", gap: 90, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={o + 8}>
              <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                <Big size={52}>NVDA falls to $90.</Big>
                <Pill color={C.goldSoft}>−10%</Pill>
              </div>
            </Show>
            <Show at={o + 44} style={{ marginTop: 40 }}>
              <Body size={46}>The pool holds 2 shares:</Body>
            </Show>
            <Show at={o + 62}>
              <Big size={110} color={C.red}>
                2 × $90 = $180
              </Big>
            </Show>
          </div>
          <Show at={o + 8}>
            <StockPair price={price} color={C.red} />
          </Show>
        </div>
      </Frame>
      <Intro text="What if the price falls?" />
    </Scene>
  );
};

const PartBar2: React.FC<{ alice: number; bob: number; bobNote: string; head: string }> = ({
  alice,
  bob,
  bobNote,
  head,
}) => (
  <div style={{ width: 660 }}>
    <Label>{head}</Label>
    <div
      style={{
        marginTop: 14,
        border: `4px solid ${C.ink}`,
        boxShadow: `8px 8px 0 ${C.ink}`,
        fontSize: 42,
        fontWeight: 900,
      }}
    >
      <div
        style={{
          height: Math.max(64, alice * 1.5),
          background: alice > 0.5 ? C.orange : "#F3E3D8",
          color: alice > 0.5 ? C.ink : C.muted,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 30px",
          borderBottom: `4px solid ${C.ink}`,
        }}
      >
        <span>Alice's part</span>
        <span>{usd(alice)}</span>
      </div>
      <div
        style={{
          height: bob * 1.5,
          background: C.sky,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 30px",
        }}
      >
        <span>{bobNote}</span>
        <span>{usd(bob)}</span>
      </div>
    </div>
  </div>
);

const Drop: React.FC<{ dur: number; price: number }> = ({ dur, price }) => {
  const p = useTween(10, 40, 100, price);
  const pool = price * 2;
  const short = pool < 100;
  return (
    <Scene dur={dur}>
      <Frame
        kicker="A BIGGER FALL"
        right="The pool keeps both shares"
        title={short ? "At $40, Bob takes a loss too." : "At $50, the whole pool pays Bob."}
      >
        <div style={{ display: "flex", gap: 70, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={8}>
              <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
                <StockPair price={p} color={C.red} />
                <span
                  style={{
                    background: C.red,
                    color: "#fff",
                    borderRadius: 30,
                    padding: "6px 22px",
                    fontSize: 40,
                    fontWeight: 900,
                  }}
                >
                  {short ? "−60%" : "−50%"}
                </span>
              </div>
            </Show>
            <Show at={45} style={{ marginTop: 30 }}>
              <Big size={72}>
                2 × ${price} = {usd(pool)}
              </Big>
            </Show>
            <Show at={72} style={{ marginTop: 14 }}>
              <Body size={35} bold>
                {short
                  ? "The pool cannot pay Bob's $100. He gets $80."
                  : "Bob takes $100. Alice gets $100 − $100 = $0."}
              </Body>
            </Show>
          </div>
          <Show at={45}>
            <PartBar2
              alice={0}
              bob={short ? 80 : 100}
              bobNote={short ? "Bob's part, $20 short" : "Bob's part, fixed"}
              head={`THE POOL: 2 bNVDA × $${price} = ${usd(pool)}`}
            />
          </Show>
        </div>
      </Frame>
    </Scene>
  );
};

const TableLeverage2: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cols = ["bNVDA price", "Price drop", "Pool value", "Bob", "Alice", "Leverage", "What happens"];
  const rows = [
    ["$100", "0%", "$200", "$100", "$100", "2.00×", ""],
    ["$90", "−10%", "$180", "$100", "$80", "2.25×", ""],
    ["$80", "−20%", "$160", "$100", "$60", "2.67×", ""],
    ["$70", "−30%", "$140", "$100", "$40", "3.50×", ""],
    ["$60", "−40%", "$120", "$100", "$20", "6.00×", ""],
    ["$50", "−50%", "$100", "$100", "$0", "–", "All pays Bob"],
    ["$40", "−60%", "$80", "$80", "$0", "–", "Bob loses too"],
  ];
  const grid = "1fr 1fr 1fr 0.8fr 0.8fr 1fr 1.5fr";
  const mark = spring({ frame: frame - 205, fps, config: { damping: 200 } });
  return (
    <Scene dur={dur}>
      <Frame
        kicker="ALL-STOCK POOL"
        right="Before the sell rule"
        title="The leverage rises as the price falls."
        footer="High leverage is the danger. Each next drop takes a larger part of what Alice has left."
        footAt={232}
      >
        <div style={{ fontSize: 32 }}>
          <Show at={10}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: grid,
                fontWeight: 900,
                textAlign: "center",
                paddingBottom: 12,
              }}
            >
              {cols.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          </Show>
          {rows.map((r, i) => {
            const s = spring({ frame: frame - 22 - i * 24, fps, config: { damping: 200 } });
            const hot = i >= 2 && i <= 4;
            return (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: grid,
                  textAlign: "center",
                  padding: "9px 0",
                  borderRadius: 8,
                  background: i % 2 ? "transparent" : C.stripe,
                  opacity: s,
                  transform: `translateY(${(1 - s) * 14}px)`,
                }}
              >
                {r.map((c, j) => (
                  <div key={j} style={{ fontWeight: j === 6 ? 900 : 500, color: j === 6 ? C.red : C.ink }}>
                    {j === 5 && hot ? (
                      <span
                        style={{
                          background: `rgba(176,58,46,${mark})`,
                          color: mark > 0.5 ? "#fff" : C.ink,
                          fontWeight: 900,
                          borderRadius: 8,
                          padding: "2px 14px",
                        }}
                      >
                        {c}
                      </span>
                    ) : (
                      c
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Frame>
    </Scene>
  );
};

const NotLiquidated: React.FC<{ dur: number }> = ({ dur }) => {
  const price = useTween(92, 122, 50, 60);
  const alice = price * 2 - 100;
  return (
    <Scene dur={dur}>
      <Frame
        kicker="NO FORCED EXIT"
        right="bNVDA $50, then back to $60"
        title="Zero does not mean liquidated."
      >
        <div style={{ display: "flex", gap: 70, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={12}>
              <Body size={44}>
                At $50, Alice's tokens are worth <b>$0</b>.
              </Body>
            </Show>
            <Show at={36}>
              <Body size={44}>Nobody sold them. She still holds them all.</Body>
            </Show>
            <Show at={62} style={{ marginTop: 26 }}>
              <div
                style={{
                  display: "inline-block",
                  border: `4px solid ${C.ink}`,
                  borderRadius: 14,
                  background: C.gold,
                  padding: "12px 28px",
                  fontSize: 52,
                  fontWeight: 900,
                }}
              >
                Alice = total pool − Bob
              </div>
            </Show>
            <Show at={92} style={{ marginTop: 26 }}>
              <Body size={44}>If NVDA goes back to $60:</Body>
              <Big size={72} color={C.blue}>
                $120 − $100 = $20
              </Big>
            </Show>
          </div>
          <Show at={12}>
            <PartBar2
              alice={alice}
              bob={100}
              bobNote="Bob's part, fixed"
              head={`THE POOL: 2 bNVDA × ${usd(price)} = ${usd(price * 2)}`}
            />
          </Show>
        </div>
      </Frame>
    </Scene>
  );
};

const SellTrigger2: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="REPLAY THE FALL"
      right="Before the first sale"
      title="At $80, the leverage is too high."
      footer="So the pool sells $40 of stock."
      footAt={178}
    >
      <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
        <div>
          <Show at={14}>
            <PoolBox shares={2} />
          </Show>
          <Show at={28} style={{ marginTop: 30 }}>
            <div style={{ display: "flex", gap: 14, width: 720 }}>
              <Box who="ALICE" value="$60" color={C.orange} />
              <Box who="BOB" value="$100" color={C.sky} />
            </div>
          </Show>
        </div>
        <div>
          <Show at={45}>
            <Label>LEVERAGE = STOCK VALUE ÷ ALICE'S PART</Label>
          </Show>
          <Show at={60}>
            <Big size={92}>$160 ÷ $60</Big>
          </Show>
          <Show at={85}>
            <Big size={110} color={C.red}>
              = 2.67×
            </Big>
          </Show>
          <Show at={118} style={{ marginTop: 14 }}>
            <Pill color={C.goldSoft}>2.67× is too high.</Pill>
          </Show>
          <Show at={145} style={{ marginTop: 16 }}>
            <Body bold size={40}>
              The pool brings it back to 2×:
              <br />2 × $60 = $120 of stock.
            </Body>
          </Show>
        </div>
      </div>
    </Frame>
  </Scene>
);

const AfterSale: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="AFTER THE FIRST SALE"
      right="bNVDA at $80"
      title="After the sale, nobody lost value."
      footer="The same pool value. Less stock. Lower leverage."
      footAt={112}
    >
      <div style={{ display: "flex", gap: 70, alignItems: "center" }}>
        <div>
          <Show at={10}>
            <PoolBox shares={1.5} usdc={40} />
          </Show>
          <Show at={24} style={{ marginTop: 28 }}>
            <Body bold size={40}>
              $120 stock + $40 USDC = $160
            </Body>
          </Show>
        </div>
        <div style={{ flex: 1 }}>
          <Show at={44}>
            <div style={{ display: "flex", gap: 14 }}>
              <SideBox who="BOB" sub="fixed, the same" value="$100" color={C.sky} />
              <SideBox who="ALICE" sub="$160 − $100" value="$60" color={C.orange} />
            </div>
          </Show>
          <Show at={72} style={{ marginTop: 30 }}>
            <Label>LEVERAGE = STOCK VALUE ÷ ALICE'S PART</Label>
          </Show>
          <Show at={86}>
            <Big size={100} color={C.blue}>
              $120 ÷ $60 = 2×
            </Big>
          </Show>
        </div>
      </div>
    </Frame>
  </Scene>
);

// ---------- Fifth pass: rebound, algorithm, simpler benefits, markets ----------
const Buyback2: React.FC<{ dur: number }> = ({ dur }) => {
  const price = useTween(12, 42, 40.96, 54.61);
  const shares = useTween(98, 130, 0.633, 0.791);
  const usdcV = useTween(98, 130, 87.04, 78.4);
  return (
    <Scene dur={dur}>
      <Frame
        kicker="THE REBOUND"
        right="The reverse of a sale"
        title="When the price rises, the pool buys back."
      >
        <div style={{ display: "flex", gap: 80, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <Show at={10}>
              <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                <Big size={60}>NVDA rises to {usd(price, 2)}</Big>
                <Pill>up</Pill>
              </div>
            </Show>
            <Show at={48} style={{ marginTop: 26 }}>
              <Pill color={C.sky}>Leverage is low now: 1.6×</Pill>
            </Show>
            <Show at={78} style={{ marginTop: 26 }}>
              <Body size={44}>The pool spends USDC on stock:</Body>
              <Big size={110} color={C.blue}>
                $8.64
              </Big>
            </Show>
            <Show at={120}>
              <Body size={44} bold>
                Leverage is back at 2×.
              </Body>
            </Show>
          </div>
          <div>
            <Show at={10}>
              <PoolBox shares={shares} usdc={Math.round(usdcV * 100) / 100} />
            </Show>
            <Show at={98} style={{ marginTop: 30 }}>
              <div style={{ fontSize: 44, fontWeight: 900, textAlign: "center" }}>
                <span style={{ background: C.gold, padding: "2px 14px", borderRadius: 8 }}>USDC</span>
                {"  →  "}
                <span style={{ background: C.green, padding: "2px 14px", borderRadius: 8 }}>stock</span>
              </div>
            </Show>
          </div>
        </div>
      </Frame>
    </Scene>
  );
};

const TableRebound: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="THE REBOUND"
      right="Gold rows show a buy"
      title="On the way up, the pool buys three times."
      footer="Every buy takes the leverage back to 2×."
      footAt={140}
    >
      <Table
        cols={["bNVDA price", "Shares", "Stock value", "USDC", "Pool value", "Bob", "Alice", "Leverage"]}
        start={20}
        step={28}
        gold={[1, 2, 3]}
        size={32}
        tags={{ 1: "1st buy", 2: "2nd buy", 3: "3rd buy" }}
        rows={[
          ["$40", "0.633", "$25.31", "$87.04", "$112.35", "$100", "$12.35", "2.05×"],
          ["$54.61", "0.791", "$43.20", "$78.40", "$121.60", "$100", "$21.60", "2.00×"],
          ["$72.82", "0.989", "$72.00", "$64.00", "$136.00", "$100", "$36.00", "2.00×"],
          ["$97.09", "1.236", "$120.00", "$40.00", "$160.00", "$100", "$60.00", "2.00×"],
          ["$100", "1.236", "$123.60", "$40.00", "$163.60", "$100", "$63.60", "1.94×"],
        ]}
      />
    </Frame>
  </Scene>
);


const LOGO: Record<string, string> = {
  Atlas: "partners/atlas.svg",
  CoinMarketCap: "partners/coinmarketcap.png",
  Flap: "partners/flap.png",
  "Four.meme": "partners/fourmeme.png",
};

const Powered: React.FC<{ label: string; items: string[] }> = ({ label, items }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
    <span style={{ fontSize: 38, fontWeight: 800, color: C.ink }}>{label}</span>
    {items.map((t) => (
      <span
        key={t}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 14,
          background: "#fff",
          border: `4px solid ${C.ink}`,
          borderRadius: 50,
          padding: "8px 28px 8px 12px",
          fontSize: 38,
          fontWeight: 900,
          boxShadow: `5px 5px 0 ${C.ink}`,
        }}
      >
        <Img src={staticFile(LOGO[t])} style={{ width: 54, height: 54, objectFit: "contain", borderRadius: 12 }} />
        {t}
      </span>
    ))}
  </div>
);

const Algo: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <AbsoluteFill
      style={{
        fontFamily: HEAD,
        color: C.ink,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <Show at={4}>
        <div style={{ fontSize: 80, fontWeight: 900, letterSpacing: -1, whiteSpace: "nowrap" }}>
          An algorithm does the buying and selling.
        </div>
      </Show>
      <Show at={76} style={{ marginTop: 44 }}>
        <div style={{ fontSize: 56, fontWeight: 900, color: C.red }}>
          If leverage is too high → sell stock.
        </div>
      </Show>
      <Show at={166}>
        <div style={{ fontSize: 56, fontWeight: 900, color: C.blue }}>
          If leverage is low again → buy back.
        </div>
      </Show>
    </AbsoluteFill>
  </Scene>
);

const Loan2: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="WHY ALICE PAYS A FUNDING FEE"
      right="Loan example: 80% limit, 8% penalty"
      title="A loan can liquidate you. MORE cannot."
    >
      <div style={{ display: "flex", gap: 60 }}>
        <Show at={16} style={{ flex: 1 }}>
          <Label>2× WITH A MARGIN LOAN</Label>
          <Body size={38}>Liquidation price</Body>
          <Big size={130} color={C.red}>
            $62.50
          </Big>
          <Body size={40} bold>
            + a penalty of about 8%
          </Body>
        </Show>
        <div style={{ width: 3, background: C.line, opacity: 0.4 }} />
        <Show at={62} style={{ flex: 1 }}>
          <Label>2× WITH MORE</Label>
          <Body size={38}>Liquidation price</Body>
          <Big size={130} color={C.blue}>
            None
          </Big>
          <Body size={40} bold>
            At $60, Alice still holds $31.50.
          </Body>
        </Show>
      </div>
      <Show at={108} style={{ marginTop: 34 }}>
        <Banner>The 4% funding fee is the price of this protection.</Banner>
      </Show>
    </Frame>
  </Scene>
);

const WhyBob2: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame
      kicker="WHY BOB JOINS"
      right="The stable side"
      title="Bob wants a higher yield."
      footer="Bob can lose principal. The yield is the payment for that risk."
      footAt={104}
    >
      <div style={{ display: "flex", gap: 70, alignItems: "center" }}>
        <Show at={10}>
          <Bob width={380} />
        </Show>
        <div style={{ flex: 1 }}>
          <Show at={24}>
            <Big size={62}>He earns Alice's 4% funding fee.</Big>
          </Show>
          <Show at={52} style={{ marginTop: 20 }}>
            <Body size={42}>Every stable token pays into it.</Body>
          </Show>
          <Show at={78}>
            <div style={{ height: 3, background: C.line, margin: "30px 0 22px" }} />
            <Label color={C.blue}>WHAT HE RISKS</Label>
            <Body bold size={44}>
              A price gap before the pool can sell.
            </Body>
          </Show>
        </div>
      </div>
    </Frame>
  </Scene>
);

const Rates: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const rows: { name: string; note: string; v: number; label: string; hot?: boolean }[] = [
    { name: "Binance", note: "Simple Earn, USDT", v: 1.6, label: "1.6%" },
    { name: "Lista", note: "USDT and USD1 vaults", v: 2.4, label: "up to 2.4%" },
    { name: "Aave", note: "USDC on Ethereum", v: 4.33, label: "4.33%" },
    { name: "MORE", note: "Stability Pool, example", v: 8, label: "8%", hot: true },
  ];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="WHY BOB JOINS"
        right="Yield for one year on dollars"
        title="What lending pays, and what Bob earns."
        footer="MORE example: 4% fee, half of the stable tokens deposited. Rates are snapshots from November 2026."
        footAt={135}
      >
        <div>
          {rows.map((r, i) => {
            const at = 18 + i * 24;
            const w = interpolate(frame, [at, at + 26], [0, r.v], { ...clamp, easing: ease });
            return (
              <Show key={r.name} at={at}>
                <div style={{ display: "flex", alignItems: "center", gap: 30, marginBottom: 22 }}>
                  <div style={{ width: 430 }}>
                    <div style={{ fontSize: 46, fontWeight: 900 }}>{r.name}</div>
                    <div style={{ fontSize: 28, fontWeight: 500, color: C.muted }}>{r.note}</div>
                  </div>
                  <div
                    style={{
                      width: w * 120,
                      height: 70,
                      background: r.hot ? C.blue : C.sky,
                      border: `4px solid ${C.ink}`,
                      borderRadius: 10,
                    }}
                  />
                  <div style={{ fontSize: 60, fontWeight: 900, color: r.hot ? C.blue : C.ink }}>
                    {r.label}
                  </div>
                </div>
              </Show>
            );
          })}
        </div>
      </Frame>
    </Scene>
  );
};

const Markets: React.FC<{ dur: number }> = ({ dur }) => {
  const cards = [
    { at: 40, stock: "bNVDA", color: C.green, rows: ["2.0×", "2.67×", "1.6×", "4%"] },
    { at: 82, stock: "bTSLA", color: C.orange, rows: ["1.8×", "2.3×", "1.5×", "6%"] },
    { at: 124, stock: "bAAPL", color: C.sky, rows: ["2.2×", "3.0×", "1.8×", "3%"] },
  ];
  const keys = ["Leverage target", "Sell stock at", "Buy back at", "Funding fee"];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="LAUNCHPAD / BNB CHAIN"
        right="Example markets"
        title="Anyone can create a market."
        footer="Then anyone can deposit and pick a side. Protocol limits keep every setting safe."
        footAt={200}
      >
        <Show at={12}>
          <Body size={40}>
            The creator chooses the stock, the leverage, and when the algorithm sells and buys.
          </Body>
        </Show>
        <div style={{ display: "flex", gap: 40, marginTop: 30 }}>
          {cards.map((c) => (
            <Show key={c.stock} at={c.at} style={{ flex: 1 }}>
              <div
                style={{
                  border: `4px solid ${C.ink}`,
                  borderRadius: 18,
                  boxShadow: `8px 8px 0 ${C.ink}`,
                  background: "#fff",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    background: c.color,
                    borderBottom: `4px solid ${C.ink}`,
                    padding: "14px 26px",
                    fontSize: 50,
                    fontWeight: 900,
                  }}
                >
                  {c.stock} market
                </div>
                <div style={{ padding: "12px 26px 16px" }}>
                  {keys.map((k, i) => (
                    <div
                      key={k}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        fontSize: 32,
                        fontWeight: 500,
                        lineHeight: 1.75,
                        borderBottom: i < 3 ? `2px solid ${C.stripe}` : "none",
                      }}
                    >
                      <span>{k}</span>
                      <span style={{ fontSize: 40, fontWeight: 900 }}>{c.rows[i]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Show>
          ))}
        </div>
      </Frame>
    </Scene>
  );
};

// ---------- Sixth pass: the leverage formula ----------
const Formula: React.FC<{ dur: number }> = ({ dur }) => {
  const price = useTween(52, 100, 100, 60);
  const stock = price * 2;
  const alice = stock - 100;
  const bar = (label: string, v: number, color: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 24, marginTop: 16 }}>
      <div style={{ width: 330, fontSize: 36, fontWeight: 800 }}>{label}</div>
      <div
        style={{
          width: v * 4.2,
          height: 64,
          background: color,
          border: `4px solid ${C.ink}`,
          borderRadius: 10,
        }}
      />
      <div style={{ fontSize: 48, fontWeight: 900 }}>{usd(v)}</div>
    </div>
  );
  return (
    <Scene dur={dur}>
      <Frame
        kicker="THE FORMULA"
        right="bNVDA from $100 down to $60"
        title="How is the leverage counted?"
        footer="The pool gets smaller slowly. Alice's part gets smaller fast. So the leverage rises."
        footAt={98}
      >
        <Show at={10}>
          <div
            style={{
              display: "inline-block",
              background: C.gold,
              border: `4px solid ${C.ink}`,
              borderRadius: 16,
              boxShadow: `6px 6px 0 ${C.ink}`,
              padding: "14px 34px",
              fontSize: 58,
              fontWeight: 900,
            }}
          >
            Leverage = stock in the pool ÷ Alice's part
          </div>
        </Show>
        <div style={{ display: "flex", alignItems: "center", gap: 40, marginTop: 30 }}>
          <Show at={30} style={{ flex: 1 }}>
            {bar("Stock in the pool", stock, C.green)}
            {bar("Alice's part", alice, C.orange)}
          </Show>
          <Show at={40} style={{ textAlign: "right", width: 400 }}>
            <Label>LEVERAGE</Label>
            <Big size={130} color={stock / alice > 2.6 ? C.red : C.blue}>
              {(stock / alice).toFixed(2)}×
            </Big>
          </Show>
        </div>
      </Frame>
    </Scene>
  );
};

// ---------- Seventh pass: the full trip as a graph, and market settings ----------
const Trip: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  // [distance travelled by the price, price, Alice's value, event]
  const pts: [number, number, number, string][] = [
    [0, 100, 100, ""],
    [20, 120, 140, ""],
    [60, 80, 60, "sale"],
    [76, 64, 36, "sale"],
    [88.8, 51.2, 21.6, "sale"],
    [99.04, 40.96, 12.96, "sale"],
    [100, 40, 12.35, ""],
    [114.61, 54.61, 21.6, "buy"],
    [132.82, 72.82, 36, "buy"],
    [157.09, 97.09, 60, "buy"],
    [170, 110, 75.96, ""],
  ];
  const W = 1320;
  const H = 400;
  const X = (d: number) => (d / 170) * W;
  const Y = (v: number) => H - (v / 150) * H;
  const line = (k: 1 | 2) => pts.map((p, i) => `${i ? "L" : "M"}${X(p[0])},${Y(p[k])}`).join(" ");
  const prog = interpolate(frame, [18, 118], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  const seen = (d: number) => interpolate(prog * 170, [d, d + 4], [0, 1], clamp);
  const note = (d: number, v: number, text: string, dy: number, anchor: "start" | "middle" | "end" = "middle") => (
    <text
      x={X(d)}
      y={Y(v) + dy}
      textAnchor={anchor}
      fontSize={30}
      fontWeight={800}
      fill={C.ink}
      opacity={seen(d)}
    >
      {text}
    </text>
  );
  return (
    <Scene dur={dur}>
      <Frame
        kicker="THE FULL TRIP"
        right="NVDA: $100 → $120 → $40 → $110"
        title="Up, down to $40, and back up to $110."
        footer="At the end the pool holds 1.236 bNVDA and $40 USDC: $175.96. Bob has $100. Alice has $75.96."
        footAt={132}
      >
        <div style={{ display: "flex", gap: 34, fontSize: 30, fontWeight: 800, marginBottom: 30 }}>
          <Show at={8}>
            <span style={{ color: C.ink }}>▬ NVDA price</span>
          </Show>
          <Show at={8}>
            <span style={{ color: C.blue }}>▬ Bob</span>
          </Show>
          <Show at={8}>
            <span style={{ color: "#E0632F" }}>▬ Alice</span>
          </Show>
          <Show at={8}>
            <span style={{ color: C.muted }}>● sale &nbsp; ○ buy</span>
          </Show>
        </div>
        <svg width={W + 380} height={H + 40} style={{ overflow: "visible" }}>
          <defs>
            <clipPath id="tripclip">
              <rect x={-10} y={-40} width={prog * W + 12} height={H + 80} />
            </clipPath>
          </defs>
          {[0, 50, 100].map((v) => (
            <g key={v}>
              <line x1={0} x2={W} y1={Y(v)} y2={Y(v)} stroke={C.line} strokeWidth={2} opacity={0.25} />
              <text x={-14} y={Y(v) + 10} textAnchor="end" fontSize={26} fill={C.muted} fontWeight={700}>
                ${v}
              </text>
            </g>
          ))}
          <g clipPath="url(#tripclip)">
            <line x1={0} x2={W} y1={Y(100)} y2={Y(100)} stroke={C.blue} strokeWidth={9} />
            <path d={line(1)} fill="none" stroke={C.ink} strokeWidth={6} strokeLinejoin="round" />
            <path d={line(2)} fill="none" stroke="#E0632F" strokeWidth={9} strokeLinejoin="round" />
            {pts
              .filter((p) => p[3])
              .map((p) => (
                <circle
                  key={p[0]}
                  cx={X(p[0])}
                  cy={Y(p[2])}
                  r={11}
                  fill={p[3] === "sale" ? C.ink : "#fff"}
                  stroke={C.ink}
                  strokeWidth={4}
                />
              ))}
          </g>
          <text x={X(20) + 26} y={Y(140) + 12} fontSize={30} fontWeight={800} fill={C.ink} opacity={seen(20)}>
            NVDA $120 → Alice $140
          </text>
          <text x={X(100)} y={H + 38} textAnchor="middle" fontSize={30} fontWeight={800} fill={C.ink} opacity={seen(100)}>
            NVDA $40 → Alice $12.35, Bob $100
          </text>
          <g opacity={seen(166)}>
            <text x={W + 22} y={Y(110) - 6} fontSize={34} fontWeight={900} fill={C.ink}>
              NVDA $110
            </text>
            <text x={W + 22} y={Y(100) + 30} fontSize={34} fontWeight={900} fill={C.blue}>
              Bob $100
            </text>
            <text x={W + 22} y={Y(75.96) + 34} fontSize={34} fontWeight={900} fill="#E0632F">
              Alice $75.96
            </text>
          </g>
        </svg>
      </Frame>
    </Scene>
  );
};

const Markets2: React.FC<{ dur: number }> = ({ dur }) => {
  const cards = [
    { at: 200, stock: "bNVDA", color: C.green, rows: ["1.6× to 2.67×", "4%", "$10,000", "20%", "10%"] },
    { at: 225, stock: "bTSLA", color: C.orange, rows: ["1.5× to 2.3×", "6%", "$25,000", "20%", "10%"] },
    { at: 250, stock: "bAAPL", color: C.sky, rows: ["1.8× to 3.0×", "3%", "$5,000", "20%", "10%"] },
  ];
  const keys = ["Leverage range", "Funding fee", "Vault seed", "Creator earns", "Platform earns"];
  return (
    <Scene dur={dur}>
      <Frame
        kicker="LAUNCHPAD / BNB CHAIN"
        right="Example settings, not final"
        title="Not only a platform. A launchpad."
        footer="Then anyone can deposit and pick a side. Creator and platform earn a share of the mint and redeem fees."
        footAt={185}
      >
        <Show at={95}>
          <Powered label="A launchpad on" items={["Flap", "Four.meme"]} />
        </Show>
        <Show at={165} style={{ marginTop: 24 }}>
          <Body size={38}>
            Anyone can launch a MORE market with their own config: stock, leverage, fee and vault.
          </Body>
        </Show>
        <div style={{ display: "flex", gap: 40, marginTop: 22 }}>
          {cards.map((c) => (
            <Show key={c.stock} at={c.at} style={{ flex: 1 }}>
              <div
                style={{
                  border: `4px solid ${C.ink}`,
                  borderRadius: 18,
                  boxShadow: `8px 8px 0 ${C.ink}`,
                  background: "#fff",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    background: c.color,
                    borderBottom: `4px solid ${C.ink}`,
                    padding: "10px 26px",
                    fontSize: 46,
                    fontWeight: 900,
                  }}
                >
                  {c.stock} market
                </div>
                <div style={{ padding: "8px 26px 12px" }}>
                  {keys.map((k, i) => (
                    <div
                      key={k}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        fontSize: 29,
                        fontWeight: 500,
                        lineHeight: 1.7,
                        borderBottom: i < 4 ? `2px solid ${C.stripe}` : "none",
                      }}
                    >
                      <span>{k}</span>
                      <span style={{ fontSize: 34, fontWeight: 900 }}>{c.rows[i]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Show>
          ))}
        </div>
      </Frame>
    </Scene>
  );
};

// ---------- Eighth pass: the two closing scenes about the partners ----------
const Partner: React.FC<{ name: string; color: string; children: React.ReactNode }> = ({
  name,
  color,
  children,
}) => (
  <div
    style={{
      flex: 1,
      border: `4px solid ${C.ink}`,
      borderRadius: 18,
      boxShadow: `8px 8px 0 ${C.ink}`,
      background: "#fff",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        background: color,
        borderBottom: `4px solid ${C.ink}`,
        padding: "12px 28px",
        fontSize: 50,
        fontWeight: 900,
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 18 }}>
        <Img
          src={staticFile(LOGO[name])}
          style={{ width: 64, height: 64, objectFit: "contain", borderRadius: 14, background: "#fff", padding: 6 }}
        />
        {name}
      </span>
    </div>
    <div style={{ padding: "16px 28px 20px" }}>{children}</div>
  </div>
);

const Row: React.FC<{ k: string; v: string; at?: number }> = ({ k, v, at = 0 }) => (
  <Show at={at} dist={12}>
    <div style={{ fontSize: 34, lineHeight: 1.5, marginBottom: 8 }}>
      <span style={{ fontWeight: 900 }}>{k}</span>
      <span style={{ fontWeight: 500 }}> {v}</span>
    </div>
  </Show>
);

const DataPartners: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame title="Price and data: Atlas, CoinMarketCap.">
      <div style={{ display: "flex", gap: 44 }}>
        <Show at={58} style={{ flex: 1, display: "flex" }}>
          <Partner name="Atlas" color={C.green}>
            <Row at={128} k="Live stock price." v="Every mint, redeem, sale and buy uses it." />
            <Row at={150} k="It gives the leverage:" v="stock value ÷ leveraged side." />
          </Partner>
        </Show>
        <Show at={82} style={{ flex: 1, display: "flex" }}>
          <Partner name="CoinMarketCap" color={C.sky}>
            <Row at={196} k="Volatility" v="sets how early the pool sells." />
            <Row at={236} k="Liquidity" v="sets how much it sells in one trade." />
            <Row at={356} k="Price check:" v="mints stop if it differs from Atlas." />
          </Partner>
        </Show>
      </div>
    </Frame>
  </Scene>
);

const LaunchPartners: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur}>
    <Frame title="Launch a token on Flap or Four.meme.">
      <div style={{ display: "flex", gap: 44 }}>
        <Show at={16} style={{ flex: 1, display: "flex" }}>
          <Partner name="Flap" color={C.orange}>
            <Row k="Create your own token." v="Configure the launch on Flap." />
            <Row k="The raise opens a market." v="Example: NVDA." />
          </Partner>
        </Show>
        <Show at={44} style={{ flex: 1, display: "flex" }}>
          <Partner name="Four.meme" color={C.gold}>
            <Row k="Create your own token." v="Configure the launch on OpenFour." />
            <Row k="Selling out opens a market." v="Example: TSLA." />
          </Partner>
        </Show>
      </div>
      <Show at={78} style={{ marginTop: 44 }}>
        <Body size={42} bold>
          On both, a user configures and launches a token. The launch opens a market.
        </Body>
      </Show>
    </Frame>
  </Scene>
);

// ---------- Timeline ----------
type Item = { dur: number; el: (dur: number) => React.ReactNode };
const TIMELINE: Item[] = [
  { dur: 95, el: (d) => <Opening dur={d} /> },
  { dur: 155, el: (d) => <Problem dur={d} /> },
  { dur: 95, el: (d) => <Title dur={d} /> },
  { dur: 160, el: (d) => <Choice dur={d} /> },
  { dur: 195, el: (d) => <Deposit2 dur={d} who="alice" /> },
  { dur: 215, el: (d) => <Deposit2 dur={d} who="bob" /> },
  { dur: 140, el: (d) => <Beat dur={d} to={110} part="pool" /> },
  { dur: 140, el: (d) => <Beat dur={d} to={110} part="split" /> },
  { dur: 140, el: (d) => <Beat dur={d} to={110} part="result" /> },
  { dur: 155, el: (d) => <FallPool dur={d} /> },
  { dur: 130, el: (d) => <Beat dur={d} to={90} part="split" /> },
  { dur: 125, el: (d) => <Drop dur={d} price={50} /> },
  { dur: 130, el: (d) => <Formula dur={d} /> },
  { dur: 255, el: (d) => <TableLeverage2 dur={d} /> },
  { dur: 140, el: (d) => <NotLiquidated dur={d} /> },
  { dur: 95, el: (d) => <Control dur={d} /> },
  { dur: 200, el: (d) => <SellTrigger2 dur={d} /> },
  {
    dur: 230,
    el: (d) => (
      <Sale dur={d} price={80} sold={0.5} got={40} sharesFrom={2} usdcFrom={0} stockFrom={160} alice={60} />
    ),
  },
  { dur: 140, el: (d) => <AfterSale dur={d} /> },
  { dur: 290, el: (d) => <TableSales dur={d} /> },
  { dur: 180, el: (d) => <AtForty dur={d} /> },
  { dur: 150, el: (d) => <Buyback2 dur={d} /> },
  { dur: 180, el: (d) => <Trip dur={d} /> },
  { dur: 95, el: (d) => <Algo dur={d} /> },
  { dur: 155, el: (d) => <WhyAlice dur={d} /> },
  { dur: 155, el: (d) => <Loan2 dur={d} /> },
  { dur: 140, el: (d) => <WhyBob2 dur={d} /> },
  { dur: 165, el: (d) => <Rates dur={d} /> },
  { dur: 240, el: (d) => <Markets2 dur={d} /> },
  { dur: 195, el: (d) => <DataPartners dur={d} /> },
  { dur: 130, el: (d) => <Title dur={d} end /> },
];

// [audio start in seconds, audio end in seconds, scene length in frames], one for each scene.
const VOICE: [number, number, number, string?][] = [
  [0.00, 2.93, 88],
  [2.93, 8.60, 170],
  [8.60, 13.62, 151],
  [13.62, 21.87, 248],
  [21.87, 28.81, 208],
  [28.81, 38.23, 283],
  [38.23, 42.32, 123],
  [42.32, 49.80, 224],
  [49.80, 58.20, 252],
  [58.20, 62.39, 126],
  [62.39, 65.65, 98],
  [68.40, 71.39, 90],
  [74.00, 77.55, 106],
  [77.55, 84.66, 213],
  [84.66, 93.24, 257],
  [0.00, 6.08, 182, "voice/extra.mp3"],
  [95.55, 100.31, 143],
  [100.31, 105.27, 149],
  [105.27, 109.38, 123],
  [109.38, 116.54, 215],
  [116.54, 124.04, 225],
  [124.04, 127.01, 89],
  [130.82, 138.83, 240],
  [0.00, 7.71, 236, "voice/27.mp3"],
  [6.08, 12.25, 185, "voice/extra.mp3"],
  [145.31, 149.87, 137],
  [12.25, 16.51, 132, "voice/extra.mp3"],
  [154.97, 158.67, 111],
  [0.00, 14.71, 441, "voice/end2.mp3"],
  [14.71, 29.57, 455, "voice/end2.mp3"],
  [166.38, 170.76, 146],
];

export const TOTAL_FRAMES = VOICE.reduce((a, v) => a + v[2], 0);

// Plays a scene in its voice length. A scene that is shorter than its design plays faster.
const Fit: React.FC<{ design: number; actual: number; el: (dur: number) => React.ReactNode }> = ({
  design,
  actual,
  el,
}) => {
  const frame = useCurrentFrame();
  if (actual >= design) {
    return <>{el(actual)}</>;
  }
  return <Freeze frame={(frame * design) / actual}>{el(design)}</Freeze>;
};

export const More: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: C.bg }}>
    <Series>
      {TIMELINE.map((t, i) => (
        <Series.Sequence key={i} durationInFrames={VOICE[i][2]}>
          {VOICE[i][1] > VOICE[i][0] ? (
            <Audio
              src={staticFile(VOICE[i][3] ?? "voice/full.mp3")}
              startFrom={Math.round(VOICE[i][0] * 30)}
              endAt={Math.round(VOICE[i][1] * 30)}
            />
          ) : null}
          <Fit design={t.dur} actual={VOICE[i][2]} el={t.el} />
        </Series.Sequence>
      ))}
    </Series>
  </AbsoluteFill>
);
