"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const ColorBends = dynamic(() => import("./color-bends"), { ssr: false });

/**
 * The moving backdrop for dark surfaces: cold steel bands drifting under the type, with one ember
 * of alarm red buried far enough down that you read it as heat off metal rather than as a colour.
 *
 * Client-only, and only where it is affordable and welcome — wide screens, WebGL present, motion not
 * reduced. The static `.veil` gradient underneath paints first and is what everyone else sees, so
 * the page never flashes and never depends on this arriving.
 */
export function Veil({
  intensity = 0.9,
  speed = 0.1,
  className = "",
}: {
  intensity?: number;
  speed?: number;
  className?: string;
}) {
  const [canAnimate, setCanAnimate] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      let webgl = false;
      try {
        const c = document.createElement("canvas");
        webgl = Boolean(c.getContext("webgl2") || c.getContext("webgl"));
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
      <ColorBends
        style={{ width: "100%", height: "100%" }}
        colors={[
          "#0b0d10", // graphite, most of the field
          "#232a33", // cold shadow in the metal
          "#4a5765", // brushed steel
          "#8d99a8", // the highlight that catches the shop light
          "#3a1416", // an ember, kept almost black
        ]}
        speed={speed}
        intensity={intensity}
        rotation={-18}
        autoRotate={0.02}
        scale={1.25}
        frequency={1.35}
        warpStrength={0.85}
        bandWidth={2.1}
        mouseInfluence={0.08}
        parallax={0.03}
        noise={0.035}
        transparent
      />
    </div>
  );
}
