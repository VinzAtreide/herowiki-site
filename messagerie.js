/* ═══════════════════════════════════════════════════════════════════════════
   HeroWiki — la messagerie.  Fichier public : aucun secret ici.

   Firebase n'est qu'une boîte aux lettres : chaque message y arrive déjà
   chiffré (AES-GCM) avec la clé de son canal. Qui a la clé lit ; les autres —
   Firebase compris — transportent du bruit. Les clés de canal voyagent dans
   les trousseaux, exactement comme les clés de coffre : la distribution des
   clés EST la permission (salon de groupe, canal joueur↔MJ, exceptions).
   Append-only côté serveur : personne n'efface l'histoire — le journal
   complet reste donc disponible, et la page 🗒 du MJ le déroule en clair.

   Immersion : le MJ peut écrire SOUS LE NOM d'un PNJ ou d'un PJ (champ
   « expéditeur » + horodatage libre), et chaque joueur tient un carnet
   d'adresses qui s'enrichit tout seul dès qu'un nouveau correspondant lui
   écrit — il peut alors le recontacter (« À : L'Horloger »). Ces réponses
   voyagent sur le canal privé joueur↔MJ : le joueur croit écrire au
   personnage, seul le MJ reçoit.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

let MSG_CANAUX = new Map();   // id → {n: nom, k: clé brute}
let MSG_ACTIF = null;         // canal ouvert
let MSG_DEST = null;          // « À : PNJ » (réponse en personnage)
let MSG_MINUTEUR = null;
let MSG_DERNIER = {};         // id → dernière clé de message vue
let MSG_CTC = new Set();      // carnet d'adresses

function msgInit(tr) {
  MSG_CANAUX = new Map();
  for (const [id, c] of Object.entries(tr.m || {}))
    MSG_CANAUX.set(id, { n: c.n, k: deb64(c.k) });
  MSG_CTC = new Set(tr.ctc || []);          // contacts semés par le MJ
  try {                                      // + ceux déjà découverts ici
    for (const n of JSON.parse(localStorage.getItem(msgCleCarnet()) || '[]'))
      MSG_CTC.add(n);
  } catch (e) { /* carnet neuf */ }
  const b = $('#msg-btn');
  if (b) b.hidden = !(META.msg && MSG_CANAUX.size);
}

function msgCleCarnet() { return 'hw.carnet.' + (MOI.nom || ''); }

function msgApprendre(nom) {
  /* Le carnet apprend tout seul : un correspondant inconnu écrit → il entre. */
  if (!nom || nom === MOI.nom || MSG_CTC.has(nom)) return false;
  MSG_CTC.add(nom);
  try {
    localStorage.setItem(msgCleCarnet(), JSON.stringify([...MSG_CTC].sort()));
  } catch (e) { /* stockage plein : le carnet vivra en mémoire */ }
  return true;
}

async function msgGz(b) {
  const s = new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function msgSceller(cle, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', cle, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k,
    await msgGz(enc.encode(JSON.stringify(obj)))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000)
    s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ── le panneau ─────────────────────────────────────────────────────────── */

function msgOuvrir() {
  let p = $('#msgr');
  if (!p) {
    p = document.createElement('div');
    p.id = 'msgr';
    p.innerHTML = `<div class="msgr-tete"><b>💬 Messages</b>
        ${MOI.mj ? '<button class="ico" id="msgr-log" title="Journal complet des messages">🗒</button>' : ''}
        <button class="ico" id="msgr-x">✕</button></div>
      <div class="msgr-canaux" id="msgr-canaux"></div>
      <div class="msgr-carnet" id="msgr-carnet"></div>
      <div class="msgr-corps" id="msgr-corps"><p class="rien">Choisis un canal.</p></div>
      <form class="msgr-envoi" id="msgr-form" hidden>
        ${MOI.mj ? `<div class="msgr-mj">
          <select id="msgr-de" title="Expéditeur affiché"></select>
          <input id="msgr-ts" autocomplete="off"
                 placeholder="horodatage affiché — vide : maintenant" maxlength="40">
        </div>` : ''}
        <div class="msgr-dest" id="msgr-dest" hidden></div>
        <div class="msgr-ligne">
          <input id="msgr-texte" autocomplete="off" placeholder="ton message…" maxlength="600">
          <button class="btn1" type="submit">➤</button>
        </div>
      </form>`;
    document.body.appendChild(p);
    $('#msgr-x').onclick = msgFermer;
    if (MOI.mj) $('#msgr-log').onclick = msgJournal;
    $('#msgr-canaux').innerHTML = [...MSG_CANAUX.entries()].map(([id, c]) =>
      `<a class="puce" data-canal="${ech(id)}">${ech(c.n)}</a>`).join('');
    document.querySelectorAll('[data-canal]').forEach(a =>
      a.onclick = () => { MSG_DEST = null; msgCanal(a.dataset.canal); });
    $('#msgr-form').onsubmit = msgEnvoyer;
  }
  msgCarnet();
  if (MOI.mj) {
    msgPersonas();                           // au moins le carnet, tout de suite
    if (typeof chargerAdmin === 'function')  // puis toutes les fiches PNJ/PJ
      chargerAdmin().then(msgPersonas).catch(() => {});
  }
  p.classList.add('ouvert');
  if (MSG_CANAUX.size === 1) msgCanal([...MSG_CANAUX.keys()][0]);
}

/* Le carnet d'adresses du joueur : un clic ouvre le canal privé avec le MJ
   et adresse le message au personnage choisi. */
function msgCarnet() {
  const z = $('#msgr-carnet');
  if (!z) return;
  const mien = [...MSG_CANAUX.keys()].find(id => id.startsWith('mj-'));
  if (MOI.mj || !MSG_CTC.size || !mien) { z.innerHTML = ''; return; }
  z.innerHTML = '<span class="msgr-ctitre">📇 Écrire à :</span> '
    + [...MSG_CTC].sort().map(n =>
      `<a class="puce p2" data-ctc="${ech(n)}">${ech(n)}</a>`).join('');
  z.querySelectorAll('[data-ctc]').forEach(a => a.onclick = () => {
    MSG_DEST = a.dataset.ctc;
    msgCanal(mien);
  });
}

/* Les identités que le MJ peut endosser, en liste déroulante : lui-même, les
   contacts du carnet, les personnages-joueurs — et « Autre… » pour improviser
   n'importe qui. (Pour enrichir la liste durablement : ⚙ Réglages →
   Messagerie → contacts semés.) */
function msgPersonas() {
  const sel = $('#msgr-de');
  if (!sel) return;
  const garde = sel.value;
  const noms = new Set(MSG_CTC);
  const a = (typeof ADMIN !== 'undefined') && ADMIN;   // rempli si la page MJ a servi
  if (a && a.fiches)
    for (const f of Object.values(a.fiches))
      if ((f.c || '').startsWith('pj/'))
        noms.add(f.n || f.id);
  sel.innerHTML = `<option value="">✍ Moi (${ech(MOI.nom)})</option>`
    + [...noms].sort().map(n => `<option value="${ech(n)}">🎭 ${ech(n)}</option>`).join('')
    + '<option value="*autre*">🎭 Autre…</option>';
  if ([...sel.options].some(o => o.value === garde)) sel.value = garde;
  sel.onchange = () => {
    if (sel.value !== '*autre*') return;
    const n = (prompt('Nom de l\'expéditeur affiché ?') || '').trim();
    if (n) {
      const o = document.createElement('option');
      o.value = n; o.textContent = '🎭 ' + n;
      sel.insertBefore(o, sel.lastElementChild);
      sel.value = n;
    } else sel.value = '';
  };
}

async function msgEnvoyer(ev) {
  ev.preventDefault();
  const t = $('#msgr-texte').value.trim();
  if (!t || !MSG_ACTIF) return;
  $('#msgr-texte').value = '';
  const c = MSG_CANAUX.get(MSG_ACTIF);
  const m = { de: MOI.nom, t, ts: stamp() };
  if (MOI.mj) {                              // métadonnées libres du MJ
    const de = ($('#msgr-de') || {}).value || '';
    const ts = ($('#msgr-ts') || {}).value || '';
    if (de.trim() && de !== '*autre*') m.de = de.trim();
    if (ts.trim()) m.ts = ts.trim();
  }
  if (MSG_DEST) m.a = MSG_DEST;              // réponse « en personnage »
  const d = await msgSceller(c.k, m);
  try {
    await fetch(`${META.msg}/c/${MSG_ACTIF}.json`, {
      method: 'POST', body: JSON.stringify({ d }),
    });
    msgCharger(MSG_ACTIF);
  } catch (e) {
    $('#msgr-corps').insertAdjacentHTML('beforeend',
      `<p class="msg">Envoi impossible — vérifie la connexion.</p>`);
  }
}

function stamp() {
  const d = new Date();
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
    + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function msgFermer() {
  const p = $('#msgr');
  if (p) p.classList.remove('ouvert');
  clearInterval(MSG_MINUTEUR);
  MSG_MINUTEUR = null;
}

function msgCanal(id) {
  MSG_ACTIF = id;
  document.querySelectorAll('[data-canal]').forEach(a =>
    a.classList.toggle('on', a.dataset.canal === id));
  const z = $('#msgr-dest');
  z.hidden = !MSG_DEST;
  if (MSG_DEST) {
    z.innerHTML = `À : <b>${ech(MSG_DEST)}</b> <a id="msgr-dest-x" title="annuler">✕</a>`;
    $('#msgr-dest-x').onclick = () => { MSG_DEST = null; z.hidden = true; };
  }
  $('#msgr-form').hidden = false;
  $('#msgr-corps').innerHTML = '<p class="charge">Déchiffrement…</p>';
  msgCharger(id);
  clearInterval(MSG_MINUTEUR);
  MSG_MINUTEUR = setInterval(() => msgCharger(id, true), 6000);
}

function msgLigne(m) {
  const qui = m.a ? `${ech(m.de)} → ${ech(m.a)}` : ech(m.de);
  return `<div class="msgr-un${m.de === MOI.nom ? ' moi' : ''}">
      <span class="msgr-de">${qui} · ${ech(m.ts || '')}</span>
      <span class="msgr-t">${ech(m.t)}</span></div>`;
}

async function msgCharger(id, silencieux) {
  if (MSG_ACTIF !== id) return;
  const c = MSG_CANAUX.get(id);
  let data;
  try {
    const r = await fetch(`${META.msg}/c/${id}.json?orderBy="$key"&limitToLast=60`);
    data = await r.json();
  } catch (e) {
    if (!silencieux) $('#msgr-corps').innerHTML =
      '<p class="rien">Messagerie injoignable.</p>';
    return;
  }
  const cles = Object.keys(data || {}).sort();
  if (silencieux && cles[cles.length - 1] === MSG_DERNIER[id]) return;
  MSG_DERNIER[id] = cles[cles.length - 1];
  const lus = [];
  let neuf = false;
  for (const k of cles) {
    const m = await ouvrir(c.k, deb64(String(data[k].d || '')));
    if (m) { lus.push(m); neuf = msgApprendre(m.de) || neuf; }
  }
  if (neuf) msgCarnet();                     // un nouveau contact vient d'écrire
  $('#msgr-corps').innerHTML = lus.length
    ? lus.map(msgLigne).join('')
    : '<p class="rien">Aucun message — inaugure ce canal.</p>';
  $('#msgr-corps').scrollTop = $('#msgr-corps').scrollHeight;
}

/* ── le journal du MJ : tous les canaux, déroulés en clair ─────────────── */

async function msgJournal() {
  clearInterval(MSG_MINUTEUR);
  MSG_ACTIF = null;
  document.querySelectorAll('[data-canal]').forEach(a => a.classList.remove('on'));
  $('#msgr-form').hidden = true;
  const corps = $('#msgr-corps');
  corps.innerHTML = '<p class="charge">Déchiffrement du journal…</p>';
  const tout = [];
  for (const [id, c] of MSG_CANAUX.entries()) {
    let data;
    try {
      const r = await fetch(`${META.msg}/c/${id}.json?orderBy="$key"&limitToLast=500`);
      data = await r.json();
    } catch (e) { continue; }
    for (const k of Object.keys(data || {})) {
      const m = await ouvrir(c.k, deb64(String(data[k].d || '')));
      if (m) tout.push({ k, canal: c.n, ...m });
    }
  }
  tout.sort((x, y) => x.k < y.k ? -1 : 1);   // les clés Firebase sont chronologiques
  corps.innerHTML = `<div class="msgr-jtete"><b>🗒 Journal — ${tout.length} message${tout.length > 1 ? 's' : ''}</b>
      <button class="ico" id="msgr-exp" title="Télécharger le journal">⬇</button></div>`
    + (tout.length
      ? tout.map(m => `<div class="msgr-un jrn">
          <span class="msgr-de">[${ech(m.canal)}] ${m.a ? ech(m.de) + ' → ' + ech(m.a) : ech(m.de)} · ${ech(m.ts || '')}</span>
          <span class="msgr-t">${ech(m.t)}</span></div>`).join('')
      : '<p class="rien">Aucun message nulle part — les archives sont calmes.</p>');
  $('#msgr-exp').onclick = () => {
    const b = new Blob([JSON.stringify(tout.map(({ k, ...m }) => m), null, 1)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'herowiki-journal-messages.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
