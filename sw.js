// Service worker : garde l'application disponible hors ligne et affiche les notifications.
// Les données (Supabase) ne sont jamais mises en cache ici.
const VERSION = 'carnet-v16';
const SHELL = [
  './', './index.html', './config.js', './supabase.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

// config.js définit window.CARNET_CONFIG : dans le service worker, « window » n'existe pas.
self.window = self;
try { importScripts('./config.js'); } catch (e) { /* hors ligne : les boutons « Oui » ouvriront l'application */ }

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase et autres : réseau direct
  // Réseau d'abord (pour recevoir les mises à jour), cache en secours hors ligne.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});

/* ---------- Notifications ---------- */
// Toujours afficher une notification à la réception (sinon l'iPhone peut couper l'abonnement).
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { corps: e.data ? e.data.text() : '' }; }
  const url = m.url || './';
  const entree = /[?&]t=entree/.test(url);
  const opts = {
    body: m.corps || '',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url }
  };
  // Boutons dans la notification : pris en charge sur Android (Chrome). Sur iPhone, toucher la notification ouvre la question.
  if (m.boutons) opts.actions = [{ action: 'oui', title: entree ? 'Oui, reçu' : 'Oui, payé' }, { action: 'non', title: 'Pas encore' }];
  e.waitUntil(self.registration.showNotification(m.titre || 'Carnet de dépenses', opts));
});

self.addEventListener('notificationclick', e => {
  const n = e.notification;
  n.close();
  const url = new URL((n.data && n.data.url) || './', self.registration.scope).href;
  if (e.action === 'non') return;

  if (e.action === 'oui') {
    const jeton = new URL(url).searchParams.get('rappel');
    const c = self.CARNET_CONFIG || {};
    if (!jeton || !c.SUPABASE_URL) { e.waitUntil(self.clients.openWindow(url)); return; }
    e.waitUntil(
      fetch(c.SUPABASE_URL + '/rest/v1/rpc/payer_par_jeton', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: c.SUPABASE_KEY },
        body: JSON.stringify({ p_jeton: jeton })
      })
        .then(r => r.ok ? r.json() : Promise.reject(r.status))
        .then(lib => self.registration.showNotification(lib ? '✓ ' + lib : 'Rappel déjà traité', {
          body: lib ? 'Coché dans votre carnet.' : 'Ce rappel a déjà été utilisé ou a expiré.',
          tag: (n.tag || 'rappel') + '-ok', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png'
        }))
        .catch(() => self.clients.openWindow(url))
    );
    return;
  }

  // Toucher la notification : ouvrir l'application (ou la ramener au premier plan) sur la question « C'est payé ? »
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const w of list) {
      if ('focus' in w) { w.postMessage({ type: 'rappel', url }); return w.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
