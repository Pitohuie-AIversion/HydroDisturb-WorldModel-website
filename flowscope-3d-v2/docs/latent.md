# 导入真实潜空间

在冻结 Encoder 的评估模式下，用与训练一致的四场归一化和几何输入运行 C04 一帧。在推理端保存同次运行得到的 `z_clean` 及其身份字段。以下片段假定 `z_clean` 已转成 CPU NumPy 数组，`frame` 来自对应的 C04 manifest，`encoder_sha256` 来自加载的 checkpoint。

```python
np.savez(
    "encoder_cache.npz",
    z_clean=z_clean,  # CPU NumPy 数组，形状 (256, 8, 12, 24)
    step=frame["step"],
    time_s=frame["time_s"],
    source_sha256=frame["source_sha256"],
    checkpoint_sha256=encoder_sha256,
    training_noise=False,
    rmsnorm="per_token_no_affine",
)
```

RMSNorm 消融输出采用 `rmsnorm="off_ablation"`。通道在第一轴，后三轴依次为展向、横流和流向。训练端存在批次或时间轴时，应显式选出目标样本和时刻再导出。

```powershell
python scripts/export_latent.py --cache encoder_cache.npz --checkpoint frozen.pt --out encoder_cache.fslat
```

在第三章选择「导入已训练 z_clean 缓存」。页面验证 C04 来源和时间、checkpoint 身份字段、形状、无训练噪声标记，以及整个 FP32 数据区的 SHA-256。导入后，单 Token 的 16×16 特征图及空间实例颜色直接取自缓存。点击「恢复合成潜空间」返回结构演示。

单文件容器由八字节签名 `FSLAT2\r\n`、四字节 little-endian JSON 长度、用空格对齐到四字节的 UTF-8 JSON 头和 589,824 个 little-endian FP32 标量组成。每个元素的线性偏移为 `((c * 8 + z) * 12 + y) * 24 + x`。旁路 b 使用归档中同一 C04 帧的独立物理统计。
