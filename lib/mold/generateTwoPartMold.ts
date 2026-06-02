export type ProfilePoint = {
  x: number;
  y: number;
};

type V3 = [number, number, number];

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
  private tris: [V3, V3, V3, V3][] = [];

  tri(v0: V3, v1: V3, v2: V3) {
    const n = normalize(cross(sub(v1, v0), sub(v2, v0)));
    this.tris.push([n, v0, v1, v2]);
  }

  quad(v0: V3, v1: V3, v2: V3, v3: V3) {
    this.tri(v0, v1, v2);
    this.tri(v0, v2, v3);
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    const za = Math.min(z0, z1);
    const zb = Math.max(z0, z1);

    // Bottom
    this.quad([xa, ya, za], [xb, ya, za], [xb, yb, za], [xa, yb, za]);

    // Top
    this.quad([xa, yb, zb], [xb, yb, zb], [xb, ya, zb], [xa, ya, zb]);

    // Front
    this.quad([xa, ya, zb], [xb, ya, zb], [xb, ya, za], [xa, ya, za]);

    // Back
    this.quad([xb, yb, zb], [xa, yb, zb], [xa, yb, za], [xb, yb, za]);

    // Left
    this.quad([xa, yb, zb], [xa, ya, zb], [xa, ya, za], [xa, yb, za]);

    // Right
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

      // Side wall
      this.quad(p0, p1, p2, p3);

      // Bottom cap
      this.tri([cx, cy, z0], p1, p0);

      // Top cap
      this.tri([cx, cy, z1], p3, p2);
    }
  }

  toUint8Array(): Uint8Array {
    const buf = new ArrayBuffer(84 + this.tris.length * 50);
    const view = new DataView(buf);

    // 80 byte STL header left blank
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

      view.setUint16(o, 0, true);
      o += 2;
    }

    return new Uint8Array(buf);
  }
}

export function generateTwoPartMold(
  input:
    | {
        profile?: ProfilePoint[];
        heightMm?: number;
      }
    | ProfilePoint[],
  maybeHeightMm?: number
): {
  left: Uint8Array;
  right: Uint8Array;
} {
  let profile: ProfilePoint[];
  let heightMm: number;

  // Support both calling styles:
  // generateTwoPartMold({ profile, heightMm })
  // generateTwoPartMold(profile, heightMm)
  if (Array.isArray(input)) {
    profile = input;
    heightMm = maybeHeightMm ?? 100;
  } else {
    profile = input.profile ?? [];
    heightMm = input.heightMm ?? 100;
  }

  // Safety fallback so the worker never dies on profile.map
  if (!profile || profile.length === 0) {
    profile = [
      { x: 35, y: 0 },
      { x: 38, y: 50 },
      { x: 45, y: 100 },
    ];
  }

  const maxR = Math.max(...profile.map((p) => p.x), 40);
  const moldPadding = 18;

  const moldW = heightMm + moldPadding * 2;
  const moldD = maxR + moldPadding * 2;
  const moldH = maxR * 2 + moldPadding * 2;

  const left = new STLWriter();
  const right = new STLWriter();

  // Crude but valid placeholder mould blocks.
  // This is intentionally simple for now:
  //
  // X = cup height direction
  // Y = split direction
  // Z = mould thickness / vertical depth

  left.box(
    -moldW / 2,
    moldW / 2,
    -moldD,
    0,
    -moldH / 2,
    moldH / 2
  );

  right.box(
    -moldW / 2,
    moldW / 2,
    0,
    moldD,
    -moldH / 2,
    moldH / 2
  );

  // Simple registration pins on left half.
  left.cylinder(
    -moldW * 0.3,
    -4,
    moldH * 0.2,
    moldH * 0.2 + 6,
    5
  );

  left.cylinder(
    moldW * 0.3,
    -4,
    -moldH * 0.2,
    -moldH * 0.2 + 6,
    5
  );

  // Matching raised visual socket markers on right half.
  // These are not true cut-out sockets yet. Proper boolean subtraction comes later.
  right.cylinder(
    -moldW * 0.3,
    4,
    moldH * 0.2,
    moldH * 0.2 + 4,
    5.5
  );

  right.cylinder(
    moldW * 0.3,
    4,
    -moldH * 0.2,
    -moldH * 0.2 + 4,
    5.5
  );

  return {
    left: left.toUint8Array(),
    right: right.toUint8Array(),
  };
}