import { store } from '../state/store';
import { h, toast, download } from './dom';
import type { SceneManager } from '../render/sceneManager';
import { exportGLB, exportBirdseye, planToJSON, downloadText } from '../export/exporter';

/** 导出页：GLB 模型 / 鸟瞰效果图 / 方案 JSON（含树种，可发同事） */
export class ExportPage {
  private root = h('div');
  private scene: SceneManager;
  private busy = false;

  constructor(scene: SceneManager) {
    this.scene = scene;
  }

  render(): HTMLElement {
    const plan = store.currentPlan;
    this.root.innerHTML = '';
    if (!plan) {
      this.root.append(h('div', { class: 'empty', text: '请先打开一个方案' }));
      return this.root;
    }

    this.root.append(
      h('div', { class: 'section-title', text: '导出成果' }),

      h('div', { class: 'card' },
        h('div', { class: 'name', style: 'margin-bottom:6px', text: '🎲 三维模型（GLB）' }),
        h('div', { class: 'meta', style: 'line-height:1.7', text: `把当前 ${plan.trees.length} 棵树按当前季节烘焙为标准 glTF 二进制模型，可在 Blender、3ds Max、Unity、Unreal 中打开。` }),
        h('button', {
          class: 'primary',
          style: 'margin-top:10px',
          ...(this.busy ? { disabled: true } : {}),
          text: this.busy ? '正在烘焙，请稍候…' : '导出 GLB',
          onclick: () => this.doExportGLB(),
        }),
      ),

      h('div', { class: 'card' },
        h('div', { class: 'name', style: 'margin-bottom:6px', text: '📷 鸟瞰效果图（PNG）' }),
        h('div', { class: 'meta', style: 'line-height:1.7', text: '自动切到正交感鸟瞰机位渲染 1920×1080 截图，完成后恢复当前视角。' }),
        h('button', {
          class: 'primary',
          style: 'margin-top:10px',
          text: '导出鸟瞰图',
          onclick: () => this.doExportImage(),
        }),
      ),

      h('div', { class: 'card' },
        h('div', { class: 'name', style: 'margin-bottom:6px', text: '📄 方案文件（JSON）' }),
        h('div', { class: 'meta', style: 'line-height:1.7', text: '包含全部树木坐标、区域、场地设置和自定义树种参数。同事在「方案」页导入即可继续编辑，随机种子保证两边树形一致。' }),
        h('button', {
          class: 'primary',
          style: 'margin-top:10px',
          text: '导出方案文件',
          onclick: async () => {
            await store.flush();
            const json = planToJSON(plan, store.species);
            const safe = plan.name.replace(/[\\/:*?"<>|]/g, '_');
            downloadText(json, `${safe}.garden.json`);
            toast('方案文件已导出');
          },
        }),
      ),

      h('div', { class: 'section-title', text: '当前方案概要' }),
      h('div', { class: 'card' },
        h('div', { class: 'meta', style: 'line-height:2; font-size:13px' },
          `方案名称：${plan.name}`,
          h('br'),
          `树木：${plan.trees.length} 棵 · 区域：${plan.regions.length} 个`,
          h('br'),
          `季节：${({ spring: '春', summer: '夏', autumn: '秋', winter: '冬' } as const)[plan.season]}季`,
          h('br'),
          `最后修改：${new Date(plan.updatedAt).toLocaleString('zh-CN')}`,
        ),
      ),
    );
    return this.root;
  }

  private async doExportGLB(): Promise<void> {
    const plan = store.currentPlan;
    if (!plan || this.busy) return;
    this.busy = true;
    this.render();
    try {
      await store.flush();
      const blob = await exportGLB(this.scene, plan, store.species);
      const safe = plan.name.replace(/[\\/:*?"<>|]/g, '_');
      download(`${safe}.glb`, URL.createObjectURL(blob));
      toast(`GLB 已导出（${(blob.size / 1024 / 1024).toFixed(1)} MB）`);
    } catch (e) {
      toast(`GLB 导出失败：${(e as Error).message}`, true, 5000);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async doExportImage(): Promise<void> {
    const plan = store.currentPlan;
    if (!plan) return;
    try {
      toast('正在渲染鸟瞰图…');
      const url = await exportBirdseye(this.scene);
      const safe = plan.name.replace(/[\\/:*?"<>|]/g, '_');
      download(`${safe}-鸟瞰.png`, url);
      toast('鸟瞰图已导出');
    } catch (e) {
      toast(`截图失败：${(e as Error).message}`, true);
    }
  }

  dispose(): void {}
}
