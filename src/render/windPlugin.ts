import type { Material } from '@babylonjs/core/Materials/material';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Scene } from '@babylonjs/core/scene';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Nullable } from '@babylonjs/core/types';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

/**
 * 风动画插件：注入 PBR 顶点着色器。
 * 摆动幅度 = 顶点色 alpha（骨架层级：主干≈0，枝梢/叶=1）。
 * 每棵树的相位由世界坐标派生，ThinInstance 渲染时无需额外 instance buffer。
 */
export class WindMaterialPlugin extends MaterialPluginBase {
  private _strength: number;
  private _speed: number;
  private _time = 0;
  private static direction = new Vector3(1, 0, 0.35).normalize();

  constructor(material: Material, initialStrength = 0.3) {
    // 最后一个 enable=true：立即启用并标记 define
    super(material, 'GardenWind', 200, { WIND_ENABLED: false }, true, true);
    this._strength = initialStrength;
    this._speed = 1.4;
  }

  get strength(): number {
    return this._strength;
  }

  set strength(v: number) {
    if (Math.abs(this._strength - v) < 0.0001) {
      this._strength = v;
      return;
    }
    this._strength = v;
    this.markAllDefinesAsDirty();
  }

  override getClassName(): string {
    return 'WindMaterialPlugin';
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, _mesh: AbstractMesh): void {
    defines['WIND_ENABLED'] = this._strength > 0.001;
  }

  override getUniforms() {
    return {
      ubo: [
        { name: 'windStrength', size: 1, type: 'float' },
        { name: 'windSpeed', size: 1, type: 'float' },
        { name: 'windTime', size: 1, type: 'float' },
        { name: 'windDirection', size: 3, type: 'vec3' },
      ],
      fragment: `#ifdef WIND_ENABLED
        uniform float windStrength;
        uniform float windSpeed;
        uniform float windTime;
        uniform vec3 windDirection;
      #endif`,
      vertex: `#ifdef WIND_ENABLED
        uniform float windStrength;
        uniform float windSpeed;
        uniform float windTime;
        uniform vec3 windDirection;
      #endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    uniformBuffer.updateFloat('windStrength', this._strength);
    uniformBuffer.updateFloat('windSpeed', this._speed);
    uniformBuffer.updateFloat('windTime', this._time);
    uniformBuffer.updateFloat3(
      'windDirection',
      WindMaterialPlugin.direction.x,
      WindMaterialPlugin.direction.y,
      WindMaterialPlugin.direction.z,
    );
  }

  /** 每帧由 TreeRenderer 调用，推进风的时间相位 */
  tick(deltaSeconds: number): void {
    this._time += deltaSeconds * this._speed;
  }

  override getCustomCode(shaderType: string): Nullable<{ [pointName: string]: string }> {
    if (shaderType !== 'vertex') return null;
    return {
      // 自定义 attribute：每顶点风层级（0 主干 → 1 枝梢），由几何缓冲提供
      CUSTOM_VERTEX_DEFINITIONS: `
        #ifdef WIND_ENABLED
          attribute float gardenWind;
        #endif
      `,
      // PBR 顶点阶段 worldPos 已算出后注入位移
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `
        #ifdef WIND_ENABLED
        {
          float windLevel = gardenWind;
          vec3 phaseSeed = worldPos.xyz * 0.35;
          float gust = sin(windTime * 1.7 + phaseSeed.x + phaseSeed.z * 0.7);
          float flutter = sin(windTime * 4.3 + phaseSeed.z * 2.1) * 0.35;
          float bend = windStrength * windLevel * (0.55 + 0.45 * (gust + flutter));
          worldPos.xz += windDirection.xz * bend * (0.25 + worldPos.y * 0.06) * windLevel;
          worldPos.y -= windStrength * windLevel * windLevel * 0.08 * abs(gust);
        }
        #endif
      `,
    };
  }
}
