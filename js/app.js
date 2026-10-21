import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import Panzoom from "https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.5.1/+esm";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// --- Réglages ---
const QUALITE = 2;              // finesse du dessin : 2 = net jusqu'à un zoom ×2
const PIXELS_MAX = 16_000_000;  // plafond pour ne pas saturer la mémoire d'un téléphone

// --- Éléments de la page ---
const choixPdf = document.getElementById("choixPdf");
const canevas = document.getElementById("canevasPlan");
const cadre = document.getElementById("cadrePlan");
const contenu = document.getElementById("contenuPlan");
const boutonRecadrer = document.getElementById("recadrer");

// --- Zoom et déplacement ---
const panzoom = Panzoom(contenu, { minScale: 0.5, maxScale: 6, step: 0.3 });
cadre.addEventListener("wheel", panzoom.zoomWithWheel);       // molette sur PC
boutonRecadrer.addEventListener("click", () => panzoom.reset());

// --- Ouverture d'un PDF ---
choixPdf.addEventListener("change", async () => {
  const fichier = choixPdf.files[0];
  if (!fichier) return;

  try {
    const donnees = await fichier.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: donnees }).promise;
    const page = await pdf.getPage(1);
    await afficherPage(page);
  } catch (erreur) {
    alert("Impossible d'ouvrir ce PDF : " + erreur.message);
  }
});

// --- Dessin du plan, ajusté pour tenir entièrement dans l'écran ---
async function afficherPage(page) {
  const tailleOrigine = page.getViewport({ scale: 1 });

  // Échelle qui fait tenir le plan dans le cadre (largeur ET hauteur), avec une petite marge
  const echelleEcran = Math.min(
    cadre.clientWidth / tailleOrigine.width,
    cadre.clientHeight / tailleOrigine.height
  ) * 0.98;

  const largeurAffichee = tailleOrigine.width * echelleEcran;
  const hauteurAffichee = tailleOrigine.height * echelleEcran;

  // Finesse = densité de l'écran × qualité voulue, plafonnée si l'image devient trop lourde
  let finesse = (window.devicePixelRatio || 1) * QUALITE;
  const pixels = largeurAffichee * hauteurAffichee * finesse * finesse;
  if (pixels > PIXELS_MAX) {
    finesse = finesse * Math.sqrt(PIXELS_MAX / pixels);
  }

  const vue = page.getViewport({ scale: echelleEcran * finesse });

  // Taille réelle du dessin (en pixels physiques)...
  canevas.width = Math.floor(vue.width);
  canevas.height = Math.floor(vue.height);
  // ...et taille à l'écran (plus petite : c'est ce qui donne la netteté)
  canevas.style.width = largeurAffichee + "px";
  canevas.style.height = hauteurAffichee + "px";

  panzoom.reset({ animate: false });

  await page.render({
    canvasContext: canevas.getContext("2d"),
    viewport: vue
  }).promise;
}