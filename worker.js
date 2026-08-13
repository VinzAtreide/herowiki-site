/* Dérivation de la clé (PBKDF2, 310 000 tours) hors du fil principal :
   l'interface reste vivante pendant les ~1 à 3 secondes de calcul. */
'use strict';
onmessage = async ev => {
  const { phrase, sel, it } = ev.data;
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: sel, iterations: it }, base, 256);
  postMessage(bits, [bits]);
};
