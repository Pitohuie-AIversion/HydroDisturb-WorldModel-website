export async function loadFilm(manifestPath = './library/flowscope-demo.parts.json'): Promise<Blob> {
  const manifest = await fetch(manifestPath);
  if (!manifest.ok) throw new Error('影片清单读取失败');
  const {parts, bytes} = await manifest.json() as {parts: string[]; bytes: number};
  const blobs = await Promise.all(parts.map(async name => {
    const response = await fetch(new URL(name, manifest.url));
    if (!response.ok) throw new Error('影片分卷读取失败');
    return response.blob();
  }));
  const film = new Blob(blobs, {type: 'video/mp4'});
  if (!film.size || film.size !== bytes) throw new Error('影片未完整载入');
  return film;
}
