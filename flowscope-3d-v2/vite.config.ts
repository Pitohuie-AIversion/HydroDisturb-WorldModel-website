import { defineConfig } from 'vite';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const library = new URL('public/library/', root);
mkdirSync(library, {recursive:true});
const movieFile = new URL('deliverables/flowscope-demo.mp4', root);
function prepareFilm(source: URL, directory: URL, stem: string) {
  const movie = readFileSync(source);
  const partSize = 16 * 1024 * 1024;
  const parts: string[] = [];
  const fullName = stem + '.mp4';
  const offlineMovie = new URL(fullName, directory);
  if (offlineMovie.href !== source.href) copyFileSync(source, offlineMovie);
  if (movie.length <= 24 * 1024 * 1024) {
    parts.push(fullName);
  } else {
    for (let offset = 0; offset < movie.length; offset += partSize) {
      const name = fullName + '.part-' + String(parts.length + 1).padStart(2, '0');
      writeFileSync(new URL(name, directory), movie.subarray(offset, offset + partSize));
      parts.push(name);
    }
  }
  writeFileSync(new URL(stem + '.parts.json', directory), JSON.stringify({parts, bytes: movie.length}));
  const prefix = fullName + '.part-';
  for (const name of readdirSync(directory)) {
    if (name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)) && !parts.includes(name)) {
      unlinkSync(new URL(name, directory));
    }
  }
}
prepareFilm(movieFile, library, 'flowscope-demo');
const shortDirectory = new URL('public/media/', root);
const shortFilm = new URL('flowscope-30s-4k.mp4', shortDirectory);
for (const file of ['presentation.pptx','architecture.svg','architecture.pdf','narration.md','interaction-script.md','latent.md','prediction.md','design-review.md']) {
  const source = file.endsWith('.md') ? 'docs/' : 'deliverables/';
  copyFileSync(fileURLToPath(new URL(source + file, root)), fileURLToPath(new URL(file, library)));
}
for (const name of ['performance-before.json','performance-window.json','performance-fullscreen.json']) {
  copyFileSync(fileURLToPath(new URL('docs/'+name,root)),fileURLToPath(new URL(name,library)));
}
const exchangeTools=new URL('public/scripts/',root);
mkdirSync(exchangeTools,{recursive:true});
for(const name of ['export_latent.py','export_prediction.py']){
  copyFileSync(fileURLToPath(new URL('scripts/'+name,root)),fileURLToPath(new URL(name,exchangeTools)));
}

export default defineConfig({
  base: './',
  server: {watch:{ignored:['**/deliverables/**','**/public/data/frames/**','**/public/data/transitions/**','**/public/library/**']}},
  plugins: [{
    name: 'prepare-short-film',
    configResolved(config) {
      if (config.command === 'serve' && !existsSync(shortFilm)) return;
      prepareFilm(shortFilm, shortDirectory, 'flowscope-30s-4k');
    }
  }, {
    name: 'serve-cfd-binary',
    configureServer(server) {
      server.middlewares.use((request,response,next)=>{
        const path=request.url?.split('?')[0];
        // These are independently checksummed gzip containers. Send their
        // exact bytes so the browser can verify them before decompression.
        if(!path || !/^\/data\/(?:frames\/\d+\/[a-z0-9.-]+|simulated-rollout\/\d+\.f32)\.gz$/.test(path))return next();
        const file=new URL('public'+path,root);
        const stream=createReadStream(file);
        stream.once('error',()=>{response.statusCode=404;response.end();});
        response.setHeader('Content-Type','application/octet-stream');
        stream.pipe(response);
      });
    }
  }],
  build: {
    outDir: 'deliverables/flowscope-offline',
    target: 'es2022',
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', root)),
        film: fileURLToPath(new URL('film.html', root))
      },
      output: { manualChunks: { three: ['three'] } }
    }
  }
});
