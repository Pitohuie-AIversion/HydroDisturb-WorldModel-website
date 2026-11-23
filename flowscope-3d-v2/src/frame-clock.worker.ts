// Request exactly one display callback per acknowledgement from the renderer.
// A busy main thread therefore never receives a backlog of expired frames.
self.onmessage=()=>{
  try{
    self.requestAnimationFrame(()=>self.postMessage('frame'));
  }catch{
    self.postMessage('unavailable');
  }
};
export {};
