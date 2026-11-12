import type { Season } from '../types';
import { store } from '../state/store';
import { h, slider, toast } from './dom';
import type { SceneManager } from '../render/sceneManager';

const SEASONS: { key: Season; label: string; ico: string; desc: string }[] = [
  { key: 'spring', label: '春', ico: '🌸', desc: '新叶与花期色' },
  { key: 'summer', label: '夏', ico: '🌳', desc: '浓绿盛叶期' },
  { key: 'autumn', label: '秋', ico: '🍁', desc: '叶色转黄转红' },
  { key: 'winter', label: '冬', ico: '❄', desc: '落叶树只剩枝干' },
];

/** 四季预览页：季节切换、风力调节、太阳方位/高度与阴影 */
export class SeasonPage {
  private root = h('div');
  private scene: SceneManager;

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
      h('div', { class: 'section-title', text: '季节' }),
      h(
        'div',
        { class: 'season-grid' },
        ...SEASONS.map((s) =>
          h('button', {
            class: plan.season === s.key ? 'season-btn active' : 'season-btn',
            onclick: () => {
              store.setSeason(s.key);
              if (s.key === 'winter') toast('落叶树已落叶，常绿树保持暗绿色');
            },
          }, h('span', { class: 'ico', text: s.ico }), h('div', { text: s.label })),
        ),
      ),
      h('div', { class: 'hint', text: SEASONS.find((s) => s.key === plan.season)?.desc }),
    );

    // 风力
    this.root.append(
      h('div', { class: 'section-title', text: '风力' }),
      slider('风强度', plan.site.windStrength, 0, 1, 0.02, (v) => {
        store.updatePlan((p) => (p.site.windStrength = v));
      }, (v) => `${Math.round(v * 100)}%`),
      h('div', { class: 'hint', text: '风在 GPU 顶点着色器中按枝干层级摆动：主干几乎不动，枝梢与叶片摆动最大。' }),
    );

    // 太阳
    this.root.append(
      h('div', { class: 'section-title', text: '太阳与阴影' }),
      slider('方位角', plan.site.sunAzimuth, 0, Math.PI * 2, 0.02, (v) => {
        store.updatePlan((p) => (p.site.sunAzimuth = v));
        this.scene.applySun();
        store.saveSoon();
      }, (v) => `${Math.round((v * 180) / Math.PI)}°`),
      slider('高度角', plan.site.sunElevation, 0.12, Math.PI / 2 - 0.05, 0.02, (v) => {
        store.updatePlan((p) => (p.site.sunElevation = v));
        this.scene.applySun();
        store.saveSoon();
      }, (v) => `${Math.round((v * 180) / Math.PI)}°`),
      h('div', { class: 'hint', text: '也可以直接在场景中拖动金色太阳球，实时观察投影方向与长度变化。' }),
      h('button', {
        style: 'width:100%',
        text: '恢复默认光照',
        onclick: () => {
          store.updatePlan((p) => {
            p.site.sunAzimuth = 0.8;
            p.site.sunElevation = 0.9;
          });
          this.scene.applySun();
        },
      }),
    );

    // 季节下的树种状态说明
    const deciduous = store.species.filter((s) => s.deciduous).length;
    const evergreen = store.species.length - deciduous;
    this.root.append(
      h('div', { class: 'section-title', text: '树种物候' }),
      h('div', { class: 'card' },
        h('div', { class: 'meta', style: 'line-height:2; font-size:13px' },
          `落叶树 ${deciduous} 种：冬季隐藏全部叶片，仅保留枝干骨架`,
          h('br'),
          `常绿树 ${evergreen} 种：冬季保留叶片，颜色压暗`,
          h('br'),
          '切换季节时实例位置与数量不变，仅替换叶色与叶片显隐',
        ),
      ),
    );
    return this.root;
  }

  dispose(): void {}
}
