import type { Plan, SpeciesParams } from '../types';
import type { SceneManager } from '../render/sceneManager';
import { getTreeTemplate } from '../core/treeGenerator';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { LodGeometry } from '../core/treeGenerator';
import { GLTF2Export } from '@babylonjs/serializers/glTF';
import { CreateScreenshotAsync } from '@babylonjs/core/Misc/screenshotTools';

/**
 * 导出 GLB：把 ThinInstance 数据烘焙成每树种合并的实体网格。
 * 公告板实例烘焙为带 alpha 的十字叶片简化体，保证远景树也在文件里。
 */
export async function exportGLB(sceneManager: SceneManager, plan: Plan, speciesList: SpeciesParams[]): Promise<Blob> {
  const scene = sceneManager.scene;
  const exportMeshes: AbstractMesh[] = [];
  const tmpMaterials: StandardMaterial[] = [];
  const groups = new Map<string, typeof plan.trees>();
  for (const t of plan.trees) {
    const arr = groups.get(t.speciesId);
    if (arr) arr.push(t);
    else groups.set(t.speciesId, [t]);
  }

  for (const [speciesId, trees] of groups) {
    const sp = speciesList.find((s) => s.id === speciesId);
    if (!sp) continue;
    const tpl = getTreeTemplate(sp, scene);
    const showLeaves = plan.season !== 'winter' || !sp.deciduous;

    const barkMat = new StandardMaterial(`exp-bark-${sp.id}`, scene);
    barkMat.diffuseColor = Color3.FromArray(sp.barkColor);
    tmpMaterials.push(barkMat);

    let leafMat: StandardMaterial | null = null;
    if (showLeaves) {
      leafMat = new StandardMaterial(`exp-leaf-${sp.id}`, scene);
      leafMat.diffuseColor = plan.season === 'winter'
        ? Color3.FromArray(sp.leafColors.summer).scale(0.6)
        : Color3.FromArray(sp.leafColors[plan.season]);
      leafMat.backFaceCulling = false;
      tmpMaterials.push(leafMat);
    }

    // 用低模 LOD 导出：3000 棵规模下文件体积可控，鸟瞰/方案评审精度足够
    const branchMesh = mergeInstances(tpl.low.branch, trees, `exp-branch-${sp.id}`, scene);
    branchMesh.material = barkMat;
    exportMeshes.push(branchMesh);

    if (showLeaves) {
      const leafMesh = mergeInstances(tpl.low.leaf, trees, `exp-leaf-${sp.id}`, scene);
      leafMesh.material = leafMat;
      exportMeshes.push(leafMesh);
    }
  }

  try {
    const result = await GLTF2Export.GLBAsync(scene, `${plan.name || 'garden-plan'}`, {
      // 场景含动态风插件，跳过 whenReadyAsync 的无限等待；网格几何数据已在 CPU 侧就绪
      exportWithoutWaitingForScene: true,
      shouldExportNode: (n) => exportMeshes.includes(n as AbstractMesh),
    });
    const glbEntry = Object.entries(result.files).find(([name]) => name.endsWith('.glb'));
    const blob = glbEntry && glbEntry[1] instanceof Blob ? (glbEntry[1] as Blob) : new Blob();
    return blob;
  } finally {
    exportMeshes.forEach((m) => m.dispose());
    tmpMaterials.forEach((m) => m.dispose());
  }
}

/** 把同一 LOD 几何按实例矩阵烘焙合并为单个网格（CPU 侧变换顶点） */
function mergeInstances(geo: LodGeometry, trees: Plan['trees'], name: string, scene: import('@babylonjs/core/scene').Scene): Mesh {
  const n = geo.positions.length / 3;
  const idxCount = geo.indices.length;
  const positions = new Float32Array(n * trees.length * 3);
  const normals = new Float32Array(n * trees.length * 3);
  const uvs = new Float32Array(n * trees.length * 2);
  const indices = new Uint32Array(idxCount * trees.length);

  const m = new Matrix();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const v = Vector3.Zero();
  const nv = Vector3.Zero();

  trees.forEach((t, ti) => {
    p.set(t.x, 0, t.z);
    Quaternion.FromEulerAnglesToRef(0, t.rotation, 0, q);
    s.setAll(t.scale);
    Matrix.ComposeToRef(s, q, p, m);
    const normalMat = m.getRotationMatrix();
    const base = ti * n;
    for (let i = 0; i < n; i++) {
      v.set(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]);
      Vector3.TransformCoordinatesToRef(v, m, v);
      positions[(base + i) * 3] = v.x;
      positions[(base + i) * 3 + 1] = v.y;
      positions[(base + i) * 3 + 2] = v.z;
      nv.set(geo.normals[i * 3], geo.normals[i * 3 + 1], geo.normals[i * 3 + 2]);
      Vector3.TransformNormalToRef(nv, normalMat, nv);
      normals[(base + i) * 3] = nv.x;
      normals[(base + i) * 3 + 1] = nv.y;
      normals[(base + i) * 3 + 2] = nv.z;
      uvs[(base + i) * 2] = geo.uvs[i * 2];
      uvs[(base + i) * 2 + 1] = geo.uvs[i * 2 + 1];
    }
    const offset = base;
    for (let i = 0; i < idxCount; i++) {
      indices[ti * idxCount + i] = geo.indices[i] + offset;
    }
  });

  const mesh = new Mesh(name, scene);
  mesh.setVerticesData('position', positions);
  mesh.setVerticesData('normal', normals);
  mesh.setVerticesData('uv', uvs);
  mesh.setIndices(Array.from(indices));
  return mesh;
}

/** 鸟瞰效果图：临时切到鸟瞰机位截图，再恢复当前视角 */
export async function exportBirdseye(sceneManager: SceneManager): Promise<string> {
  const cam = sceneManager.camera;
  const saved = { alpha: cam.alpha, beta: cam.beta, radius: cam.radius, tx: cam.target.x, ty: cam.target.y, tz: cam.target.z };
  sceneManager.setBirdView();

  // 等若干帧，让阴影/公告板纹理与 LOD 在新机位下稳定
  await waitFrames(sceneManager.scene, 5);
  try {
    const url = await CreateScreenshotAsync(
      sceneManager.engine,
      sceneManager.camera,
      { width: 1920, height: 1080 },
      'image/png',
    );
    return url;
  } finally {
    cam.alpha = saved.alpha;
    cam.beta = saved.beta;
    cam.radius = saved.radius;
    cam.target.set(saved.tx, saved.ty, saved.tz);
  }
}

function waitFrames(scene: import('@babylonjs/core/scene').Scene, count: number): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const obs = scene.onAfterRenderObservable.add(() => {
      n++;
      if (n >= count) {
        scene.onAfterRenderObservable.remove(obs);
        resolve();
      }
    });
  });
}

/** 方案 JSON 导出（含树种，可发给同事直接导入） */
export function planToJSON(plan: Plan, speciesList: SpeciesParams[]): string {
  return JSON.stringify(
    {
      format: 'garden-plan/v1',
      exportedAt: Date.now(),
      species: speciesList,
      plan,
    },
    null,
    2,
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
