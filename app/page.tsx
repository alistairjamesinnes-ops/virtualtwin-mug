"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { svgPathProperties } from "svg-path-properties";

type ProfilePoint = { x: number; y: number };

type SvgFootMeta = {
  // in SVG coordinate units (same units as sampled points, before scaling to mm)
  outerBaseR: number; // outer radius at y=0 (foot ring outer radius)
  innerRecessR: number; // inner recess wall radius
  recessDepth: number; // depth (in Y) of the recess feature found in SVG
};

function extractPathD(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const paths = Array.from(doc.querySelectorAll("path"));
  if (paths.length === 0) throw new Error("No <path> found in SVG.");

  // Longest path is usually the main outline
  const best = paths
    .map((p) => p.getAttribute("d") || "")
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];

  if (!best) throw new Error("Could not read valid path.");
  return best;
}

function median(values: number[]): number {
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length === 0) return NaN;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * Closed-outline friendly sampling:
 * - sample lots of points
 * - normalize and flip Y
 * - for each y-bin:
 *    - outerX = max x
 *    - innerX = "next" significant x inside outer wall (captures foot recess)
 *
 * Returns:
 * - outer profile points (max X envelope)
 * - foot meta (outerBaseR, innerRecessR, recessDepth) detected from SVG
 */
function sampleOuterProfileAndFootFromPathD(
  d: string,
  samples = 3500
): { profile: ProfilePoint[]; foot: SvgFootMeta } {
  const props = new svgPathProperties(d);
  const len = props.getTotalLength();

  // 1) sample raw points along the path
  const raw: ProfilePoint[] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / (samples - 1)) * len;
    const p = props.getPointAtLength(t);
    raw.push({ x: p.x, y: p.y });
  }

  // 2) normalize to start at 0,0
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const norm = raw.map((p) => ({ x: p.x - minX, y: p.y - minY }));

  // 3) flip Y (SVG increases downward)
  const maxY0 = Math.max(...norm.map((p) => p.y));
  const flipped = norm.map((p) => ({ x: p.x, y: maxY0 - p.y }));

  // Basic bounds
  const yMax = Math.max(...flipped.map((p) => p.y));
  const xMaxAll = Math.max(...flipped.map((p) => p.x));

  // 4) bin by Y
  const bins = 520;
  const binSize = yMax / (bins - 1);

  const maxXByBin = new Array<number>(bins).fill(-Infinity);
  const innerXByBin = new Array<number>(bins).fill(-Infinity);

  // We'll detect "inner" as the largest x that is meaningfully smaller than maxX in that bin.
  // This avoids accidentally choosing axis/zero-ish points.
  for (const p of flipped) {
    const idx = Math.max(0, Math.min(bins - 1, Math.round(p.y / binSize)));

    // update outer
    if (p.x > maxXByBin[idx]) maxXByBin[idx] = p.x;
  }

  // second pass: compute inner candidates using per-bin max
  for (const p of flipped) {
    const idx = Math.max(0, Math.min(bins - 1, Math.round(p.y / binSize)));
    const outer = maxXByBin[idx];
    if (!isFinite(outer) || outer <= 0) continue;

    // delta is "how far inside" we require the inner feature to be.
    // This helps isolate the foot recess wall from noise.
    const delta = Math.max(outer * 0.02, xMaxAll * 0.01, 0.5);

    // candidate must be inside outer wall by at least delta
    if (p.x < outer - delta) {
      if (p.x > innerXByBin[idx]) innerXByBin[idx] = p.x;
    }
  }

  // 5) rebuild outer profile (envelope)
  let profile: ProfilePoint[] = [];
  for (let i = 0; i < bins; i++) {
    const x = maxXByBin[i];
    if (isFinite(x) && x > 0) profile.push({ x: Math.max(x, 0.2), y: i * binSize });
  }

  profile.sort((a, b) => a.y - b.y);
  if (profile.length < 40) throw new Error("Profile extraction produced too few points.");

  // Light smoothing of outer profile X (keep base detail)
  const window = 3;
  profile = profile.map((p, i) => {
    let sum = 0;
    let count = 0;
    for (let k = -window; k <= window; k++) {
      const j = i + k;
      if (j >= 0 && j < profile.length) {
        sum += profile[j].x;
        count++;
      }
    }
    return { x: Math.max(sum / count, 0.2), y: p.y };
  });

  // 6) Detect SVG foot meta from bottom region (first ~15% height)
  const scanY = yMax * 0.18;
  const scanBins = Math.max(6, Math.floor(scanY / binSize));

  const outerBaseR = isFinite(maxXByBin[0]) ? Math.max(maxXByBin[0], 0.2) : Math.max(profile[0].x, 0.2);

  // Collect inner candidates where the inner feature exists and is meaningfully different from outer.
  const innerCandidates: number[] = [];
  let recessDepth = 0;

  for (let i = 0; i <= scanBins; i++) {
    const outer = maxXByBin[i];
    const inner = innerXByBin[i];
    if (!isFinite(outer) || !isFinite(inner)) continue;

    const gap = outer - inner;
    // "recess exists" if there's a decent gap
    if (gap > Math.max(outer * 0.04, 1.0)) {
      innerCandidates.push(inner);
      recessDepth = Math.max(recessDepth, i * binSize);
    }
  }

  // If we couldn't detect, fall back to a reasonable default
  const innerRecessR = isFinite(median(innerCandidates))
    ? Math.max(median(innerCandidates), 1.0)
    : Math.max(outerBaseR * 0.75, 2.0);

  // Clamp recess depth to something sane (still in SVG units)
  recessDepth = Math.max(recessDepth, yMax * 0.04);

  return {
    profile,
    foot: {
      outerBaseR,
      innerRecessR: Math.min(innerRecessR, outerBaseR - 0.8),
      recessDepth,
    },
  };
}

function toLathePointsWithScale(
  profile: ProfilePoint[],
  heightMm: number,
  maxRadiusMm: number
): { pts: THREE.Vector2[]; sx: number; sy: number } {
  const maxY = Math.max(...profile.map((p) => p.y));
  const maxX = Math.max(...profile.map((p) => p.x));

  const sy = maxY > 0 ? heightMm / maxY : 1;
  const sx = maxX > 0 ? maxRadiusMm / maxX : 1;

  const pts = profile.map((p) => new THREE.Vector2(Math.max(p.x * sx, 0.2), p.y * sy));
  return { pts, sx, sy };
}

function fallbackOuter(heightMm: number, radiusMm: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 140; i++) {
    const y = (i / 140) * heightMm;
    const x = radiusMm * (1 - 0.25 * (y / heightMm));
    pts.push(new THREE.Vector2(Math.max(x, 0.2), y));
  }
  return pts;
}

function flipWinding(geo: THREE.BufferGeometry) {
  const idx = geo.getIndex();
  if (!idx) return;
  const arr = idx.array as Uint16Array | Uint32Array | number[];
  for (let i = 0; i < arr.length; i += 3) {
    const t = arr[i + 1];
    arr[i + 1] = arr[i + 2];
    arr[i + 2] = t;
  }
  idx.needsUpdate = true;
}

function buildCupGeometry(opts: {
  outerPts: THREE.Vector2[];
  heightMm: number;
  wallMm: number;
  baseThicknessMm: number; // inside bottom height
  // Foot ring derived from SVG
  outerBaseR: number;
  innerRecessR: number;
  recessDepthMm: number; // actual recess depth (mm)
  segments?: number;
}): THREE.BufferGeometry {
  const {
    outerPts,
    heightMm,
    wallMm,
    baseThicknessMm,
    outerBaseR,
    innerRecessR,
    recessDepthMm,
  } = opts;
  const segments = opts.segments ?? 220;

  // Outer surface
  const outerGeo = new THREE.LatheGeometry(outerPts, segments);
  outerGeo.computeVertexNormals();

  // Inner surface (offset by wall) starting at inside bottom
  const safeBase = Math.max(2, Math.min(baseThicknessMm, heightMm - 2));
  const innerPts: THREE.Vector2[] = [];

  for (const p of outerPts) {
    if (p.y < safeBase) continue;
    innerPts.push(new THREE.Vector2(Math.max(p.x - wallMm, 0.9), p.y));
  }
  if (innerPts.length < 10) {
    const r0 = Math.max(outerPts[0].x - wallMm, 0.9);
    innerPts.push(new THREE.Vector2(r0, safeBase));
    innerPts.push(new THREE.Vector2(Math.max(outerPts[outerPts.length - 1].x - wallMm, 0.9), heightMm));
  }

  const innerGeo = new THREE.LatheGeometry(innerPts, segments);
  flipWinding(innerGeo);
  innerGeo.computeVertexNormals();

  // Rim ring at top (cap thickness between inner and outer)
  const outerRimR = Math.max(outerPts[outerPts.length - 1].x, 1);
  const innerRimR = Math.max(outerRimR - wallMm, 0.9);

  const rimRing = new THREE.RingGeometry(innerRimR, outerRimR, segments);
  rimRing.rotateX(-Math.PI / 2);
  rimRing.translate(0, heightMm, 0);
  rimRing.computeVertexNormals();

  // --- Recessed foot from SVG detection ---
  const safeOuterBaseR = Math.max(outerBaseR, 2);
  const safeInnerRecessR = Math.max(Math.min(innerRecessR, safeOuterBaseR - 1.2), 2);

  // recess depth cannot exceed inside base height (otherwise it would punch through)
  const safeRecessDepth = Math.max(1, Math.min(recessDepthMm, safeBase - 1));

  // ring that contacts table (annulus at y=0)
  const footRing = new THREE.RingGeometry(safeInnerRecessR, safeOuterBaseR, segments);
  footRing.rotateX(-Math.PI / 2);
  footRing.translate(0, 0, 0);
  footRing.computeVertexNormals();

  // recess wall (cylinder) up to safeRecessDepth
  const recessWall = new THREE.CylinderGeometry(
    safeInnerRecessR,
    safeInnerRecessR,
    safeRecessDepth,
    segments,
    1,
    true
  );
  recessWall.translate(0, safeRecessDepth / 2, 0);
  flipWinding(recessWall);
  recessWall.computeVertexNormals();

  // recess ceiling (disk) at y=safeRecessDepth, facing downward
  const recessCeiling = new THREE.CircleGeometry(safeInnerRecessR, segments);
  recessCeiling.rotateX(-Math.PI / 2);
  recessCeiling.translate(0, safeRecessDepth, 0);
  recessCeiling.computeVertexNormals();

  // inner bottom of cup (disk) at y=safeBase, facing upward (+Y)
  const innerBottomR = Math.max(safeOuterBaseR - wallMm, 1.2);
  const innerBottom = new THREE.CircleGeometry(innerBottomR, segments);
  innerBottom.rotateX(Math.PI / 2);
  innerBottom.translate(0, safeBase, 0);
  innerBottom.computeVertexNormals();

  const merged = mergeGeometries(
    [outerGeo, innerGeo, rimRing, footRing, recessWall, recessCeiling, innerBottom],
    true
  );
  if (!merged) throw new Error("Failed to merge geometries.");

  merged.computeVertexNormals();

  // Center vertically for viewing
  merged.translate(0, -heightMm / 2, 0);

  return merged;
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null);

  const [height, setHeight] = useState(100);
  const [radius, setRadius] = useState(45);
  const [wall, setWall] = useState(4);
  const [baseThickness, setBaseThickness] = useState(6);

  // This slider is now a *multiplier* on what we detect from the SVG
  // (so you can exaggerate or reduce the recess without breaking the match)
  const [footDepthFactor, setFootDepthFactor] = useState(1.0);

  const [svgName, setSvgName] = useState("No file chosen");
  const [profile, setProfile] = useState<ProfilePoint[] | null>(null);
  const [footMeta, setFootMeta] = useState<SvgFootMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  const derived = useMemo(() => {
    if (!profile) return null;
    const { pts, sx, sy } = toLathePointsWithScale(profile, height, radius);

    // If we have SVG foot data, scale it into mm as well
    const outerBaseRmm = footMeta ? footMeta.outerBaseR * sx : pts[0].x;
    const innerRecessRmm = footMeta ? footMeta.innerRecessR * sx : Math.max(outerBaseRmm * 0.78, 2);
    const recessDepthMmSvg = footMeta ? footMeta.recessDepth * sy : Math.max(height * 0.08, 4);

    const recessDepthMm = recessDepthMmSvg * footDepthFactor;

    return { pts, outerBaseRmm, innerRecessRmm, recessDepthMm };
  }, [profile, footMeta, height, radius, footDepthFactor]);

  const meshRef = useRef<THREE.Mesh | null>(null);

  // Init Three.js once
  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const heightPx = mountRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(60, width / heightPx, 0.1, 9000);
    camera.position.set(190, 130, 190);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, heightPx);
    renderer.setPixelRatio(window.devicePixelRatio);

    mountRef.current.innerHTML = "";
    mountRef.current.appendChild(renderer.domElement);

    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(6, 12, 7);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-8, 6, -6);
    scene.add(fill);

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const grid = new THREE.GridHelper(800, 80);
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.update();

    const material = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.65,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

    // initial geometry
    const initialOuter = fallbackOuter(height, radius);
    const initialGeo = buildCupGeometry({
      outerPts: initialOuter,
      heightMm: height,
      wallMm: wall,
      baseThicknessMm: baseThickness,
      outerBaseR: initialOuter[0].x,
      innerRecessR: Math.max(initialOuter[0].x * 0.78, 2),
      recessDepthMm: Math.max(height * 0.08, 5),
      segments: 220,
    });

    const mesh = new THREE.Mesh(initialGeo, material);
    scene.add(mesh);
    meshRef.current = mesh;

    const onResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    let running = true;
    const animate = () => {
      if (!running) return;
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      running = false;
      window.removeEventListener("resize", onResize);
      controls.dispose();
      material.dispose();
      mesh.geometry.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update geometry when parameters change
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const pts = derived?.pts ?? fallbackOuter(height, radius);

    const safeWall = Math.max(0.9, Math.min(wall, Math.max(pts[pts.length - 1].x - 1.6, 0.9)));
    const safeBase = Math.max(2, Math.min(baseThickness, height - 2));

    const outerBaseR = derived?.outerBaseRmm ?? pts[0].x;
    const innerRecessR = derived?.innerRecessRmm ?? Math.max(outerBaseR * 0.78, 2);
    const recessDepthMm = derived?.recessDepthMm ?? Math.max(height * 0.08, 5);

    const newGeo = buildCupGeometry({
      outerPts: pts,
      heightMm: height,
      wallMm: safeWall,
      baseThicknessMm: safeBase,
      outerBaseR,
      innerRecessR,
      recessDepthMm,
      segments: 240,
    });

    mesh.geometry.dispose();
    mesh.geometry = newGeo;
  }, [derived, height, radius, wall, baseThickness]);

  const handleFile = async (file: File) => {
    try {
      setError(null);
      setSvgName(file.name);

      const text = await file.text();
      const d = extractPathD(text);

      const { profile, foot } = sampleOuterProfileAndFootFromPathD(d, 3800);

      const maxX = Math.max(...profile.map((p) => p.x));
      const maxY = Math.max(...profile.map((p) => p.y));
      if (maxX <= 0 || maxY <= 0) throw new Error("SVG path has no usable size.");

      setProfile(profile);
      setFootMeta(foot);
    } catch (e: any) {
      setProfile(null);
      setFootMeta(null);
      setError(e?.message || "Failed to parse SVG.");
    }
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="sticky top-0 z-10 bg-black/80 backdrop-blur border-b border-white/10">
        <div className="max-w-6xl mx-auto p-4 flex flex-col gap-2">
          <h1 className="text-2xl font-bold">Virtual Twin Mug Design</h1>

          <label className="text-sm text-white/80">
            Upload SVG (auto-envelope + SVG-detected dipped foot ring)
          </label>

          <div className="flex items-center gap-3">
            <input
              type="file"
              accept=".svg,image/svg+xml"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            <span className="text-xs text-white/60">{svgName}</span>
            {error && <span className="text-xs text-red-400">Error: {error}</span>}
          </div>

          {footMeta && (
            <div className="text-xs text-white/50">
              Detected foot ring from SVG • outerBaseR≈{footMeta.outerBaseR.toFixed(1)} • innerRecessR≈
              {footMeta.innerRecessR.toFixed(1)} • recessDepth≈{footMeta.recessDepth.toFixed(1)} (SVG units)
            </div>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6 flex flex-col gap-6">
        <div
          ref={mountRef}
          className="w-full h-[640px] rounded-xl overflow-hidden border border-white/10"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <label>Height: {height} mm</label>
            <input
              type="range"
              min="50"
              max="220"
              value={height}
              onChange={(e) => setHeight(+e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label>Radius: {radius} mm</label>
            <input
              type="range"
              min="20"
              max="120"
              value={radius}
              onChange={(e) => setRadius(+e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label>Wall thickness: {wall} mm</label>
            <input
              type="range"
              min="2"
              max="12"
              value={wall}
              onChange={(e) => setWall(+e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label>Base thickness (inside bottom): {baseThickness} mm</label>
            <input
              type="range"
              min="2"
              max="20"
              value={baseThickness}
              onChange={(e) => setBaseThickness(+e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2 md:col-span-2">
            <label>Foot recess depth factor: {footDepthFactor.toFixed(2)}×</label>
            <input
              type="range"
              min="0.5"
              max="1.8"
              step="0.01"
              value={footDepthFactor}
              onChange={(e) => setFootDepthFactor(+e.target.value)}
            />
            <div className="text-xs text-white/60">
              This scales the recess depth detected from your SVG (so you can fine-tune without breaking the shape).
            </div>
          </div>
        </div>

        <p className="text-sm text-white/70">
          Drag to rotate • Scroll to zoom • Foot ring radius is now detected from the SVG (not guessed)
        </p>
      </div>
    </main>
  );
}