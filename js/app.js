import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import Panzoom from "https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.5.1/+esm";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// ===== Réglages =====
const QUALITE = 2;
const PIXELS_MAX = 16_000_000;
const DUREE_APPUI_LONG = 600;    // millisecondes
const TOLERANCE_MOUVEMENT = 10;  // pixels : au-delà, c'est un déplacement, pas un appui

// ===== Éléments de la page =====
const choixPdf = document.getElementById("choixPdf");
const canevas = document.getElementById("canevasPlan");
const cadre = document.getElementById("cadrePlan");
const contenu = document.getElementById("contenuPlan");
const boutonRecadrer = document.getElementById("recadrer");

const fiche = document.getElementById("fiche");
const titreFiche = document.getElementById("titreFiche");
const champTexte = document.getElementById("champTexte");
const champStatut = document.getElementById("champStatut");
const champEntreprise = document.getElementById("champEntreprise");
const champDate = document.getElementById("champDate");
const boutonSupprimer = document.getElementById("boutonSupprimer");

// ===== Données (en mémoire vive pour l'instant) =====
let remarques = [];
let remarqueEnCours = null;   // celle affichée dans la fiche
let estNouvelle = false;

// ===== Zoom et déplacement =====
const panzoom = Panzoom(contenu, { minScale: 0.5, maxScale: 6, step: 0.3 });
cadre.addEventListener("wheel", panzoom.zoomWithWheel);
boutonRecadrer.addEventListener("click", () => panzoom.reset());

// À chaque zoom, on transmet le niveau au CSS pour garder les pastilles à taille fixe
contenu.addEventListener("panzoomchange", (e) => {
  contenu.style.setProperty("--echelle", e.detail.scale);
});

// Empêche le menu contextuel du navigateur lors d'un appui long
cadre.addEventListener("contextmenu", (e) => e.preventDefault());

// ===== Ouverture d'un PDF =====
choixPdf.addEventListener("change", async () => {
  const fichier = choixPdf.files[0];
  if (!fichier) return;

  try {
    const donnees = await fichier.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: donnees }).promise;
    const page = await pdf.getPage(1);
    await afficherPage(page);
    remarques = [];          // nouveau plan : on repart à zéro (provisoire)
    dessinerPastilles();
  } catch (erreur) {
    alert("Impossible d'ouvrir ce PDF : " + erreur.message);
  }
});

async function afficherPage(page) {
  const tailleOrigine = page.getViewport({ scale: 1 });
  const echelleEcran = Math.min(
    cadre.clientWidth / tailleOrigine.width,
    cadre.clientHeight / tailleOrigine.height
  ) * 0.98;

  const largeurAffichee = tailleOrigine.width * echelleEcran;
  const hauteurAffichee = tailleOrigine.height * echelleEcran;

  let finesse = (window.devicePixelRatio || 1) * QUALITE;
  const pixels = largeurAffichee * hauteurAffichee * finesse * finesse;
  if (pixels > PIXELS_MAX) {
    finesse = finesse * Math.sqrt(PIXELS_MAX / pixels);
  }

  const vue = page.getViewport({ scale: echelleEcran * finesse });
  canevas.width = Math.floor(vue.width);
  canevas.height = Math.floor(vue.height);
  canevas.style.width = largeurAffichee + "px";
  canevas.style.height = hauteurAffichee + "px";

  panzoom.reset({ animate: false });

  await page.render({ canvasContext: canevas.getContext("2d"), viewport: vue }).promise;
}

// ===== Détection de l'appui long =====
let minuteur = null;
let pointDepart = null;

contenu.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary) { annulerAppui(); return; }  // deuxième doigt = pincement, pas un appui
  if (e.target !== canevas) return;               // appui sur une pastille : on ignore ici
  pointDepart = { x: e.clientX, y: e.clientY };
  minuteur = setTimeout(() => {
    minuteur = null;
    poserRemarque(e.clientX, e.clientY);
  }, DUREE_APPUI_LONG);
});

contenu.addEventListener("pointermove", (e) => {
  if (!minuteur) return;
  const distance = Math.hypot(e.clientX - pointDepart.x, e.clientY - pointDepart.y);
  if (distance > TOLERANCE_MOUVEMENT) annulerAppui();   // le doigt bouge : c'est un déplacement
});

contenu.addEventListener("pointerup", annulerAppui);
contenu.addEventListener("pointercancel", annulerAppui);

function annulerAppui() {
  clearTimeout(minuteur);
  minuteur = null;
}

// ===== Création d'une remarque =====
function poserRemarque(clientX, clientY) {
  // Position du doigt convertie en proportion du plan (0 = bord gauche/haut, 1 = bord droit/bas)
  const rect = canevas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  if (navigator.vibrate) navigator.vibrate(30);   // petit retour tactile sur Android

  const numero = remarques.reduce((max, r) => Math.max(max, r.numero), 0) + 1;

  ouvrirFiche({
    id: crypto.randomUUID(),
    numero,
    x,
    y,
    texte: "",
    statut: "ouverte",
    entreprise: "",
    date: aujourdhui()
  }, true);
}

// ===== Fiche remarque =====
function ouvrirFiche(remarque, nouvelle) {
  remarqueEnCours = remarque;
  estNouvelle = nouvelle;

  titreFiche.textContent = "Remarque n° " + remarque.numero;
  champTexte.value = remarque.texte;
  champStatut.value = remarque.statut;
  champEntreprise.value = remarque.entreprise;
  champDate.value = remarque.date;
  boutonSupprimer.hidden = nouvelle;   // pas de suppression d'une remarque pas encore créée

  fiche.returnValue = "";
  fiche.showModal();
}

fiche.addEventListener("close", () => {
  const action = fiche.returnValue;   // la « value » du bouton cliqué

  if (action === "enregistrer") {
    remarqueEnCours.texte = champTexte.value.trim();
    remarqueEnCours.statut = champStatut.value;
    remarqueEnCours.entreprise = champEntreprise.value.trim();
    remarqueEnCours.date = champDate.value;
    if (estNouvelle) remarques.push(remarqueEnCours);
  }

  if (action === "supprimer") {
    if (confirm("Supprimer la remarque n° " + remarqueEnCours.numero + " ?")) {
      remarques = remarques.filter((r) => r.id !== remarqueEnCours.id);
    }
  }

  remarqueEnCours = null;
  dessinerPastilles();
});

// ===== Affichage des pastilles =====
function dessinerPastilles() {
  contenu.querySelectorAll(".pastille").forEach((p) => p.remove());   // on efface tout...

  for (const r of remarques) {                                        // ...et on redessine
    const pastille = document.createElement("button");
    pastille.className = "pastille panzoom-exclude " + r.statut;
    pastille.textContent = r.numero;
    pastille.style.left = (r.x * 100) + "%";
    pastille.style.top = (r.y * 100) + "%";
    pastille.addEventListener("click", () => ouvrirFiche(r, false));
    contenu.appendChild(pastille);
  }
}

// ===== Outils =====
function aujourdhui() {
  // Date locale au format AAAA-MM-JJ (toISOString seul donnerait l'heure UTC,
  // donc la veille entre minuit et 2 h en Belgique)
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}