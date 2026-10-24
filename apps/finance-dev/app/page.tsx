"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { MotionRoot, prefersReducedMotion } from "./components/MotionRoot";
import "./mk.css";

const VantaDots = dynamic(() => import("./components/VantaDots"), { ssr: false });

export default function Landing() {
  const eq = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    if (prefersReducedMotion()) return;
    // Assembles on scroll with transforms only; at rest every word is already in place and visible.
    gsap.utils.toArray<HTMLElement>(".el", eq.current).forEach(el => {
      gsap.fromTo(el, { x: Number(el.dataset.x) }, { x: 0, ease: "none", overwrite: "auto", scrollTrigger: { trigger: eq.current, start: "top 90%", end: "top 45%", scrub: true } });
    });
  }, { scope: eq });

  return <MotionRoot className="night">
    <main aria-label="Mangekyo">
      <section className="hero">
        <VantaDots />
        <div className="wrap" style={{ width: "100%" }}>
          <div className="hero-inner">
            <img className="hero-logo" src="/mangekyo-logo.png" alt="Mangekyo" width={56} height={56} />
            <h1>Every dollar in a pooled account, proven to its owner.</h1>
            <p>Mangekyo investigates every deposit, keeps the bank, the books and every owner&apos;s balance matched, and asks a person whenever it isn&apos;t sure.</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Link className="btn" href="/desk" style={{ background: "#F2F2F0", color: "#050505" }}>Open the desk</Link>
              <a className="btn alt" href="#how" style={{ background: "transparent", color: "#F2F2F0", borderColor: "#5A5A5A" }}>How it works</a>
            </div>
          </div>
        </div>
      </section>

      <section className="land-sec"><div className="wrap">
        <span className="eyebrow" style={{ color: "var(--night-muted)" }}>Why it matters</span>
        <h2>Pooled accounts fail quietly, then all at once.</h2>
        <div className="facts">
          <div className="fact"><b className="n">$265M vs $180M</b><span>What Synapse&apos;s fintech customers were owed vs what the banks held when it collapsed in 2024.</span></div>
          <div className="fact"><b className="n">16 of 18</b><span>Law firms in a California State Bar pilot that couldn&apos;t properly show whose money was whose.</span></div>
          <div className="fact"><b>Monthly, by hand</b><span>How most firms reconcile today. Mistakes surface weeks after the money moved.</span></div>
        </div>
      </div></section>

      <section className="land-sec" id="how"><div className="wrap">
        <span className="eyebrow" style={{ color: "var(--night-muted)" }}>What we keep true, every minute</span>
        <h2>Three numbers that must always agree.</h2>
        <div className="eqland" ref={eq} aria-label="Bank equals books equals every owner, added up">
          <span className="el" data-x="-140">Bank</span><span className="op" aria-hidden="true">=</span>
          <span className="el" data-x="0">Books</span><span className="op" aria-hidden="true">=</span>
          <span className="el" data-x="140">Every owner, added up</span>
        </div>
        <ol className="steps-l">
          <li><b>Money arrives</b><span>From the bank feed and ERP you already have.</span></li>
          <li><b>An agent investigates</b><span>Whose money is it? Every claim cites a source.</span></li>
          <li><b>A second agent checks</b><span>It re-reads each source. Unsupported claims stop the run.</span></li>
          <li><b>A person signs off</b><span>Unsure items become questions. Code blocks unsafe payments.</span></li>
        </ol>
        <div style={{ marginTop: 36 }}><Link className="btn" href="/desk" style={{ background: "#F2F2F0", color: "#050505" }}>Open the desk</Link></div>
      </div></section>
    </main>
  </MotionRoot>;
}
