import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./page.module.css";

function Hero() {
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <p className={styles.eyebrow}>
          <span className={styles.eyebrowDot} aria-hidden /> npm i -g hatchkit
          &nbsp;·&nbsp; v0.1.42
        </p>
        <h1 className={styles.heroTitle}>
          From <code className={styles.inlineCode}>npx hatchkit</code>
          <br />
          to a <span className={styles.heroAccent}>deployed full-stack app</span>.
        </h1>
        <p className={styles.heroTagline}>
          Interactive CLI that scaffolds, provisions, and deploys
          production-ready TypeScript products — including GPU-backed ML
          services — onto infrastructure you own. No vendor lock-in.
        </p>
        <div className={styles.heroCtas}>
          <Link className={styles.ctaPrimary} href="/docs/getting-started">
            Get started →
          </Link>
          <Link
            className={styles.ctaSecondary}
            href="https://github.com/trebeljahr/hatchkit"
          >
            View on GitHub
          </Link>
        </div>

        <div className={styles.terminal} aria-label="Example terminal session">
          <div className={styles.terminalBar}>
            <span className={styles.dot} data-color="red" />
            <span className={styles.dot} data-color="amber" />
            <span className={styles.dot} data-color="green" />
            <span className={styles.terminalTitle}>~/projects</span>
          </div>
          <pre className={styles.terminalBody}>
            <code>
              <span className={styles.prompt}>$</span>{" "}
              <span className={styles.cmd}>npx hatchkit create</span>
              {"\n"}
              <span className={styles.muted}>? Project name ›</span>{" "}
              <span className={styles.input}>nimbus</span>
              {"\n"}
              <span className={styles.muted}>? Domain ›</span>{" "}
              <span className={styles.input}>nimbus.dev</span>
              {"\n"}
              <span className={styles.muted}>? Deploy target ›</span>{" "}
              <span className={styles.input}>New Hetzner VPS (cpx21)</span>
              {"\n"}
              <span className={styles.muted}>? Features ›</span>{" "}
              <span className={styles.input}>websocket, stripe, analytics</span>
              {"\n"}
              <span className={styles.muted}>? ML services ›</span>{" "}
              <span className={styles.input}>
                subtitles, background-removal
              </span>
              {"\n\n"}
              <span className={styles.ok}>✓</span> Scaffolded starter (44 files)
              {"\n"}
              <span className={styles.ok}>✓</span> Created GitHub repo
              trebeljahr/nimbus
              {"\n"}
              <span className={styles.ok}>✓</span> Provisioned VPS + DNS via
              Terraform
              {"\n"}
              <span className={styles.ok}>✓</span> Deployed Coolify app
              {"\n"}
              <span className={styles.ok}>✓</span> Deployed 2 ML endpoints to
              Modal
              {"\n\n"}
              <span className={styles.success}>
                → https://nimbus.nimbus.dev
              </span>
            </code>
          </pre>
        </div>
      </div>
    </header>
  );
}

type Pillar = {
  title: string;
  body: string;
  bullets: string[];
};

const pillars: Pillar[] = [
  {
    title: "Scaffold",
    body: "One opinionated starter, shaped to the features you actually picked. No layered scaffolds, no dead code.",
    bullets: [
      "Full-stack TypeScript + websockets + Stripe + auth",
      "Desktop (Electron) and mobile (Capacitor) opt-ins",
      "Collision-free local ports across projects",
    ],
  },
  {
    title: "Provision",
    body: "Terraform spins up DNS, a Hetzner VPS, and a Coolify app — or pushes to a server you already operate.",
    bullets: [
      "Hetzner + INWX / Cloudflare wired end-to-end",
      "Coolify env block, private key, deploy hooks set up",
      "GlitchTip, OpenPanel, Resend paired per environment",
    ],
  },
  {
    title: "Ship ML",
    body: "Pre-built GPU service templates deploy to Modal, RunPod, Hugging Face, or Replicate as first-class endpoints.",
    bullets: [
      "Subtitles, image recognition, background removal, 3D",
      "Bring your own Hugging Face model with one prompt",
      "Endpoints surface as typed clients in your project",
    ],
  },
];

function Pillars() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <h2 className={styles.sectionTitle}>
          The same boring two weeks, in one command.
        </h2>
        <p className={styles.sectionLede}>
          Hatchkit collapses the rituals of starting a new product — auth,
          analytics, domains, servers, deployment pipelines, env-var ping-pong
          — into a single guided run.
        </p>
        <div className={styles.pillarGrid}>
          {pillars.map((p) => (
            <article key={p.title} className={styles.pillarCard}>
              <h3 className={styles.pillarTitle}>{p.title}</h3>
              <p className={styles.pillarBody}>{p.body}</p>
              <ul className={styles.pillarList}>
                {p.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Workflow() {
  const steps = [
    {
      num: "01",
      cmd: "hatchkit setup",
      title: "Onboard once",
      body: "Walks through every credential — GitHub, Coolify, Hetzner, DNS, GlitchTip, OpenPanel, Resend, GPU providers. Tokens go to your OS keychain, never to git.",
    },
    {
      num: "02",
      cmd: "hatchkit create",
      title: "Scaffold + deploy",
      body: "Pick name, domain, features, ML services, deploy target. Hatchkit scaffolds the repo, creates GitHub, provisions infra, deploys the app and your GPU endpoints.",
    },
    {
      num: "03",
      cmd: "hatchkit doctor",
      title: "Stay healthy",
      body: "Read-only health check across every provider with contextual fix hints. Re-configure any single provider with `hatchkit config add <name>`.",
    },
  ];

  return (
    <section className={`${styles.section} ${styles.sectionAlt}`}>
      <div className={styles.sectionInner}>
        <h2 className={styles.sectionTitle}>Three commands to know.</h2>
        <p className={styles.sectionLede}>
          Hatchkit's surface area is tiny on purpose. Most of the value is in
          what it does between the prompts.
        </p>
        <ol className={styles.steps}>
          {steps.map((s) => (
            <li key={s.num} className={styles.step}>
              <div className={styles.stepNum}>{s.num}</div>
              <div className={styles.stepBody}>
                <code className={styles.stepCmd}>{s.cmd}</code>
                <h3 className={styles.stepTitle}>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const providerGroups: { label: string; items: string[] }[] = [
  { label: "Hosting", items: ["Hetzner Cloud", "Coolify", "Your own VPS"] },
  { label: "DNS", items: ["Cloudflare", "INWX"] },
  { label: "Observability", items: ["GlitchTip", "OpenPanel"] },
  { label: "Email", items: ["Resend"] },
  { label: "GPU", items: ["Modal", "RunPod", "Hugging Face", "Replicate"] },
  { label: "Storage", items: ["S3-compatible"] },
  { label: "Source", items: ["GitHub"] },
  { label: "Secrets", items: ["dotenvx", "OS keychain"] },
];

function Providers() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionInner}>
        <h2 className={styles.sectionTitle}>
          Wired up to the tools you'd pick anyway.
        </h2>
        <p className={styles.sectionLede}>
          Hatchkit is an orchestrator, not a platform. Everything it spins up —
          your server, your Coolify, your repo, your domain — stays yours.
        </p>
        <div className={styles.providers}>
          {providerGroups.map((g) => (
            <div key={g.label} className={styles.providerGroup}>
              <div className={styles.providerLabel}>{g.label}</div>
              <ul className={styles.providerList}>
                {g.items.map((i) => (
                  <li key={i} className={styles.providerChip}>
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Philosophy() {
  return (
    <section className={`${styles.section} ${styles.sectionAlt}`}>
      <div className={styles.sectionInner}>
        <blockquote className={styles.quote}>
          <p>
            Your code, your repo, your server, your domain. Hatchkit is the
            orchestrator that wires them together — and then gets out of the
            way.
          </p>
        </blockquote>
        <div className={styles.principles}>
          <div>
            <h4>No vendor lock-in</h4>
            <p>
              Nothing hatchkit creates depends on hatchkit. Walk away anytime —
              your infra keeps running.
            </p>
          </div>
          <div>
            <h4>Lazy prompts</h4>
            <p>
              You're only asked about a provider when you actually need it.
              Configure it later with one command.
            </p>
          </div>
          <div>
            <h4>Secrets out of git</h4>
            <p>
              dotenvx-encrypted env files, private keys in the OS keychain,
              never in your repo.
            </p>
          </div>
          <div>
            <h4>One starter, many shapes</h4>
            <p>
              Features are stripped at scaffold time, not layered on top. The
              output is lean, not scaffold-soup.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className={styles.finalCta}>
      <div className={styles.sectionInner}>
        <h2 className={styles.finalTitle}>Spend day one on product.</h2>
        <p className={styles.finalLede}>
          Hatchkit is MIT-licensed and runs on Node 20+. Try it without
          installing.
        </p>
        <pre className={styles.finalCmd}>
          <code>
            <span className={styles.finalPrompt}>$</span> npx hatchkit setup
          </code>
        </pre>
        <div className={styles.heroCtas}>
          <Link className={styles.ctaPrimary} href="/docs/getting-started">
            Read the docs →
          </Link>
          <Link
            className={styles.ctaSecondary}
            href="https://github.com/trebeljahr/hatchkit"
          >
            Star on GitHub
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <main className={styles.main}>
      <Hero />
      <Pillars />
      <Workflow />
      <Providers />
      <Philosophy />
      <FinalCta />
    </main>
  );
}
