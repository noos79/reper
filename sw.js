// ===== Service worker : fonctionnement hors ligne =====
// Ce petit programme tourne en arrière-plan dans le navigateur. Il garde une copie de tous les
// fichiers de l'application (dans un « cache ») et la sert quand il n'y a pas de réseau.
// Les données (projets, plans, remarques, photos) ne sont pas concernées : elles sont dans IndexedDB.

// Même numéro que « ?v=N » dans index.html : l'augmenter à chaque modification du CSS ou du JS.
// Un nouveau numéro = un nouveau cache ; l'ancien est effacé.
const VERSION = 25;
const NOM_CACHE = "suivi-chantier-" + VERSION;

// Fichiers copiés dès l'installation, pour que tout marche hors ligne dès la visite suivante
const FICHIERS = [
  "./",
  `css/charte.css?v=${VERSION}`,
  `css/style.css?v=${VERSION}`,
  `js/app.js?v=${VERSION}`,
  "manifest.webmanifest",
  "polices/roboto-condensed.woff2",
  "polices/dosis.woff2",
  "icones/icone-192.png",
  "icones/icone-512.png",
  // Bibliothèques (versions figées : leur contenu ne change jamais)
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
  "https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.5.1/+esm",
  "https://cdn.jsdelivr.net/npm/dexie@4.0.10/+esm",
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm"
];

// Au-delà de ce délai sans réponse du réseau, on ouvre la page gardée en cache
const DELAI_RESEAU = 3000;   // millisecondes

// ----- Installation : copie de tous les fichiers -----
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(NOM_CACHE);
    // « reload » : demande au serveur la version actuelle, sans passer par le cache habituel du navigateur
    await cache.addAll(FICHIERS.map((adresse) => new Request(adresse, { cache: "reload" })));
    await self.skipWaiting();   // la nouvelle version prend la main sans attendre
  })());
});

// ----- Activation : effacement des anciennes versions -----
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const nom of await caches.keys()) {
      if (nom.startsWith("suivi-chantier-") && nom !== NOM_CACHE) await caches.delete(nom);
    }
    await self.clients.claim();   // prend aussi en charge la page déjà ouverte

    // Annonce sa version aux pages ouvertes : une page plus ancienne affichera
    // « nouvelle version disponible »
    for (const page of await self.clients.matchAll({ type: "window" })) {
      page.postMessage({ type: "version", version: VERSION });
    }
  })());
});

// ----- Chaque demande de fichier passe par ici -----
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const adresse = new URL(e.request.url);
  const nousConcerne = adresse.origin === self.location.origin || adresse.hostname === "cdn.jsdelivr.net";
  if (!nousConcerne) return;

  if (e.request.mode === "navigate") {
    e.respondWith(pageReseauDAbord(e.request));
  } else {
    e.respondWith(cacheDAbord(e.request));
  }
});

// La page elle-même : le réseau d'abord (pour recevoir les mises à jour), le cache si le réseau
// ne répond pas ou trop lentement (chantier sans couverture)
async function pageReseauDAbord(demande) {
  const cache = await caches.open(NOM_CACHE);
  try {
    const reponse = await avecDelai(fetch(demande), DELAI_RESEAU);
    if (reponse.ok) cache.put("./", reponse.clone());
    return reponse;
  } catch {
    return (await cache.match("./")) || Response.error();
  }
}

// Les autres fichiers : le cache d'abord. Leur adresse change à chaque version (« ?v=N », numéro
// de version des bibliothèques) : une copie gardée n'est donc jamais périmée.
async function cacheDAbord(demande) {
  const cache = await caches.open(NOM_CACHE);
  const copie = await cache.match(demande);
  if (copie) return copie;

  const reponse = await fetch(demande);
  if (reponse.ok) cache.put(demande, reponse.clone());
  return reponse;
}

// Abandonne une attente trop longue
function avecDelai(promesse, duree) {
  return Promise.race([
    promesse,
    new Promise((_, echec) => setTimeout(() => echec(new Error("délai dépassé")), duree))
  ]);
}
