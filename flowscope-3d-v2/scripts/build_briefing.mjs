// Generates the seven editable PowerPoint diagrams and a browser-readable storyboard.
// Run with the Codex presentation runtime. The source image is a crop of time_frames_3d/frame_010.png.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [build, photoPath] = process.argv.slice(2);
if (!build || !photoPath) throw new Error("Usage: node build_briefing.mjs BUILD_DIR C04_PNG");
const localRequire = createRequire(path.resolve(build, "resolve.cjs"));
const { Presentation, PresentationFile } = await import(pathToFileURL(localRequire.resolve("@oai/artifact-tool")).href);
const W = 1280, H = 720;
const C = {ink:"#163447",muted:"#4B6373",teal:"#007C7D",purple:"#67499B",orange:"#B65B1A",
  gray:"#A5BAC3",edge:"#D4E1E5",ice:"#E0F3F1",lilac:"#F0ECF8",warm:"#FFF0DC",white:"#FFFFFF",paper:"#FBFCFC"};
const chapters = [
  ["真实三维尾流","C04 圆柱绕流","同一坐标网格记录圆柱后方的三分量速度与压力。","图中选取成熟尾流的一帧。Q 等值面沿流向展开，表面颜色表示有符号的涡量分量。时间和网格坐标均取自 C04 导出。"],
  ["3D DC-AE 编码","空间压缩","三级空间到通道重排，将每一轴的分辨率缩至八分之一。","逐帧在有效流体域内归一化四场，拼接流体掩码与归一化距离场。Stem 把 6 个通道投影成 32 个通道。每一级 S2C 后，特征通道依次升至 64、128、256。"],
  ["潜空间与 Probe","空间位置与物理统计","每帧有 2,304 个空间位置，每个位置保存 256 个特征。","局部 256 维特征经过无仿射 RMSNorm，评估与缓存使用无噪声的 z_clean。Probe 从潜变量估计无量纲Enstrophy和三维能谱，以离线 CFD 标签监督。六维统计量 b 走独立旁路。"],
  ["物理解码","矢量势与边界","解码器先恢复矢量势和压力，再还原物理速度与压力。","三级 C2S 还原空间分辨率。相容离散 Curl 从矢量势求出三个归一化速度分量。压力独立读出。六维统计恢复单位，固体填值、观测有效域和差分有效域分别处理。"],
  ["双轨时空模型","历史四帧与当前查询","Clean 缓存历史键值，Query 只读取可用历史与已知条件。","每帧包含五个条件槽位。流态从历史推断。Query 在各层读取同层历史键值；六维统计预测头读取历史汇总。训练时未来潜变量与统计量仅作为监督，推理窗口保持因果。"],
  ["Flow Matching","一个潜分量的两次更新","从最后一帧的潜状态出发，用八个积分步生成下一个物理时刻。","选择一个合成潜分量 D0。普通 FM 的条件 d=0，数值步长 h=1/8，潜空间速度示例为 v=1−0.5z+0.25τ。第一步从 z=0.2 和 τ=0 得到速度 0.9，更新至 0.3125。第二步用 z=0.3125、τ=0.125 重新运行 Query，得速度 0.875，更新至 0.421875。每步 Query 都读取同一份四帧历史 K/V，统计头仅从历史与已知条件估计六维旁路。训练示例可用从 0.2 到 1 的真值弦线构造目标速度 0.8；推演仅依赖历史和当前状态。达到 τ=1 后，将预测潜状态与预测统计量配对解码。"],
  ["未来恢复与滚动","配对解码与自由滚动","预测的潜状态与六维统计成对回填四帧历史窗。","冻结的解码器将预测状态恢复为下一物理时刻的 u、v、w、p。保留最近四帧，重复预测十、五十或一百步。导入同网格、同时标的真实模型结果后，才能比较场值和误差。"],
];
const deck = Presentation.create({slideSize:{width:W,height:H}});
const photo = await fs.readFile(photoPath);
const dataUri="data:image/png;base64,"+photo.toString("base64");
const pages=[];
let slide,svg=[],layer=0;
const escapeXml = str=>String(str).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\"","&quot;");
function emit(s){svg.push(layer ? `<g data-focus="${layer}">${s}</g>` : s);}
function text(t,x,y,w,h,size,color=C.ink,bold=false,align="left"){
  const sh=slide.shapes.add({name:t,geometry:"textbox",position:{left:x,top:y,width:w,height:h},fill:"none",line:{fill:"none",width:0}});
  sh.text=t;sh.text.style={typeface:"Microsoft YaHei",fontSize:size,bold,color,insets:0,alignment:align,verticalAlignment:"middle",autoFit:"none",wrap:"none"};
  const tx=align==="left"?x:align==="center"?x+w/2:x+w;
  emit(`<text x="${tx}" y="${y+h/2+size*.36}" fill="${color}" font-size="${size}" font-weight="${bold?700:400}" text-anchor="${{left:"start",center:"middle",right:"end"}[align]}">${escapeXml(t)}</text>`);
}
function rect(x,y,w,h,fill,stroke="none",line=0){
  slide.shapes.add({geometry:"rect",position:{left:x,top:y,width:w,height:h},fill,line:{fill:stroke,width:line}});
  emit(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${line}"/>`);
}
function dot(x,y,r,fill){
  slide.shapes.add({geometry:"ellipse",position:{left:x-r,top:y-r,width:r*2,height:r*2},fill,line:{fill:"none",width:0}});
  emit(`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`);
}
function pathShape(pts,fill="none",stroke=C.gray,line=1.6){
  const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]), x=Math.min(...xs),y=Math.min(...ys);
  const w=Math.max(1,Math.max(...xs)-x),h=Math.max(1,Math.max(...ys)-y);
  const commands=pts.map(([a,b],i)=>({[i?"lineTo":"moveTo"]:{x:a-x,y:b-y}}));
  if(fill!=="none")commands.push({close:{}});
  slide.shapes.add({geometry:"custom",position:{left:x,top:y,width:w,height:h},fill,line:{fill:stroke,width:line},customPaths:[{width:w,height:h,commands}]});
  emit(`<${fill==="none"?"polyline":"polygon"} points="${pts.map(p=>p.join(",")).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="${line}" stroke-linejoin="round"/>`);
}
function arrow(x,y,tx,ty,color=C.teal){
  pathShape([[x,y],[tx,ty]],"none",color,2);
  const a=Math.atan2(ty-y,tx-x);
  pathShape([[tx,ty],[tx-10*Math.cos(a-.44),ty-10*Math.sin(a-.44)],[tx-10*Math.cos(a+.44),ty-10*Math.sin(a+.44)]],color,color,1);
}
function cube(x,y,w,h,d,color=C.teal){
  const pale=color===C.purple?"#ECE3F7":"#D8F1EC",mid=color===C.purple?"#C5ADD9":"#91CFC3";
  pathShape([[x,y],[x+d,y-d*.58],[x+w+d,y-d*.58],[x+w,y]],"#F1F8F6",color);
  pathShape([[x+w,y],[x+w+d,y-d*.58],[x+w+d,y+h-d*.58],[x+w,y+h]],mid,color);
  pathShape([[x,y],[x+w,y],[x+w,y+h],[x,y+h]],pale,color);
  for(let i=1;i<4;i++){pathShape([[x+w*i/4,y],[x+w*i/4,y+h]],"none",mid,1);pathShape([[x,y+h*i/4],[x+w,y+h*i/4]],"none",mid,1);}
}
const tag=(s,x,y,w,fill,ink)=>{rect(x,y,w,52,fill);text(s,x+5,y,w-10,52,21,ink,true,"center");};
function imageObj(blob,x,y,w,h){slide.images.add({name:"C04 Q 等值面",blob:blob.buffer.slice(blob.byteOffset,blob.byteOffset+blob.byteLength),contentType:"image/png",alt:"C04 成熟尾流的 Q 等值面，物理时间 51.24 s",fit:"contain",position:{left:x,top:y,width:w,height:h}});emit(`<image id="wake-image" x="${x}" y="${y}" width="${w}" height="${h}" href="${dataUri}"/>`);}
function subsection(y,label,lines){text(label,64,y,400,41,27,C.ink,true);lines.forEach((l,i)=>text(l,64,y+53+i*36,460,30,20,C.muted));}
function bottom(left,right){rect(64,625,1152,1,C.edge);text(left,64,640,810,42,19,C.muted);text(right,908,640,308,42,17,C.muted,false,"right");}
function init(i){
  layer=0;svg=[];slide=deck.slides.add();slide.background.fill=C.paper;
  const [name,kicker,summary,notes]=chapters[i]; const j=String(i+1).padStart(2,"0");
  text("FlowScope 3D   /   V2.0",64,34,660,22,16,C.teal,true);
  text(`${j}   /   07`,1020,32,196,24,17,C.muted,false,"right");
  text(name,64,83,1152,77,53,C.ink,true);text(summary,66,171,1150,45,25,C.muted);
  slide.speakerNotes.text=notes+"\n资料：flowworldshowdesign.md、FlowWorldModel_3D_V1_2_Pretrain_Architecture.svg"+(i===0?"、C04 / time_frames_3d / frame_010.png。":"。本页为架构演示。");
}
function finalize(i){pages.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" font-family="Microsoft YaHei, sans-serif"><rect width="1280" height="720" fill="${C.paper}"/>${svg.join("\n")}</svg>`);}

init(0);
text("C04",64,261,390,83,72,C.teal,true);
text("圆柱绕流",67,360,400,48,33,C.ink,true);
text("64 × 96 × 192",68,429,424,46,32,C.ink);
text("每个时刻的体网格（Z，Y，X）",68,483,426,36,20,C.muted);
text("u、v、w  [m/s]       p  [Pa]",68,534,460,35,20,C.muted);
rect(551,225,665,375,"#09090D");
imageObj(photo,551,226,665,374);
bottom("真实 CFD     C04 固定视角，Q = 0.85 s⁻²，t = 51.24 s","数据记录  0–60 s");finalize(0);
init(1);
const specs=[["Stem","64 × 96 × 192","6 → 32",155,103,60],["S2C  1","32 × 48 × 96","64",127,83,48],["S2C  2","16 × 24 × 48","128",100,64,38],["S2C  3","8 × 12 × 24","256",77,49,28]];
specs.forEach(([s,size,ch,w,h,d],i)=>{const x=94+i*291;layer=i+1;text(s,x,251,210,38,24,C.teal,true);cube(x+8,390-h/2,w,h,d,i===3?C.purple:C.teal);text(size,x,487,245,38,26,C.ink,true);text(ch+" 通道",x,539,221,33,21,C.muted);if(i<3){layer=0;arrow(x+222,397,x+266,397,C.gray);}});
layer=0;bottom("架构演示     输入包含归一化的四场、流体掩码与 SDF / D","各轴压缩  8 倍");finalize(1);
init(2);
layer=1;cube(82,349,157,113,76,C.purple);text("8 × 12 × 24",65,490,278,45,27,C.purple,true,"center");
layer=2;arrow(322,402,390,402,C.gray);tag("RMSNorm",405,361,198,C.lilac,C.purple);text("每个位置的 256 维特征",358,454,300,35,20,C.muted,false,"center");
layer=3;arrow(616,387,694,337,C.purple);tag("z_clean",708,296,212,C.lilac,C.purple);arrow(929,322,993,322,C.purple);text("物理 Probe",996,291,218,58,26,C.ink,true,"center");text("Enstrophy与三维能谱",962,363,260,40,19,C.muted,false,"center");
layer=4;rect(712,474,502,84,C.ice);text("b[6]   四个均值与两项尺度",721,488,484,50,25,C.teal,true,"center");layer=0;
bottom("架构演示     Probe 的监督标签来自离线 CFD","2304 位置  ×  256 特征");finalize(2);
init(3);
layer=1;tag("z_clean",67,344,162,C.lilac,C.purple);arrow(238,370,296,370);tag("C2S × 3",304,344,170,C.ice,C.teal);
layer=2;arrow(480,370,565,303);tag("矢量势 A*",577,267,179,C.ice,C.teal);arrow(761,294,813,294);tag("Curl",821,267,125,C.ice,C.teal);
layer=3;arrow(480,370,566,434);tag("归一化压力",577,408,179,C.lilac,C.purple);arrow(763,434,952,434,C.purple);
layer=4;arrow(952,293,1002,345);arrow(952,434,1002,405,C.purple);tag("物理读出",1000,346,202,C.warm,C.orange);text("u、v、w、p",974,429,247,43,25,C.ink,true,"center");
layer=5;text("b[6]  恢复均值与尺度",760,535,441,41,23,C.orange,true,"right");arrow(1097,520,1097,475,C.orange);
layer=0;bottom("架构演示     差分计算使用有效模板，壁面误差单独评估","边界掩码参与读出");finalize(3);
init(4);
layer=1;text("五个条件槽位",65,266,275,46,28,C.ink,true);["Text / 空","Physics","Step","Action","Regime"].forEach((s,k)=>text(String(k)+"    "+s,69,333+k*45,255,39,23,k===4?C.purple:C.muted,k===4));
layer=2;rect(362,267,846,100,C.ice);text("Clean",382,278,180,45,27,C.teal,true);text("历史四帧     t−3      t−2      t−1      t",565,278,615,45,23,C.ink);text("每层缓存严格因果的 K 与 V",384,324,760,33,19,C.muted);
layer=3;arrow(574,382,574,439,C.teal);text("同层 K、V",601,389,195,38,20,C.teal);text("历史汇总   →   六维统计头",818,388,394,39,20,C.teal,true);
layer=4;rect(362,454,846,99,C.lilac);text("Query",382,466,183,43,27,C.purple,true);text("当前 zτ、τ 与步长 d",568,466,620,43,23,C.ink);text("更新生成状态后再运行 Transformer",384,512,770,32,19,C.muted);
layer=0;bottom("架构演示     未来真值只用于训练监督","历史长度  L = 4");finalize(4);
init(5);
layer=1;
rect(64,230,1152,55,C.ice);
text("四帧历史保持固定",81,237,241,41,23,C.teal,true);
text("每一步都用当前的 z 和 τ 重新运行 Query，读取同一份 Clean K/V。",325,237,865,41,22,C.ink);
layer=0;
rect(64,308,530,183,C.white,C.edge,1.5);rect(685,308,531,183,C.white,C.edge,1.5);
arrow(606,400,670,400,C.purple);
layer=2;
text("第 1 步",82,317,113,38,24,C.purple,true);
text("τ = 0，z = 0.2000",203,317,373,38,23,C.ink);
text("查询速度   v = 0.9000",82,367,487,39,25,C.ink);
layer=3;
text("0.2000 + 0.125 × 0.9000 = 0.3125",82,418,493,50,25,C.purple,true);
layer=4;
text("第 2 步",703,317,113,38,24,C.purple,true);
text("τ = 0.125，z = 0.3125",824,317,370,38,23,C.ink);
text("重新查询   v = 0.8750",703,367,488,39,25,C.ink);
layer=5;
text("0.3125 + 0.125 × 0.8750 = 0.421875",703,418,495,50,24,C.purple,true);
layer=0;
text("教学速度",65,513,130,38,22,C.orange,true);
text("v(z, τ) = 1 − 0.5z + 0.25τ",195,513,425,38,23,C.ink);
text("普通 FM    d = 0，积分步长 h = 1/8",686,513,526,38,21,C.muted);
text("训练参照",65,564,130,36,21,C.teal,true);
text("若真值从 0.2 到 1.0，弦线监督速度 v* = 1.0 − 0.2 = 0.8。",195,564,997,36,21,C.muted);
bottom("D0 为合成潜分量，速度表示它对生成时间 τ 的变化率。","τ = 1 后与六维统计配对解码");finalize(5);
init(6);
layer=1;text("当前四帧",71,258,300,42,26,C.ink,true);["t−3","t−2","t−1","t"].forEach((s,k)=>tag(s,71+k*104,331,87,C.ice,C.teal));
layer=2;arrow(488,357,553,357);tag("生成一步",567,331,178,C.lilac,C.purple);arrow(752,356,818,356,C.purple);tag("ẑ(t+1)   +   b̂(t+1)",832,331,374,C.warm,C.orange);
layer=3;text("替换最旧状态",72,445,418,46,27,C.teal,true);text("回填最新配对状态，保持窗口长度为 4。",73,504,571,41,23,C.muted);
layer=4;text("H = 10 / 50 / 100",678,441,532,56,35,C.purple,true);text("每一步使用上一步的预测继续滚动。",679,507,526,40,23,C.muted);
layer=0;bottom("架构演示     独立真值用于同一变量、同一时刻的误差评估","模型输出待导入");finalize(6);

await fs.mkdir(build,{recursive:true});
for (const [i,s] of deck.slides.items.entries()){
  const stem="scene-"+String(i+1).padStart(2,"0");
  await fs.writeFile(path.join(build,stem+".svg"),pages[i]);
  const png=await deck.export({slide:s,format:"png",scale:1});
  await fs.writeFile(path.join(build,stem+".png"),new Uint8Array(await png.arrayBuffer()));
}
await (await PresentationFile.exportPptx(deck)).save(path.join(build,"candidate.pptx"));
await fs.writeFile(path.join(build,"chapters.json"),JSON.stringify(chapters,null,2));
