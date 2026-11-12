import type { SpeciesParams } from '../types';
import { rng, hashSeed } from './rng';
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color4, Color3 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';

/** 单档 LOD 的几何数据（单位树，根部在原点，高度≈species.height） */
export interface LodGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  uvs: Float32Array;
  /** 顶点色 rgb=明暗变化，a 保留 */
  colors: Float32Array;
  /** 每顶点风层级（0 主干 → 1 枝梢），自定义 attribute */
  wind: Float32Array;
}

export interface TreeTemplate {
  speciesId: string;
  height: number;
  crownWidth: number;
  high: { branch: LodGeometry; leaf: LodGeometry };
  low: { branch: LodGeometry; leaf: LodGeometry };
  /** 公告板在场景中实际使用的尺寸（米） */
  billboardWidth: number;
  billboardHeight: number;
  billboardTexture: RenderTargetTexture;
}

interface SkeletonEdge {
  from: Vector3;
  to: Vector3;
  radius: number;
  level: number;
}

interface LeafCluster {
  pos: Vector3;
  yaw: number;
  size: number;
  shade: number;
}

interface Skeleton {
  edges: SkeletonEdge[];
  leaves: LeafCluster[];
  maxLevel: number;
  height: number;
  crownWidth: number;
}

/** 几何构建器：累加 position/normal/uv/color/索引 */
class GeoBuilder {
  positions: number[] = [];
  normals: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  wind: number[] = [];

  vertex(p: Vector3, n: Vector3, uv: [number, number], c: Color4, windLevel: number): number {
    const idx = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(uv[0], uv[1]);
    this.colors.push(c.r, c.g, c.b, c.a);
    // 独立的风层级缓冲（每顶点 1 分量），与 position 顶点一一对应
    this.wind.push(windLevel);
    return idx;
  }

  build(): LodGeometry {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      indices: Uint32Array.from(this.indices),
      uvs: Float32Array.from(this.uvs),
      colors: Float32Array.from(this.colors),
      wind: Float32Array.from(this.wind),
    };
  }
}

/** 递归生成树骨架，所有随机数来自种子化 PRNG，结果可复现 */
function buildSkeleton(sp: SpeciesParams): Skeleton {
  const rand = rng(sp.seed);
  const edges: SkeletonEdge[] = [];
  const tips: { pos: Vector3; level: number }[] = [];
  const maxLevel = sp.branchDepth;
  // 枝条总量封顶：避免 深度×每节枝数 指数爆炸（黑松默认参数可达 10 万+ 顶点）
  const EDGE_BUDGET = 1400;

  const trunkLen = sp.height * 0.26;
  const baseRadius = sp.height * 0.035;
  const crownRatio = sp.crownWidth / sp.height;

  const grow = (from: Vector3, dir: Vector3, len: number, radius: number, level: number) => {
    const to = from.add(dir.scale(len));
    edges.push({ from, to, radius, level });
    if (level >= maxLevel) {
      tips.push({ pos: to, level });
      return;
    }
    // 预算耗尽后深层只走顶芽，保证树形高度但不再横向扩张
    const overBudget = edges.length > EDGE_BUDGET;
    const n = overBudget ? 1 : sp.branchesPerNode;
    const baseAz = rand() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const az = baseAz + (k / n) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const ang = sp.branchAngle * (0.75 + rand() * 0.5);
      // 绕 Y 方位 + 相对父方向俯仰，构造子枝方向
      const horiz = Math.sin(ang);
      const vert = Math.cos(ang);
      const childDir = new Vector3(
        Math.cos(az) * horiz,
        vert,
        Math.sin(az) * horiz,
      );
      // 与父方向混合，避免枝条完全水平
      const blended = dir.scale(0.25).add(childDir.scale(0.75)).normalize();
      const childLen = len * (0.66 + rand() * 0.14) * (1 + crownRatio * 0.12);
      grow(to, blended, childLen, radius * 0.62, level + 1);
    }
    // 顶芽继续向上（保证高度）
    if (level === 0 || rand() < 0.35) {
      const up = dir.scale(0.85).add(new Vector3((rand() - 0.5) * 0.1, 0.3, (rand() - 0.5) * 0.1)).normalize();
      grow(to, up, len * (0.72 + rand() * 0.1), radius * 0.6, level + 1);
    }
  };

  grow(Vector3.Zero(), Vector3.Up(), trunkLen, baseRadius, 0);

  // 叶簇：枝梢 + 末两级枝条上的附生点，数量由叶密度决定
  const targetLeaves = Math.round(24 + sp.leafDensity * 150);
  const leaves: LeafCluster[] = [];
  const terminal = edges.filter((e) => e.level >= maxLevel - 1);
  for (let i = 0; i < targetLeaves; i++) {
    const e = terminal[Math.floor(rand() * terminal.length)] ?? edges[edges.length - 1];
    const t = rand();
    const pos = e.from.scale(1 - t).add(e.to.scale(t));
    pos.x += (rand() - 0.5) * sp.crownWidth * 0.18;
    pos.z += (rand() - 0.5) * sp.crownWidth * 0.18;
    pos.y += (rand() - 0.5) * sp.height * 0.04;
    leaves.push({
      pos,
      yaw: rand() * Math.PI,
      size: sp.crownWidth * (0.1 + rand() * 0.08),
      shade: 0.82 + rand() * 0.36,
    });
  }

  return { edges, leaves, maxLevel, height: sp.height, crownWidth: sp.crownWidth };
}

/** 把骨架边烘焙成渐细圆管网格（radialSegments 决定档位；lowPoly 时跳过最细枝条） */
function buildBranchGeometry(sk: Skeleton, radialSegments: number, lowPoly = false): LodGeometry {
  const b = new GeoBuilder();
  const tmp: Vector3[] = [];
  for (let i = 0; i < radialSegments; i++) tmp.push(new Vector3());

  for (const e of sk.edges) {
    // 低模：剔除末级细枝，由叶簇覆盖视觉，面数大幅下降
    if (lowPoly && e.level >= sk.maxLevel - 1) continue;
    const axis = e.to.subtract(e.from);
    const len = axis.length();
    const dir = axis.scale(1 / len);
    // 构造垂直于 dir 的基
    const ref = Math.abs(dir.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const n1 = Vector3.Cross(dir, ref).normalize();
    const n2 = Vector3.Cross(dir, n1).normalize();
    const start = b.positions.length / 3;
    const levelFactor = e.level / sk.maxLevel;
    // 风层级：主干 0.08，枝梢趋近 1
    const windLevel = 0.08 + levelFactor * 0.92;

    for (let ring = 0; ring < 2; ring++) {
      const center = ring === 0 ? e.from : e.to;
      const r = ring === 0 ? e.radius : e.radius * 0.62;
      for (let i = 0; i < radialSegments; i++) {
        const a = (i / radialSegments) * Math.PI * 2;
        const normal = n1.scale(Math.cos(a)).add(n2.scale(Math.sin(a))).normalize();
        const p = center.add(normal.scale(r));
        const barkShade = 0.9 + ((i + e.level) % 3) * 0.05;
        b.vertex(
          p,
          normal,
          [i / radialSegments, ring],
          new Color4(barkShade, barkShade, barkShade, 1),
          windLevel,
        );
      }
    }
    for (let i = 0; i < radialSegments; i++) {
      const a = start + i;
      const c = start + ((i + 1) % radialSegments);
      const d = start + radialSegments + ((i + 1) % radialSegments);
      const bb = start + radialSegments + i;
      b.indices.push(a, bb, c, c, bb, d);
    }
  }
  return b.build();
}

/** 叶簇烘焙为十字双面片，UV 对应程序化叶片贴图 */
function buildLeafGeometry(sk: Skeleton, stride: number): LodGeometry {
  const b = new GeoBuilder();
  const clusters = stride === 1 ? sk.leaves : sk.leaves.filter((_, i) => i % stride === 0);
  const up = Vector3.Up();

  for (const cl of clusters) {
    const half = cl.size / 2;
    const yawM = Matrix.RotationAxis(up, cl.yaw);
    const yawM2 = Matrix.RotationAxis(up, cl.yaw + Math.PI / 2);
    const c = new Color4(cl.shade, cl.shade, cl.shade, 1); // a=1：完全受风
    for (const m of [yawM, yawM2]) {
      const corners = [
        new Vector3(-half, -half, 0),
        new Vector3(half, -half, 0),
        new Vector3(half, half, 0),
        new Vector3(-half, half, 0),
      ].map((v) => Vector3.TransformCoordinates(v, m).add(cl.pos));
      const normal = Vector3.TransformNormal(new Vector3(0, 0, 1), m);
      const base = b.positions.length / 3;
      const uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
      corners.forEach((p, i) => b.vertex(p, normal, uvs[i], c, 1));
      b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return b.build();
}

/** 程序化叶片 alpha 贴图（椭圆叶形，白色不透明像素） */
export function createLeafTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('leaf-alpha', { width: 128, height: 128 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.moveTo(64, 8);
  ctx.bezierCurveTo(112, 34, 112, 94, 64, 120);
  ctx.bezierCurveTo(16, 94, 16, 34, 64, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(64, 12);
  ctx.lineTo(64, 116);
  ctx.stroke();
  tex.update(false);
  tex.hasAlpha = true;
  return tex;
}

/**
 * 生成一个树种的三档模板（高模 / 低模 / 公告板）。
 * 同参数重复调用返回缓存；参数变化时由 key 变化触发重建。
 */
const templateCache = new Map<string, TreeTemplate>();

export function templateKey(sp: SpeciesParams): string {
  return [
    sp.id, sp.seed, sp.height, sp.crownWidth, sp.branchDepth, sp.branchAngle,
    sp.branchesPerNode, sp.leafDensity, sp.deciduous,
  ].join('|');
}

export function getTreeTemplate(sp: SpeciesParams, scene: Scene): TreeTemplate {
  const key = templateKey(sp);
  const cached = templateCache.get(key);
  if (cached) return cached;

  const sk = buildSkeleton(sp);
  const highBranch = buildBranchGeometry(sk, 5);
  const lowBranch = buildBranchGeometry(sk, 3, true);
  const highLeaf = buildLeafGeometry(sk, 1);
  const lowLeaf = buildLeafGeometry(sk, 3);

  // 公告板：离机渲染高模侧面到 RTT
  const rttSize = 256;
  const rtt = new RenderTargetTexture(`bb-${sp.id}`, rttSize, scene, {
    generateMipMaps: true,
    type: Constants.TEXTURETYPE_UNSIGNED_BYTE,
    format: Constants.TEXTUREFORMAT_RGBA,
  });
  rtt.clearColor = new Color4(0, 0, 0, 0);
  rtt.hasAlpha = true;
  // 静态纹理：只在首帧渲染一次，之后复用，避免每帧额外 draw call
  rtt.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;

  const tempMeshes = buildTempMeshes(sp, sk, scene);
  for (const m of tempMeshes) {
    rtt.renderList?.push(m);
    m.setEnabled(false); // 不进主画布
  }
  const sideCam = new FreeCamera(
    `bb-cam-${sp.id}`,
    new Vector3(-sp.height * 1.35, sp.height * 0.5, sp.height * 0.4),
    scene,
  );
  sideCam.setTarget(new Vector3(0, sp.height * 0.45, 0));
  sideCam.viewport = new Viewport(0, 0, 1, 1);
  sideCam.fov = 0.7;
  rtt.activeCamera = sideCam;
  rtt.onBeforeRenderObservable.add(() => {
    tempMeshes.forEach((m) => m.setEnabled(true));
  });
  rtt.onAfterRenderObservable.add(() => {
    tempMeshes.forEach((m) => m.setEnabled(false));
  });
  // shader 编译需要几帧；渲染 5 帧后脱离自动渲染循环并释放临时资源
  let frames = 0;
  const stop = () => {
    const idx = scene.customRenderTargets.indexOf(rtt);
    if (idx >= 0) scene.customRenderTargets.splice(idx, 1);
    sideCam.dispose();
    tempMeshes.forEach((m) => m.dispose());
    rtt.renderList = [];
    rtt.onBeforeRenderObservable.clear();
    rtt.onAfterRenderObservable.clear();
  };
  scene.customRenderTargets.push(rtt);
  const obs = scene.onAfterRenderObservable.add(() => {
    frames++;
    if (frames >= 5) {
      scene.onAfterRenderObservable.remove(obs);
      stop();
    }
  });

  const tpl: TreeTemplate = {
    speciesId: sp.id,
    height: sk.height,
    crownWidth: sk.crownWidth,
    high: { branch: highBranch, leaf: highLeaf },
    low: { branch: lowBranch, leaf: lowLeaf },
    billboardWidth: sp.crownWidth * 1.25,
    billboardHeight: sp.height * 0.95,
    billboardTexture: rtt,
  };
  templateCache.set(key, tpl);
  return tpl;
}

/** 释放模板的 GPU 纹理（几何是纯数据，随 GC 回收） */
export function disposeTemplate(tpl: TreeTemplate): void {
  tpl.billboardTexture.dispose();
  templateCache.forEach((v, k) => {
    if (v === tpl) templateCache.delete(k);
  });
}

/** 公告板离机渲染用的临时实体网格 */
function buildTempMeshes(sp: SpeciesParams, sk: Skeleton, scene: Scene): AbstractMesh[] {
  const branchGeo = buildBranchGeometry(sk, 5);
  const leafGeo = buildLeafGeometry(sk, 1);
  const out: AbstractMesh[] = [];

  const branchMesh = new Mesh(`tmp-branch-${sp.id}`, scene);
  applyGeo(branchMesh, branchGeo);
  const bm = new StandardMaterial(`tmp-bm-${sp.id}`, scene);
  bm.diffuseColor = Color3.FromArray(sp.barkColor);
  bm.specularColor = new Color3(0.05, 0.05, 0.05);
  branchMesh.material = bm;
  out.push(branchMesh);

  const leafMesh = new Mesh(`tmp-leaf-${sp.id}`, scene);
  applyGeo(leafMesh, leafGeo);
  const lm = new StandardMaterial(`tmp-lm-${sp.id}`, scene);
  lm.diffuseColor = Color3.FromArray(sp.leafColors.summer);
  lm.specularColor = new Color3(0.1, 0.15, 0.1);
  lm.backFaceCulling = false;
  leafMesh.material = lm;
  out.push(leafMesh);
  return out;
}

function applyGeo(mesh: Mesh, geo: LodGeometry): void {
  mesh.setVerticesData('position', geo.positions);
  mesh.setVerticesData('normal', geo.normals);
  mesh.setVerticesData('uv', geo.uvs);
  mesh.setVerticesData('color', geo.colors);
  mesh.setIndices(Array.from(geo.indices));
}

/** 树种参数 hash，用于判断是否需要重建场景实例 */
export function speciesHash(sp: SpeciesParams): number {
  return hashSeed(templateKey(sp));
}
