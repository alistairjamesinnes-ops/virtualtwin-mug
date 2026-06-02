export type WallDimensions = {
  baseW: number;
  baseD: number;
  cupH: number;
};

export interface WallOptions {
  wallThick?: number;
  wallHeight?: number;
  clipThick?: number;
  clipGrip?: number;
  clipCount?: number;
  clipClearance?: number;
}

type V3 = [number, number, number];
type Triangle = [V3, V3, V3, V3];

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: V3): V3 {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

class STLWriter {
  private tris: Triangle[] = [];

  tri(v0: V3, v1: V3, v2: V3) {
    const n = normalize(cross(sub(v1, v0), sub(v2, v0)));
    this.tris.push([n, v0, v1, v2]);
  }

  quad(v0: V3, v1: V3, v2: V3, v3: V3) {
    this.tri(v0, v1, v2);
    this.tri(v0, v2, v3);
  }

  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number
  ) {
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    const za = Math.min(z0, z1);
    const zb = Math.max(z0, z1);

    // bottom
    this.quad([xa, ya, za], [xb, ya, za], [xb, yb, za], [xa, yb, za]);

    // top
    this.quad([xa, yb, zb], [xb, yb, zb], [xb, ya, zb], [xa, ya, zb]);

    // front
    this.quad([xa, ya, zb], [xb, ya, zb], [xb, ya, za], [xa, ya, za]);

    // back
    this.quad([xb, yb, zb], [xa, yb, zb], [xa, yb, za], [xb, yb, za]);

    // left
    this.quad([xa, yb, zb], [xa, ya, zb], [xa, ya, za], [xa, yb, za]);

    // right
    this.quad([xb, ya, zb], [xb, yb, zb], [xb, yb, za], [xb, ya, za]);
  }

  cylinder(
    cx: number,
    cy: number,
    z0: number,
    z1: number,
    r: number,
    segments = 48
  ) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;

      const p0: V3 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z0];
      const p1: V3 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z0];
      const p2: V3 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z1];
      const p3: V3 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z1];

      this.quad(p0, p1, p2, p3);

      // bottom cap
      this.tri([cx, cy, z0], p1, p0);

      // top cap
      this.tri([cx, cy, z1], p3, p2);
    }
  }

  toUint8Array(): Uint8Array {
    const buf = new ArrayBuffer(84 + this.tris.length * 50);
    const view = new DataView(buf);

    // 80-byte STL header is left blank.
    view.setUint32(80, this.tris.length, true);

    let o = 84;

    for (const [n, v0, v1, v2] of this.tris) {
      view.setFloat32(o, n[0], true);
      o += 4;
      view.setFloat32(o, n[1], true);
      o += 4;
      view.setFloat32(o, n[2], true);
      o += 4;

      view.setFloat32(o, v0[0], true);
      o += 4;
      view.setFloat32(o, v0[1], true);
      o += 4;
      view.setFloat32(o, v0[2], true);
      o += 4;

      view.setFloat32(o, v1[0], true);
      o += 4;
      view.setFloat32(o, v1[1], true);
      o += 4;
      view.setFloat32(o, v1[2], true);
      o += 4;

      view.setFloat32(o, v2[0], true);
      o += 4;
      view.setFloat32(o, v2[1], true);
      o += 4;
      view.setFloat32(o, v2[2], true);
      o += 4;

      // STL attribute byte count.
      view.setUint16(o, 0, true);
      o += 2;
    }

    return new Uint8Array(buf);
  }
}

export function generateMoldWalls(
  dimensions: WallDimensions,
  options: WallOptions = {}
): Uint8Array {
  const {
    baseW,
    baseD,
    cupH,
  } = dimensions;

  const wallThick = options.wallThick ?? 8;
  const wallHeight = options.wallHeight ?? cupH + 25;
  const clipThick = options.clipThick ?? 8;
  const clipGrip = options.clipGrip ?? 12;
  const clipCount = options.clipCount ?? 3;
  const clipClearance = options.clipClearance ?? 0.4;

  const w = new STLWriter();

  const halfW = baseW / 2;
  const halfD = baseD / 2;

  const x0 = -halfW;
  const x1 = halfW;
  const y0 = -halfD;
  const y1 = halfD;

  const z0 = 0;
  const z1 = wallHeight;

  // Front wall
  w.box(
    x0 - wallThick,
    x1 + wallThick,
    y0 - wallThick,
    y0,
    z0,
    z1
  );

  // Back wall
  w.box(
    x0 - wallThick,
    x1 + wallThick,
    y1,
    y1 + wallThick,
    z0,
    z1
  );

  // Left wall
  w.box(
    x0 - wallThick,
    x0,
    y0,
    y1,
    z0,
    z1
  );

  // Right wall
  w.box(
    x1,
    x1 + wallThick,
    y0,
    y1,
    z0,
    z1
  );

  // Bottom slab / mould tray base
  w.box(
    x0 - wallThick,
    x1 + wallThick,
    y0 - wallThick,
    y1 + wallThick,
    -wallThick,
    0
  );

  // Simple external clip lugs on the front and back walls.
  // These are deliberately crude but printable and useful for alignment/clamping.
  const usableW = baseW * 0.75;
  const startX = -usableW / 2;
  const spacing = clipCount > 1 ? usableW / (clipCount - 1) : 0;

  for (let i = 0; i < clipCount; i++) {
    const cx = startX + i * spacing;
    const lugW = clipGrip;
    const lugH = clipGrip;
    const lugZ0 = wallHeight * 0.35;
    const lugZ1 = lugZ0 + lugH;

    // Front lug
    w.box(
      cx - lugW / 2,
      cx + lugW / 2,
      y0 - wallThick - clipThick,
      y0 - wallThick - clipClearance,
      lugZ0,
      lugZ1
    );

    // Back lug
    w.box(
      cx - lugW / 2,
      cx + lugW / 2,
      y1 + wallThick + clipClearance,
      y1 + wallThick + clipThick,
      lugZ0,
      lugZ1
    );
  }

  // Registration pins on one side of the mould tray.
  // These create simple raised cylinders that can be used as alignment features.
  const pinR = 4;
  const pinH = 5;
  const pinZ0 = z1;
  const pinZ1 = z1 + pinH;

  w.cylinder(x0 + baseW * 0.25, y0 - wallThick / 2, pinZ0, pinZ1, pinR);
  w.cylinder(x1 - baseW * 0.25, y0 - wallThick / 2, pinZ0, pinZ1, pinR);

  return w.toUint8Array();
}

export function generateMoldWallPair(
  dimensions: WallDimensions,
  options: WallOptions = {}
): {
  left: Uint8Array;
  right: Uint8Array;
} {
  const left = generateMoldWalls(dimensions, options);
  const right = generateMoldWalls(dimensions, options);

  return { left, right };
}

export { STLWriter };