// 1. Chargement de pdf.js depuis Internet (version figée pour éviter les surprises)
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

// pdf.js délègue le décodage lourd à un « travailleur » en arrière-plan,
// pour que l'écran ne se fige pas pendant le calcul.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// 2. On récupère les éléments de la page par leur id
const choixPdf = document.getElementById("choixPdf");
const canevas = document.getElementById("canevasPlan");

// 3. Quand l'utilisateur a choisi un fichier...
choixPdf.addEventListener("change", async () => {
  const fichier = choixPdf.files[0];
  if (!fichier) return; // il a annulé : on ne fait rien

  try {
    const donnees = await fichier.arrayBuffer();                    // lecture du fichier brut
    const pdf = await pdfjsLib.getDocument({ data: donnees }).promise; // décodage du PDF
    const page = await pdf.getPage(1);                              // première page
    await afficherPage(page);
  } catch (erreur) {
    alert("Impossible d'ouvrir ce PDF : " + erreur.message);
  }
});

// 4. Dessin de la page dans le canevas, ajustée à la largeur de l'écran
async function afficherPage(page) {
  const largeurEcran = canevas.clientWidth;           // largeur affichée, en pixels
  const tailleOrigine = page.getViewport({ scale: 1 });
  const echelle = largeurEcran / tailleOrigine.width; // facteur pour remplir la largeur

  // Les écrans de téléphone ont 2 à 3 pixels physiques par pixel « logique » :
  // on dessine plus fin pour que les traits du plan restent nets.
  const densite = window.devicePixelRatio || 1;
  const vue = page.getViewport({ scale: echelle * densite });

  canevas.width = vue.width;
  canevas.height = vue.height;

  await page.render({
    canvasContext: canevas.getContext("2d"),
    viewport: vue
  }).promise;
}