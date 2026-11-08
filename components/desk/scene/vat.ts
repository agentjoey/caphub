// Adapted from paper-crumple-demo, MIT, Toi Nagasawa / ITEM Inc. See THIRD_PARTY_NOTICES.md.
import * as T from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
export type VAT = Awaited<ReturnType<typeof decode>>;
let cached: Promise<VAT> | undefined;
export function loadVAT() {
  return (cached ??= decode().catch((e) => {
    cached = undefined;
    throw e;
  }));
}
async function decode() {
  const [group, texture] = await Promise.all([
    new FBXLoader().loadAsync("/vat/geo/vertex_animation_textures1_mesh.fbx"),
    new EXRLoader().setDataType(T.FloatType).loadAsync("/vat/tex/vertex_animation_textures1_pos.exr")
  ]);
  const meshes: T.Mesh[] = [];
  group.traverse((o) => {
    if (o instanceof T.Mesh) meshes.push(o);
  });
  const geo = meshes[0]?.geometry;
  if (!geo) throw new Error("Missing VAT mesh");
  const rest = geo.getAttribute("position"),
    uv = geo.getAttribute("uv"),
    lookup = geo.getAttribute("uv1") ?? geo.getAttribute("uv2");
  if (!lookup) throw new Error("Missing VAT point lookup");
  const { data, width, height } = texture.image;
  if (!data) throw new Error("Missing VAT texture data");
  const channels = data.length / (width * height);
  // Compact away the six placeholder vertices, including their UVs and bounds contribution.
  const vertices = Array.from({ length: rest.count }, (_, i) => i).filter(
    (i) => lookup.getX(i) !== 0 || lookup.getY(i) !== 0
  );
  const remap = new Map(vertices.map((v, i) => [v, i]));
  const indices: number[] = [];
  const index = geo.getIndex();
  const original = index ? Array.from(index.array) : Array.from({ length: rest.count }, (_, i) => i);
  for (let i = 0; i < original.length; i += 3) {
    const tri = original.slice(i, i + 3).map((v) => remap.get(v));
    if (tri.every((v) => v !== undefined)) indices.push(...(tri as number[]));
  }
  const ids = vertices.map(
    (v) => Math.floor((1 - lookup.getY(v)) * height) * width + Math.floor(lookup.getX(v) * width)
  );
  const pointCount = Math.max(...ids) + 1,
    rows = Math.ceil(pointCount / width),
    vertexCount = vertices.length,
    stride = vertexCount * 3;
  const raw = new Float32Array(stride * 50),
    uvs = new Float32Array(vertexCount * 2);
  vertices.forEach((v, i) => {
    uvs[i * 2] = uv.getX(v);
    uvs[i * 2 + 1] = uv.getY(v);
  });
  for (let f = 0; f < 50; f++)
    vertices.forEach((v, i) => {
      const id = ids[i],
        row = 50 * rows - 1 - (f * rows + Math.floor(id / width)),
        pixel = (row * width + (id % width)) * channels,
        offset = f * stride + i * 3;
      raw[offset] = rest.getX(v) - Number(data[pixel]);
      raw[offset + 1] = rest.getY(v) + Number(data[pixel + 1]);
      raw[offset + 2] = rest.getZ(v) + Number(data[pixel + 2]);
    });
  const deltas = Array.from({ length: 49 }, (_, f) => {
    let max = 0;
    for (let i = 0; i < stride; i++)
      max = Math.max(max, Math.abs(raw[f * stride + i] - raw[(f + 1) * stride + i]));
    return max;
  });
  const start = Math.max(
    0,
    deltas.findIndex((d) => d > 1e-4)
  );
  let last = 48;
  while (last > start && deltas[last] <= 1e-4) last--;
  const frameCount = last + 2 - start,
    positions = raw.slice(start * stride, (last + 2) * stride),
    normals = new Float32Array(positions.length);
  const pointNormals = new Float32Array(pointCount * 3),
    a = new T.Vector3(),
    b = new T.Vector3(),
    c = new T.Vector3();
  for (let f = 0; f < frameCount; f++) {
    pointNormals.fill(0);
    const offset = f * stride;
    for (let i = 0; i < indices.length; i += 3) {
      a.fromArray(positions, offset + indices[i] * 3);
      b.fromArray(positions, offset + indices[i + 1] * 3).sub(a);
      c.fromArray(positions, offset + indices[i + 2] * 3).sub(a);
      b.cross(c);
      for (const v of indices.slice(i, i + 3)) {
        const p = ids[v] * 3;
        pointNormals[p] += b.x;
        pointNormals[p + 1] += b.y;
        pointNormals[p + 2] += b.z;
      }
    }
    ids.forEach((id, i) => {
      a.fromArray(pointNormals, id * 3).normalize();
      a.toArray(normals, offset + i * 3);
    });
  }
  const flatBox = new T.Box3();
  for (let i = 0; i < vertexCount; i++) flatBox.expandByPoint(a.fromArray(positions, i * 3));
  const flat = {
    width: flatBox.max.x - flatBox.min.x,
    depth: flatBox.max.z - flatBox.min.z,
    center: flatBox.getCenter(new T.Vector3())
  };
  const center = new T.Vector3();
  for (let i = 0; i < vertexCount; i++) center.add(a.fromArray(positions, (frameCount - 1) * stride + i * 3));
  center.divideScalar(vertexCount);
  const distances = ids
    .map((_, i) => a.fromArray(positions, (frameCount - 1) * stride + i * 3).distanceTo(center))
    .sort((a, b) => a - b);
  texture.dispose();
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  }
  return {
    vertexCount,
    frameCount,
    positions,
    normals,
    indices,
    uvs,
    flat,
    crumple: { center, radius: distances[Math.floor(distances.length * 0.9)] }
  };
}
export function makeGeometry(vat: VAT) {
  const geo = new T.BufferGeometry();
  geo.setIndex(vat.indices);
  geo.setAttribute("uv", new T.BufferAttribute(vat.uvs, 2));
  geo.setAttribute("position", new T.BufferAttribute(new Float32Array(vat.vertexCount * 3), 3));
  geo.setAttribute("normal", new T.BufferAttribute(new Float32Array(vat.vertexCount * 3), 3));
  return geo;
}
export function setFrame(geo: T.BufferGeometry, vat: VAT, frame: number) {
  const clamped = T.MathUtils.clamp(frame, 0, vat.frameCount - 1),
    f = Math.floor(clamped),
    next = Math.min(f + 1, vat.frameCount - 1),
    t = clamped - f,
    stride = vat.vertexCount * 3;
  // Recenter each frame so rotation/physics and open pose share the same origin.
  const center = vat.flat.center.clone().lerp(vat.crumple.center, clamped / (vat.frameCount - 1));
  for (const [name, data] of [
    ["position", vat.positions],
    ["normal", vat.normals]
  ] as const) {
    const attr = geo.getAttribute(name) as T.BufferAttribute;
    for (let i = 0; i < stride; i++)
      attr.array[i] =
        data[f * stride + i] * (1 - t) +
        data[next * stride + i] * t -
        (name === "position" ? center.getComponent(i % 3) : 0);
    attr.needsUpdate = true;
  }
  geo.computeBoundingSphere();
}
