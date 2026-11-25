const CACHE='lt-cache-v4';
const SCOPE=self.registration.scope;
const PRECACHE=['manifest.json','icon-192.png','icon-512.png'].map(p=>new URL(p,SCOPE).href);
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>Promise.allSettled(PRECACHE.map(u=>fetch(u,{cache:'reload'}).then(r=>r.ok&&c.put(u,r))))))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==CACHE).map(n=>caches.delete(n)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||r.headers.has('range'))return;
  const u=new URL(r.url);
  if(u.origin!==location.origin)return;
  e.respondWith(caches.open(CACHE).then(async c=>{
    const hit=await c.match(r,{ignoreSearch:r.mode==='navigate'})||(r.mode==='navigate'?await c.match(new URL('index.html',SCOPE).href):null);
    const net=fetch(r).then(res=>{if(res&&res.ok)c.put(r,res.clone());return res}).catch(()=>null);
    if(hit){e.waitUntil(net);return hit}
    return (await net)||Response.error();
  }));
});
