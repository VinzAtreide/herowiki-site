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

const MJ_PALIERS = { 'Grand public': 'p0', 'Super': 'p1', 'Secret': 'p2', 'Très secret': 'p3', 'MJ only': 'p4' };

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
    <textarea id="ed" spellcheck="false">${ech(src)}</textarea>
    <div class="ed-b">
      <button id="ed-voir" class="btn2">Aperçu</button>
      <button id="ed-ok" class="btn1">Publier la modification</button>
      <a href="#/f/${h}" class="btn3">Annuler</a>
    </div>
    <p id="ed-msg" class="msg"></p>
    <div id="ed-apercu"></div>`;
  window.scrollTo(0, 0);
  const msg = t => { $('#ed-msg').className = 'msg ok'; $('#ed-msg').textContent = t; };

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

  const cfg = a.config || {}, st = a.stats || {};
  const groupes = Object.entries(cfg.groupes || {});
  const revs = cfg.revelations || [];
  const exc = cfg.exceptions || {};
  const nExc = Object.values(exc.voit || {}).flat().length
    + Object.values(exc.voit_pas || {}).flat().length;

  $('#vue').innerHTML = `
    <h1 class="tt">🛠 Page MJ</h1>
    <p class="meta"><span>générée le ${ech(a.genere_le || '?')}</span>
    <span>${st.fragments || '?'} fragments</span><span>${st.coffres || '?'} coffres</span></p>

    <h2>Accès</h2>
    <div class="tw"><table><thead><tr><th>Qui</th><th>Voit</th><th>Phrase</th><th></th></tr></thead>
    <tbody>${(a.acces || []).map(j => `<tr><td><b>${ech(j.nom)}</b></td>
      <td>${j.mj ? 'tout (MJ)' : 'groupe ' + ech(j.groupe || '—')}</td>
      <td><code>${ech(j.phrase)}</code></td>
      <td>${j.lien ? `<a class="copie" data-c="${ech(j.lien)}">copier le lien</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="meta"><span>⚠ un lien vaut la phrase : chacun ne reçoit que le sien</span></p>

    <h2>Groupes et paliers</h2>
    <div class="tw"><table><thead><tr><th>Groupe</th><th>Palier</th></tr></thead><tbody>
    ${groupes.map(([id, g]) => `<tr><td>${ech(g.nom || id)}</td><td>${ech(g.palier || '?')}</td></tr>`).join('')
    || '<tr><td colspan=2>aucun</td></tr>'}</tbody></table></div>

    <h2>Le corpus</h2>
    <div class="tw"><table><thead><tr><th>Bible</th><th>Fiches</th></tr></thead><tbody>
    ${Object.entries(st.fiches || {}).map(([b, n]) => `<tr><td>${ech(b)}</td><td>${n}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="tw"><table><thead><tr><th>Palier</th><th>Fiches</th></tr></thead><tbody>
    ${Object.entries(st.paliers || {}).map(([p, n]) => `<tr><td>${ech(p)}</td><td>${n}</td></tr>`).join('')}
    </tbody></table></div>

    <h2>Révélations & exceptions</h2>
    <p>${revs.length} révélation(s) actée(s) · ${nExc} exception(s) nominative(s).</p>
    ${revs.length ? '<ul>' + revs.map(r => `<li><b>${ech(r.date || '')}</b> — ${ech(r.episode || '')}
      (${(r.ouvre || []).length} ouverture(s), groupe ${ech(r.groupe || '?')})</li>`).join('') + '</ul>' : ''}
    <p>Pour révéler, exclure, ajouter un joueur : <code>campagne.yml</code> sur ton PC, puis
    <b>Publier</b> — le détail est dans GUIDE.md.</p>

    <h2>Édition en direct</h2>
    <p>Ouvre n'importe quelle fiche et touche <b>✏️ Modifier cette fiche</b>. La modification
    est en ligne dans la minute, et sauvegardée dans tes sources : le prochain Publier ne
    l'écrasera pas. Jeton d'édition : ${jeton.lire() ? '✓ enregistré' : '✗ absent'} —
    <a href="#/mj/jeton">gérer</a>.</p>

    <h2>Réglages avancés</h2>
    <div class="tw"><table><tbody>
    ${Object.entries(cfg.avance || {}).map(([k, v]) => `<tr><td><code>${ech(k)}</code></td><td>${ech(String(v))}</td></tr>`).join('')}
    </tbody></table></div>`;
  window.scrollTo(0, 0);
  document.title = 'Page MJ — ' + META.titre;
  document.querySelectorAll('.copie').forEach(el => el.onclick = async () => {
    try { await navigator.clipboard.writeText(el.dataset.c); el.textContent = '✓ copié'; }
    catch (e) { prompt('Copie ce lien :', el.dataset.c); }
  });
};
