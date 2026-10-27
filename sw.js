// Версия теперь нужна только для чистки старого кэша; обновления приложения подхватываются сами:
// страница и скрипты берутся из сети первыми (кэш — только запасной вариант без интернета).
const VERSION='finance-v47';
const SHELL=['./','index.html','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/maskable-512.png','icons/apple-touch-icon.png','icons/favicon-32.png'];
const WAIT=4000; // сколько ждём сеть, прежде чем открыть сохранённую копию

self.addEventListener('install',e=>{
  // cache:'reload' — мимо HTTP-кэша браузера, чтобы в кэш не попала устаревшая копия
  e.waitUntil(caches.open(VERSION).then(c=>Promise.all(SHELL.map(u=>
    fetch(new Request(u,{cache:'reload'})).then(r=>{if(!r.ok)throw new Error(u);return c.put(u,r)}))))
    .then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

const fresh=(r)=>fetch(r.url,{cache:'no-cache',credentials:'same-origin'}).then(res=>{
  if(res&&res.ok){const copy=res.clone();caches.open(VERSION).then(c=>c.put(r.url,copy))}
  return res});

self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  if(new URL(r.url).searchParams.has('_'))return;   // проверки версии и «живые» запросы с меткой _ идут напрямую в сеть и не попадают в кэш
  const isPage=r.mode==='navigate'||/\.(html|webmanifest|js)$/.test(new URL(r.url).pathname)||new URL(r.url).pathname.endsWith('/');
  if(isPage){
    // сеть первой (всегда свежая версия), при отсутствии интернета или долгом ответе — кэш
    e.respondWith((async()=>{
      const net=fresh(r);
      const cached=()=>caches.match(r,{ignoreSearch:true}).then(h=>h||(r.mode==='navigate'?caches.match('index.html'):undefined));
      try{
        const res=await Promise.race([net,new Promise((_,no)=>setTimeout(no,WAIT))]);
        if(res&&res.ok)return res;
        return (await cached())||res;
      }catch(err){
        e.waitUntil(net.catch(()=>{}));
        return (await cached())||Response.error()}
    })());
    return}
  // иконки и прочее — из кэша
  e.respondWith(caches.match(r,{ignoreSearch:true}).then(hit=>hit||fetch(r).then(res=>{
    if(res&&res.ok){const copy=res.clone();caches.open(VERSION).then(c=>c.put(r,copy))}
    return res})));
});
