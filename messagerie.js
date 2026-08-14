/* ═══════════════════════════════════════════════════════════════════════════
   HeroWiki — la messagerie.  Fichier public : aucun secret ici.

   Firebase n'est qu'une boîte aux lettres : chaque message y arrive déjà
   chiffré (AES-GCM) avec la clé de son canal. Qui a la clé lit ; les autres —
   Firebase compris — transportent du bruit. Les clés de canal voyagent dans
   les trousseaux, exactement comme les clés de coffre : la distribution des
   clés EST la permission (salon de groupe, canal joueur↔MJ, exceptions).
   Append-only côté serveur : personne n'efface l'histoire.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

let MSG_CANAUX = new Map();   // id → {n: nom, k: clé brute}
let MSG_ACTIF = null;         // canal ouvert
let MSG_MINUTEUR = null;
let MSG_DERNIER = {};         // id → dernière clé de message vue

function msgInit(tr) {
  MSG_CANAUX = new Map();
  for (const [id, c] of Object.entries(tr.m || {}))
    MSG_CANAUX.set(id, { n: c.n, k: deb64(c.k) });
  const b = $('#msg-btn');
  if (b) b.hidden = !(META.msg && MSG_CANAUX.size);
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
        <button class="ico" id="msgr-x">✕</button></div>
      <div class="msgr-canaux" id="msgr-canaux"></div>
      <div class="msgr-corps" id="msgr-corps"><p class="rien">Choisis un canal.</p></div>
      <form class="msgr-envoi" id="msgr-form" hidden>
        <input id="msgr-texte" autocomplete="off" placeholder="ton message…" maxlength="600">
        <button class="btn1" type="submit">➤</button>
      </form>`;
    document.body.appendChild(p);
    $('#msgr-x').onclick = msgFermer;
    $('#msgr-canaux').innerHTML = [...MSG_CANAUX.entries()].map(([id, c]) =>
      `<a class="puce" data-canal="${ech(id)}">${ech(c.n)}</a>`).join('');
    document.querySelectorAll('[data-canal]').forEach(a =>
      a.onclick = () => msgCanal(a.dataset.canal));
    $('#msgr-form').onsubmit = async ev => {
      ev.preventDefault();
      const t = $('#msgr-texte').value.trim();
      if (!t || !MSG_ACTIF) return;
      $('#msgr-texte').value = '';
      const c = MSG_CANAUX.get(MSG_ACTIF);
      const d = await msgSceller(c.k, { de: MOI.nom, t, ts: stamp() });
      try {
        await fetch(`${META.msg}/c/${MSG_ACTIF}.json`, {
          method: 'POST', body: JSON.stringify({ d }),
        });
        msgCharger(MSG_ACTIF);
      } catch (e) {
        $('#msgr-corps').insertAdjacentHTML('beforeend',
          `<p class="msg">Envoi impossible — vérifie la connexion.</p>`);
      }
    };
  }
  p.classList.add('ouvert');
  if (MSG_CANAUX.size === 1) msgCanal([...MSG_CANAUX.keys()][0]);
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
  $('#msgr-form').hidden = false;
  $('#msgr-corps').innerHTML = '<p class="charge">Déchiffrement…</p>';
  msgCharger(id);
  clearInterval(MSG_MINUTEUR);
  MSG_MINUTEUR = setInterval(() => msgCharger(id, true), 6000);
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
  for (const k of cles) {
    const m = await ouvrir(c.k, deb64(String(data[k].d || '')));
    if (m) lus.push(m);
  }
  $('#msgr-corps').innerHTML = lus.length
    ? lus.map(m => `<div class="msgr-un${m.de === MOI.nom ? ' moi' : ''}">
        <span class="msgr-de">${ech(m.de)} · ${ech(m.ts || '')}</span>
        <span class="msgr-t">${ech(m.t)}</span></div>`).join('')
    : '<p class="rien">Aucun message — inaugure ce canal.</p>';
  $('#msgr-corps').scrollTop = $('#msgr-corps').scrollHeight;
}
