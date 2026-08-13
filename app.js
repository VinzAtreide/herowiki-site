/* ═══════════════════════════════════════════════════════════════════════════
   HeroWiki — tout le site tient ici.

   Le serveur ne filtre rien : il ne sait rien. Il sert des blocs chiffrés à
   qui les demande. Ce que le lecteur voit est exactement ce que son trousseau
   lui permet de déchiffrer, et le reste est du bruit — y compris pour qui
   lirait ce fichier, qui est public.

   Trois clés dérivent de celle d'un coffre, par HKDF et par usage :
     nav        → la liste des fiches du coffre
     index:xx   → un seau de l'index de recherche
     frag:h#n   → un fragment de fiche
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const $ = s => document.querySelector(s);
const enc = new TextEncoder();
const dec = new TextDecoder();

let META = null;        // meta.json
let SEL = null;         // le sel du site
let MOI = null;         // {nom, mj, groupe, coffres:Map(nom→CryptoKey brut), frags:Map}
let TAGS = new Map();   // tag de coffre → clé brute
let CAT = new Map();    // hachage de fiche → {h,n,t,k,b,tg}
let ORDRE = [];         // catalogue trié
const CACHE_P = new Map();   // conteneurs de fiche
const CACHE_I = new Map();   // seaux d'index

/* ── outils ─────────────────────────────────────────────────────────────── */
const deb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

async function sha256(...parts) {
  let n = 0; parts.forEach(p => n += p.length);
  const buf = new Uint8Array(n); let o = 0;
  parts.forEach(p => { buf.set(p, o); o += p.length; });
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

async function hkdf(brut, info, len = 32) {
  const k = await crypto.subtle.importKey('raw', brut, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL, info: enc.encode(info) }, k, len * 8));
}

async function degonfler(buf) {
  const fl = new DecompressionStream('gzip');
  const s = new Blob([buf]).stream().pipeThrough(fl);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Ouvre un paquet AES-GCM. Rend `null` si la clé n'est pas la bonne — c'est
 *  le comportement normal, pas une erreur : on essaie souvent sans savoir. */
async function ouvrir(brutCle, paquet) {
  try {
    const k = await crypto.subtle.importKey('raw', brutCle, 'AES-GCM', false, ['decrypt']);
    const clair = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: paquet.slice(0, 12) }, k, paquet.slice(12));
    return JSON.parse(dec.decode(await degonfler(new Uint8Array(clair))));
  } catch (e) { return null; }
}

async function prendre(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

function nrm(s) {
  return (s || '').replace(/[’]/g, "'").normalize('NFD')
    .replace(/[̀-ͯ]/g, '').toLowerCase();
}
function ech(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── déverrouillage ─────────────────────────────────────────────────────── */

async function cleDePhraseIci(phrase) {
  const base = await crypto.subtle.importKey('raw', enc.encode(phrase.trim()),
    'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: SEL, iterations: META.it }, base, 256));
}

/** La clé se calcule dans un worker pour ne pas geler l'écran ; si le worker
 *  ne démarre pas (vieux navigateur, file://), on calcule sur place. */
function cleDePhrase(phrase) {
  return new Promise(res => {
    let w;
    try { w = new Worker('worker.js'); }
    catch (e) { return res(cleDePhraseIci(phrase)); }
    const secours = setTimeout(async () => { w.terminate(); res(await cleDePhraseIci(phrase)); }, 30000);
    w.onmessage = ev => { clearTimeout(secours); w.terminate(); res(new Uint8Array(ev.data)); };
    w.onerror = async () => { clearTimeout(secours); w.terminate(); res(await cleDePhraseIci(phrase)); };
    w.postMessage({ phrase: phrase.trim(), sel: SEL, it: META.it });
  });
}

async function ouvrirTrousseau(k) {
  const nom = hex(await sha256(SEL, enc.encode('trousseau:'), k)).slice(0, 24);
  const paquet = await prendre('t/' + nom + '.bin');
  if (!paquet) return null;
  return await ouvrir(await hkdf(k, 'trousseau'), paquet);
}

async function installer(tr) {
  MOI = { nom: tr.nom, mj: tr.mj, groupe: tr.groupe, pjh: tr.pj || null,
          coffres: new Map(), frags: new Map() };
  TAGS = new Map();
  for (const [nom, b] of Object.entries(tr.v || {})) {
    const brut = deb64(b);
    MOI.coffres.set(nom, brut);
    TAGS.set(hex(await sha256(SEL, enc.encode('coffre:'), enc.encode(nom))).slice(0, 16), brut);
  }
  for (const [fid, b] of Object.entries(tr.f || {})) MOI.frags.set(fid, deb64(b));

  // catalogue : la liste de navigation de chacun de mes coffres
  CAT = new Map();
  for (const [nom, brut] of MOI.coffres) {
    const tag = hex(await sha256(SEL, enc.encode('coffre:'), enc.encode(nom))).slice(0, 16);
    const paquet = await prendre('n/' + tag + '.bin');
    if (!paquet) continue;
    const lst = await ouvrir(await hkdf(brut, 'nav'), paquet);
    if (lst) for (const e of lst) if (!CAT.has(e.h)) CAT.set(e.h, e);
  }
  // les fiches ouvertes par exception n'apparaissent dans aucune liste :
  // leur entrée est allée chercher sa clé une par une.
  for (const fid of MOI.frags.keys()) {
    const [h, o] = fid.split('#');
    if (o !== '0' || CAT.has(h)) continue;
    const fr = await fragment(h, 0);
    if (fr) CAT.set(h, { h, n: fr.n, t: fr.ti, k: fr.k, b: fr.b, tg: fr.tg || [] });
  }
  ORDRE = [...CAT.values()].sort((a, b) => nrm(a.n).localeCompare(nrm(b.n), 'fr'));
}

/* ── lecture d'un fragment ──────────────────────────────────────────────── */

async function conteneur(h) {
  if (CACHE_P.has(h)) return CACHE_P.get(h);
  const p = prendre('p/' + h + '.bin').then(b => b ? JSON.parse(dec.decode(b)) : null);
  CACHE_P.set(h, p);
  return p;
}

/** Rend le fragment `h#o` en clair, ou `null` s'il n'est pas pour moi. */
async function fragment(h, o) {
  const c = await conteneur(h);
  if (!c) return null;
  const bloc = c.f.find(x => x.o === o);
  if (!bloc) return null;
  const fid = h + '#' + o;
  let brut = MOI.frags.get(fid);            // clé donnée nommément (exception)
  if (brut) return await ouvrir(brut, deb64(bloc.c));
  const coffre = TAGS.get(bloc.v);           // clé dérivée d'un coffre
  if (!coffre) return null;
  return await ouvrir(await hkdf(coffre, 'frag:' + fid), deb64(bloc.c));
}

async function ficheEntiere(h) {
  const c = await conteneur(h);
  if (!c) return null;
  const parts = await Promise.all(c.f.map(b => fragment(h, b.o)));
  const lues = [];
  c.f.forEach((b, i) => { if (parts[i]) lues.push({ o: b.o, d: parts[i] }); });
  if (!lues.length) return null;
  lues.sort((a, b) => a.o - b.o);
  return { h, entree: lues[0].o === 0 ? lues[0].d : null, rubriques: lues.filter(x => x.o > 0) };
}

/* ── recherche ──────────────────────────────────────────────────────────── */

const SEAU = t => {
  let s = '';
  for (const c of t.slice(0, 2)) s += /[a-z0-9]/.test(c) ? c : '_';
  return (s + '__').slice(0, 2);
};

async function seau(nomCoffre, brut, s) {
  const cle = nomCoffre + '/' + s;
  if (CACHE_I.has(cle)) return CACHE_I.get(cle);
  const p = (async () => {
    const tag = hex(await sha256(SEL, enc.encode('coffre:'), enc.encode(nomCoffre))).slice(0, 16);
    const paquet = await prendre('i/' + tag + '/' + s + '.bin');
    if (!paquet) return null;
    return await ouvrir(await hkdf(brut, 'index:' + s), paquet);
  })();
  CACHE_I.set(cle, p);
  return p;
}

/** Le dernier mot tapé est traité en préfixe : on cherche pendant la frappe. */
async function chercher(requete) {
  const mots = nrm(requete).split(/[^0-9a-zà-öø-ÿ]+/).filter(x => x.length >= 2);
  if (!mots.length) return [];
  const parMot = [];

  for (let i = 0; i < mots.length; i++) {
    const m = mots[i], prefixe = (i === mots.length - 1);
    const trouve = new Map();               // hachage → score
    for (const [nomCoffre, brut] of MOI.coffres) {
      const idx = await seau(nomCoffre, brut, SEAU(m));
      if (!idx) continue;
      const cles = prefixe ? Object.keys(idx.t).filter(t => t.startsWith(m))
        : (idx.t[m] ? [m] : []);
      for (const t of cles.slice(0, 60)) {
        const exact = (t === m) ? 3 : 1;
        for (const [di, o, n] of idx.t[t]) {
          const h = idx.d[di];
          // le nom et le préambule pèsent plus lourd que le corps d'une rubrique
          const p = (o === 0 ? 6 : 1) * exact * Math.min(n, 6);
          const v = trouve.get(h) || { s: 0, ou: new Set() };
          v.s += p; v.ou.add(o); trouve.set(h, v);
        }
      }
    }
    parMot.push(trouve);
  }

  // toutes les fiches qui portent tous les mots ; à défaut, celles qui en
  // portent le plus — mieux vaut une réponse approchée qu'une page vide
  let clefs = [...parMot[0].keys()];
  for (let i = 1; i < parMot.length; i++) clefs = clefs.filter(h => parMot[i].has(h));
  if (!clefs.length) {
    const c = new Map();
    parMot.forEach(m => m.forEach((v, h) => c.set(h, (c.get(h) || 0) + 1)));
    clefs = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(x => x[0]);
  }

  const res = clefs.map(h => {
    let s = 0; const ou = new Set();
    parMot.forEach(m => { const v = m.get(h); if (v) { s += v.s; v.ou.forEach(o => ou.add(o)); } });
    return { h, s, ou: [...ou].sort((a, b) => a - b) };
  }).sort((a, b) => b.s - a.s).slice(0, 50);

  res.forEach(r => { r.e = CAT.get(r.h) || { n: '(fiche)', t: '', k: '', b: '' }; });
  res.motifs = mots.map(m => new RegExp(classes(m), 'gi'));
  return res;
}

/** Les extraits arrivent **après** la liste.
 *
 *  Chercher, c'est deux choses : savoir *où* c'est, et savoir *ce que ça dit*.
 *  La première tient dans l'index, déjà en mémoire. La seconde demande d'aller
 *  chercher cinquante fragments sur le réseau. Les attendre pour afficher quoi
 *  que ce soit faisait patienter deux secondes devant une page blanche ; les
 *  laisser se poser un par un dans une liste déjà lisible ne fait patienter
 *  personne. */
async function poserExtraits(res, quand) {
  await Promise.all(res.slice(0, 30).map(async r => {
    const o = r.ou.find(x => x > 0);
    let fr = await fragment(r.h, o === undefined ? 0 : o);
    let txt = fr ? texteNu(fr.h || '') : '';
    // Le mot peut n'être que dans le nom ou une étiquette : la rubrique
    // trouvée n'a alors rien à montrer. On retombe sur le préambule, qui dit
    // au moins de quoi la fiche parle.
    if (!txt && o !== undefined) {
      fr = await fragment(r.h, 0);
      txt = fr ? texteNu(fr.h || '') : '';
    }
    if (!txt || quand() !== res) return;
    const el = document.getElementById('x-' + r.h);
    if (el) el.innerHTML = extrait(txt, res.motifs, fr.t || '');
  }));
}

/** « ecole » doit trouver « école » : chaque voyelle devient sa classe. */
function classes(m) {
  const c = { a: '[aàâä]', e: '[eéèêë]', i: '[iîï]', o: '[oôö]', u: '[uùûü]', c: '[cç]', y: '[yÿ]' };
  return m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split('').map(x => c[x] || x).join('');
}

/** Une balise de bloc vaut une espace, une balise en ligne n'en vaut aucune :
 *  sinon « d'<a>Omega</a>drones » se lit « d' Omega drones » dans l'extrait. */
function texteNu(html) {
  return html
    .replace(/<\/?(?:a|b|i|em|strong|code|mark|span)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function extrait(txt, motifs, titre) {
  let pos = -1;
  for (const m of motifs) { m.lastIndex = 0; const r = m.exec(txt); if (r) { pos = r.index; break; } }
  if (pos < 0) pos = 0;
  const d = Math.max(0, pos - 90);
  let bout = txt.slice(d, d + 240);
  bout = ech(bout);
  for (const m of motifs) bout = bout.replace(new RegExp(m.source, 'gi'), x => '<mark>' + x + '</mark>');
  return (titre ? '<b>' + ech(titre) + '</b> — ' : '') +
    (d > 0 ? '…' : '') + bout + (d + 240 < txt.length ? '…' : '');
}

/* ── rendu ──────────────────────────────────────────────────────────────── */

const RAYONS = [
  { id: 'lore', nom: 'Le monde', ico: '🌍' },
  { id: 'pnj', nom: 'Les personnages', ico: '🦸' },
  { id: 'regles', nom: 'Les règles', ico: '📖' },
  { id: 'campagne', nom: 'La chronique', ico: '📜' },
  { id: 'pj', nom: 'Nos personnages', ico: '⭐' },
];

/* L'ordre de lecture de chaque rayon : les catégories citées d'abord, dans
   cet ordre ; les autres suivent par taille. L'alphabet ne sert qu'à
   l'intérieur d'une catégorie. */
const CAT_ORDRE = {
  lore: ['Lieu', 'Quartier général', 'Organisation', 'Événement', 'Espèce', 'Artefact'],
  pnj: ['Héros', 'Vilain', 'Personnalité', 'Figurant', 'Créature', 'Archétype'],
  regles: ['Pouvoir', 'Talent', 'Équipement', 'Véhicule', 'Option de règles'],
  campagne: ["Résumé d'épisode", 'Journal', 'Aide de jeu'],
};
const BAL = { 'Grand public': 0, 'Super': 1, 'Secret': 2, 'Très secret': 3, 'MJ only': 4 };

function liens(el) {
  el.querySelectorAll('a[data-h]').forEach(a => {
    const h = a.dataset.h;
    if (CAT.has(h)) { a.href = '#/f/' + h; }
    else { const s = document.createElement('span'); s.textContent = a.textContent; a.replaceWith(s); }
  });
}

function carte(e) {
  return `<li><a href="#/f/${e.h}"><span class="n">${ech(e.n)}</span>` +
    (e.t ? ` <span class="t">${ech(e.t)}</span>` : '') + `</a></li>`;
}

function listeAvecLettres(items) {
  if (!items.length) return `<p class="rien">Rien ici.</p>`;
  let out = '<ul class="liste">', lettre = '';
  for (const e of items) {
    const l = (nrm(e.n)[0] || '#').toUpperCase();
    if (l !== lettre) { lettre = l; out += `<li class="lettre">${l}</li>`; }
    out += carte(e);
  }
  return out + '</ul>';
}

async function vueFiche(h) {
  $('#vue').innerHTML = '<p class="charge">Déchiffrement…</p>';
  const f = await ficheEntiere(h);
  if (!f) { $('#vue').innerHTML = `<p class="rien">Cette page ne t'est pas ouverte.</p>`; return; }
  const e = f.entree;
  let out = '';
  if (e) {
    out += `<h1 class="tt">${ech(e.n)}</h1>`;
    if (e.ti) out += `<p class="stt">${ech(e.ti)}</p>`;
    const m = [];
    if (e.k) m.push(ech(e.k));
    if (e.al && e.al.length) m.push('alias : ' + e.al.map(ech).join(', '));
    // la ligne de source cite l'ouvrage réel : réservée au MJ sauf réglage
    if ((MOI.mj || META.src) && e.src && e.src.length) m.push(ech(String(e.src[0])));
    out += `<p class="meta">${m.map(x => '<span>' + x + '</span>').join('')}</p>`;
    if (MOI.mj && window.editerFiche)
      out += `<p class="mj-actions"><a class="puce" id="mj-editer">✏️ Modifier</a>
        <a class="puce" id="mj-mention">📋 Copier la mention @</a></p>`;
    if (e.hz === 'scenario')
      out += `<div class="bandeau">⚠ Ce qui suit n'existe que si l'aventure est jouée : ` +
        `rien n'en est encore vrai dans le monde.</div>`;
    if (e.img || e.h)
      out += `<div class="tete">` +
        (e.img ? `<figure class="portrait" id="visuel"></figure>` : '') +
        (e.h ? `<div class="entree">${e.h}</div>` : '') + `</div>`;
    if (e.tg && e.tg.length)
      out += `<p>${e.tg.map(t => `<a class="puce" href="#/t/${encodeURIComponent(t)}">${ech(String(t))}</a>`).join('')}</p>`;
  }
  for (const r of f.rubriques) {
    const b = BAL[r.d.bal] ?? 4;
    out += `<section class="rub"><h2><span>${ech(r.d.t || '')}</span>` +
      `<span class="bal b${b}">${ech(r.d.bal || '')}</span></h2>${r.d.h}</section>`;
  }
  $('#vue').innerHTML = out;
  // mémorise les six dernières fiches lues, sur cet appareil seulement
  try {
    const vu = JSON.parse(localStorage.getItem('hw.vu') || '[]').filter(x => x !== h);
    vu.unshift(h);
    localStorage.setItem('hw.vu', JSON.stringify(vu.slice(0, 6)));
  } catch (err) { }
  armerTables($('#vue'));
  if (e && e.img) chargerVisuel(h);
  liens($('#vue'));
  const be = $('#mj-editer');
  if (be) be.onclick = () => editerFiche(h);
  const bm = $('#mj-mention');
  if (bm) bm.onclick = async () => {
    // collée dans une autre fiche, cette mention devient un lien au rendu
    const m = '@' + (e ? e.n : '');
    try { await navigator.clipboard.writeText(m); bm.textContent = `✓ ${m} copié`; }
    catch (err) { prompt('Copie cette mention :', m); }
  };
  window.scrollTo(0, 0);
  document.title = (e ? e.n + ' — ' : '') + META.titre;
}

/** Les tables à jet du corpus deviennent jouables : toute table dont la
 *  première colonne s'appelle « d20 », « 1d20 », « 2d6 »… reçoit un bouton
 *  🎲. Le jet surligne la ligne obtenue et affiche le résultat en clair.
 *  Les plages « 1–5 » et les valeurs simples sont comprises. */
function armerTables(racine) {
  racine.querySelectorAll('.tw table').forEach(table => {
    const th = table.querySelector('thead th');
    const m = th && th.textContent.trim().match(/^(\d*)d(\d+)$/i);
    if (!m) return;
    const nb = parseInt(m[1] || '1', 10), faces = parseInt(m[2], 10);
    if (!faces || faces > 1000 || nb > 20) return;
    const conteneur = table.closest('.tw');
    const barre = document.createElement('p');
    barre.className = 'de-barre';
    barre.innerHTML = `<button class="btn2 de-btn">🎲 Lancer ${nb > 1 ? nb : ''}d${faces}</button>
      <span class="de-resultat"></span>`;
    conteneur.before(barre);
    barre.querySelector('.de-btn').onclick = () => {
      let total = 0;
      for (let i = 0; i < nb; i++) total += 1 + Math.floor(Math.random() * faces);
      let ligne = null;
      table.querySelectorAll('tbody tr').forEach(tr => {
        tr.classList.remove('de-touche');
        const c = tr.cells[0] ? tr.cells[0].textContent.trim() : '';
        const plage = c.match(/^(\d+)\s*[–\-—à]+\s*(\d+)/);
        const seul = c.match(/^(\d+)\+?$/);
        if ((plage && total >= +plage[1] && total <= +plage[2])
          || (seul && (+seul[1] === total || (c.endsWith('+') && total >= +seul[1]))))
          ligne = tr;
      });
      const sortie = barre.querySelector('.de-resultat');
      if (ligne) {
        ligne.classList.add('de-touche');
        ligne.scrollIntoView({ block: 'nearest' });
        const texte = [...ligne.cells].slice(1).map(c => c.textContent.trim()).join(' — ');
        sortie.innerHTML = `<b>${total}</b> → ${ech(texte)}`;
      } else sortie.innerHTML = `<b>${total}</b> — hors table`;
    };
  });
}

/** Le visuel d'une fiche est chiffré avec une clé dérivée du coffre de son
 *  entrée : qui lit la fiche voit l'image, personne d'autre. */
async function chargerVisuel(h) {
  const c = await conteneur(h);
  const b0 = c && c.f.find(x => x.o === 0);
  const brut = b0 && TAGS.get(b0.v);
  if (!brut) return;
  const paquet = await prendre('img/' + h + '.bin');
  if (!paquet) return;
  const d = await ouvrir(await hkdf(brut, 'img:' + h), paquet);
  const el = document.getElementById('visuel');
  if (d && el) el.innerHTML = `<img src="data:${d.m};base64,${d.d}" alt="">`;
}

/** Un rayon se feuillette par catégorie, pas par alphabet : personne ne
 *  cherche « Absorption cinétique » sans savoir d'abord qu'il cherche un
 *  pouvoir. Chaque catégorie se replie d'un toucher. */
function listeParCategories(items, bible) {
  if (!items.length) return `<p class="rien">Rien ici.</p>`;
  const cats = new Map();
  for (const e of items) {
    const k = e.k || 'Autres';
    if (!cats.has(k)) cats.set(k, []);
    cats.get(k).push(e);
  }
  const pref = CAT_ORDRE[bible] || [];
  const ordre = [...cats.entries()].sort((a, b) => {
    const ia = pref.indexOf(a[0]), ib = pref.indexOf(b[0]);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return b[1].length - a[1].length;
  });

  // Repliées par défaut ; l'état ouvert survit à la navigation, par rayon,
  // sur cet appareil.
  let ouverts = new Set();
  try { ouverts = new Set(JSON.parse(localStorage.getItem('hw.ouvert.' + bible) || '[]')); } catch (e) { }

  // Les 540 lieux se subdivisent par région du monde, d'après leurs
  // étiquettes — Freedom City d'abord, puis le tour d'Earth-Prime.
  const REGIONS = ['Freedom City', 'Emerald City', 'États-Unis', 'Caraïbes',
    'Amérique centrale', 'Amérique du Sud', 'Méditerranée', 'Moyen-Orient',
    'Afrique subsaharienne', 'Asie centrale', 'Asie orientale', 'Australasie'];
  const AILLEURS = 'Ailleurs & au-delà';

  const sousListe = (k, l) => {
    if (!(bible === 'lore' && k === 'Lieu' && l.length > 40))
      return '<ul class="liste">' + l.map(carte).join('') + '</ul>';
    const sous = new Map();
    for (const e of l) {
      const r = REGIONS.find(x => (e.tg || []).some(t => String(t) === x)) || AILLEURS;
      if (!sous.has(r)) sous.set(r, []);
      sous.get(r).push(e);
    }
    const rOrdre = [...REGIONS.filter(r => sous.has(r)), ...(sous.has(AILLEURS) ? [AILLEURS] : [])];
    return rOrdre.map(r =>
      `<details class="sous"${ouverts.has(k + '/' + r) ? ' open' : ''} data-m="${ech(k + '/' + r)}">` +
      `<summary><span>${ech(r)}</span> <i>${sous.get(r).length}</i></summary>` +
      '<ul class="liste">' + sous.get(r).map(carte).join('') + '</ul></details>').join('');
  };

  // pas de vraies ancres : un « # » dans l'adresse relancerait le routeur
  let out = '<p>' + ordre.map(([k, l]) =>
    `<a class="puce" data-cat="${ech(k)}">${ech(k)} ${l.length}</a>`).join('') + '</p>';
  for (const [k, l] of ordre) {
    out += `<details class="cat"${ouverts.has(k) ? ' open' : ''} data-c="${ech(k)}" data-m="${ech(k)}">` +
      `<summary><span>${ech(k)}</span> <i>${l.length}</i></summary>` +
      sousListe(k, l) + '</details>';
  }
  setTimeout(() => {
    document.querySelectorAll('[data-cat]').forEach(a => a.onclick = () => {
      const cible = [...document.querySelectorAll('details.cat')].find(d => d.dataset.c === a.dataset.cat);
      if (cible) { cible.open = true; cible.scrollIntoView({ behavior: 'smooth' }); }
    });
    document.querySelectorAll('details[data-m]').forEach(d => d.addEventListener('toggle', () => {
      d.open ? ouverts.add(d.dataset.m) : ouverts.delete(d.dataset.m);
      try { localStorage.setItem('hw.ouvert.' + bible, JSON.stringify([...ouverts])); } catch (e) { }
    }));
  }, 0);
  return out;
}

function vueRayon(bible, filtre) {
  const f = nrm(filtre || '');
  let items = ORDRE.filter(e => e.b === bible);
  if (f) items = items.filter(e => nrm(e.n).includes(f) || nrm(e.t || '').includes(f));
  const r = RAYONS.find(x => x.id === bible) || { nom: bible, ico: '' };
  const parCats = ['lore', 'pnj', 'regles', 'campagne'].includes(bible) && !f;
  $('#vue').innerHTML = `<h1 class="tt">${r.ico} ${ech(r.nom)}</h1>` +
    `<p class="meta"><span>${items.length} fiche${items.length > 1 ? 's' : ''}</span></p>` +
    `<div class="champ champ-rayon"><input id="filtre-rayon" type="search"
      placeholder="filtrer ${ech(r.nom.toLowerCase())}…" autocapitalize="none"
      value="${ech(filtre || '')}"></div>` +
    (parCats ? listeParCategories(items, bible) : listeAvecLettres(items));
  const fr = $('#filtre-rayon');
  let tmp = null;
  fr.addEventListener('input', () => {
    clearTimeout(tmp);
    tmp = setTimeout(() => { $('#filtre').value = fr.value; vueRayon(bible, fr.value); }, 200);
  });
  if (filtre) { fr.focus(); fr.selectionStart = fr.selectionEnd = fr.value.length; }
  else window.scrollTo(0, 0);
  document.title = r.nom + ' — ' + META.titre;
}

function vueTag(t) {
  const n = nrm(t);
  const items = ORDRE.filter(e => (e.tg || []).some(x => nrm(String(x)) === n));
  $('#vue').innerHTML = `<h1 class="tt">${ech(t)}</h1>` +
    `<p class="meta"><span>${items.length} fiche${items.length > 1 ? 's' : ''}</span></p>` +
    listeAvecLettres(items);
  window.scrollTo(0, 0);
}

let recherche_en_cours = null;

async function vueRecherche(q) {
  $('#vue').innerHTML = '<p class="charge">Recherche…</p>';
  const res = await chercher(q);
  recherche_en_cours = res;
  if (!res.length) {
    $('#vue').innerHTML = `<h1 class="tt">« ${ech(q)} »</h1>` +
      `<p class="rien">Rien trouvé. Essaie un mot plus court, ou une orthographe voisine.</p>`;
    return;
  }
  $('#vue').innerHTML = `<h1 class="tt">« ${ech(q)} »</h1>` +
    `<p class="meta"><span>${res.length} résultat${res.length > 1 ? 's' : ''}</span></p>` +
    '<ul class="liste">' + res.map(r =>
      `<li><a href="#/f/${r.h}"><span class="n">${ech(r.e.n)}</span>` +
      (r.e.t ? ` <span class="t">${ech(r.e.t)}</span>` : '') +
      `<span class="x" id="x-${r.h}"></span></a></li>`).join('') + '</ul>';
  window.scrollTo(0, 0);
  poserExtraits(res, () => recherche_en_cours);
}

async function vueAccueil() {
  const parRayon = RAYONS.map(r => ({ ...r, n: ORDRE.filter(e => e.b === r.id).length }))
    .filter(r => r.n);

  // un article au hasard PAR rayon, retiré à chaque chargement
  const surpr = [];
  for (const r of parRayon) {
    const pool = ORDRE.filter(e => e.b === r.id && e.h !== MOI.pjh);
    if (pool.length) surpr.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  // liens utiles : sa fiche, celles de ses camarades, les portes du monde
  const camarades = ORDRE.filter(e => e.b === 'pj' && e.h !== MOI.pjh);
  const portes = ['Claremont Academy', 'Freedom City']
    .map(n => ORDRE.find(e => e.n === n)).filter(Boolean);

  let out = `
    <h1 class="tt">Bienvenue sur ${ech(META.titre)}, ${ech(MOI.nom)}</h1>
    <p class="stt">${ech(META.sous_titre || '')}</p>
    <div id="accueil-mot"></div>`;

  if (MOI.pjh && CAT.has(MOI.pjh)) {
    const moi = CAT.get(MOI.pjh);
    out += `<h2>⭐ ${ech(moi.n)}${moi.t ? ` <span class="stt petit">${ech(moi.t)}</span>` : ''}</h2>
      <div class="visuel" id="visuel"></div>
      <p><a class="puce" href="#/f/${MOI.pjh}">Ouvrir ma fiche complète</a></p>
      <div id="accueil-statbloc"></div>`;
  }

  out += `<h2>🔗 Liens utiles</h2><ul class="liste">`;
  if (MOI.pjh && CAT.has(MOI.pjh))
    out += `<li><a href="#/f/${MOI.pjh}"><span class="n">⭐ Ma fiche — ${ech(CAT.get(MOI.pjh).n)}</span></a></li>`;
  out += camarades.map(e =>
    `<li><a href="#/f/${e.h}"><span class="n">🦸 ${ech(e.n)}</span>` +
    (e.t ? ` <span class="t">${ech(e.t)}</span>` : '') + `</a></li>`).join('');
  out += portes.map(e =>
    `<li><a href="#/f/${e.h}"><span class="n">📍 ${ech(e.n)}</span></a></li>`).join('');
  out += parRayon.map(r =>
    `<li><a href="#/r/${r.id}"><span class="n">${r.ico} ${ech(r.nom)}</span>` +
    `<span class="x">${r.n} fiches</span></a></li>`).join('') + '</ul>';

  // reprendre où on en était — mémoire locale de l'appareil, rien en ligne
  let repris = [];
  try {
    repris = JSON.parse(localStorage.getItem('hw.vu') || '[]')
      .map(x => CAT.get(x)).filter(Boolean).slice(0, 5);
  } catch (e) { }
  if (repris.length)
    out += `<h2>📖 Reprendre la lecture</h2><ul class="liste">${repris.map(carte).join('')}</ul>`;

  out += `<h2>🎲 À découvrir</h2><ul class="liste">${surpr.map(carte).join('')}</ul>`;

  $('#vue').innerHTML = out;
  document.title = META.titre;
  window.scrollTo(0, 0);

  // le mot d'accueil du MJ (chiffré Grand public)
  (async () => {
    const brut = MOI.coffres.get('p0');
    const paquet = brut && await prendre('accueil.bin');
    if (!paquet) return;
    const d = await ouvrir(await hkdf(brut, 'accueil'), paquet);
    const el = document.getElementById('accueil-mot');
    if (d && el) { el.innerHTML = `<div class="entree">${d.h}</div>`; liens(el); }
  })();

  // le visuel et le statbloc de son personnage
  if (MOI.pjh && CAT.has(MOI.pjh)) {
    chargerVisuel(MOI.pjh);
    (async () => {
      const f = await ficheEntiere(MOI.pjh);
      const el = document.getElementById('accueil-statbloc');
      if (!f || !el) return;
      const sb = f.rubriques.find(r => /statbloc/i.test(r.d.t || ''));
      if (sb) {
        el.innerHTML = `<section class="rub"><h2><span>${ech(sb.d.t)}</span></h2>${sb.d.h}</section>`;
        liens(el);
      }
    })();
  }
}

/* ── colonne latérale ───────────────────────────────────────────────────── */

function peuplerCote() {
  $('#rayons').innerHTML = '<h4>Rayons</h4>' + RAYONS
    .map(r => ({ ...r, n: ORDRE.filter(e => e.b === r.id).length }))
    .filter(r => r.n)
    .map(r => `<a class="ray" data-r="${r.id}" href="#/r/${r.id}"><b>${r.ico} ${ech(r.nom)}</b><i>${r.n}</i></a>`)
    .join('');

  // Les étiquettes nomment les ouvrages sources : réservées au MJ, elles
  // casseraient l'immersion (et révèleraient la gamme) côté joueurs.
  $('#bloc-tags').hidden = !MOI.mj;
  const c = new Map();
  ORDRE.forEach(e => (e.tg || []).forEach(t => c.set(String(t), (c.get(String(t)) || 0) + 1)));
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28);
  $('#tags').innerHTML = MOI.mj ? top.map(([t, n]) =>
    `<a class="puce" href="#/t/${encodeURIComponent(t)}">${ech(t)} ${n}</a>`).join('') : '';

  const types = new Map();
  ORDRE.forEach(e => { if (e.k) types.set(e.k, (types.get(e.k) || 0) + 1); });
  $('#types').innerHTML = [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([t, n]) => `<a class="puce" data-k="${ech(t)}">${ech(t)} ${n}</a>`).join('');
  $('#types').onclick = ev => {
    const a = ev.target.closest('[data-k]'); if (!a) return;
    const k = a.dataset.k;
    const items = ORDRE.filter(e => e.k === k);
    $('#vue').innerHTML = `<h1 class="tt">${ech(k)}</h1>` +
      `<p class="meta"><span>${items.length} fiches</span></p>` + listeAvecLettres(items);
    fermerCote();
  };
  $('#compteur').textContent = `${ORDRE.length} pages · ${MOI.mj ? 'accès MJ' : 'accès joueur'}`;
}

const fermerCote = () => document.body.classList.remove('ouvert');

/* ── routage ────────────────────────────────────────────────────────────── */

async function router() {
  const h = location.hash.replace(/^#\/?/, '');
  const [quoi, ...reste] = h.split('/');
  const arg = decodeURIComponent(reste.join('/') || '');
  document.querySelectorAll('.ray').forEach(a =>
    a.classList.toggle('on', quoi === 'r' && a.dataset.r === arg));
  $('#retour').hidden = !quoi;
  fermerCote();
  if (quoi === 'mj' && window.vueMJ) return vueMJ(arg);
  if (quoi === 'f') return vueFiche(arg);
  if (quoi === 'r') return vueRayon(arg, $('#filtre').value);
  if (quoi === 't') return vueTag(arg);
  if (quoi === 'q') { $('#q').value = arg; return vueRecherche(arg); }
  return vueAccueil();
}

/* ── démarrage ──────────────────────────────────────────────────────────── */

async function demarrer(tr) {
  window.TR_COURANT = tr;        // la page MJ s'en sert pour « voir comme »
  await installer(tr);
  $('#porte').hidden = true;
  $('#app').hidden = false;
  $('#logo').querySelector('span').textContent = META.titre;
  $('#qui').title = MOI.nom + (MOI.mj ? ' — MJ' : '');
  $('#mj-btn').hidden = !MOI.mj;
  peuplerCote();
  await router();
}

async function tenter(phrase, memoriser) {
  document.body.classList.add('travail');
  try {
    const k = await cleDePhrase(phrase);
    const tr = await ouvrirTrousseau(k);
    if (!tr) return false;
    if (memoriser) try { localStorage.setItem('hw.k', btoa(String.fromCharCode(...k))); } catch (e) { }
    await demarrer(tr);
    return true;
  } finally { document.body.classList.remove('travail'); }
}

(async function () {
  META = await (await fetch('meta.json', { cache: 'no-cache' })).json();
  SEL = deb64(META.sel);
  $('#porte-titre').textContent = META.titre;
  $('#porte-sous').textContent = META.porte || META.sous_titre || '';
  document.title = META.titre;

  if (!window.DecompressionStream) {
    $('#porte-msg').textContent = "Ce navigateur est trop ancien. Essaie Chrome, Edge, Firefox ou Safari récent.";
    return;
  }

  // lien direct : la phrase voyage dans le fragment (#), qui ne part jamais
  // sur le réseau. On l'efface de la barre et de l'historique aussitôt lue.
  const lien = location.hash.match(/^#\/?cle=(.+)$/);
  if (lien) {
    history.replaceState(null, '', location.pathname + location.search);
    if (await tenter(decodeURIComponent(lien[1]), true)) return;
    $('#porte-msg').textContent = "Ce lien d'accès n'est plus valable — demande le nouveau au MJ.";
  }

  // reprise silencieuse
  try {
    const s = localStorage.getItem('hw.k');
    if (s) {
      const tr = await ouvrirTrousseau(deb64(s));
      if (tr) { await demarrer(tr); return; }
      localStorage.removeItem('hw.k');
    }
  } catch (e) { }

  $('#porte-form').onsubmit = async ev => {
    ev.preventDefault();
    const p = $('#phrase').value.trim();
    if (!p) return;
    $('#porte-ok').disabled = true;
    $('#porte-msg').className = 'msg ok';
    $('#porte-msg').textContent = 'Ouverture du trousseau…';
    const ok = await tenter(p, $('#memo').checked);
    if (!ok) {
      $('#porte-ok').disabled = false;
      $('#porte-msg').className = 'msg';
      $('#porte-msg').textContent = 'Cette phrase de passe ne correspond à aucun accès.';
      $('#phrase').select();
    }
  };
})();

/* ── interactions ───────────────────────────────────────────────────────── */

window.addEventListener('hashchange', router);
$('#retour').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/');
$('#mj-btn').onclick = () => location.hash = '#/mj';
$('#voirph').onclick = () => {
  const p = $('#phrase');
  p.type = p.type === 'password' ? 'text' : 'password';
  p.focus();
};
$('#menu').onclick = () => document.body.classList.toggle('ouvert');
$('#voile').onclick = fermerCote;

let minuteur = null;
$('#q').addEventListener('input', () => {
  const v = $('#q').value.trim();
  $('#q-vider').hidden = !v;
  clearTimeout(minuteur);
  minuteur = setTimeout(() => {
    if (v.length >= 2) location.hash = '#/q/' + encodeURIComponent(v);
    else if (!v && location.hash.startsWith('#/q/')) location.hash = '#/';
  }, 220);
});
$('#q-vider').onclick = () => { $('#q').value = ''; $('#q-vider').hidden = true; location.hash = '#/'; };
$('#filtre').addEventListener('input', () => {
  if (location.hash.startsWith('#/r/')) router();
});
$('#qui').onclick = () => {
  const quoi = MOI.mj ? 'Tu vois tout.' : `Groupe : ${MOI.groupe || '—'}.`;
  $('#vue').innerHTML = `<h1 class="tt">Mon accès</h1>
    <div class="entree"><p><b>${ech(MOI.nom)}</b><br>${quoi}<br>
    ${ORDRE.length} pages te sont ouvertes.</p></div>
    <p><a id="sortir">Oublier ma phrase de passe sur cet appareil</a></p>`;
  $('#sortir').onclick = () => {
    try { localStorage.removeItem('hw.k'); } catch (e) { }
    location.reload();
  };
  fermerCote();
};
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape') fermerCote();
});
