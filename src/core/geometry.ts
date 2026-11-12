import type { TreeInstance, PlantRegion } from '../types';
import { rng, randRange } from './rng';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

/** 点是否在多边形内（射线法，x/z 平面） */
export function pointInPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 多边形面积（鞋带公式，平方米） */
export function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

/**
 * 在多边形区域内按密度（株/100㎡）做抖动网格撒点。
 * 抖动网格比纯随机分布更均匀，结果由 seed 完全确定。
 */
export function scatterInRegion(region: PlantRegion): [number, number][] {
  const area = polygonArea(region.polygon);
  const count = Math.max(1, Math.round((area * region.density) / 100));
  const rand = rng(region.seed);
  const xs = region.polygon.map((p) => p[0]);
  const zs = region.polygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cell = Math.sqrt((area * Math.max(0.1, region.density / 100)) > 0
    ? area / count
    : 1);

  const points: [number, number][] = [];
  const stride = cell;
  for (let gx = minX; gx <= maxX; gx += stride) {
    for (let gz = minZ; gz <= maxZ; gz += stride) {
      const x = gx + randRange(rand, 0, stride);
      const z = gz + randRange(rand, 0, stride);
      if (pointInPolygon(x, z, region.polygon)) points.push([x, z]);
    }
  }
  // 密度修正：过多则确定性抽稀，过少则补充随机点
  if (points.length > count) {
    return points.filter((_, i) => i % Math.ceil(points.length / count) === 0).slice(0, count);
  }
  let guard = 0;
  while (points.length < count && guard++ < count * 60) {
    const x = randRange(rand, minX, maxX);
    const z = randRange(rand, minZ, maxZ);
    if (pointInPolygon(x, z, region.polygon)) points.push([x, z]);
  }
  return points;
}

/** 检测株距不足的树，返回冲突树 id 集合（含冲突双方） */
export function findSpacingConflicts(
  trees: TreeInstance[],
  spacingOf: (speciesId: string) => number,
): Set<string> {
  const conflicts = new Set<string>();
  // 网格分桶，避免 O(n²)；3000 棵也只检查相邻桶
  const cell = 4;
  const buckets = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx}|${cz}`;
  trees.forEach((t, i) => {
    const cx = Math.floor(t.x / cell);
    const cz = Math.floor(t.z / cell);
    const k = key(cx, cz);
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  });

  for (let i = 0; i < trees.length; i++) {
    const a = trees[i];
    const minA = spacingOf(a.speciesId);
    const cx = Math.floor(a.x / cell);
    const cz = Math.floor(a.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = buckets.get(key(cx + dx, cz + dz));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const b = trees[j];
          const minB = spacingOf(b.speciesId);
          const limit = (minA + minB) / 2;
          const ddx = a.x - b.x;
          const ddz = a.z - b.z;
          if (ddx * ddx + ddz * ddz < limit * limit) {
            conflicts.add(a.id);
            conflicts.add(b.id);
          }
        }
      }
    }
  }
  return conflicts;
}

/** 鸟瞰相机定位辅助：场地中心（正方形场地恒为原点） */
export function siteCenter(): Vector3 {
  return new Vector3(0, 0, 0);
}
