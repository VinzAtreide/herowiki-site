/* Service worker de HeroWiki — l'application hors connexion.
 *
 *  Deux caches, deux stratégies :
 *   • `hw-coque`   : l'application elle-même (HTML, JS, CSS, icône). Réseau
 *     d'abord, cache en secours — ainsi une mise à jour du site arrive dès
 *     la première ouverture avec du réseau, sans jamais bloquer hors ligne.
 *   • `hw-donnees` : les conteneurs chiffrés (`p/`, `n/`, `i/`, `t/`, `img/`).
 *     Leur nom est un condensat : un fichier donné ne change JAMAIS de
 *     contenu. Cache d'abord, donc, et pour toujours.
 *
 *  Rien de déchiffré n'est stocké : le cache ne contient que des octets
 *  illisibles sans la phrase de passe. Perdre son téléphone n'expose rien
 *  de plus que perdre l'adresse du site.
 */
'use strict';

const VERSION = 'v1';
const COQUE = 'hw-coque-' + VERSION;
const DONNEES = 'hw-donnees-' + VERSION;
const NOYAU = ['./', 'index.html', 'app.js', 'style.css', 'worker.js',
               'messagerie.js', 'manifest.json', 'icone.png', 'meta.json'];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(COQUE)
      .then(c => c.addAll(NOYAU.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()));   // une ressource absente ne bloque rien
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks
        .filter(k => k !== COQUE && k !== DONNEES)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // Firebase, GitHub : jamais

  //  Les conteneurs chiffrés. ⚠ Leur nom vient de l'IDENTIFIANT de la fiche,
  //  pas de son contenu : un même fichier change quand la fiche change. Un
  //  cache « pour toujours » gèlerait donc le wiki au premier chargement —
  //  l'épisode suivant n'arriverait jamais, et une phrase révoquée
  //  continuerait de fonctionner. (Défaut trouvé au second audit, 19/08.)
  //  Donc : réseau d'abord, cache en secours, et un délai court pour ne pas
  //  punir une mauvaise connexion.
  if (/\/(p|n|i|t|img)\/[^/]+\.bin$/.test(url.pathname)) {
    ev.respondWith((async () => {
      const c = await caches.open(DONNEES);
      try {
        const ctrl = new AbortController();
        const minuteur = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(req, { signal: ctrl.signal });
        clearTimeout(minuteur);
        if (r && r.ok) c.put(req, r.clone());
        return r;
      } catch (e) {
        const vu = await c.match(req);
        if (vu) return vu;
        throw e;
      }
    })());
    return;
  }

  //  L'application : réseau d'abord, cache en secours.
  ev.respondWith((async () => {
    try {
      const r = await fetch(req);
      if (r && r.ok) (await caches.open(COQUE)).put(req, r.clone());
      return r;
    } catch (e) {
      const vu = await caches.match(req);
      if (vu) return vu;
      if (req.mode === 'navigate') {
        const acc = await caches.match('index.html');
        if (acc) return acc;
      }
      throw e;
    }
  })());
});

/*  Le MJ peut vider le cache des données depuis la page MJ : utile après une
 *  refonte, inutile au quotidien (les noms de fichiers changent d'eux-mêmes). */
self.addEventListener('message', ev => {
  if (ev.data === 'hw-vider') {
    ev.waitUntil(Promise.all([caches.delete(DONNEES), caches.delete(COQUE)])
      .then(() => ev.source && ev.source.postMessage('hw-vide')));
  }
});
