export const chapters = [
  {
    id: 'wake', name: '真实三维尾流', en: 'Cylinder wake', rail: 'CFD / C04',
    subtitle: '跟随 C04 的 81 个归档时刻，观察涡从圆柱两侧脱落并向下游移动。',
    panel: '流场探查', hint: '拖动旋转 · 滚轮缩放'
  },
  {
    id: 'encoder', name: '3D DC-AE 编码', en: 'Spatial encoder', rail: 'DC-AE / S2C',
    subtitle: '选择一层，追踪三维体素如何映射到更粗的空间网格。',
    panel:'编码层检查', hint:'点选网格 · 拖动旋转',
    input:'X̃ ⊕ G', trace:['6 × 64 × 96 × 192','3 × S2C','256 × 8 × 12 × 24'],
    note:'归一化的四个物理通道与两个几何通道组成输入。每次 S2C 将各轴相邻的 2 × 2 × 2 个位置重排到通道维。',
    reference:'V1.2 · Stage 1', keyword:'空间压缩', next:'RMSNorm → z_clean'
  },
  {
    id:'latent', name:'潜空间与 Probe', en:'Latent explorer', rail:'8 × 12 × 24',
    subtitle:'点选一个空间 Token，检查它的 256 维向量、RMSNorm 和物理探针。',
    panel:'Token 透视台', hint:'点选 Token · 拖动旋转',
    input:'z_raw',trace:['8 × 12 × 24','2,304 个位置','每位置 D = 256'],
    note:'网格保留 Z、Y、X 的位置关系。Enstrophy 与 Spectrum Probe 用于检验表示是否保留涡量与谱信息，六维统计 b 独立保存。',
    reference:'V1.4 · Latent Explorer', keyword:'表征与探针', next:'z_clean ⊕ b'
  },
  {
    id:'decoder', name:'物理解码', en:'Physical readout', rail:'C2S / CURL',
    subtitle:'逐层展开潜变量，检查矢量势、压力读出、统计旁路和边界掩码。',
    panel:'解码路径', hint:'拖动旋转 · 勾选计算图层',
    input:'z_clean',trace:['3 × C2S','A → Curl(A)','u, v, w, p'],
    note:'相容离散 Curl 将三维矢量势映射为速度脉动。解码器独立读出压力，再用配对的 b 还原物理量；有效差分模板决定导数可评估的区域。',
    reference:'V1.2 · Stage 1',keyword:'物理读出',next:'恢复物理单位'
  },
  {
    id:'temporal',name:'双轨时空模型',en:'Causal transformer',rail:'CLEAN / QUERY',
    subtitle:'切换训练与推理，查看四帧历史、五个条件槽和 Query 的因果连接。',
    panel:'条件与双轨',hint:'点选条件槽 · 拖动旋转',
    input:'zₜ₋₃ … zₜ',trace:['L = 4','Clean K / V','Query → 速度头'],
    note:'每帧有五个条件前缀。Clean 轨提供历史 K/V，Query 读取历史并处理当前生成状态。未来统计头从 Clean 历史取值。',
    reference:'V1.2 · Stage 2',keyword:'时序条件',next:'vθ(zτ, τ | 历史)'
  },
  {
    id:'fm',name:'Flow Matching',en:'Flow matching',rail:'τ / K = 1',
    subtitle:'固定同一组历史条件，跟随一个 Token 走完八步积分，观察每次重算的速度怎样改变下一步落点。',
    panel:'单步推演',hint:'拖动旋转 · 点选积分节点',
    input:'zτ',trace:['Query / Transformer','vθ','zτ + Δτ · vθ'],
    note:'生成时间 τ 在一个物理步内部从 0 到 1。更新 zτ 后，下一步重新计算 Query 和速度；当前轨迹为结构示意。',
    reference:'V1.2 · Stage 2',keyword:'单速度头',next:'ẑₜ₊₁ 与 b̂ₜ₊₁'
  },
  {
    id:'rollout',name:'未来恢复与滚动',en:'Autoregressive rollout',rail:'FIFO / HORIZON',
    subtitle:'跟踪同一个截面，比较 C04 归档与模拟预测；也可载入训练模型的输出。',
    panel:'滚动与对照',hint:'相机同步 · 误差独立色标',
    input:'ẑ ⊕ b̂',trace:['解码至物理域','FIFO L = 4','H = 10 / 50 / 100'],
    note:'四帧窗口演示模型滚动机制。模拟场从 C04 第 835 步外推，目标时刻有归档时可比较切片误差。',
    reference:'V1.2 · Rollout',keyword:'预测核验',next:'同帧、同网格对照'
  }
] as const;

export const physicalChannels = ['u','v','w','p'] as const;
export type Channel = typeof physicalChannels[number];
export const names:Record<Channel,string> = {u:'流向速度',v:'横流速度',w:'展向速度',p:'压力'};
export const palette = ['#053061','#2166ac','#4393c3','#92c5de','#d1e5f0','#f7f7f7','#fddbc7','#f4a582','#d6604d','#b2182b','#67001f'];
