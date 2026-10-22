import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import Panzoom from "https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.5.1/+esm";
import Dexie from "https://cdn.jsdelivr.net/npm/dexie@4.0.10/+esm";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

// ===== Base de données =====
// Trois « tables ». Après « id », on liste les champs sur lesquels on fera des recherches.
const db = new Dexie("suiviChantier");
db.version(1).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId"
});
// Version 2 : ajout des photos des remarques. Les données de la version 1 sont conservées.
db.version(2).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId",
  photos: "id, remarqueId, planId, projetId"
});

// Demande à Android de ne pas effacer nos données s'il manque de place
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist();
}

// ===== Réglages =====
const QUALITE = 2;
const PIXELS_MAX = 16_000_000;
const DUREE_APPUI_LONG = 600;
const TOLERANCE_MOUVEMENT = 10;

// Photos : réduites à l'ajout pour ne pas alourdir la base et les exports
const PHOTO_COTE_MAX = 1600;        // pixels, sur le plus grand côté
const PHOTO_QUALITE = 0.85;         // qualité JPEG (0 à 1)
const EPAISSEUR_TRAIT = 0.006;      // épaisseur des traits, en proportion du plus grand côté
const COULEUR_TRAIT =
  getComputedStyle(document.documentElement).getPropertyValue("--trait-annotation").trim();

// Identifiant et version du format des fichiers d'export
const FORMAT_EXPORT = "suivi-chantier";
const VERSION_EXPORT = 2;           // version 2 : ajout des photos

// ===== Raccourci =====
const el = (id) => document.getElementById(id);

// ===== Éléments de la page =====
const listeProjets = el("listeProjets");
const listePlans = el("listePlans");
const choixPdf = el("choixPdf");
const choixZip = el("choixZip");
const canevas = el("canevasPlan");
const cadre = el("cadrePlan");
const contenu = el("contenuPlan");

const fiche = el("fiche");
const titreFiche = el("titreFiche");
const champTexte = el("champTexte");
const champStatut = el("champStatut");
const champEntreprise = el("champEntreprise");
const champDate = el("champDate");
const boutonSupprimer = el("boutonSupprimer");
const vignettes = el("vignettes");
const choixPhoto = el("choixPhoto");
const appareilPhoto = el("appareilPhoto");

const editeurPhoto = el("editeurPhoto");
const cadrePhoto = el("cadrePhoto");
const canevasPhoto = el("canevasPhoto");

// ===== État courant : ce qui est ouvert en ce moment =====
let projetCourant = null;
let planCourant = null;
let remarques = [];           // remarques du plan affiché
let remarqueEnCours = null;   // celle affichée dans la fiche
let estNouvelle = false;
let photosFiche = [];         // photos de la remarque affichée (copie de travail, enregistrée avec la fiche)
let photosSupprimees = [];    // identifiants des photos à effacer à l'enregistrement
let photoEnEdition = null;    // celle affichée dans l'écran d'annotation
const imagesDecodees = new Map();   // images déjà préparées pour l'affichage (évite de les relire)

// ===== Navigation entre écrans =====
function afficherEcran(idEcran) {
  document.querySelectorAll(".ecran").forEach((ecran) => {
    ecran.hidden = ecran.id !== idEcran;
  });
}

el("retourProjets").addEventListener("click", afficherProjets);
el("retourProjet").addEventListener("click", () => ouvrirProjet(projetCourant));

// ===================================================================
// ÉCRAN 1 : PROJETS
// ===================================================================
el("nouveauProjet").addEventListener("click", async () => {
  const nom = prompt("Nom du projet :");
  if (!nom || !nom.trim()) return;

  await db.projets.add({
    id: crypto.randomUUID(),
    nom: nom.trim(),
    creeLe: aujourdhui(),
    dernierNumero: 0
  });
  await afficherProjets();
});

async function afficherProjets() {
  const projets = await db.projets.orderBy("nom").toArray();

  listeProjets.replaceChildren();   // vide la liste avant de la reconstruire
  if (projets.length === 0) {
    listeProjets.append(elementVide("Aucun projet. Crée le premier avec « Nouveau projet »."));
  }
  for (const projet of projets) {
    listeProjets.append(elementListe(
      projet.nom,
      "Créé le " + formaterDate(projet.creeLe),
      () => ouvrirProjet(projet),
      () => supprimerProjet(projet),
      () => exporterProjet(projet)
    ));
  }
  afficherEcran("ecranProjets");
}

// ----- Export : un fichier .zip contenant projet.json, les PDF des plans et les photos -----
async function exporterProjet(projet) {
  try {
    const projetAJour = await db.projets.get(projet.id);
    const plans = await db.plans.where("projetId").equals(projet.id).toArray();
    const remarquesProjet = await db.remarques.where("projetId").equals(projet.id).toArray();
    const photosProjet = await db.photos.where("projetId").equals(projet.id).toArray();

    const zip = new JSZip();
    zip.file("projet.json", JSON.stringify({
      format: FORMAT_EXPORT,
      version: VERSION_EXPORT,
      exporteLe: aujourdhui(),
      projet: projetAJour,
      // Chaque plan sans son « fichier » : le PDF est rangé à part dans le dossier plans/
      plans: plans.map(({ fichier, ...reste }) => reste),
      remarques: remarquesProjet,
      // De même, chaque photo sans son « image » : rangée à part dans le dossier photos/
      photos: photosProjet.map(({ image, ...reste }) => reste)
    }, null, 2));

    for (const plan of plans) {
      zip.file(`plans/${plan.id}.pdf`, plan.fichier);
    }
    for (const photo of photosProjet) {
      zip.file(`photos/${photo.id}.jpg`, photo.image);
    }

    const contenuZip = await zip.generateAsync({ type: "blob" });
    telecharger(contenuZip, `${nomDeFichier(projetAJour.nom)}_${aujourdhui()}.zip`);
  } catch (erreur) {
    alert("Export impossible : " + erreur.message);
  }
}

// ----- Import : remplace le projet s'il existe déjà sur l'appareil (sans fusion) -----
choixZip.addEventListener("change", async () => {
  const fichier = choixZip.files[0];
  choixZip.value = "";   // permet de rechoisir le même fichier plus tard
  if (!fichier) return;

  try {
    await importerProjet(fichier);
  } catch (erreur) {
    alert("Import impossible : " + erreur.message);
  }
  await afficherProjets();
});

async function importerProjet(fichierZip) {
  let zip;
  try {
    zip = await JSZip.loadAsync(fichierZip);
  } catch {
    throw new Error("ce fichier n'est pas un .zip valide.");
  }

  const fichierJson = zip.file("projet.json");
  if (!fichierJson) throw new Error("ce fichier n'est pas un export de Suivi chantier.");
  const donnees = JSON.parse(await fichierJson.async("string"));

  // Vérifications : bon format, version connue, contenu complet
  if (donnees.format !== FORMAT_EXPORT) {
    throw new Error("ce fichier n'est pas un export de Suivi chantier.");
  }
  // Version 1 (sans photos) et version 2 (avec photos) sont acceptées
  if (donnees.version !== 1 && donnees.version !== 2) {
    throw new Error(`version de format inconnue (${donnees.version}). Mets l'application à jour.`);
  }
  const { projet, plans, remarques: remarquesImportees } = donnees;
  const photosImportees = donnees.photos || [];   // absentes en version 1
  if (!projet || !projet.id || !Array.isArray(plans) || !Array.isArray(remarquesImportees)
      || !Array.isArray(photosImportees)) {
    throw new Error("le fichier projet.json est incomplet.");
  }
  const idsPlans = new Set(plans.map((p) => p.id));
  if (remarquesImportees.some((r) => !idsPlans.has(r.planId))) {
    throw new Error("certaines remarques renvoient à un plan absent du fichier.");
  }
  const idsRemarques = new Set(remarquesImportees.map((r) => r.id));
  if (photosImportees.some((p) => !idsRemarques.has(p.remarqueId))) {
    throw new Error("certaines photos renvoient à une remarque absente du fichier.");
  }

  // Lecture des PDF AVANT la transaction : une transaction Dexie ne doit attendre que la base
  const plansAImporter = [];
  for (const plan of plans) {
    const fichierPdf = zip.file(`plans/${plan.id}.pdf`);
    if (!fichierPdf) throw new Error(`le PDF du plan « ${plan.nom} » est absent du fichier.`);
    const octets = await fichierPdf.async("blob");
    plansAImporter.push({
      ...plan,
      projetId: projet.id,
      fichier: new Blob([octets], { type: "application/pdf" })
    });
  }
  const remarquesAImporter = remarquesImportees.map((r) => ({ ...r, projetId: projet.id }));

  const photosAImporter = [];
  for (const photo of photosImportees) {
    const fichierPhoto = zip.file(`photos/${photo.id}.jpg`);
    if (!fichierPhoto) throw new Error("une photo est absente du fichier.");
    const octets = await fichierPhoto.async("blob");
    photosAImporter.push({
      ...photo,
      projetId: projet.id,
      image: new Blob([octets], { type: "image/jpeg" })
    });
  }

  const existant = await db.projets.get(projet.id);
  if (existant && !confirm(
    `Le projet « ${existant.nom} » existe déjà sur cet appareil.\n\n` +
    `Le remplacer par la version du fichier (exportée le ${formaterDate(donnees.exporteLe)}) ?\n` +
    `Ses plans, remarques et photos actuels seront définitivement supprimés.`
  )) return;

  // Transaction : soit tout le projet est remplacé, soit rien ne change
  await db.transaction("rw", db.projets, db.plans, db.remarques, db.photos, async () => {
    await db.photos.where("projetId").equals(projet.id).delete();
    await db.remarques.where("projetId").equals(projet.id).delete();
    await db.plans.where("projetId").equals(projet.id).delete();
    await db.projets.put(projet);
    await db.plans.bulkAdd(plansAImporter);
    await db.remarques.bulkAdd(remarquesAImporter);
    await db.photos.bulkAdd(photosAImporter);
  });

  alert(`Projet « ${projet.nom} » importé : ${plans.length} plan(s), ` +
    `${remarquesImportees.length} remarque(s), ${photosImportees.length} photo(s).`);
}

async function supprimerProjet(projet) {
  if (!confirm(`Supprimer le projet « ${projet.nom} » avec tous ses plans, remarques et photos ?`)) return;

  // Transaction : soit tout est supprimé, soit rien (jamais de remarques ni de photos orphelines)
  await db.transaction("rw", db.projets, db.plans, db.remarques, db.photos, async () => {
    await db.photos.where("projetId").equals(projet.id).delete();
    await db.remarques.where("projetId").equals(projet.id).delete();
    await db.plans.where("projetId").equals(projet.id).delete();
    await db.projets.delete(projet.id);
  });
  await afficherProjets();
}

// ===================================================================
// ÉCRAN 2 : UN PROJET ET SES PLANS
// ===================================================================
async function ouvrirProjet(projet) {
  projetCourant = await db.projets.get(projet.id);   // version à jour depuis la base
  el("titreProjet").textContent = projetCourant.nom;

  const plans = await db.plans.where("projetId").equals(projetCourant.id).sortBy("nom");

  listePlans.replaceChildren();
  if (plans.length === 0) {
    listePlans.append(elementVide("Aucun plan. Ajoute un PDF avec « Ajouter un plan »."));
  }
  for (const plan of plans) {
    const ouvertes = await db.remarques
      .where("planId").equals(plan.id)
      .filter((r) => r.statut === "ouverte")
      .count();
    const detail = ouvertes + (ouvertes > 1 ? " remarques ouvertes" : " remarque ouverte");

    listePlans.append(elementListe(
      plan.nom,
      detail,
      () => ouvrirPlan(plan),
      () => supprimerPlan(plan)
    ));
  }
  afficherEcran("ecranProjet");
}

choixPdf.addEventListener("change", async () => {
  const fichier = choixPdf.files[0];
  choixPdf.value = "";   // permet de rechoisir le même fichier plus tard
  if (!fichier) return;

  const nomParDefaut = fichier.name.replace(/\.pdf$/i, "");
  const nom = prompt("Nom du plan :", nomParDefaut);
  if (nom === null) return;   // « Annuler »

  await db.plans.add({
    id: crypto.randomUUID(),
    projetId: projetCourant.id,
    nom: nom.trim() || nomParDefaut,
    fichier,      // le PDF lui-même est stocké dans la base
    page: 1
  });
  await ouvrirProjet(projetCourant);
});

async function supprimerPlan(plan) {
  if (!confirm(`Supprimer le plan « ${plan.nom} », ses remarques et leurs photos ?`)) return;

  await db.transaction("rw", db.plans, db.remarques, db.photos, async () => {
    await db.photos.where("planId").equals(plan.id).delete();
    await db.remarques.where("planId").equals(plan.id).delete();
    await db.plans.delete(plan.id);
  });
  await ouvrirProjet(projetCourant);
}

// ===================================================================
// ÉCRAN 3 : UN PLAN ET SES REMARQUES
// ===================================================================
const panzoom = Panzoom(contenu, { minScale: 0.5, maxScale: 6, step: 0.3 });
cadre.addEventListener("wheel", panzoom.zoomWithWheel);
el("recadrer").addEventListener("click", () => panzoom.reset());

contenu.addEventListener("panzoomchange", (e) => {
  contenu.style.setProperty("--echelle", e.detail.scale);
});

cadre.addEventListener("contextmenu", (e) => e.preventDefault());

async function ouvrirPlan(plan) {
  planCourant = plan;
  el("titrePlan").textContent = plan.nom;

  remarques = [];
  dessinerPastilles();         // efface les pastilles du plan précédent

  // L'écran doit être visible AVANT de dessiner : un élément caché a une taille nulle
  afficherEcran("ecranPlan");

  try {
    const donnees = await plan.fichier.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: donnees }).promise;
    const page = await pdf.getPage(plan.page);
    await afficherPage(page);

    remarques = await db.remarques.where("planId").equals(plan.id).toArray();
    dessinerPastilles();
  } catch (erreur) {
    alert("Impossible d'ouvrir ce plan : " + erreur.message);
  }
}

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

// ----- Appui long -----
let minuteur = null;
let pointDepart = null;

contenu.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary) { annulerAppui(); return; }
  if (e.target !== canevas) return;
  pointDepart = { x: e.clientX, y: e.clientY };
  minuteur = setTimeout(() => {
    minuteur = null;
    poserRemarque(e.clientX, e.clientY);
  }, DUREE_APPUI_LONG);
});

contenu.addEventListener("pointermove", (e) => {
  if (!minuteur) return;
  const distance = Math.hypot(e.clientX - pointDepart.x, e.clientY - pointDepart.y);
  if (distance > TOLERANCE_MOUVEMENT) annulerAppui();
});

contenu.addEventListener("pointerup", annulerAppui);
contenu.addEventListener("pointercancel", annulerAppui);

function annulerAppui() {
  clearTimeout(minuteur);
  minuteur = null;
}

// ----- Création d'une remarque -----
function poserRemarque(clientX, clientY) {
  const rect = canevas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  if (navigator.vibrate) navigator.vibrate(30);

  ouvrirFiche({
    id: crypto.randomUUID(),
    projetId: projetCourant.id,
    planId: planCourant.id,
    numero: (projetCourant.dernierNumero || 0) + 1,   // numéro réservé, confirmé à l'enregistrement
    x,
    y,
    texte: "",
    statut: "ouverte",
    entreprise: "",
    date: aujourdhui()
  }, true);
}

// ----- Fiche remarque -----
async function ouvrirFiche(remarque, nouvelle) {
  remarqueEnCours = remarque;
  estNouvelle = nouvelle;

  titreFiche.textContent = "Remarque n° " + remarque.numero;
  champTexte.value = remarque.texte;
  champStatut.value = remarque.statut;
  champEntreprise.value = remarque.entreprise;
  champDate.value = remarque.date;
  boutonSupprimer.hidden = nouvelle;

  // Copie de travail des photos : rien n'est écrit dans la base avant « enregistrer »
  photosFiche = nouvelle ? [] : await db.photos.where("remarqueId").equals(remarque.id).toArray();
  photosSupprimees = [];
  afficherVignettes();

  fiche.returnValue = "";
  fiche.showModal();
}

fiche.addEventListener("close", async () => {
  const action = fiche.returnValue;
  const remarque = remarqueEnCours;
  remarqueEnCours = null;

  if (action === "enregistrer") {
    remarque.texte = champTexte.value.trim();
    remarque.statut = champStatut.value;
    remarque.entreprise = champEntreprise.value.trim();
    remarque.date = champDate.value;

    // Transaction : la remarque, ses photos et le compteur sont enregistrés ensemble
    await db.transaction("rw", db.remarques, db.photos, db.projets, async () => {
      await db.remarques.put(remarque);   // « put » = créer ou mettre à jour
      await db.photos.bulkDelete(photosSupprimees);
      await db.photos.bulkPut(photosFiche);
      if (estNouvelle) {
        // Le numéro est définitivement consommé : il ne sera jamais réattribué
        await db.projets.update(projetCourant.id, { dernierNumero: remarque.numero });
      }
    });

    if (estNouvelle) {
      remarques.push(remarque);
      projetCourant.dernierNumero = remarque.numero;
    }
  }

  if (action === "supprimer") {
    if (confirm("Supprimer la remarque n° " + remarque.numero + " et ses photos ?")) {
      await db.transaction("rw", db.remarques, db.photos, async () => {
        await db.photos.where("remarqueId").equals(remarque.id).delete();
        await db.remarques.delete(remarque.id);
      });
      remarques = remarques.filter((r) => r.id !== remarque.id);
    }
  }

  // Libère la mémoire des images affichées dans la fiche
  for (const lecture of imagesDecodees.values()) lecture.then((image) => image.close());
  imagesDecodees.clear();
  photosFiche = [];
  photosSupprimees = [];

  dessinerPastilles();
});

// ===================================================================
// PHOTOS DES REMARQUES
// ===================================================================
// Une photo garde son image d'origine et, à part, ses traits d'annotation : l'annotation reste
// modifiable. Chaque trait est une liste de points [x, y] en proportion de l'image (0 à 1).

// Deux entrées : l'appareil photo directement, ou la galerie
el("prendrePhoto").addEventListener("click", () => appareilPhoto.click());
el("ajouterPhoto").addEventListener("click", () => choixPhoto.click());
appareilPhoto.addEventListener("change", () => ajouterPhoto(appareilPhoto));
choixPhoto.addEventListener("change", () => ajouterPhoto(choixPhoto));

async function ajouterPhoto(entree) {
  const fichier = entree.files[0];
  entree.value = "";   // permet de reprendre une photo plus tard
  if (!fichier) return;

  try {
    const { image, largeur, hauteur } = await reduirePhoto(fichier);
    const photo = {
      id: crypto.randomUUID(),
      projetId: remarqueEnCours.projetId,
      planId: remarqueEnCours.planId,
      remarqueId: remarqueEnCours.id,
      image,
      largeur,
      hauteur,
      traits: [],
      ajouteeLe: aujourdhui()
    };
    photosFiche.push(photo);
    afficherVignettes();
    ouvrirEditeur(photo);   // on peut annoter tout de suite
  } catch (erreur) {
    alert("Impossible d'ajouter cette photo (format non pris en charge ?) : " + erreur.message);
  }
}

// Réduit la photo à PHOTO_COTE_MAX pixels et la convertit en JPEG
async function reduirePhoto(fichier) {
  // « from-image » : respecte l'orientation enregistrée par l'appareil photo
  const source = await createImageBitmap(fichier, { imageOrientation: "from-image" });
  const echelle = Math.min(1, PHOTO_COTE_MAX / Math.max(source.width, source.height));
  const largeur = Math.round(source.width * echelle);
  const hauteur = Math.round(source.height * echelle);

  const canevasTravail = document.createElement("canvas");
  canevasTravail.width = largeur;
  canevasTravail.height = hauteur;
  canevasTravail.getContext("2d").drawImage(source, 0, 0, largeur, hauteur);
  source.close();

  const image = await new Promise((resolu) => canevasTravail.toBlob(resolu, "image/jpeg", PHOTO_QUALITE));
  return { image, largeur, hauteur };
}

// Image prête à dessiner (lue une seule fois, puis gardée tant que la fiche est ouverte).
// On garde la lecture en cours (une « promesse ») : deux demandes simultanées ne lisent pas deux fois.
function imageDe(photo) {
  if (!imagesDecodees.has(photo.id)) {
    imagesDecodees.set(photo.id, createImageBitmap(photo.image));
  }
  return imagesDecodees.get(photo.id);
}

// Dessine la photo et ses traits dans un canevas, à la taille affichée demandée
async function dessinerPhoto(canevasCible, photo, largeurAffichee, hauteurAffichee) {
  const finesse = window.devicePixelRatio || 1;
  canevasCible.width = Math.round(largeurAffichee * finesse);
  canevasCible.height = Math.round(hauteurAffichee * finesse);
  canevasCible.style.width = largeurAffichee + "px";
  canevasCible.style.height = hauteurAffichee + "px";

  const ctx = canevasCible.getContext("2d");
  ctx.drawImage(await imageDe(photo), 0, 0, canevasCible.width, canevasCible.height);
  for (const trait of photo.traits) {
    dessinerTrait(ctx, trait, canevasCible.width, canevasCible.height);
  }
}

function dessinerTrait(ctx, trait, largeur, hauteur) {
  ctx.strokeStyle = COULEUR_TRAIT;
  ctx.lineWidth = EPAISSEUR_TRAIT * Math.max(largeur, hauteur);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(trait[0][0] * largeur, trait[0][1] * hauteur);
  for (const [x, y] of trait) ctx.lineTo(x * largeur, y * hauteur);
  if (trait.length === 1) ctx.lineTo(trait[0][0] * largeur + 0.1, trait[0][1] * hauteur);   // un simple point
  ctx.stroke();
}

// ----- Vignettes dans la fiche -----
const HAUTEUR_VIGNETTE = 72;

function afficherVignettes() {
  vignettes.replaceChildren();
  for (const photo of photosFiche) {
    const bouton = document.createElement("button");
    bouton.type = "button";   // dans un formulaire, sinon le bouton fermerait la fiche
    bouton.className = "vignette";
    bouton.setAttribute("aria-label", "Ouvrir la photo");
    const apercu = document.createElement("canvas");
    bouton.append(apercu);
    bouton.addEventListener("click", () => ouvrirEditeur(photo));
    vignettes.append(bouton);

    const largeur = HAUTEUR_VIGNETTE * photo.largeur / photo.hauteur;
    dessinerPhoto(apercu, photo, largeur, HAUTEUR_VIGNETTE);
  }
}

// ----- Écran d'annotation -----
let traitEnCours = null;

function ouvrirEditeur(photo) {
  photoEnEdition = photo;
  editeurPhoto.showModal();
  redessinerEditeur();   // après showModal : l'écran doit être visible pour connaître sa taille
}

async function redessinerEditeur() {
  const photo = photoEnEdition;
  const echelle = Math.min(cadrePhoto.clientWidth / photo.largeur, cadrePhoto.clientHeight / photo.hauteur);
  await dessinerPhoto(canevasPhoto, photo, photo.largeur * echelle, photo.hauteur * echelle);
}

// Position du doigt en proportion de l'image (0 à 1), arrondie pour garder des données légères
function pointSurPhoto(e) {
  const rect = canevasPhoto.getBoundingClientRect();
  const borne = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  return [borne((e.clientX - rect.left) / rect.width), borne((e.clientY - rect.top) / rect.height)];
}

canevasPhoto.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary) return;   // un deuxième doigt ne dessine pas
  canevasPhoto.setPointerCapture(e.pointerId);
  traitEnCours = [pointSurPhoto(e)];
  photoEnEdition.traits.push(traitEnCours);
  dessinerTrait(canevasPhoto.getContext("2d"), traitEnCours, canevasPhoto.width, canevasPhoto.height);
});

canevasPhoto.addEventListener("pointermove", (e) => {
  if (!traitEnCours || !e.isPrimary) return;
  const precedent = traitEnCours[traitEnCours.length - 1];
  const point = pointSurPhoto(e);
  traitEnCours.push(point);
  // Dessine seulement le nouveau morceau : plus rapide que de tout redessiner
  dessinerTrait(canevasPhoto.getContext("2d"), [precedent, point], canevasPhoto.width, canevasPhoto.height);
});

canevasPhoto.addEventListener("pointerup", () => { traitEnCours = null; });
canevasPhoto.addEventListener("pointercancel", () => { traitEnCours = null; });

el("annulerTrait").addEventListener("click", () => {
  photoEnEdition.traits.pop();
  redessinerEditeur();
});

el("supprimerPhoto").addEventListener("click", () => {
  if (!confirm("Supprimer cette photo ?")) return;
  photosFiche = photosFiche.filter((p) => p !== photoEnEdition);
  photosSupprimees.push(photoEnEdition.id);
  editeurPhoto.close();
});

el("fermerEditeur").addEventListener("click", () => editeurPhoto.close());

// Tablette tournée : la photo est redessinée à la nouvelle taille de l'écran
window.addEventListener("resize", () => {
  if (photoEnEdition) redessinerEditeur();
});

// Fermeture (bouton « terminé », « supprimer » ou touche Échap) : mise à jour des vignettes
editeurPhoto.addEventListener("close", () => {
  photoEnEdition = null;
  traitEnCours = null;
  afficherVignettes();
});

// ----- Clavier : garder la fiche dans la partie visible de l'écran -----
// « visualViewport » est la zone réellement visible, sans le clavier. Certains appareils
// (tablettes notamment) ne réduisent pas la page à l'ouverture du clavier : on transmet donc
// au CSS la position de cette zone pour y centrer la fiche.
function ajusterFicheAuClavier() {
  const zone = window.visualViewport;
  const basCache = window.innerHeight - zone.offsetTop - zone.height;
  fiche.style.setProperty("--haut-visible", zone.offsetTop + "px");
  fiche.style.setProperty("--bas-cache", Math.max(0, basCache) + "px");
  fiche.style.setProperty("--hauteur-visible", zone.height + "px");
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", ajusterFicheAuClavier);
  window.visualViewport.addEventListener("scroll", ajusterFicheAuClavier);
  ajusterFicheAuClavier();
}

// ----- Pastilles -----
function dessinerPastilles() {
  contenu.querySelectorAll(".pastille").forEach((p) => p.remove());

  for (const r of remarques) {
    const pastille = document.createElement("button");
    pastille.className = "pastille panzoom-exclude " + r.statut;
    pastille.textContent = r.numero;
    pastille.style.left = (r.x * 100) + "%";
    pastille.style.top = (r.y * 100) + "%";
    pastille.addEventListener("click", () => ouvrirFiche(r, false));
    contenu.appendChild(pastille);
  }
}

// ===================================================================
// OUTILS
// ===================================================================
// « quandExporter » est facultatif : sans lui, pas de bouton « Exporter »
function elementListe(titre, detail, quandOuvrir, quandSupprimer, quandExporter) {
  const li = document.createElement("li");

  const ouvrir = document.createElement("button");
  ouvrir.className = "elementListe";
  const spanTitre = document.createElement("span");
  spanTitre.className = "titreElement";
  spanTitre.textContent = titre;
  const spanDetail = document.createElement("span");
  spanDetail.className = "detailElement";
  spanDetail.textContent = detail;
  ouvrir.append(spanTitre, spanDetail);
  ouvrir.addEventListener("click", quandOuvrir);

  li.append(ouvrir);

  if (quandExporter) {
    const exporter = document.createElement("button");
    exporter.className = "actionElement";
    exporter.textContent = "Exporter";
    exporter.addEventListener("click", quandExporter);
    li.append(exporter);
  }

  const supprimer = document.createElement("button");
  supprimer.className = "actionElement";
  supprimer.textContent = "Supprimer";
  supprimer.addEventListener("click", quandSupprimer);

  li.append(supprimer);
  return li;
}

// Fait enregistrer un fichier par le navigateur (dossier Téléchargements)
function telecharger(blob, nomFichier) {
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(blob);
  lien.download = nomFichier;
  lien.click();
  // Libère la mémoire un peu plus tard, une fois le téléchargement lancé
  setTimeout(() => URL.revokeObjectURL(lien.href), 10_000);
}

// Retire les caractères interdits dans un nom de fichier Windows ou Android
function nomDeFichier(texte) {
  return texte.replace(/[\\/:*?"<>|]/g, "-").trim() || "projet";
}

function elementVide(message) {
  const li = document.createElement("li");
  li.className = "listeVide";
  li.textContent = message;
  return li;
}

function aujourdhui() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function formaterDate(iso) {
  if (!iso) return "";
  const [annee, mois, jour] = iso.split("-");
  return `${jour}/${mois}/${annee}`;
}

// ===== Démarrage =====
afficherProjets();