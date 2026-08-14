/* ═══════════════════════════════════════════════════════════════════════════
   HeroWiki — la page MJ.  Ce fichier est public ; il ne contient aucun secret.

   Tout ce qu'il affiche sort d'`admin.bin`, un paquet chiffré pour le seul
   coffre MJ : configuration, accès (phrases comprises — même protection que
   le reste du contenu MJ), compteurs, et la carte des fiches nécessaire à
   l'édition en direct.

   L'édition en direct écrit à DEUX endroits, via l'API GitHub :
     1. la source markdown, dans le dépôt privé — pour que la modification
        survive au prochain Publier ;
     2. le conteneur chiffré de la fiche, dans le dépôt public — pour que la
        modification soit visible dans la minute.
   Le rendu navigateur est un portage fidèle mais léger de celui du
   générateur ; le prochain Publier renormalise tout (rendu, listes, index).
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

let ADMIN = null;

async function chargerAdmin() {
  if (ADMIN) return ADMIN;
  const brut = MOI.coffres.get('p4');
  if (!brut) return null;
  const paquet = await prendre('admin.bin');
  if (!paquet) return null;
  ADMIN = await ouvrir(await hkdf(brut, 'admin'), paquet);
  return ADMIN;
}

/* ── jeton GitHub ───────────────────────────────────────────────────────── */

const jeton = {
  lire() { try { return localStorage.getItem('hw.pat') || ''; } catch (e) { return ''; } },
  poser(t) { try { t ? localStorage.setItem('hw.pat', t) : localStorage.removeItem('hw.pat'); } catch (e) { } },
};

async function gh(methode, depot, chemin, corps) {
  const r = await fetch(`https://api.github.com/repos/${depot}/contents/${chemin}`, {
    method: methode,
    headers: {
      Authorization: 'Bearer ' + jeton.lire(),
      Accept: 'application/vnd.github+json',
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} sur ${chemin}` +
    (r.status === 401 || r.status === 403 ? ' — jeton absent, expiré ou sans droits' : ''));
  return r.json();
}

function b64utf8(s) {
  const b = enc.encode(s);
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000)
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(out);
}
function b64vers(b) {
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000)
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(out);
}
function deb64utf8(s) {
  return dec.decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
}

/* ── portage du rendu : markdown du corpus → HTML ───────────────────────── */

const MJ_MENTION = /@((?:les|le|la|l'|l’|un|une|des)\s+)?([A-ZÀ-ÖØ-ÝŒÆ…a-zà-öø-ÿ][\wÀ-ÿŒœÆæ'’«»\-…]*\.?(?:\s+[\wÀ-ÿŒœÆæ'’«»\-…]+\.?){0,7})/g;
const MJ_QUEUE = /\s+(?:et|ou|de|du|des|la|le|les|à|au|aux|en|dans|pour|par|sur|sous|avec|sans|qui|que|dont|est|sont|a|ont|se|ne)$/i;

function* mjCandidats(brut) {
  brut = brut.replace(/[,;]+$/, '');
  const mots = brut.split(/\s+/);
  for (let n = mots.length; n > 0; n--) {
    const bout = mots.slice(0, n).join(' ').replace(MJ_QUEUE, '');
    if (bout) yield bout;
  }
}

function mjEnligne(s) {
  s = ech(s);
  const garde = [];
  s = s.replace(/\\([*_|\\`#\[\]<>-])/g, (m, c) => { garde.push(c); return `\x00${garde.length - 1}\x01`; });
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, '$1<i>$2</i>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\x00(\d+)\x01/g, (m, i) => garde[+i]);
  s = s.replace(MJ_MENTION, (tout, art, nom) => {
    const brut = (art || '') + nom;
    for (const essai of [...mjCandidats(brut), ...mjCandidats(nom)]) {
      const cible = ADMIN.noms[nrm(essai)];
      if (cible) {
        const reste = brut.toLowerCase().startsWith(essai.toLowerCase())
          ? brut.slice(essai.length) : '';
        return `<a data-h="${cible}">${essai}</a>${reste}`;
      }
    }
    return brut;
  });
  return s;
}

function mjRendre(texte) {
  const L = texte.split('\n');
  const T = /^\s*\|.*\|\s*$/, SEP = /^\s*\|[\s:|-]+\|\s*$/, LI = /^\s*[-*]\s+/;
  const out = [];
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (T.test(l) && i + 1 < L.length && SEP.test(L[i + 1])) {
      const th = l.trim().replace(/^\||\|$/g, '').split('|').map(c => `<th>${mjEnligne(c.trim())}</th>`).join('');
      i += 2;
      let tr = '';
      while (i < L.length && T.test(L[i])) {
        tr += '<tr>' + L[i].trim().replace(/^\||\|$/g, '').split('|')
          .map(c => `<td>${mjEnligne(c.trim())}</td>`).join('') + '</tr>';
        i++;
      }
      out.push(`<div class=tw><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }
    if (LI.test(l)) {
      const items = [];
      while (i < L.length && (LI.test(L[i]) || (items.length && /^  \S/.test(L[i])))) {
        if (LI.test(L[i])) items.push(L[i].replace(LI, ''));
        else items[items.length - 1] += ' ' + L[i].trim();
        i++;
      }
      out.push('<ul>' + items.map(x => `<li>${mjEnligne(x)}</li>`).join('') + '</ul>');
      continue;
    }
    if (l.startsWith('>')) {
      const bloc = [];
      while (i < L.length && L[i].startsWith('>')) { bloc.push(L[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${mjEnligne(bloc.join(' '))}</blockquote>`);
      continue;
    }
    const H = l.match(/^(#{3,6})\s+(.*)/);
    if (H) { const n = Math.min(H[1].length + 1, 6); out.push(`<h${n}>${mjEnligne(H[2])}</h${n}>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < L.length && L[i].trim() && !T.test(L[i]) && !LI.test(L[i])
           && !L[i].startsWith('>') && !/^#{3,6}\s/.test(L[i])) { para.push(L[i].trim()); i++; }
    out.push(`<p>${mjEnligne(para.join(' '))}</p>`);
  }
  return out.join('');
}

/* ── analyse d'une fiche source ─────────────────────────────────────────── */

function mjParser(source) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("En-tête YAML introuvable (la fiche doit commencer par ---)");
  const meta = {};
  let cle = null;
  for (const ligne of m[1].split('\n')) {
    const kv = ligne.match(/^(\w[\w_]*):\s*(.*)$/);
    if (kv) {
      cle = kv[1];
      let v = kv[2].trim();
      if (v.startsWith('[')) {
        meta[cle] = v.replace(/^\[|\]$/g, '').split(',').map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
      } else meta[cle] = v.replace(/^"|"$/g, '');
    } else {
      const it = ligne.match(/^\s+-\s+(.*)$/);
      if (it && cle) {
        if (!Array.isArray(meta[cle])) meta[cle] = [];
        meta[cle].push(it[1].trim().replace(/^"|"$/g, ''));
      }
    }
  }
  const corps = source.slice(m[0].length);
  const coupes = [...corps.matchAll(/^## \[([^\]]+)\]\s*(.*)$/gm)];
  const preambule = (coupes.length ? corps.slice(0, coupes[0].index) : corps).trim();
  const rubriques = coupes.map((c, i) => ({
    balise: c[1].trim(), titre: c[2].trim(),
    texte: corps.slice(c.index + c[0].length, i + 1 < coupes.length ? coupes[i + 1].index : undefined).trim(),
  }));
  return { meta, preambule, rubriques };
}

const MJ_PALIERS = { 'Grand public': 'p0', 'Super': 'p1', 'Secret': 'p2', 'Très secret': 'p3',
  'MJ only': 'p4', 'Projet Isekai': 'p4' };

function mjCoffre(fiche, balise) {
  const meta = fiche.meta;
  const montrer = String((ADMIN.config.avance || {}).montrer_horizon_scenario || '')
    .match(/^(oui|true|yes|1)$/i);
  if ((meta.bible || '') === 'pj')
    return nrm(meta.etat || '') === 'complet' ? 'g:' + (meta.groupe || '') : 'p4';
  if ((meta.horizon || 'etabli') === 'scenario' && !montrer) return 'p4';
  return MJ_PALIERS[balise] || 'p4';
}

/* ── chiffrement côté navigateur ────────────────────────────────────────── */

async function mjGz(b) {
  const s = new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function mjSceller(cleBrut, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', cleBrut, 'AES-GCM', false, ['encrypt']);
  const corps = await mjGz(enc.encode(JSON.stringify(obj)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, corps));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

async function mjTag(nomCoffre) {
  return hex(await sha256(SEL, enc.encode('coffre:'), enc.encode(nomCoffre))).slice(0, 16);
}

/** Refabrique le conteneur chiffré d'une fiche à partir de sa source. */
async function mjConteneur(h, fiche) {
  const meta = fiche.meta;
  const frags = [{
    o: 0, coffre: mjCoffre(fiche, meta.confidentialite || 'MJ only'),
    contenu: {
      n: meta.nom || '', ti: meta.titre || '', k: meta.type || meta.type_kanka || '',
      b: meta.bible || '', tg: meta.tags || [], src: meta.sources || [],
      hz: meta.horizon || 'etabli', al: meta.alias || [],
      h: mjRendre(fiche.preambule),
      ...(meta.visuel ? { img: 1 } : {}),
    },
  }];
  fiche.rubriques.forEach((r, i) => frags.push({
    o: i + 1, coffre: mjCoffre(fiche, r.balise),
    contenu: { t: r.titre, bal: r.balise, h: mjRendre(r.texte) },
  }));
  const conteneur = [];
  for (const fr of frags) {
    const brut = MOI.coffres.get(fr.coffre);
    if (!brut) throw new Error(`Coffre inconnu : ${fr.coffre}`);
    const cle = await hkdf(brut, `frag:${h}#${fr.o}`);
    conteneur.push({ o: fr.o, v: await mjTag(fr.coffre), c: b64vers(await mjSceller(cle, fr.contenu)) });
  }
  return { json: JSON.stringify({ f: conteneur }), frags };
}

/* ── voir le site comme un joueur ───────────────────────────────────────── */
/* Le MJ a toutes les clés de coffre ; la vue d'un joueur n'est qu'un
   sous-ensemble. On fabrique un trousseau de simulation à partir des noms de
   coffres du joueur (fournis par admin.bin) et des clés du MJ, et on relance
   le site avec. Aucune phrase de passe n'est touchée. */

window.voirComme = async function (nom) {
  const a = await chargerAdmin();
  const vue = a && a.vues && a.vues[nom];
  if (!vue) return;
  if (!window.MJ_TR) window.MJ_TR = TR_COURANT;
  const reelles = new Map(MOI.coffres);
  const tr = { nom, mj: false, groupe: vue.groupe, pj: vue.pj || null,
               v: {}, f: {}, _simulation: true };
  for (const c of vue.v) {
    const b = reelles.get(c);
    if (b) tr.v[c] = b64vers(b);
  }
  for (const [fid, c] of Object.entries(vue.f || {})) {
    const b = reelles.get(c);
    if (b) tr.f[fid] = b64vers(await hkdf(b, 'frag:' + fid));
  }
  /* La messagerie aussi se simule : mêmes canaux que le joueur, avec SES
     étiquettes (« Avec le MJ », « 💬 Untel ») — les clés viennent du
     trousseau du MJ, qui a tout. */
  if (MJ_TR.m) {
    tr.m = {};
    const vm = vue.msg || {};
    const ids = Array.isArray(vm) ? vm : Object.keys(vm);
    for (const id of ids)
      if (MJ_TR.m[id])
        tr.m[id] = { n: Array.isArray(vm) ? MJ_TR.m[id].n : vm[id],
                     k: MJ_TR.m[id].k };
    tr.ctc = vue.ctc || [];
  }
  await demarrer(tr);
  location.hash = '#/';
  let b = document.getElementById('simu');
  if (!b) { b = document.createElement('div'); b.id = 'simu'; document.body.appendChild(b); }
  b.innerHTML = `👁 Tu vois le site comme <b>${ech(nom)}</b> — <a id="simu-fin">revenir MJ</a>`;
  document.getElementById('simu-fin').onclick = async () => {
    b.remove();
    await demarrer(MJ_TR);
    location.hash = '#/mj';
  };
};

/* ── campagne.yml : émission depuis la page MJ ──────────────────────────── */

function ym(v) {
  const s = String(v);
  return /^[\w.\-]+$/.test(s) ? s : JSON.stringify(s);
}

function emettreCampagne(cfg) {
  const L = [];
  L.push('# Fichier régénéré depuis la page MJ du site — le détail des options');
  L.push('# est dans GUIDE.md. Les commentaires manuels ne sont pas conservés.');
  L.push('');
  L.push('site:');
  for (const [k, v] of Object.entries(cfg.site || {})) L.push(`  ${k}: ${ym(v)}`);
  L.push('', 'groupes:');
  for (const [id, g] of Object.entries(cfg.groupes || {})) {
    L.push(`  ${id}:`);
    L.push(`    nom: ${ym(g.nom || id)}`);
    L.push(`    palier: ${ym(g.palier || 'Grand public')}`);
  }
  L.push('', 'joueurs:');
  for (const j of cfg.joueurs || []) {
    L.push(`  - nom: ${ym(j.nom)}`);
    if (String(j.role || '').toLowerCase() === 'mj') L.push('    role: mj');
    else {
      if (j.groupe) L.push(`    groupe: ${j.groupe}`);
      if (j.palier) L.push(`    palier: ${ym(j.palier)}`);
      if (j.pj) L.push(`    pj: ${ym(j.pj)}`);
    }
  }
  L.push('', 'exceptions:');
  for (const sens of ['voit', 'voit_pas']) {
    const bloc = (cfg.exceptions || {})[sens] || {};
    const noms = Object.keys(bloc).filter(n => (bloc[n] || []).length);
    L.push(`  ${sens}:${noms.length ? '' : ' {}'}`);
    for (const n of noms) {
      L.push(`    ${ym(n)}:`);
      for (const spec of bloc[n]) L.push(`      - ${ym(spec)}`);
    }
  }
  L.push('', 'revelations:' + ((cfg.revelations || []).length ? '' : ' []'));
  for (const r of cfg.revelations || []) {
    L.push(`  - date: ${ym(r.date || '')}`);
    if (r.episode) L.push(`    episode: ${ym(r.episode)}`);
    if (r.groupe) L.push(`    groupe: ${r.groupe}`);
    L.push('    ouvre:');
    for (const o of r.ouvre || []) L.push(`      - ${ym(o)}`);
  }
  const m = cfg.messagerie || {};
  L.push('', 'messagerie:');
  L.push(`  actif: ${ym(m.actif || 'non')}`);
  L.push(`  firebase_url: ${ym(m.firebase_url || '')}`);
  const cx = m.canaux || [];
  L.push(`  canaux:${cx.length ? '' : ' []'}`);
  for (const c of cx) {
    L.push(`    - id: ${ym(c.id)}`);
    L.push(`      nom: ${ym(c.nom || c.id)}`);
    L.push('      membres:');
    for (const mb of c.membres || []) L.push(`        - ${ym(mb)}`);
  }
  const ctc = m.contacts || [];
  L.push(`  contacts:${ctc.length ? '' : ' []'}`);
  for (const n of ctc) L.push(`    - ${ym(n)}`);
  L.push('', 'avance:');
  for (const [k, v] of Object.entries(cfg.avance || {})) {
    if (k === 'rotation') {                       // liste → JSON (YAML le lit)
      if ((v || []).length) L.push(`  rotation: ${JSON.stringify(v)}`);
    } else if (k === 'renommer') {                // dict → JSON en ligne
      if (v && Object.keys(v).length) L.push(`  renommer: ${JSON.stringify(v)}`);
    } else L.push(`  ${k}: ${ym(v)}`);
  }
  L.push('');
  return L.join('\n');
}

async function sauverCampagne(cfg, message) {
  const a = await chargerAdmin();
  let sha;
  try { sha = (await gh('GET', a.depots.prive, 'campagne.yml?ref=main')).sha; }
  catch (e) { sha = undefined; }
  await gh('PUT', a.depots.prive, 'campagne.yml', {
    message, content: b64utf8(emettreCampagne(cfg)),
    ...(sha ? { sha } : {}), branch: 'main',
  });
  a.config = cfg;      // la page reflète le nouveau réglage sans attendre
}

/* ── l'éditeur ──────────────────────────────────────────────────────────── */

window.editerFiche = async function (h) {
  $('#vue').innerHTML = '<p class="charge">Ouverture de l\'éditeur…</p>';
  const admin = await chargerAdmin();
  if (!admin) { $('#vue').innerHTML = '<p class="rien">Paquet MJ introuvable.</p>'; return; }
  const info = admin.fiches[h];
  if (!info) { $('#vue').innerHTML = '<p class="rien">Fiche inconnue du paquet MJ.</p>'; return; }
  if (!jeton.lire()) { location.hash = '#/mj/jeton'; return; }

  let src, sha;
  try {
    const d = await gh('GET', admin.depots.prive, info.c + '?ref=main');
    src = deb64utf8(d.content); sha = d.sha;
  } catch (e) {
    $('#vue').innerHTML = `<p class="rien">Lecture impossible : ${ech(e.message)}</p>
      <p><a href="#/mj/jeton">Vérifier le jeton</a></p>`;
    return;
  }

  // Garde-fou : si un fragment vit dans un coffre d'exclusion, l'édition en
  // direct le renverrait dans son coffre commun — et l'exclu le verrait.
  const cont = await conteneur(h);
  const attendus = new Set();
  for (const c of [...Object.keys(MJ_PALIERS).map(p => MJ_PALIERS[p]),
                   ...[...MOI.coffres.keys()].filter(x => x.startsWith('g:'))])
    attendus.add(await mjTag(c));
  if (cont && cont.f.some(b => !attendus.has(b.v))) {
    $('#vue').innerHTML = `<p class="rien">Cette fiche porte une exception nominative
      (voit_pas) : modifie-la sur ton PC et passe par Publier, pour ne pas défaire
      l'exception.</p>`;
    return;
  }

  $('#vue').innerHTML = `
    <h1 class="tt">✏️ ${ech(info.n)}</h1>
    <p class="meta"><span>${ech(info.c)}</span></p>
    <p class="meta"><span>insérer une rubrique :</span>
      ${['Grand public', 'Super', 'Secret', 'Très secret', 'MJ only', 'Projet Isekai'].map((b, i) =>
        `<a class="puce bal-ins b${i}" data-bal="${b}">[${b}]</a>`).join('')}
      <a class="puce" id="ed-sceau" title="marque une invention dans le texte">🜲 sceau</a></p>
    <textarea id="ed" spellcheck="false">${ech(src)}</textarea>
    <div class="ed-b">
      <button id="ed-voir" class="btn2">Aperçu</button>
      <button id="ed-ok" class="btn1">Publier la modification</button>
      <label class="btn2 btn-fichier">🖼 Visuel…
        <input id="ed-img" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
      <a href="#/f/${h}" class="btn3">Annuler</a>
    </div>
    <p id="ed-msg" class="msg"></p>
    <div id="ed-apercu"></div>`;
  window.scrollTo(0, 0);
  const msg = t => { $('#ed-msg').className = 'msg ok'; $('#ed-msg').textContent = t; };

  // insère « ## [Balise] » au curseur — plus rapide que de la taper sans faute
  document.querySelectorAll('.bal-ins').forEach(el => el.onclick = () => {
    const ta = $('#ed');
    const bloc = `\n## [${el.dataset.bal}] Titre de la rubrique\n\n`;
    const p = ta.selectionStart;
    ta.value = ta.value.slice(0, p) + bloc + ta.value.slice(ta.selectionEnd);
    ta.focus();
    ta.selectionStart = p + bloc.indexOf('Titre');
    ta.selectionEnd = p + bloc.indexOf(' de la rubrique') + 15;
  });
  const sceau = document.getElementById('ed-sceau');
  if (sceau) sceau.onclick = () => {
    const ta = $('#ed');
    const p = ta.selectionStart;
    ta.value = ta.value.slice(0, p) + ' {{isekai}}' + ta.value.slice(ta.selectionEnd);
    ta.focus();
  };

  // Un visuel : l'original part dans le dépôt privé, la version chiffrée
  // (clé du coffre de l'entrée) dans le dépôt public, et la ligne `visuel:`
  // est posée dans l'en-tête — le prochain Publier retrouvera tout.
  $('#ed-img').onchange = async ev => {
    const fichier = ev.target.files[0];
    if (!fichier) return;
    if (fichier.size > 3_000_000) {
      $('#ed-msg').className = 'msg';
      $('#ed-msg').textContent = 'Image trop lourde (3 Mo max) — réduis-la d\'abord.';
      return;
    }
    try {
      const f = mjParser($('#ed').value);
      const ext = (fichier.name.match(/\.(png|jpe?g|webp|gif)$/i) || ['.jpg'])[0].toLowerCase();
      const chemin = `images/${info.id}${ext.startsWith('.') ? ext : '.' + ext}`;
      const octets = new Uint8Array(await fichier.arrayBuffer());

      msg('Envoi du visuel 1/2 — original dans le dépôt privé…');
      let ancien;
      try { ancien = (await gh('GET', ADMIN.depots.prive, chemin + '?ref=main')).sha; } catch (e) { }
      await gh('PUT', ADMIN.depots.prive, chemin, {
        message: `visuel : ${info.n}`, content: b64vers(octets),
        ...(ancien ? { sha: ancien } : {}), branch: 'main',
      });

      msg('Envoi du visuel 2/2 — version chiffrée en ligne…');
      const coffre = mjCoffre(f, f.meta.confidentialite || 'MJ only');
      const brut = MOI.coffres.get(coffre);
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                     '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'image/jpeg';
      const paquet = await mjSceller(await hkdf(brut, 'img:' + h),
                                     { m: mime, d: b64vers(octets) });
      let ancienPub;
      try { ancienPub = (await gh('GET', ADMIN.depots.public, `img/${h}.bin?ref=main`)).sha; } catch (e) { }
      await gh('PUT', ADMIN.depots.public, `img/${h}.bin`, {
        message: 'visuel chiffré', content: b64vers(paquet),
        ...(ancienPub ? { sha: ancienPub } : {}), branch: 'main',
      });

      // pose (ou remplace) la ligne visuel: dans l'en-tête du textarea
      const ta = $('#ed');
      if (/^visuel:.*$/m.test(ta.value))
        ta.value = ta.value.replace(/^visuel:.*$/m, `visuel: ${chemin}`);
      else
        ta.value = ta.value.replace(/^---\n/, `---\nvisuel: ${chemin}\n`);
      msg('Visuel en ligne. Touche « Publier la modification » pour qu\'il '
        + 's\'affiche sur la fiche.');
    } catch (e) {
      $('#ed-msg').className = 'msg'; $('#ed-msg').textContent = e.message;
    }
  };

  $('#ed-voir').onclick = () => {
    try {
      const f = mjParser($('#ed').value);
      $('#ed-apercu').innerHTML =
        `<div class="entree">${mjRendre(f.preambule)}</div>` +
        f.rubriques.map(r => `<section class="rub"><h2><span>${ech(r.titre)}</span>
          <span class="bal b${['Grand public','Super','Secret','Très secret','MJ only'].indexOf(r.balise)}">${ech(r.balise)}</span></h2>${mjRendre(r.texte)}</section>`).join('');
    } catch (e) { $('#ed-msg').className = 'msg'; $('#ed-msg').textContent = e.message; }
  };

  $('#ed-ok').onclick = async () => {
    const b = $('#ed-ok'); b.disabled = true;
    try {
      const texte = $('#ed').value;
      const f = mjParser(texte);
      if ((f.meta.id || '') !== info.id)
        throw new Error(`L'identifiant (id: ${f.meta.id}) ne doit pas changer.`);
      for (const r of f.rubriques)
        if (!(r.balise in MJ_PALIERS)) throw new Error(`Balise inconnue : [${r.balise}]`);

      msg('1/2 — sauvegarde de la source dans le dépôt privé…');
      const r1 = await gh('PUT', ADMIN.depots.prive, info.c, {
        message: `MJ en direct : ${info.n}`, content: b64utf8(texte), sha, branch: 'main',
      });
      sha = r1.content.sha;

      msg('2/2 — rechiffrement et mise en ligne…');
      const { json } = await mjConteneur(h, f);
      let ancien = null;
      try { ancien = (await gh('GET', ADMIN.depots.public, `p/${h}.bin?ref=main`)).sha; } catch (e) { }
      await gh('PUT', ADMIN.depots.public, `p/${h}.bin`, {
        message: `MJ en direct : mise à jour d'une fiche`, content: b64utf8(json),
        ...(ancien ? { sha: ancien } : {}), branch: 'main',
      });

      CACHE_P.delete(h);
      const ent = CAT.get(h);
      if (ent) { ent.n = f.meta.nom || ent.n; ent.t = f.meta.titre || ent.t; }
      msg('En ligne. Le site se met à jour dans la minute ; listes et recherche se '
        + 'rafraîchiront au prochain Publier.');
      setTimeout(() => { location.hash = '#/f/' + h; }, 1800);
    } catch (e) {
      $('#ed-msg').className = 'msg'; $('#ed-msg').textContent = e.message;
      b.disabled = false;
    }
  };
};

/* ── la page MJ ─────────────────────────────────────────────────────────── */

window.vueMJ = async function (sous) {
  if (!MOI || !MOI.mj) { $('#vue').innerHTML = '<p class="rien">Réservé au MJ.</p>'; return; }
  $('#vue').innerHTML = '<p class="charge">Déchiffrement du paquet MJ…</p>';
  const a = await chargerAdmin();
  if (!a) { $('#vue').innerHTML = '<p class="rien">Paquet MJ introuvable — republie le site.</p>'; return; }

  if (sous === 'jeton') {
    $('#vue').innerHTML = `
      <h1 class="tt">🛠 Jeton d'édition</h1>
      <div class="entree"><p>Pour modifier les fiches en direct, il faut un jeton GitHub
      (une autorisation d'écriture). Une fois collé ici, il reste sur cet appareil.</p></div>
      <ul><li>Ouvre <b>github.com/settings/personal-access-tokens</b> → Generate new token</li>
      <li><i>Repository access</i> : <b>Only select repositories</b> → ${ech(a.depots.prive)} et ${ech(a.depots.public)}</li>
      <li><i>Permissions → Contents</i> : <b>Read and write</b> → Generate</li></ul>
      <div class="champ"><input id="pat" type="password" placeholder="colle le jeton ici"
        value="${ech(jeton.lire())}"></div>
      <div class="ed-b"><button id="pat-ok" class="btn1">Enregistrer</button>
      <button id="pat-non" class="btn3">Effacer</button></div>
      <p id="pat-msg" class="msg"></p>`;
    $('#pat-ok').onclick = async () => {
      jeton.poser($('#pat').value.trim());
      try {
        await gh('GET', a.depots.prive, 'campagne.yml?ref=main');
        $('#pat-msg').className = 'msg ok'; $('#pat-msg').textContent = '✓ Jeton valide.';
        setTimeout(() => location.hash = '#/mj', 900);
      } catch (e) { $('#pat-msg').className = 'msg'; $('#pat-msg').textContent = e.message; }
    };
    $('#pat-non').onclick = () => { jeton.poser(''); $('#pat').value = ''; };
    return;
  }

  if (sous === 'config') return vueConfig(a);

  const cfg = a.config || {}, st = a.stats || {};
  const groupes = Object.entries(cfg.groupes || {});
  const revs = cfg.revelations || [];
  const exc = cfg.exceptions || {};
  const nExc = Object.values(exc.voit || {}).flat().length
    + Object.values(exc.voit_pas || {}).flat().length;

  const repli = (titre, corps, ouvert) =>
    `<details class="cat"${ouvert ? ' open' : ''}><summary><span>${titre}</span></summary>
     <div class="repli-corps">${corps}</div></details>`;

  $('#vue').innerHTML = `
    <h1 class="tt">🛠 Page MJ</h1>
    <p class="meta"><span>générée le ${ech(a.genere_le || '?')}</span>
    <span>jeton d'édition ${jeton.lire() ? '✓' : '✗ <a href="#/mj/jeton">à poser</a>'}</span></p>

    <p class="mj-actions">
      <a class="puce" data-page="episode">➕ Résumé d'épisode</a>
      <a class="puce" data-page="journal">➕ Journal</a>
      <a class="puce" data-page="aide">➕ Aide de jeu</a>
      <a class="puce" href="#/mj/config">⚙ Groupes & joueurs</a>
      <a class="puce" href="#/mj/jeton">🔐 Jeton</a>
    </p>
    <p class="mj-actions">Voir le site comme :
      ${(a.acces || []).filter(j => !j.mj).map(j =>
        `<a class="puce" data-voir="${ech(j.nom)}">👁 ${ech(j.nom)}</a>`).join(' ') || 'aucun joueur'}
    </p>

    ${repli('🔑 Accès des joueurs', `
    <div class="tw"><table><thead><tr><th>Qui</th><th>Voit</th><th>Phrase</th><th></th></tr></thead>
    <tbody>${(a.acces || []).map(j => {
      const vue = (a.vues || {})[j.nom] || {};
      const noms = { p0: 'Grand public', p1: 'Super', p2: 'Secret', p3: 'Très secret', p4: 'MJ only' };
      let palier = 'p0';
      for (const c of vue.v || []) if (noms[c] && c > palier) palier = c;
      return `<tr><td><b>${ech(j.nom)}</b></td>
      <td>${j.mj ? 'tout (MJ)' : ech(j.groupe || '—') + ' · ' + noms[palier]}</td>
      <td><code>${ech(j.phrase)}</code></td>
      <td>${j.lien ? `<a class="copie" data-c="${ech(j.lien)}">copier le lien</a><br>` : ''}
          <a class="suppr" data-rot="${ech(j.nom)}">🔑 nouvelle phrase</a></td></tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="meta"><span>⚠ un lien vaut la phrase : chacun ne reçoit que le sien</span></p>`, true)}

    ${repli(`📜 Révélations & exceptions — ${revs.length} · ${nExc}`, `
    <p>${revs.length} révélation(s) actée(s) · ${nExc} exception(s) nominative(s).</p>
    ${revs.length ? '<ul>' + revs.map(r => `<li><b>${ech(r.date || '')}</b> — ${ech(r.episode || '')}
      (${(r.ouvre || []).length} ouverture(s), groupe ${ech(r.groupe || '?')})</li>`).join('') + '</ul>' : ''}
    <p>Révélations : <code>campagne.yml</code> → <code>revelations:</code> (GUIDE.md).
    Exceptions et paliers par joueur : <a href="#/mj/config">⚙ Groupes & joueurs</a>.
    Pour modifier une fiche : ouvre-la et touche ✏️ (les 5 balises s'insèrent d'un bouton).</p>`)}

    ${repli('📊 Le corpus & les groupes', `
    <div class="tw"><table><thead><tr><th>Groupe</th><th>Palier</th></tr></thead><tbody>
    ${groupes.map(([id, g]) => `<tr><td>${ech(g.nom || id)}</td><td>${ech(g.palier || '?')}</td></tr>`).join('')
    || '<tr><td colspan=2>aucun</td></tr>'}</tbody></table></div>
    <div class="tw"><table><thead><tr><th>Bible</th><th>Fiches</th></tr></thead><tbody>
    ${Object.entries(st.fiches || {}).map(([b, n]) => `<tr><td>${ech(b)}</td><td>${n}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="tw"><table><thead><tr><th>Palier</th><th>Fiches</th></tr></thead><tbody>
    ${Object.entries(st.paliers || {}).map(([p, n]) => `<tr><td>${ech(p)}</td><td>${n}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="meta"><span>${st.fragments || '?'} fragments · ${st.coffres || '?'} coffres</span></p>`)}

    ${repli('📈 Fréquentation & réglages', `
    <p>Visites des 14 derniers jours (comptées par GitHub, rien d'ajouté au site) :
    <a href="https://github.com/${ech(a.depots.public)}/graphs/traffic"
    target="_blank" rel="noopener">ouvrir les statistiques ↗</a></p>
    <div class="tw"><table><tbody>
    ${Object.entries(cfg.avance || {}).map(([k, v]) => `<tr><td><code>${ech(k)}</code></td><td>${ech(String(v))}</td></tr>`).join('')}
    </tbody></table></div>`)}`;
  window.scrollTo(0, 0);
  document.title = 'Page MJ — ' + META.titre;
  document.querySelectorAll('.copie').forEach(el => el.onclick = async () => {
    try { await navigator.clipboard.writeText(el.dataset.c); el.textContent = '✓ copié'; }
    catch (e) { prompt('Copie ce lien :', el.dataset.c); }
  });
  document.querySelectorAll('[data-voir]').forEach(el =>
    el.onclick = () => voirComme(el.dataset.voir));
  document.querySelectorAll('[data-rot]').forEach(el => el.onclick = async () => {
    const nom = el.dataset.rot;
    if (!confirm(`Donner une phrase de passe NEUVE à « ${nom} » ?\n`
      + `L'ancienne (et son lien) cesseront de fonctionner à la régénération (~3 min).`)) return;
    if (!jeton.lire()) { location.hash = '#/mj/jeton'; return; }
    try {
      const cfg = JSON.parse(JSON.stringify(a.config));
      cfg.avance = cfg.avance || {};
      cfg.avance.rotation = [...new Set([...(cfg.avance.rotation || []), nom])];
      await sauverCampagne(cfg, `MJ : nouvelle phrase pour ${nom}`);
      el.textContent = '✓ demandée — nouvelle phrase ici dans ~3 min';
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-page]').forEach(el => el.onclick = () => creerPage(el.dataset.page));
};

/* ── création de pages depuis les gabarits ──────────────────────────────── */

const GABARITS = {
  episode: {
    nom: "Résumé d'épisode", type: "Résumé d'épisode", conf: "Grand public",
    corps: `Deux ou trois phrases : où en est l'histoire après cet épisode.

## [Grand public] Ce qui s'est passé

Le récit de la séance, tel que les personnages l'ont vécu.

## [Grand public] Ce que nous avons appris

- @Quelqu'un cache quelque chose…
- Un lieu, un nom, une piste.

## [MJ only] Notes de derrière l'écran

Ce que les joueurs n'ont pas vu, les graines plantées, à ne pas oublier.`,
  },
  journal: {
    nom: 'Journal', type: 'Journal', conf: 'Grand public',
    corps: `Un journal tenu à la première personne — par un personnage, ou par le groupe.

## [Grand public] L'entrée du jour

Le texte du journal.`,
  },
  aide: {
    nom: 'Aide de jeu', type: 'Aide de jeu', conf: 'Grand public',
    corps: `À quoi sert cette aide, en une phrase.

## [Grand public] L'essentiel

Le contenu : règle maison, carte, chronologie, mémo…

## [MJ only] Côté MJ

Ce que cette aide ne dit pas aux joueurs.`,
  },
};

async function creerPage(quoi) {
  const g = GABARITS[quoi];
  if (!g) return;
  if (!jeton.lire()) { location.hash = '#/mj/jeton'; return; }
  const titre = prompt(`Titre de la nouvelle page « ${g.nom} » ?`,
    quoi === 'episode' ? 'Épisode 1 — ' : '');
  if (!titre) return;
  const slug = slugMJ(titre);
  const id = 'campagne-' + slug;
  const source = `---
id: ${id}
nom: "${titre.replace(/"/g, "'")}"
bible: campagne
type_kanka: Journal
type: "${g.type}"
tags: [Chronique]
horizon: etabli
confidentialite: ${g.conf}
etat: complet
---

${g.corps}
`;
  try {
    await gh('PUT', ADMIN.depots.prive, `fiches/campagne/${slug}.md`, {
      message: `nouvelle page : ${titre}`, content: b64utf8(source), branch: 'main',
    });
    alert(`« ${titre} » créée. Le robot la met en ligne dans ~3 minutes — elle apparaîtra `
      + `dans le rayon 📜 La chronique. Tu pourras alors l'ouvrir et la modifier avec ✏️.`);
  } catch (e) { alert(e.message); }
}

/* ── gestion des groupes, joueurs et permissions ────────────────────────── */

function slugMJ(s) {
  return nrm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

async function vueConfig(a) {
  // copie de travail — rien ne part tant qu'on n'enregistre pas
  const cfg = JSON.parse(JSON.stringify(a.config || {}));
  cfg.site = cfg.site || {}; cfg.groupes = cfg.groupes || {};
  cfg.joueurs = cfg.joueurs || []; cfg.avance = cfg.avance || {};
  cfg.exceptions = cfg.exceptions || {}; cfg.revelations = cfg.revelations || [];
  const PALIERS_L = ['Grand public', 'Super', 'Secret', 'Très secret', 'MJ only'];

  function dessiner() {
    const optG = id => Object.keys(cfg.groupes).map(g =>
      `<option value="${ech(g)}"${g === id ? ' selected' : ''}>${ech(cfg.groupes[g].nom || g)}</option>`).join('');
    $('#vue').innerHTML = `
      <h1 class="tt">⚙ Groupes & joueurs</h1>
      <p class="meta"><span><a href="#/mj">← page MJ</a></span></p>

      <h2>Groupes</h2>
      <div class="tw"><table><thead><tr><th>Nom</th><th>Palier</th><th></th></tr></thead><tbody>
      ${Object.entries(cfg.groupes).map(([id, g]) => `<tr>
        <td><input class="cfg-in" data-g="${ech(id)}" data-k="nom" value="${ech(g.nom || id)}"></td>
        <td><select class="cfg-in" data-g="${ech(id)}" data-k="palier">
          ${PALIERS_L.map(p => `<option${p === g.palier ? ' selected' : ''}>${p}</option>`).join('')}</select></td>
        <td><a class="suppr" data-sg="${ech(id)}">retirer</a></td></tr>`).join('')}
      </tbody></table></div>
      <p><a class="puce" id="aj-groupe">+ Ajouter un groupe</a></p>

      <h2>Joueurs</h2>
      <p>« Palier » règle la permission fine de CE joueur ; « Personnage »
      relie sa fiche (elle s'affiche sur son accueil, avec son statbloc).</p>
      <div class="tw"><table><thead><tr><th>Nom</th><th>Rôle</th><th>Groupe</th><th>Palier</th><th>Personnage</th><th></th></tr></thead><tbody>
      ${cfg.joueurs.map((j, i) => {
        const mj = String(j.role || '').toLowerCase() === 'mj';
        const optP = ['', ...PALIERS_L.slice(0, 4)].map(p =>
          `<option value="${p}"${(j.palier || '') === p ? ' selected' : ''}>${p || '(celui du groupe)'}</option>`).join('');
        const fichesPJ = Object.values(a.fiches || {}).filter(x => x.b === 'pj');
        const optPJ = ['', ...fichesPJ.map(x => x.c)].map(c => {
          const f = fichesPJ.find(x => x.c === c);
          return `<option value="${ech(c)}"${(j.pj || '') === c ? ' selected' : ''}>${f ? ech(f.n) : '(aucun)'}</option>`;
        }).join('');
        return `<tr>
        <td><input class="cfg-in" data-j="${i}" data-k="nom" data-orig="${ech(j.nom || '')}" value="${ech(j.nom || '')}"></td>
        <td><select class="cfg-in" data-j="${i}" data-k="role">
          <option value=""${mj ? '' : ' selected'}>joueur</option>
          <option value="mj"${mj ? ' selected' : ''}>MJ</option></select></td>
        <td>${mj ? '—' : `<select class="cfg-in" data-j="${i}" data-k="groupe">${optG(j.groupe)}</select>`}</td>
        <td>${mj ? 'tout' : `<select class="cfg-in" data-j="${i}" data-k="palier">${optP}</select>`}</td>
        <td>${mj ? '—' : `<select class="cfg-in" data-j="${i}" data-k="pj">${optPJ}</select>`}</td>
        <td><a class="suppr" data-sj="${i}">retirer</a></td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p><a class="puce" id="aj-joueur">+ Ajouter un joueur</a></p>

      <h2>Mot d'accueil</h2>
      <p>Ce que tes joueurs lisent en arrivant. <code>@Nom</code> devient un lien.</p>
      <textarea id="cfg-accueil" class="cfg-large">${ech((cfg.site || {}).accueil || '')}</textarea>

      <h2>Messagerie</h2>
      <p>Boîte aux lettres Firebase (voir GUIDE.md pour la création, 5 minutes).
      Le carnet d'adresses sème des contacts chez chaque joueur — un nom de
      PNJ ou de PJ par ligne, qu'ils pourront contacter d'emblée.</p>
      <p><label><input type="checkbox" id="cfg-msg-actif"
        ${String((cfg.messagerie || {}).actif || '').toLowerCase().match(/^(oui|true|yes|1)$/) ? 'checked' : ''}>
        Messagerie active</label></p>
      <p><input class="cfg-url" id="cfg-msg-url"
        placeholder="https://…firebasedatabase.app"
        value="${ech((cfg.messagerie || {}).firebase_url || '')}"></p>
      <label>Contacts semés (carnet d'adresses)<br>
      <textarea id="cfg-msg-ctc" class="cfg-ctc">${ech(((cfg.messagerie || {}).contacts || []).join('\n'))}</textarea></label>

      <h2>Exceptions nominatives</h2>
      <p>Une cible par ligne : <code>pnj-omega</code> (fiche entière),
      <code>pnj-omega#Secret</code> (ces rubriques), <code>tag:atlantide</code>.</p>
      ${cfg.joueurs.filter(j => String(j.role || '').toLowerCase() !== 'mj').map(j => `
        <h3>${ech(j.nom)}</h3>
        <div class="exc"><label>voit en plus<br>
        <textarea class="cfg-exc" data-n="${ech(j.nom)}" data-s="voit">${ech(((cfg.exceptions.voit || {})[j.nom] || []).join('\n'))}</textarea></label>
        <label>ne voit pas<br>
        <textarea class="cfg-exc" data-n="${ech(j.nom)}" data-s="voit_pas">${ech(((cfg.exceptions.voit_pas || {})[j.nom] || []).join('\n'))}</textarea></label></div>`).join('')}

      <div class="ed-b"><button id="cfg-ok" class="btn1">Enregistrer les changements</button>
      <a class="btn3" href="#/mj">Annuler</a></div>
      <p id="cfg-msg" class="msg"></p>
      <p class="meta"><span>Un joueur ajouté reçoit sa phrase de passe à la prochaine
      régénération du site ; un joueur retiré perd l'accès au même moment.</span></p>`;
    brancher();
    window.scrollTo(0, 0);
  }

  function lireFormulaire() {
    document.querySelectorAll('.cfg-in').forEach(el => {
      const k = el.dataset.k, v = el.value.trim();
      if (!k) return;                       // champ hors tableaux (garde-fou)
      if (el.dataset.g !== undefined) cfg.groupes[el.dataset.g][k] = v;
      else {
        const j = cfg.joueurs[+el.dataset.j];
        if (k === 'role') { if (v === 'mj') { j.role = 'mj'; delete j.groupe; delete j.pj; } else delete j.role; }
        else if (k === 'palier') { if (v) j.palier = v; else delete j.palier; }
        else if (k === 'pj') { if (v) j.pj = v; else delete j.pj; }
        else {
          // Renommage : la directive `renommer` migre la phrase de passe du
          // joueur — son mot de passe survit au changement de nom.
          if (k === 'nom' && el.dataset.orig && v && v !== el.dataset.orig) {
            cfg.avance = cfg.avance || {};
            cfg.avance.renommer = { ...(cfg.avance.renommer || {}), [el.dataset.orig]: v };
          }
          j[k] = v;
        }
      }
    });
    const acc = document.getElementById('cfg-accueil');
    if (acc) { cfg.site = cfg.site || {}; cfg.site.accueil = acc.value.trim(); }
    const ma = document.getElementById('cfg-msg-actif');
    if (ma) {
      cfg.messagerie = cfg.messagerie || {};
      cfg.messagerie.actif = ma.checked ? 'oui' : 'non';
      cfg.messagerie.firebase_url = document.getElementById('cfg-msg-url').value.trim();
      cfg.messagerie.contacts = document.getElementById('cfg-msg-ctc').value
        .split('\n').map(x => x.trim()).filter(Boolean);
    }
    cfg.exceptions = { voit: {}, voit_pas: {} };
    document.querySelectorAll('.cfg-exc').forEach(el => {
      if (!el.dataset.s || !el.dataset.n) return;   // garde-fou : vraies exceptions seulement
      const specs = el.value.split('\n').map(x => x.trim()).filter(Boolean);
      if (specs.length) cfg.exceptions[el.dataset.s][el.dataset.n] = specs;
    });
  }

  function brancher() {
    $('#aj-groupe').onclick = () => {
      lireFormulaire();
      const nom = prompt('Nom du nouveau groupe ?');
      if (nom) { cfg.groupes[slugMJ(nom)] = { nom, palier: 'Super' }; dessiner(); }
    };
    $('#aj-joueur').onclick = () => {
      lireFormulaire();
      const nom = prompt('Nom du nouveau joueur ?');
      if (!nom) return;
      const g = Object.keys(cfg.groupes)[0];
      cfg.joueurs.push({ nom, groupe: g, pj: 'pj/' + slugMJ(nom) + '.md' });
      dessiner();
    };
    document.querySelectorAll('[data-sg]').forEach(el => el.onclick = () => {
      lireFormulaire();
      const id = el.dataset.sg;
      if (cfg.joueurs.some(j => j.groupe === id)) {
        alert('Des joueurs sont encore rattachés à ce groupe — change-les de groupe d\'abord.');
        return;
      }
      if (confirm(`Retirer le groupe « ${cfg.groupes[id].nom || id} » ?`)) {
        delete cfg.groupes[id]; dessiner();
      }
    });
    document.querySelectorAll('[data-sj]').forEach(el => el.onclick = () => {
      lireFormulaire();
      const j = cfg.joueurs[+el.dataset.sj];
      if (confirm(`Retirer « ${j.nom} » ? Sa phrase de passe cessera de fonctionner `
        + `à la prochaine régénération.`)) {
        cfg.joueurs.splice(+el.dataset.sj, 1); dessiner();
      }
    });
    $('#cfg-ok').onclick = async () => {
      lireFormulaire();
      if (!cfg.joueurs.some(j => String(j.role || '').toLowerCase() === 'mj')) {
        $('#cfg-msg').className = 'msg';
        $('#cfg-msg').textContent = 'Il faut au moins un MJ — je refuse de t\'enfermer dehors.';
        return;
      }
      if (!jeton.lire()) { location.hash = '#/mj/jeton'; return; }
      $('#cfg-ok').disabled = true;
      $('#cfg-msg').className = 'msg ok';
      $('#cfg-msg').textContent = 'Enregistrement dans le dépôt privé…';
      try {
        await sauverCampagne(cfg, 'MJ : groupes, joueurs et permissions');
        $('#cfg-msg').textContent = '✓ Enregistré. La régénération automatique met le site '
          + 'à jour dans ~3 minutes (sinon : Publier sur ton PC). Les nouvelles phrases '
          + 'apparaîtront ici après régénération.';
      } catch (e) {
        $('#cfg-msg').className = 'msg'; $('#cfg-msg').textContent = e.message;
        $('#cfg-ok').disabled = false;
      }
    };
  }

  dessiner();
  document.title = 'Groupes & joueurs — ' + META.titre;
}
