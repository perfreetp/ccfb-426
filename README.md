# 园林植物配置预览工具

浏览器内的园林种植方案实时预览工具。改种植方案、调树种参数、切季节、拖太阳，全部即时反馈。

## 技术栈

- **TypeScript + Babylon.js 7**（ES 模块按需引入，Vite 构建）
- 纯前端，数据持久化在浏览器 IndexedDB，无需后端

## 启动

```bash
npm install
npm run dev        # 开发
npm run build      # 类型检查 + 生产构建
npm run typecheck  # 仅类型检查
npm run preview    # 预览构建产物
```

## 五大页面

| 页面 | 功能 |
| --- | --- |
| 方案 | 新建 / 复制 / 删除 / 重命名 / 选择，导入同事发来的 `.garden.json` |
| 树种库 | 6 个内置树种 + 自定义树种；分枝角度、冠幅、叶密度、种子等参数化，3D 实时预览 |
| 场地编辑 | 单棵点种、圈多边形区域按密度撒播、擦除、株距冲突红色高亮 |
| 四季预览 | 春夏秋冬切换、风力调节、太阳方位/高度拖拽与实时阴影 |
| 导出 | GLB 模型、1920×1080 鸟瞰 PNG、含树种的方案 JSON |

## 关键设计

### 程序化树（`src/core/treeGenerator.ts`）
- mulberry32 种子化 PRNG，**相同种子 + 相同参数生成完全一致的树**，导出方案给同事两边形态相同。
- 递归骨架：主干 → 多级分枝 → 枝梢叶簇；每树种生成三档资源：
  - **高模**：5 段圆管枝干 + 高密度十字叶片
  - **低模**：3 段圆管，剔除末两级细枝，叶片抽稀 1/3
  - **公告板**：离机渲染高模侧面到 RenderTargetTexture，只渲染一次后复用
- 骨架边数有总量封顶（1400），避免「深度 × 每节枝数」指数爆炸。

### 3000 棵流畅（`src/render/treeRenderer.ts`）
- **ThinInstance GPU 实例化**：每树种每档仅 1 个 draw call，3000 棵稳定在 **60+ FPS、约 17 draw call**。
- LOD 按相机水平距离分档（高模 35m / 低模 75m / 公告板），带 **15% 距离抖动 + 8% 回差**，边界树木不会反复横跳；切档有 0.22s 缩放生长动画过渡。
- 稳态零缓冲重传：静态矩阵预分配进 `Float32Array`，相机不动时不重新上传；公告板仅在相机移动时重建朝向。
- 拾取用独立的不可见代理圆柱（不进渲染管线，零 draw call）。

### 风（`src/render/windPlugin.ts`）
- PBR 材质插件注入顶点着色器，风层级通过自定义 `gardenWind` attribute 逐顶点传递（主干≈0、枝梢/叶=1），按层级弯曲。
- 风强度 0~1 可调，每棵树相位由世界坐标派生，ThinInstance 下无需逐实例缓冲。

### 四季与阴影
- 落叶树冬季隐藏全部叶片与公告板，只剩枝干；常绿树保留暗绿色叶片。
- 定向光正交投影阴影，阴影渲染列表显式维护（地面 + 树木网格，代理与公告板不投影）。

### 数据与导出
- IndexedDB 防抖 0.8s 自动保存。
- 方案 JSON 含全部自定义树种，可跨人导入；树 id 重新分配避免冲突。
- GLB 导出把 ThinInstance 按**低模**烘焙为合并网格（`exportWithoutWaitingForScene` 跳过动态材质的就绪等待）。

## 测试

`scripts/` 下是通过 Chrome DevTools Protocol 驱动真实浏览器的无依赖冒烟测试（需要一个开了 `--remote-debugging-port=9222` 的 Chrome，且 `npm run dev` 在 5247 端口）：

```bash
node scripts/smoke.mjs       # 全流程：5 页签、3000 棵性能、四季、GLB/PNG/JSON 导出
node scripts/diag-ab.mjs     # 阴影/风开关对照性能
node scripts/diag-logic.mjs  # 撒播确定性、株距冲突、方案复制
node scripts/diag-season.mjs # 冬季落叶与太阳联动
```

## 目录结构

```
src/
  core/        随机数、几何工具、默认树种、程序化树生成
  state/       IndexedDB 存储、全局 store（方案/树种/自动保存）
  render/      Babylon 场景、ThinInstance LOD 渲染器、风插件
  export/      GLB / 鸟瞰图 / 方案 JSON 导出
  ui/          五个页面与 DOM 辅助
```
