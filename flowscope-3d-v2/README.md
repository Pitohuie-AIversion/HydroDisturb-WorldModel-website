# FlowScope 3D V2.0

## 打开展示

在 `deliverables/flowscope-offline` 中双击 **Start FlowScope.cmd**。启动器用本机 Python 3 的标准库在回环地址启动 HTTP 服务，并打开默认浏览器。演示期间保留启动窗口。默认端口为 8765，遇到其他程序占用时会尝试相邻端口。复制整个文件夹即可在另一台装有 Python 3 和现代浏览器的电脑上演示。

在工程目录可运行 `python server.py --open`，也可用任意静态 HTTP 服务器提供完整离线目录。打开或重新进入第一章，默认选择「全程 8 秒」。C04 从 **0.00 s / step 1** 自动开始，按顺序放完 81 个真实归档，到 **60.00 s / step 1001** 停下。相邻归档等分回放时长，三维涡面在档间做形态插值，画面用 ≈ 标出档间物理时刻。拖动「归档物理时间」可检查原始涡面，选择「物理 1×」可按真实采样间隔播放。支持 0.5×、2×、4×、暂停和重播。

## 七章操作

第一章会跟随显示器的刷新节拍绘制三维涡面。可在「演示资料」中直接打开 120 FPS 的 8 秒固定视角录像。无 WebGL2 的浏览器会根据解码能力自动选择 120 或 60 FPS 录像。

| 章节 | 可以检查的内容 |
| --- | --- |
| 真实三维尾流 | 旋转 C04 的 Q 等值面，切换到真正的三维体渲染或展向截面，浏览物理时间，比较同帧四场与历史测点。瞬时流线在当前帧速度场上积分。 |
| 3D DC-AE 编码 | 点选 Stem 或各级 S2C，检查输入输出尺寸、通道数与空间重排的格点关系。 |
| 潜空间与 Probe | 点选 2,304 个三维实例之一与右侧 16×16 特征图，切换 RMSNorm，查看真实六维统计、拟能和谱探针说明。支持导入冻结 Encoder 的实际缓存，见 docs/latent.md。 |
| 物理解码 | 分层查看三级 C2S、矢量势 Curl 和压力读出。选择通道，用 C04 真实均值与尺度将假设的归一化读数换算成 m/s 或 Pa。 |
| 双轨时空模型 | 选择五个条件前缀，切换训练和推理，检查历史 K/V 与两条读出路径。 |
| Flow Matching | 跟踪一个示例 Token 的三个分量，逐步检查八次 Euler 更新、四环节 Query 读出、训练直线的速度标签，以及 Shortcut 的教师和学生。 |
| 未来恢复与滚动 | 切换 H=10/50/100，查看移出与写回的步号、目标时刻的真值，导入匹配的实际预测以计算切片误差。见 docs/prediction.md。 |

“自动讲解”按本地普通话旁白驱动章节、固定镜头和章内动画。讲解进度、CFD 的 time_s 和生成时间 τ 各自有明确的控件。右上角可下载当前三维图和进入全屏。“演示资料”内提供 MP4、可编辑 PPTX、SVG、PDF、讲稿及原版 V1.4 透视台。浏览器无法使用 WebGL2 时，第一章自动播放覆盖 0–60 s 的本地 C04 录像，进入七章讲解后切换到配套旁白视频。

## C04 物理数据

源数据在网络存储的 `E:\cfd_3d\05_reports_viz\video_c04_shedding`，本机映射为 `Z:\E\cfd_3d\05_reports_viz\video_c04_shedding`。81 个 NPZ 覆盖 0–60 s，归档间隔不均匀。H 由求解器步号计算。

- 源数组按 `[z_cross,y_span,x]` 排布，导出为 `[Z 展向,Y 横流,X 流向]=[64,96,192]`。对应的四场为 `u, w_cross, v_span, p`，单位分别为 m/s、m/s、m/s 和 Pa。
- 所有帧都有跨越完整三维域的 LOD 2/4 标量资源与 Q 等值面。9 个时刻另存原网格 FP32，包括 835–845 的连续归档段和滚动对照目标。浏览器只加载所需帧、物理量与精度。
- 固定 Q = 0.85 s⁻²，表面按展向涡量着色，范围 −12 至 +12 s⁻¹。四场固定色标、物理坐标、时间、SDF 约定、独立的 solid / valid / derivative 掩码、六维统计及 SHA-256 随数据清单交付。
- 单测点曲线取自各归档帧同一网格位置。曲线连接离散采样点，时间轴采用实际 time_s。

可查看 `public/data/manifest.json` 和 `public/data/verification.json`。在演示包内，对应相对路径为 `data/`。

## 维护与重建

展示站的 `film.html` 默认播放 30 秒的 3840 × 2160 展示短片，可按七章定位、切换中文字幕或下载 MP4。短片和 VTT 在 `public/media`。原版 5 分 33 秒完整配音讲解可从影片页切换，也可直接访问 `film.html?edition=full`。原版逐镜讲稿在 `docs/narration.md`。维护原版分镜时修改 `scripts/film_script.json`，在有普通话 SAPI 语音、Edge、Playwright、FFmpeg 和 FFprobe 的录制机上启动本地展示后运行：

```powershell
python scripts/export_media.py --build "$env:TEMP/flowscope-film" --url http://127.0.0.1:8765/
npm run build
```

前端使用 TypeScript、Vite、Three.js 与 WebGL2。使用 `npm ci` 安装锁定版本的开发依赖，用 `npm run dev` 启动开发页，用 `npm run build` 生成 `deliverables/flowscope-offline`。build 会将同目录四项汇报素材与 docs/narration.md 一起放入成品资料库。播放成品时无需 npm。

更新源数据后，从本目录运行：

```powershell
python scripts/export_volume.py --source 'Z:\E\cfd_3d\05_reports_viz\video_c04_shedding'
python scripts/verify_volume.py --report public/data/verification.json
python scripts/export_wake_transitions.py
python scripts/export_slice_previews.py
python scripts/verify_slice_previews.py
python scripts/export_probe.py 'Z:\E\cfd_3d\05_reports_viz\video_c04_shedding' public/assets/probe.json
python scripts/export_wake_video.py --archive 'Z:\E\cfd_3d\05_reports_viz\video_c04_shedding' --ffmpeg (Get-Command ffmpeg.exe).Source
npm run build
```

体场导出依赖 NumPy、SciPy 和 scikit-image。独立核验脚本使用 NumPy。训练结果由训练环境离线导出；模型章节初始展示的激活与 FM 轨迹均为合成示意。

性能与设计书逐项复核见 [验收记录](docs/design-review.md)。可用 `scripts/benchmark_viewer.py` 记录实际 WebGL 绘制与真实网格换帧，用 `scripts/check_viewer.py --full-tour` 验证整场讲解。中面预览生成和独立像素核验另外使用 Pillow。


