"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { svgPathProperties } from "svg-path-properties";

import { generateTwoPartMold } from "@/lib/mold/generateTwoPartMold";

type ProfilePoint = { x: number; y: number };

type SvgFootMeta = {
  outerBaseR: number;
  innerRecessR: number;
  recessDepth: number;
};

function extractPathD(svgText: string): string {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const paths = Array.from(doc.querySelectorAll("path"));
  if (paths.length === 0) throw new Error("No <path> found in SVG.");
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

function sampleOuterProfileAndFootFromPathD(
  d: string,
  samples = 3500
): { profile: ProfilePoint[]; foot: SvgFootMeta } {
  const props = new svgPathProperties(d);
  const len = props.getTotalLength();

  const raw: ProfilePoint[] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / (samples - 1)) * len;
    const p = props.getPointAtLength(t);
    raw.push({ x: p.x, y: p.y });
  }

  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  const norm = raw.map((p) => ({ x: p.x - minX, y: p.y - minY }));

  const maxY0 = Math.max(...norm.map((p) => p.y));
  const flipped = norm.map((p) => ({ x: p.x, y: maxY0 - p.y }));
  const totalHeight = maxY0;

  const windowSize = Math.max(10, Math.floor(samples * 0.015));
  const smoothDy: number[] = new Array(flipped.length).fill(0);
  for (let i = windowSize; i < flipped.length - windowSize; i++) {
    smoothDy[i] = flipped[i + windowSize].y - flipped[i - windowSize].y;
  }

  const dyThreshold = totalHeight * 0.005;
  let wallStartIdx = 0;
  for (let i = 0; i < flipped.length - windowSize * 2; i++) {
    let avgDy = 0;
    for (let k = 0; k < windowSize; k++) {
      avgDy += smoothDy[Math.min(i + k, flipped.length - 1)];
    }
    avgDy /= windowSize;
    if (avgDy > dyThreshold) {
      wallStartIdx = Math.max(0, i - windowSize);
      break;
    }
  }

  const wallPoints = flipped.slice(wallStartIdx);
  const workingPoints = wallPoints.length >= 20 ? wallPoints : flipped;

  const bins = 520;
  const yMin = Math.min(...workingPoints.map((p) => p.y));
  const yMax = Math.max(...workingPoints.map((p) => p.y));
  const binSize = (yMax - yMin) / (bins - 1);

  const maxXByBin = new Array<number>(bins).fill(-Infinity);
  const innerXByBin = new Array<number>(bins).fill(-Infinity);

  for (const p of workingPoints) {
    const idx = Math.max(0, Math.min(bins - 1, Math.round((p.y - yMin) / binSize)));
    if (p.x > maxXByBin[idx]) maxXByBin[idx] = p.x;
  }

  const xMaxAll = Math.max(...workingPoints.map((p) => p.x));
  for (const p of workingPoints) {
    const idx = Math.max(0, Math.min(bins - 1, Math.round((p.y - yMin) / binSize)));
    const outer = maxXByBin[idx];
    if (!isFinite(outer) || outer <= 0) continue;
    const delta = Math.max(outer * 0.02, xMaxAll * 0.01, 0.5);
    if (p.x < outer - delta && p.x > innerXByBin[idx]) {
      innerXByBin[idx] = p.x;
    }
  }

  let profile: ProfilePoint[] = [];
  for (let i = 0; i < bins; i++) {
    const x = maxXByBin[i];
    if (isFinite(x) && x > 0.1) {
      profile.push({ x: Math.max(x, 0.2), y: yMin + i * binSize });
    }
  }

  const profileYMin = Math.min(...profile.map((p) => p.y));
  profile = profile.map((p) => ({ x: p.x, y: p.y - profileYMin }));
  profile.sort((a, b) => a.y - b.y);

  if (profile.length < 40) throw new Error("Profile extraction produced too few points.");

  const smoothWindow = 3;
  profile = profile.map((p, i) => {
    let sum = 0, count = 0;
    for (let k = -smoothWindow; k <= smoothWindow; k++) {
      const j = i + k;
      if (j >= 0 && j < profile.length) { sum += profile[j].x; count++; }
    }
    return { x: Math.max(sum / count, 0.2), y: p.y };
  });

  const outerBaseR = profile[0].x;
  const scanBins = Math.max(6, Math.floor(bins * 0.18));
  const innerCandidates: number[] = [];
  let recessDepth = 0;

  for (let i = 0; i <= scanBins; i++) {
    const outer = maxXByBin[i];
    const inner = innerXByBin[i];
    if (!isFinite(outer) || !isFinite(inner)) continue;
    const gap = outer - inner;
    if (gap > Math.max(outer * 0.04, 1.0)) {
      innerCandidates.push(inner);
      recessDepth = Math.max(recessDepth, i * binSize);
    }
  }

  const innerRecessR = isFinite(median(innerCandidates))
    ? Math.max(median(innerCandidates), 1.0)
    : Math.max(outerBaseR * 0.75, 2.0);

  recessDepth = Math.max(recessDepth, (yMax - yMin) * 0.04);

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
  baseThicknessMm: number;
  outerBaseR: number;
  innerRecessR: number;
  recessDepthMm: number;
  segments?: number;
}): THREE.BufferGeometry {
  const { outerPts, heightMm, wallMm, baseThicknessMm, outerBaseR, innerRecessR, recessDepthMm } = opts;
  const segments = opts.segments ?? 220;

  const outerGeo = new THREE.LatheGeometry(outerPts, segments);
  outerGeo.computeVertexNormals();

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

  const outerRimR = Math.max(outerPts[outerPts.length - 1].x, 1);
  const innerRimR = Math.max(outerRimR - wallMm, 0.9);
  const rimRing = new THREE.RingGeometry(innerRimR, outerRimR, segments);
  rimRing.rotateX(-Math.PI / 2);
  rimRing.translate(0, heightMm, 0);
  rimRing.computeVertexNormals();

  const safeOuterBaseR = Math.max(outerBaseR, 2);
  const safeInnerRecessR = Math.max(Math.min(innerRecessR, safeOuterBaseR - 1.2), 2);
  const safeRecessDepth = Math.max(1, Math.min(recessDepthMm, safeBase - 1));

  const footRing = new THREE.RingGeometry(safeInnerRecessR, safeOuterBaseR, segments);
  footRing.rotateX(-Math.PI / 2);
  footRing.computeVertexNormals();

  const recessWall = new THREE.CylinderGeometry(safeInnerRecessR, safeInnerRecessR, safeRecessDepth, segments, 1, true);
  recessWall.translate(0, safeRecessDepth / 2, 0);
  flipWinding(recessWall);
  recessWall.computeVertexNormals();

  const recessCeiling = new THREE.CircleGeometry(safeInnerRecessR, segments);
  recessCeiling.rotateX(-Math.PI / 2);
  recessCeiling.translate(0, safeRecessDepth, 0);
  recessCeiling.computeVertexNormals();

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
  merged.translate(0, -heightMm / 2, 0);
  return merged;
}

function downloadSTLFromMesh(mesh: THREE.Mesh, filename: string) {
  const exporter = new STLExporter();
  const stlString = exporter.parse(mesh, { binary: false }) as string;
  const blob = new Blob([stlString], { type: "model/stl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement>(null);

  const [height, setHeight] = useState(100);
  const [radius, setRadius] = useState(45);
  const [wall, setWall] = useState(4);
  const [baseThickness, setBaseThickness] = useState(6);
  const [footDepthFactor, setFootDepthFactor] = useState(1.0);
  const [svgName, setSvgName] = useState("No file chosen");
  const [profile, setProfile] = useState<ProfilePoint[] | null>(null);
  const [footMeta, setFootMeta] = useState<SvgFootMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moldStatus, setMoldStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [moldMessage, setMoldMessage] = useState<string>("");

  const derived = useMemo(() => {
    if (!profile) return null;
    const { pts, sx, sy } = toLathePointsWithScale(profile, height, radius);
    const outerBaseRmm = footMeta ? footMeta.outerBaseR * sx : pts[0].x;
    const innerRecessRmm = footMeta ? footMeta.innerRecessR * sx : Math.max(outerBaseRmm * 0.78, 2);
    const recessDepthMmSvg = footMeta ? footMeta.recessDepth * sy : Math.max(height * 0.08, 4);
    const recessDepthMm = recessDepthMmSvg * footDepthFactor;
    return { pts, outerBaseRmm, innerRecessRmm, recessDepthMm };
  }, [profile, footMeta, height, radius, footDepthFactor]);

  const meshRef = useRef<THREE.Mesh | null>(null);

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
    scene.add(new THREE.GridHelper(800, 80));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.update();
    const material = new THREE.MeshStandardMaterial({
      color: 0xcccccc, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide,
    });
    const initialOuter = fallbackOuter(height, radius);
    const initialGeo = buildCupGeometry({
      outerPts: initialOuter, heightMm: height, wallMm: wall, baseThicknessMm: baseThickness,
      outerBaseR: initialOuter[0].x, innerRecessR: Math.max(initialOuter[0].x * 0.78, 2),
      recessDepthMm: Math.max(height * 0.08, 5), segments: 220,
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
      outerPts: pts, heightMm: height, wallMm: safeWall, baseThicknessMm: safeBase,
      outerBaseR, innerRecessR, recessDepthMm, segments: 240,
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
          <h1 className="text-2xl font-bold">Virtual Twin Mug Design v2</h1>
          <label className="text-sm text-white/80">Upload SVG profile</label>
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
              Detected foot ring • outerBaseR≈{footMeta.outerBaseR.toFixed(1)} • innerRecessR≈
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
            <input type="range" min="50" max="220" value={height} onChange={(e) => setHeight(+e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <label>Radius: {radius} mm</label>
            <input type="range" min="20" max="120" value={radius} onChange={(e) => setRadius(+e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <label>Wall thickness: {wall} mm</label>
            <input type="range" min="2" max="12" value={wall} onChange={(e) => setWall(+e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <label>Base thickness: {baseThickness} mm</label>
            <input type="range" min="2" max="20" value={baseThickness} onChange={(e) => setBaseThickness(+e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 md:col-span-2">
            <label>Foot recess depth factor: {footDepthFactor.toFixed(2)}×</label>
            <input
              type="range" min="0.5" max="1.8" step="0.01"
              value={footDepthFactor} onChange={(e) => setFootDepthFactor(+e.target.value)}
            />
            <div className="text-xs text-white/60">
              Scales the recess depth detected from your SVG.
            </div>
          </div>
        </div>

        <div className="mt-2">
          <button
            className="rounded bg-white text-black px-4 py-2 text-sm font-medium"
            onClick={() => {
              const mesh = meshRef.current;
              if (mesh) downloadSTLFromMesh(mesh, "design_proof.stl");
            }}
          >
            Download Design Proof STL
          </button>
        </div>

        <div className="mt-2">
          <button
            className="rounded bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={!profile || moldStatus === "working"}
            onClick={() => {
              if (!profile) { alert("Upload an SVG first."); return; }
              setMoldStatus("working");
              setMoldMessage("Starting…");
              const worker = new Worker(
                new URL("../lib/mold/moldWorker.ts", import.meta.url)
              );
              worker.onmessage = (e) => {
                if (e.data.status === "progress") {
                  setMoldMessage(e.data.message);
                } else if (e.data.status === "done") {
  setMoldStatus("done");
  setMoldMessage("");
  worker.terminate();

  const download = (base64: string, filename: string) => {
    // Decode base64 string back to binary
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  download(e.data.leftBase64,  "mold_left.stl");
  download(e.data.rightBase64, "mold_right.stl");
                } else if (e.data.status === "error") {
                  setMoldStatus("error");
                  setMoldMessage(e.data.message);
                  worker.terminate();
                }
              };
              const pts = derived?.pts ?? fallbackOuter(height, radius);
              worker.postMessage({
                profile: pts.map((p) => ({ x: p.x, y: p.y })),
                heightMm: height,
              });
            }}
          >
            {moldStatus === "working" ? "Generating…" : "Generate 2-Part Mould"}
          </button>

          {moldStatus === "working" && (
            <div className="text-xs text-white/60 mt-1 animate-pulse">{moldMessage}</div>
          )}
          {moldStatus === "error" && (
            <div className="text-xs text-red-400 mt-1">Error: {moldMessage}</div>
          )}
          {moldStatus === "idle" && (
            <div className="text-xs text-white/60 mt-2">
              Downloads left + right STL halves. Vertical split handles belly, foot undercuts &amp; handles.
            </div>
          )}
        </div>

        <p className="text-sm text-white/70">
          Drag to rotate • Scroll to zoom
        </p>
      </div>
    </main>
  );
}