"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const MoltenMetal = dynamic(() => import("./MoltenMetal"), { ssr: false });

/**
 * The moving backdrop: molten steel, not colour.
 *
 * The palette is deliberately monochrome — cold graphite in shadow, brushed steel through the
 * filaments, near-white where they run hottest. There is no warm hue anywhere in it, because red on
 * this site means an alarm fired, and a background that glows red all day would spend that meaning
 * before the page has said anything.
 *
 * Client-only, and only where it is affordable and welcome: wide screens, WebGL present, motion not
 * reduced. The static `.veil` gradient underneath paints first, so the page never flashes and never
 * depends on this arriving.
 */
export function Veil({ className = "" }: { className?: string }) {
  const [canAnimate, setCanAnimate] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      let webgl = false;
      try {
        const c = document.createElement("canvas");
        webgl = Boolean(c.getContext("webgl2"));
      } catch {
        webgl = false;
      }
      setCanAnimate(wide.matches && !reduced.matches && webgl);
    };
    update();
    wide.addEventListener("change", update);
    reduced.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      reduced.removeEventListener("change", update);
    };
  }, []);

  if (!canAnimate) return null;

  return (
    <div
      aria-hidden
      style={{ position: "absolute", inset: 0, zIndex: 1 }}
      className={`pointer-events-none ${className}`}
    >
      <MoltenMetal
        color1="#141a21"
        color2="#5d6774"
        color3="#e6eaef"
        colorMode="molten"
        speed={0.22}
        scale={3.4}
        detail={4}
        glow={1.5}
        coreSize={0.09}
        swirl={1.1}
        fold={-0.24}
        blackPoint={0.08}
        brightness={1.15}
        grain
        grainIntensity={0.04}
        mouseInteraction
        mouseStrength={0.22}
        opacity={0.85}
      />
    </div>
  );
}
