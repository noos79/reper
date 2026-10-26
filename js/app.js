import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import Panzoom from "https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4.5.1/+esm";
import Dexie from "https://cdn.jsdelivr.net/npm/dexie@4.0.10/+esm";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
import { PDFDocument, StandardFonts, rgb, degrees } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";

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
// Version 3 : niveaux et locaux de chaque projet (importés depuis un fichier CSV)
db.version(3).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId",
  photos: "id, remarqueId, planId, projetId",
  niveaux: "id, projetId",
  locaux: "id, projetId, niveauId"
});
// Version 4 : lots du marché et CE (corps d'exécution), avec leurs entreprises
db.version(4).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId",
  photos: "id, remarqueId, planId, projetId",
  niveaux: "id, projetId",
  locaux: "id, projetId, niveauId",
  lots: "id, projetId",
  ce: "id, projetId, lotId"
});
// Version 5 : les remarques sont liées à un niveau, un local, un lot et un CE (« chapitre »).
// L'ancien champ libre « chapitre » (stocké dans « entreprise ») disparaît avec ses valeurs.
db.version(5).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId",
  photos: "id, remarqueId, planId, projetId",
  niveaux: "id, projetId",
  locaux: "id, projetId, niveauId",
  lots: "id, projetId",
  ce: "id, projetId, lotId"
}).upgrade((tx) => tx.table("remarques").toCollection().modify((r) => { delete r.entreprise; }));
// Version 6 : contours des locaux dessinés sur les plans
db.version(6).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId",
  photos: "id, remarqueId, planId, projetId",
  niveaux: "id, projetId",
  locaux: "id, projetId, niveauId",
  lots: "id, projetId",
  ce: "id, projetId, lotId",
  contours: "id, projetId, planId, localId"
});
// Version 7 : anciennes versions des plans (indices A, B…), gardées quand on remplace le PDF
db.version(7).stores({
  projets: "id, nom",
  plans: "id, projetId, nom",
  remarques: "id, planId, projetId",
  photos: "id, remarqueId, planId, projetId",
  niveaux: "id, projetId",
  locaux: "id, projetId, niveauId",
  lots: "id, projetId",
  ce: "id, projetId, lotId",
  contours: "id, projetId, planId, localId",
  versionsPlan: "id, projetId, planId"
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
const DISTANCE_FERMETURE = 24;     // pixels à l'écran : toucher aussi près du premier coin ferme le contour

// Photos : réduites à l'ajout pour ne pas alourdir la base et les exports
const PHOTO_COTE_MAX = 1600;        // pixels, sur le plus grand côté
const PHOTO_QUALITE = 0.85;         // qualité JPEG (0 à 1)
const EPAISSEUR_TRAIT = 0.006;      // épaisseur des traits, en proportion du plus grand côté
const COULEUR_TRAIT =
  getComputedStyle(document.documentElement).getPropertyValue("--trait-annotation").trim();

// Plan annoté (PDF) : diamètre des pastilles, en points PDF (1 mm = 72 / 25,4 points).
// Proportionnel au plan (un A0 imprimé en A3 garde des pastilles lisibles), mais jamais sous 5 mm.
const POINTS_PAR_MM = 72 / 25.4;
const PASTILLE_PDF_MIN = 5 * POINTS_PAR_MM;
const PASTILLE_PDF_PROPORTION = 0.01;   // 1 % du plus grand côté du plan

// Identifiant et version du format des fichiers d'export
const FORMAT_EXPORT = "suivi-chantier";
// 2 : ajout des photos ; 3 : niveaux et locaux ; 4 : lots et CE ;
// 5 : remarques liées à un niveau, un local, un lot et un CE, sans le champ « entreprise » ;
// 6 : contours des locaux sur les plans ; 7 : anciennes versions des plans (indices)
const VERSION_EXPORT = 7;

// Vérification simple d'une adresse électronique : « quelque chose@quelque chose.quelque chose »
const ADRESSE_VALIDE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ===== Raccourci =====
const el = (id) => document.getElementById(id);

// ===== Éléments de la page =====
const listeProjets = el("listeProjets");
const listePlans = el("listePlans");
const choixPdf = el("choixPdf");
const choixZip = el("choixZip");
const listeLocaux = el("listeLocaux");
const choixCsv = el("choixCsv");
const listeLots = el("listeLots");
const listeIntervenants = el("listeIntervenants");
const canevas = el("canevasPlan");
const cadre = el("cadrePlan");
const contenu = el("contenuPlan");

const fiche = el("fiche");
const titreFiche = el("titreFiche");
const champTexte = el("champTexte");
const champStatut = el("champStatut");
const champNiveau = el("champNiveau");
const champLocal = el("champLocal");
const champLot = el("champLot");
const champChapitre = el("champChapitre");
const champDate = el("champDate");
const boutonSupprimer = el("boutonSupprimer");
const boutonDeplacer = el("boutonDeplacer");
const vignettes = el("vignettes");
const choixPhoto = el("choixPhoto");
const appareilPhoto = el("appareilPhoto");

const fichePlan = el("fichePlan");
const champNiveauPlan = el("champNiveauPlan");
const champLotPlan = el("champLotPlan");
const choixNouveauPdf = el("choixNouveauPdf");

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
let listesFiche = { niveaux: [], locaux: [], lots: [], ce: [] };   // choix proposés dans la fiche
let planEnCours = null;       // celui dont on choisit le niveau et le lot
const imagesDecodees = new Map();   // images déjà préparées pour l'affichage (évite de les relire)

// ===== Navigation entre écrans =====
function afficherEcran(idEcran) {
  document.querySelectorAll(".ecran").forEach((ecran) => {
    ecran.hidden = ecran.id !== idEcran;
  });
}

el("retourProjets").addEventListener("click", afficherProjets);
el("retourProjet").addEventListener("click", () => {
  quitterModeContours();
  arreterRecalage();   // recalage abandonné : les pastilles restent où elles étaient
  ouvrirProjet(projetCourant);
});

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
      [["Exporter", () => exporterProjet(projet)], ["Supprimer", () => supprimerProjet(projet)]]
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
    const niveauxProjet = await db.niveaux.where("projetId").equals(projet.id).toArray();
    const locauxProjet = await db.locaux.where("projetId").equals(projet.id).toArray();
    const lotsProjet = await db.lots.where("projetId").equals(projet.id).toArray();
    const ceProjet = await db.ce.where("projetId").equals(projet.id).toArray();
    const contoursProjet = await db.contours.where("projetId").equals(projet.id).toArray();
    const versionsProjet = await db.versionsPlan.where("projetId").equals(projet.id).toArray();

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
      photos: photosProjet.map(({ image, ...reste }) => reste),
      niveaux: niveauxProjet,
      locaux: locauxProjet,
      lots: lotsProjet,
      ce: ceProjet,
      contours: contoursProjet,
      // Anciennes versions des plans, sans leur PDF : rangé à part dans le dossier versions/
      versions: versionsProjet.map(({ fichier, ...reste }) => reste)
    }, null, 2));

    for (const plan of plans) {
      zip.file(`plans/${plan.id}.pdf`, plan.fichier);
    }
    for (const version of versionsProjet) {
      zip.file(`versions/${version.id}.pdf`, version.fichier);
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
  // Versions acceptées : 1 (sans photos), 2 (avec photos), 3 (avec niveaux et locaux), 4 (avec lots et CE),
  // 5 (remarques liées aux niveaux, locaux, lots et CE), 6 (avec contours des locaux),
  // 7 (avec anciennes versions des plans)
  if (![1, 2, 3, 4, 5, 6, 7].includes(donnees.version)) {
    throw new Error(`version de format inconnue (${donnees.version}). Mets l'application à jour.`);
  }
  const { projet, plans, remarques: remarquesImportees } = donnees;
  const photosImportees = donnees.photos || [];   // absentes en version 1
  const niveauxImportes = donnees.niveaux || [];  // absents avant la version 3
  const locauxImportes = donnees.locaux || [];
  const lotsImportes = donnees.lots || [];        // absents avant la version 4
  const ceImportes = donnees.ce || [];
  const contoursImportes = donnees.contours || [];   // absents avant la version 6
  const versionsImportees = donnees.versions || [];  // absentes avant la version 7
  if (!projet || !projet.id || !Array.isArray(plans) || !Array.isArray(remarquesImportees)
      || !Array.isArray(photosImportees) || !Array.isArray(niveauxImportes)
      || !Array.isArray(locauxImportes) || !Array.isArray(lotsImportes)
      || !Array.isArray(ceImportes) || !Array.isArray(contoursImportes)
      || !Array.isArray(versionsImportees)) {
    throw new Error("le fichier projet.json est incomplet.");
  }
  const idsLots = new Set(lotsImportes.map((l) => l.id));
  if (ceImportes.some((c) => !idsLots.has(c.lotId))) {
    throw new Error("certains CE renvoient à un lot absent du fichier.");
  }
  const idsNiveaux = new Set(niveauxImportes.map((n) => n.id));
  if (locauxImportes.some((l) => !idsNiveaux.has(l.niveauId))) {
    throw new Error("certains locaux renvoient à un niveau absent du fichier.");
  }
  const idsPlans = new Set(plans.map((p) => p.id));
  if (remarquesImportees.some((r) => !idsPlans.has(r.planId))) {
    throw new Error("certaines remarques renvoient à un plan absent du fichier.");
  }
  // Liens facultatifs (vides = non renseignés) : s'ils sont remplis, ils doivent mener quelque part
  const idsLocaux = new Set(locauxImportes.map((l) => l.id));
  const idsCe = new Set(ceImportes.map((c) => c.id));
  const lienCasse = (id, ids) => id && !ids.has(id);
  if (plans.some((p) => lienCasse(p.niveauId, idsNiveaux) || lienCasse(p.lotId, idsLots))
      || remarquesImportees.some((r) => lienCasse(r.niveauId, idsNiveaux) || lienCasse(r.localId, idsLocaux)
        || lienCasse(r.lotId, idsLots) || lienCasse(r.ceId, idsCe))) {
    throw new Error("certains plans ou remarques renvoient à un niveau, un local, un lot ou un CE absent du fichier.");
  }
  if (contoursImportes.some((c) => !idsPlans.has(c.planId) || !idsLocaux.has(c.localId))) {
    throw new Error("certains contours renvoient à un plan ou un local absent du fichier.");
  }
  if (versionsImportees.some((v) => !idsPlans.has(v.planId))) {
    throw new Error("certaines anciennes versions renvoient à un plan absent du fichier.");
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
  const versionsAImporter = [];
  for (const version of versionsImportees) {
    const fichierPdf = zip.file(`versions/${version.id}.pdf`);
    if (!fichierPdf) throw new Error("le PDF d'une ancienne version de plan est absent du fichier.");
    const octets = await fichierPdf.async("blob");
    versionsAImporter.push({
      ...version,
      projetId: projet.id,
      fichier: new Blob([octets], { type: "application/pdf" })
    });
  }
  // « entreprise » : ancien champ libre « chapitre » des versions 1 à 4, abandonné
  const remarquesAImporter = remarquesImportees.map(({ entreprise, ...r }) => ({ ...r, projetId: projet.id }));

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
    `Ses plans, remarques, photos, locaux et lots actuels seront définitivement supprimés.`
  )) return;

  // Transaction : soit tout le projet est remplacé, soit rien ne change
  await db.transaction("rw", tablesDuProjet(), async () => {
    await viderProjet(projet.id);
    await db.projets.put(projet);
    await db.plans.bulkAdd(plansAImporter);
    await db.remarques.bulkAdd(remarquesAImporter);
    await db.photos.bulkAdd(photosAImporter);
    await db.niveaux.bulkAdd(niveauxImportes.map((n) => ({ ...n, projetId: projet.id })));
    await db.locaux.bulkAdd(locauxImportes.map((l) => ({ ...l, projetId: projet.id })));
    await db.lots.bulkAdd(lotsImportes.map((l) => ({ ...l, projetId: projet.id })));
    await db.ce.bulkAdd(ceImportes.map((c) => ({ ...c, projetId: projet.id })));
    await db.contours.bulkAdd(contoursImportes.map((c) => ({ ...c, projetId: projet.id })));
    await db.versionsPlan.bulkAdd(versionsAImporter);
  });

  alert(`Projet « ${projet.nom} » importé : ${plans.length} plan(s), ` +
    `${remarquesImportees.length} remarque(s), ${photosImportees.length} photo(s), ` +
    `${locauxImportes.length} local(aux), ${lotsImportes.length} lot(s).`);
}

async function supprimerProjet(projet) {
  if (!confirm(`Supprimer le projet « ${projet.nom} » avec tous ses plans, remarques, photos, locaux et lots ?`)) return;

  // Transaction : soit tout est supprimé, soit rien (jamais de remarques ni de photos orphelines)
  await db.transaction("rw", tablesDuProjet(), async () => {
    await viderProjet(projet.id);
    await db.projets.delete(projet.id);
  });
  await afficherProjets();
}

// Toutes les tables qui contiennent des données d'un projet (pour les transactions)
function tablesDuProjet() {
  return [db.projets, db.plans, db.remarques, db.photos, db.niveaux, db.locaux, db.lots, db.ce,
    db.contours, db.versionsPlan];
}

// Efface le contenu d'un projet (pas le projet lui-même). À appeler dans une transaction.
async function viderProjet(projetId) {
  await db.photos.where("projetId").equals(projetId).delete();
  await db.remarques.where("projetId").equals(projetId).delete();
  await db.plans.where("projetId").equals(projetId).delete();
  await db.locaux.where("projetId").equals(projetId).delete();
  await db.niveaux.where("projetId").equals(projetId).delete();
  await db.ce.where("projetId").equals(projetId).delete();
  await db.lots.where("projetId").equals(projetId).delete();
  await db.contours.where("projetId").equals(projetId).delete();
  await db.versionsPlan.where("projetId").equals(projetId).delete();
}

// ===================================================================
// ÉCRAN 2 : UN PROJET ET SES PLANS
// ===================================================================
async function ouvrirProjet(projet) {
  projetCourant = await db.projets.get(projet.id);   // version à jour depuis la base
  el("titreProjet").textContent = projetCourant.nom;

  const plans = await db.plans.where("projetId").equals(projetCourant.id).sortBy("nom");
  const niveaux = await db.niveaux.where("projetId").equals(projetCourant.id).toArray();
  const nomNiveau = new Map(niveaux.map((n) => [n.id, n.nom]));
  const lots = await db.lots.where("projetId").equals(projetCourant.id).toArray();
  const nomLot = new Map(lots.map((l) => [l.id, libelleLot(l)]));

  listePlans.replaceChildren();
  if (plans.length === 0) {
    listePlans.append(elementVide("Aucun plan. Ajoute un PDF avec « Ajouter un plan »."));
  }
  for (const plan of plans) {
    const ouvertes = await db.remarques
      .where("planId").equals(plan.id)
      .filter((r) => r.statut === "ouverte")
      .count();
    // Détail : indice actuel (si le PDF a déjà été remplacé), niveau et lot du plan s'il en a,
    // puis le nombre de remarques ouvertes
    const detail = [
      // (les anciennes versions ont pris A, B… : le plan actuel a la lettre suivante)
      plan.nombreVersions ? "indice " + lettreIndice(plan.nombreVersions + 1) : null,
      nomNiveau.get(plan.niveauId),
      nomLot.get(plan.lotId),
      ouvertes + (ouvertes > 1 ? " remarques ouvertes" : " remarque ouverte")
    ].filter(Boolean).join(" · ");

    listePlans.append(elementListe(
      plan.nom,
      detail,
      () => ouvrirPlan(plan),
      [
        ["modifier", () => reglerPlan(plan)],
        // Plan annoté en PDF ; un mot court pour laisser la place au nom du plan sur téléphone
        [creerSigle("PDF"), () => exporterPlanAnnote(plan)],
        ["Supprimer", () => supprimerPlan(plan)]
      ]
    ));

    // Anciennes versions du plan, sous lui, de la plus récente à la plus ancienne
    const versions = await db.versionsPlan.where("planId").equals(plan.id).toArray();
    versions.sort((a, b) => b.rang - a.rang);
    for (const version of versions) {
      const ligne = elementListe(
        "indice " + version.indice,
        "remplacé le " + formaterDate(version.remplaceLe),
        () => ouvrirPlan(plan, version),
        [
          [creerSigle("PDF"), () => exporterPlanAnnote(plan, version)],
          ["Supprimer", () => supprimerVersion(plan, version)]
        ]
      );
      ligne.classList.add("ancienneVersion");
      listePlans.append(ligne);
    }
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

  await db.transaction("rw", db.plans, db.remarques, db.photos, db.contours, db.versionsPlan, async () => {
    await db.photos.where("planId").equals(plan.id).delete();
    await db.remarques.where("planId").equals(plan.id).delete();
    await db.contours.where("planId").equals(plan.id).delete();
    await db.versionsPlan.where("planId").equals(plan.id).delete();
    await db.plans.delete(plan.id);
  });
  await ouvrirProjet(projetCourant);
}

// ----- Mise à jour du PDF d'un plan -----
// Le PDF actuel devient une ancienne version, avec un indice (A, B…) et la position des pastilles à
// ce moment-là ; le nouveau PDF le remplace. Les remarques restent attachées au plan, à la même place.
// Les indices ne sont jamais réutilisés, même après suppression (compteur « nombreVersions » du plan).

// Indice d'une version : 1 → A, 2 → B… 26 → Z, 27 → AA
function lettreIndice(rang) {
  let texte = "";
  for (let n = rang; n > 0; n = Math.floor((n - 1) / 26)) {
    texte = String.fromCharCode(65 + (n - 1) % 26) + texte;
  }
  return texte;
}

choixNouveauPdf.addEventListener("change", async () => {
  const fichier = choixNouveauPdf.files[0];
  choixNouveauPdf.value = "";
  const plan = planEnCours;
  if (!fichier || !plan) return;
  fichePlan.close("enregistrer");   // enregistre aussi le niveau et le lot choisis dans la fenêtre
  await remplacerPdf(plan, fichier);
});

async function remplacerPdf(plan, fichier) {
  const actuel = await db.plans.get(plan.id);   // version à jour depuis la base
  const rang = (actuel.nombreVersions || 0) + 1;
  const indice = lettreIndice(rang);

  // Le nouveau PDF doit être lisible (vérifié avant de demander quoi que ce soit)
  try {
    await pdfjsLib.getDocument({ data: new Uint8Array(await fichier.arrayBuffer()) }).promise;
  } catch {
    alert("Ce fichier n'est pas un PDF lisible. Le plan n'a pas été modifié.");
    return;
  }

  // Question : même cadrage (rien ne bouge) ou recalage par deux repères
  const choix = await demanderCadrage(
    `Remplacer le PDF du plan « ${actuel.nom} » par « ${fichier.name} » ? ` +
    `Le PDF actuel sera gardé comme indice ${indice}, consultable avec ses pastilles.\n\n` +
    `« Même cadrage » : les pastilles restent à la même place (plan réexporté à l'identique). ` +
    `« Recaler » : tu touches deux repères sur l'ancien plan, puis les mêmes sur le nouveau, ` +
    `et les pastilles suivent.`
  );
  if (choix !== "meme" && choix !== "recaler") return;

  const version = {
    id: crypto.randomUUID(),
    projetId: actuel.projetId,
    planId: actuel.id,
    rang,
    indice,
    fichier: actuel.fichier,
    page: actuel.page,
    remplaceLe: aujourdhui()
  };
  await db.transaction("rw", db.plans, db.remarques, db.versionsPlan, async () => {
    // Pastilles telles qu'elles étaient sur ce PDF (lecture seule)
    const remarquesDuPlan = await db.remarques.where("planId").equals(plan.id).toArray();
    version.pastilles = remarquesDuPlan.map((r) => ({ numero: r.numero, statut: r.statut, x: r.x, y: r.y }));
    await db.versionsPlan.add(version);
    await db.plans.update(actuel.id, { fichier, page: 1, nombreVersions: rang });
  });

  if (choix === "recaler") {
    await commencerRecalage(await db.plans.get(actuel.id), version);
  } else {
    await ouvrirProjet(projetCourant);
  }
}

// Fenêtre de choix du cadrage ; rend « meme », « recaler », ou autre chose si on annule
function demanderCadrage(texte) {
  const fenetre = el("ficheCadrage");
  // Espaces insécables dans les guillemets : « et » ne restent jamais seuls en bout de ligne
  el("texteCadrage").textContent = texte.replace(/« /g, "« ").replace(/ »/g, " »");
  fenetre.returnValue = "";
  fenetre.showModal();
  return new Promise((resolu) => {
    fenetre.addEventListener("close", () => resolu(fenetre.returnValue), { once: true });
  });
}

async function supprimerVersion(plan, version) {
  if (!confirm(`Supprimer l'indice ${version.indice} du plan « ${plan.nom} » ? ` +
    `Ce PDF ancien sera définitivement supprimé (le plan actuel et ses remarques ne changent pas).`)) return;
  await db.versionsPlan.delete(version.id);
  await ouvrirProjet(projetCourant);
}

// ----- Plan annoté en PDF -----
// Les pastilles sont dessinées dans le PDF d'origine (bibliothèque pdf-lib) : le plan reste vectoriel,
// donc net à l'impression. Seule la page du plan est gardée. Une ancienne version donne ses pastilles
// telles qu'au remplacement.
let exportPlanEnCours = false;   // évite de lancer deux fois le même travail par une double touche

async function exporterPlanAnnote(plan, version = null) {
  if (exportPlanEnCours) return;
  exportPlanEnCours = true;
  document.body.style.cursor = "wait";
  try {
    const source = version || plan;
    const pastilles = version
      ? version.pastilles
      : await db.remarques.where("planId").equals(plan.id).toArray();
    const octets = await source.fichier.arrayBuffer();

    // pdf.js donne la place de chaque pastille en points PDF, rotation de la page comprise.
    // On lui passe une copie des octets : il les transmet à son « worker » et l'original deviendrait vide.
    const pdf = await pdfjsLib.getDocument({ data: octets.slice(0) }).promise;
    const vue = (await pdf.getPage(source.page)).getViewport({ scale: 1 });

    let doc;
    try {
      doc = await PDFDocument.load(octets);
    } catch (erreur) {
      if (/encrypted/i.test(erreur.message)) {
        alert("Ce PDF est protégé (chiffré) : impossible d'y dessiner les pastilles.");
        return;
      }
      throw erreur;
    }

    // On ne garde que la page du plan
    for (let i = doc.getPageCount() - 1; i >= 0; i--) {
      if (i !== source.page - 1) doc.removePage(i);
    }
    const page = doc.getPage(0);
    const police = await doc.embedFont(StandardFonts.HelveticaBold);
    const diametre = Math.max(PASTILLE_PDF_MIN, PASTILLE_PDF_PROPORTION * Math.max(vue.width, vue.height));

    for (const r of [...pastilles].sort((a, b) => a.numero - b.numero)) {
      const [x, y] = vue.convertToPdfPoint(r.x * vue.width, r.y * vue.height);
      dessinerPastillePdf(page, police, x, y, diametre, r, vue.rotation);
    }

    const resultat = await doc.save();
    const indice = version ? version.indice : plan.nombreVersions ? lettreIndice(plan.nombreVersions + 1) : null;
    const nom = [projetCourant.nom, plan.nom, indice && "indice " + indice, "annoté " + aujourdhui()]
      .filter(Boolean).join(" - ");
    telecharger(new Blob([resultat], { type: "application/pdf" }), nomDeFichier(nom) + ".pdf");
  } catch (erreur) {
    alert("Impossible de produire le plan annoté : " + erreur.message);
  } finally {
    exportPlanEnCours = false;
    document.body.style.cursor = "";
  }
}

// Pastille dans un PDF, centrée en (x, y) : cercle de la couleur du statut, numéro noir centré, réduit
// s'il est trop long (au-delà de 80 % du diamètre). « rotation » : celle de la page (plan en paysage,
// par exemple) ; le numéro tourne avec elle pour rester droit une fois la page affichée.
function dessinerPastillePdf(page, police, x, y, diametre, remarque, rotation = 0) {
  page.drawCircle({
    x, y,
    size: diametre / 2,   // rayon
    color: couleurPdf(remarque.statut === "levee" ? "--statut-levee" : "--statut-ouverte")
  });

  const texte = String(remarque.numero);
  let taille = diametre * 0.5;
  taille = Math.min(taille, taille * diametre * 0.8 / police.widthOfTextAtSize(texte, taille));
  const largeur = police.widthOfTextAtSize(texte, taille);
  const hauteur = police.heightAtSize(taille, { descender: false });
  // Point de départ du texte (en bas à gauche), décalé depuis le centre, tourné comme la page
  const angle = rotation * Math.PI / 180;
  const dx = -largeur / 2;
  const dy = -hauteur / 2;
  page.drawText(texte, {
    x: x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: y + dx * Math.sin(angle) + dy * Math.cos(angle),
    size: taille,
    font: police,
    color: couleurPdf("--encre"),
    rotate: degrees(rotation)
  });
}

// Couleur de la charte (variable CSS « #RRVVBB ») au format de pdf-lib (trois valeurs de 0 à 1)
function couleurPdf(variable) {
  const hexa = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const [r, v, b] = [1, 3, 5].map((i) => parseInt(hexa.slice(i, i + 2), 16) / 255);
  return rgb(r, v, b);
}

// ----- Niveau et lot d'un plan (facultatifs) : proposés d'office pour les nouvelles remarques du plan.
// Utile pour un plan qui ne concerne qu'un lot (plan d'électricité, par exemple).
async function reglerPlan(plan) {
  // Sans niveaux ni lots, les deux listes ne proposent que « — » ; la fenêtre sert alors à
  // mettre à jour le PDF
  const niveaux = await db.niveaux.where("projetId").equals(projetCourant.id).sortBy("ordre");
  const lots = await lotsDuProjet();
  planEnCours = plan;
  el("titreFichePlan").textContent = plan.nom;
  remplirListe(champNiveauPlan, niveaux, (n) => n.nom, plan.niveauId);
  remplirListe(champLotPlan, lots, (l) => `${l.numero} · ${l.nom}`, plan.lotId);
  fichePlan.returnValue = "";
  fichePlan.showModal();
}

fichePlan.addEventListener("close", async () => {
  const plan = planEnCours;
  planEnCours = null;
  if (fichePlan.returnValue !== "enregistrer") return;
  await db.plans.update(plan.id, {
    niveauId: champNiveauPlan.value || null,
    lotId: champLotPlan.value || null
  });
  await ouvrirProjet(projetCourant);
});

// ===================================================================
// ÉCRAN LOCAUX : NIVEAUX ET LOCAUX DU PROJET
// ===================================================================
el("ouvrirLocaux").addEventListener("click", ouvrirLocaux);
el("retourProjetLocaux").addEventListener("click", () => ouvrirProjet(projetCourant));

async function ouvrirLocaux() {
  el("titreLocaux").textContent = "Locaux · " + projetCourant.nom;
  const niveaux = await db.niveaux.where("projetId").equals(projetCourant.id).sortBy("ordre");
  const locaux = await db.locaux.where("projetId").equals(projetCourant.id).sortBy("ordre");

  listeLocaux.replaceChildren();
  if (niveaux.length === 0) {
    listeLocaux.append(elementVide(
      "Aucun local. Importe un fichier CSV : trois colonnes « niveau ; n° ; nom », " +
      "séparées par des points-virgules, la première ligne contenant les titres."
    ));
  }
  for (const niveau of niveaux) {
    // Titre du niveau, dans une étiquette de la charte
    const titre = document.createElement("li");
    titre.className = "titreNiveau";
    titre.append(creerEtiquette(niveau.nom));
    listeLocaux.append(titre);

    for (const local of locaux.filter((l) => l.niveauId === niveau.id)) {
      const li = document.createElement("li");
      li.className = "ligneLocal";
      const numero = document.createElement("span");
      numero.className = "numeroLocal";
      numero.textContent = local.numero;
      const nom = document.createElement("span");
      nom.textContent = local.nom;
      li.append(numero, nom);
      listeLocaux.append(li);
    }
  }
  afficherEcran("ecranLocaux");
}

choixCsv.addEventListener("change", async () => {
  const fichier = choixCsv.files[0];
  choixCsv.value = "";   // permet de rechoisir le même fichier plus tard
  if (!fichier) return;

  try {
    await importerLocaux(fichier);
  } catch (erreur) {
    alert("Import impossible : " + erreur.message);
  }
  await ouvrirLocaux();
});

// Remplace les niveaux et locaux du projet par ceux du fichier. Un niveau (même nom) ou un local
// (même niveau et même n°) déjà connu garde son identifiant : les liens futurs avec les remarques
// ne sont donc pas cassés par un nouvel import.
async function importerLocaux(fichierCsv) {
  const lignes = analyserCsv(lireTexte(await fichierCsv.arrayBuffer()));
  if (lignes.length > 0 && lignes[0].length < 2) {
    throw new Error("les colonnes doivent être séparées par des points-virgules « ; ».");
  }

  const projetId = projetCourant.id;
  const anciensNiveaux = await db.niveaux.where("projetId").equals(projetId).toArray();
  const anciensLocaux = await db.locaux.where("projetId").equals(projetId).toArray();
  const ancienIdNiveau = new Map(anciensNiveaux.map((n) => [n.nom, n.id]));
  const ancienIdLocal = new Map(anciensLocaux.map((l) => [l.niveauId + "|" + l.numero, l.id]));

  const niveaux = [];
  const locaux = [];
  const niveauParNom = new Map();
  const clesVues = new Set();
  const lignesIgnorees = [];

  // La première ligne contient les titres des colonnes : on commence à la deuxième
  for (let i = 1; i < lignes.length; i++) {
    const [nomNiveau = "", numero = "", nom = ""] = lignes[i].map((cellule) => cellule.trim());
    if (!nomNiveau && !numero && !nom) continue;   // ligne vide
    const numeroLigne = i + 1;                     // tel qu'affiché dans Excel

    if (!nomNiveau || !numero) { lignesIgnorees.push(numeroLigne); continue; }

    let niveau = niveauParNom.get(nomNiveau);
    if (!niveau) {
      niveau = {
        id: ancienIdNiveau.get(nomNiveau) || crypto.randomUUID(),
        projetId,
        nom: nomNiveau,
        ordre: niveaux.length   // ordre d'apparition dans le fichier
      };
      niveaux.push(niveau);
      niveauParNom.set(nomNiveau, niveau);
    }

    const cle = niveau.id + "|" + numero;
    if (clesVues.has(cle)) { lignesIgnorees.push(numeroLigne); continue; }   // doublon
    clesVues.add(cle);
    locaux.push({
      id: ancienIdLocal.get(cle) || crypto.randomUUID(),
      projetId,
      niveauId: niveau.id,
      numero,
      nom,
      ordre: locaux.length
    });
  }

  if (locaux.length === 0) throw new Error("aucun local trouvé dans ce fichier.");

  // Niveaux ou locaux absents du nouveau fichier : les plans et remarques liés perdent ce lien
  const niveauGarde = new Set(niveaux.map((n) => n.id));
  const localGarde = new Set(locaux.map((l) => l.id));
  const remarquesProjet = await db.remarques.where("projetId").equals(projetId).toArray();
  const plansProjet = await db.plans.where("projetId").equals(projetId).toArray();
  const remarquesTouchees = remarquesProjet.filter((r) =>
    (r.niveauId && !niveauGarde.has(r.niveauId)) || (r.localId && !localGarde.has(r.localId)));
  const plansTouches = plansProjet.filter((p) => p.niveauId && !niveauGarde.has(p.niveauId));
  const contoursProjet = await db.contours.where("projetId").equals(projetId).toArray();
  const contoursEffaces = contoursProjet.filter((c) => !localGarde.has(c.localId));

  if (anciensLocaux.length > 0) {
    let question = `Remplacer les ${anciensLocaux.length} local(aux) actuels par les ${locaux.length} du fichier ?`;
    if (remarquesTouchees.length > 0 || plansTouches.length > 0) {
      question += `\n\nCertains niveaux ou locaux disparaissent : ${remarquesTouchees.length} remarque(s) ` +
        `et ${plansTouches.length} plan(s) perdront leur niveau ou leur local (le reste est conservé).`;
    }
    if (contoursEffaces.length > 0) {
      question += `\n\n${contoursEffaces.length} contour(s) de locaux disparus seront effacés des plans.`;
    }
    if (!confirm(question)) return;
  }

  await db.transaction("rw", db.niveaux, db.locaux, db.remarques, db.plans, db.contours, async () => {
    await db.locaux.where("projetId").equals(projetId).delete();
    await db.niveaux.where("projetId").equals(projetId).delete();
    await db.niveaux.bulkAdd(niveaux);
    await db.locaux.bulkAdd(locaux);
    for (const r of remarquesTouchees) {
      const niveauId = niveauGarde.has(r.niveauId) ? r.niveauId : null;
      await db.remarques.update(r.id, { niveauId, localId: niveauId && localGarde.has(r.localId) ? r.localId : null });
    }
    for (const p of plansTouches) await db.plans.update(p.id, { niveauId: null });
    await db.contours.bulkDelete(contoursEffaces.map((c) => c.id));
  });

  let message = `${niveaux.length} niveau(x) et ${locaux.length} local(aux) importés.`;
  if (lignesIgnorees.length > 0) {
    message += `\n\nLignes ignorées (niveau ou n° manquant, ou doublon) : ${lignesIgnorees.join(", ")}.`;
  }
  alert(message);
}

// ===================================================================
// ÉCRAN LOTS : LOTS DU MARCHÉ ET LEURS CE (CORPS D'EXÉCUTION)
// ===================================================================
// Saisis dans l'application (pas de CSV). Chaque CE appartient à un lot ; un lot compte au moins
// un CE (ex. lot 1 Gros-œuvre → Démolitions, Égouttage… ; lot 3 Électricité → un seul CE Électricité).
el("ouvrirLots").addEventListener("click", ouvrirLots);
el("retourProjetLots").addEventListener("click", () => ouvrirProjet(projetCourant));
el("nouveauLot").addEventListener("click", creerLot);

// Lots du projet triés par n° (« numeric » : le lot 2 avant le lot 10)
async function lotsDuProjet() {
  const lots = await db.lots.where("projetId").equals(projetCourant.id).toArray();
  return lots.sort((a, b) => a.numero.localeCompare(b.numero, "fr", { numeric: true }));
}

// CE du projet, dans l'ordre où ils ont été ajoutés
function ceDuProjet() {
  return db.ce.where("projetId").equals(projetCourant.id).sortBy("ordre");
}

function libelleLot(lot) {
  return `lot ${lot.numero} · ${lot.nom}`;
}

async function ouvrirLots() {
  el("titreLots").textContent = "Lots · " + projetCourant.nom;
  const lots = await lotsDuProjet();
  const listeCe = await ceDuProjet();

  listeLots.replaceChildren();
  if (lots.length === 0) {
    listeLots.append(elementVide("Aucun lot. Crée le premier avec « nouveau lot »."));
  }
  for (const lot of lots) {
    listeLots.append(elementLigne(creerEtiquette(libelleLot(lot)), [
      ["modifier", () => modifierLot(lot)],
      ["supprimer", () => supprimerLot(lot)]
    ], "titreNiveau"));

    const ceDuLot = listeCe.filter((c) => c.lotId === lot.id);
    for (const ce of ceDuLot) {
      listeLots.append(elementLigne(ce.nom, [
        ["renommer", () => renommerCe(ce, ceDuLot)],
        ["supprimer", () => supprimerCe(ce, ceDuLot)]
      ], "ligneCe"));
    }

    const ajout = document.createElement("li");
    ajout.className = "ligneAjout";
    const boutonAjout = boutonAction("+ ajouter un ", () => ajouterCe(lot, ceDuLot));
    boutonAjout.append(creerSigle("CE"));   // la charte met les actions en minuscules, sauf le sigle
    ajout.append(boutonAjout);
    listeLots.append(ajout);
  }
  afficherEcran("ecranLots");
}

async function creerLot() {
  const lots = await lotsDuProjet();
  const numero = demander("N° du lot :");
  if (!numero) return;
  if (lots.some((l) => l.numero === numero)) { alert(`Le lot ${numero} existe déjà.`); return; }
  const nom = demander(`Nom du lot ${numero} :`);
  if (!nom) return;
  // Un lot compte au moins un CE : on demande le premier tout de suite (souvent du même nom)
  const nomCe = demander(`Premier CE (corps d'exécution) du lot ${numero} :`, nom);
  if (!nomCe) return;

  const lot = { id: crypto.randomUUID(), projetId: projetCourant.id, numero, nom, entreprise: "", courriel: "" };
  await db.transaction("rw", db.lots, db.ce, async () => {
    await db.lots.add(lot);
    await db.ce.add(nouveauCe(lot, nomCe, 0));
  });
  await ouvrirLots();
}

async function modifierLot(lot) {
  const lots = await lotsDuProjet();
  const numero = demander("N° du lot :", lot.numero);
  if (!numero) return;
  if (lots.some((l) => l.numero === numero && l.id !== lot.id)) { alert(`Le lot ${numero} existe déjà.`); return; }
  const nom = demander(`Nom du lot ${numero} :`, lot.nom);
  if (!nom) return;

  await db.lots.update(lot.id, { numero, nom });
  await ouvrirLots();
}

async function supprimerLot(lot) {
  const liees = await remarquesLiees((r) => r.lotId === lot.id);
  const plansLies = await db.plans.where("projetId").equals(projetCourant.id)
    .filter((p) => p.lotId === lot.id).toArray();
  let question = `Supprimer le ${libelleLot(lot)}, ses CE et leurs entreprises ?`;
  if (liees.length > 0) question += `\n\n${liees.length} remarque(s) perdront leur lot et leur chapitre.`;
  if (plansLies.length > 0) question += `\n${plansLies.length} plan(s) perdront leur lot.`;
  if (!confirm(question)) return;

  // Transaction : jamais de CE sans son lot, ni de remarque ou de plan liés à un lot disparu
  await db.transaction("rw", db.lots, db.ce, db.remarques, db.plans, async () => {
    await db.ce.where("lotId").equals(lot.id).delete();
    await db.lots.delete(lot.id);
    for (const r of liees) await db.remarques.update(r.id, { lotId: null, ceId: null });
    for (const p of plansLies) await db.plans.update(p.id, { lotId: null });
  });
  await ouvrirLots();
}

// Remarques du projet qui répondent à une condition (ex. liées à un lot)
function remarquesLiees(condition) {
  return db.remarques.where("projetId").equals(projetCourant.id).filter(condition).toArray();
}

function nouveauCe(lot, nom, ordre) {
  return { id: crypto.randomUUID(), projetId: lot.projetId, lotId: lot.id, nom, ordre, entreprise: "", courriel: "" };
}

// Deux CE du même lot ne peuvent pas porter le même nom (majuscules et minuscules confondues)
function nomDejaPris(nom, ceDuLot, sauf = null) {
  return ceDuLot.some((c) => c !== sauf && c.nom.toLowerCase() === nom.toLowerCase());
}

async function ajouterCe(lot, ceDuLot) {
  const nom = demander(`Nouveau CE du ${libelleLot(lot)} :`);
  if (!nom) return;
  if (nomDejaPris(nom, ceDuLot)) { alert(`Le CE « ${nom} » existe déjà dans ce lot.`); return; }

  const ordre = Math.max(-1, ...ceDuLot.map((c) => c.ordre)) + 1;   // à la fin de la liste
  await db.ce.add(nouveauCe(lot, nom, ordre));
  await ouvrirLots();
}

async function renommerCe(ce, ceDuLot) {
  const nom = demander("Nom du CE :", ce.nom);
  if (!nom) return;
  if (nomDejaPris(nom, ceDuLot, ce)) { alert(`Le CE « ${nom} » existe déjà dans ce lot.`); return; }

  await db.ce.update(ce.id, { nom });
  await ouvrirLots();
}

async function supprimerCe(ce, ceDuLot) {
  if (ceDuLot.length <= 1) {
    alert("Un lot compte au moins un CE. Pour retirer celui-ci, supprime le lot.");
    return;
  }
  const liees = await remarquesLiees((r) => r.ceId === ce.id);
  let question = `Supprimer le CE « ${ce.nom} » et son sous-traitant ?`;
  if (liees.length > 0) question += `\n\n${liees.length} remarque(s) perdront leur chapitre (elles gardent leur lot).`;
  if (!confirm(question)) return;

  await db.transaction("rw", db.ce, db.remarques, async () => {
    await db.ce.delete(ce.id);
    for (const r of liees) await db.remarques.update(r.id, { ceId: null });
  });
  await ouvrirLots();
}

// ===================================================================
// ÉCRAN INTERVENANTS : ENTREPRISE DE CHAQUE LOT, SOUS-TRAITANT DE CHAQUE CE
// ===================================================================
// L'entreprise du lot (l'adjudicataire) est le destinataire habituel des rapports ; un CE peut
// avoir un sous-traitant. Chacun avec une adresse électronique facultative. Stockés sur le lot
// et sur le CE (champs « entreprise » et « courriel »). Pas affichés dans les remarques.
el("ouvrirIntervenants").addEventListener("click", ouvrirIntervenants);
el("retourLots").addEventListener("click", ouvrirLots);

async function ouvrirIntervenants() {
  el("titreIntervenants").textContent = "Intervenants · " + projetCourant.nom;
  const lots = await lotsDuProjet();
  const listeCe = await ceDuProjet();

  listeIntervenants.replaceChildren();
  if (lots.length === 0) {
    listeIntervenants.append(elementVide("Aucun lot. Crée d'abord les lots et leurs CE."));
  }
  for (const lot of lots) {
    const titre = document.createElement("li");
    titre.className = "titreNiveau";
    titre.append(creerEtiquette(libelleLot(lot)));
    listeIntervenants.append(titre);

    listeIntervenants.append(elementIntervenant("Entreprise du lot", lot, "aucune entreprise",
      () => modifierIntervenant(db.lots, lot, `Entreprise adjudicataire du ${libelleLot(lot)} :`)));

    for (const ce of listeCe.filter((c) => c.lotId === lot.id)) {
      listeIntervenants.append(elementIntervenant(ce.nom, ce, "pas de sous-traitant",
        () => modifierIntervenant(db.ce, ce, `Sous-traitant pour le CE « ${ce.nom} » :`)));
    }
  }
  afficherEcran("ecranIntervenants");
}

// Ligne : rôle (ou nom du CE) en gras, puis « entreprise · adresse » en dessous
function elementIntervenant(titre, element, siAucune, quandModifier) {
  const bloc = document.createElement("span");
  bloc.className = "blocIntervenant";
  const spanTitre = document.createElement("span");
  spanTitre.className = "nomIntervenant";
  spanTitre.textContent = titre;
  const spanDetail = document.createElement("span");
  spanDetail.className = "detailElement";
  spanDetail.textContent = element.entreprise
    ? [element.entreprise, element.courriel].filter(Boolean).join(" · ")
    : siAucune;
  bloc.append(spanTitre, spanDetail);
  return elementLigne(bloc, [["modifier", quandModifier]], "ligneIntervenant");
}

// « table » : db.lots ou db.ce. Un nom vide retire l'entreprise (et son adresse).
async function modifierIntervenant(table, element, question) {
  const reponse = prompt(question + "\n(laisser vide s'il n'y en a pas)", element.entreprise || "");
  if (reponse === null) return;   // « Annuler »
  const entreprise = reponse.trim();

  let courriel = "";
  if (entreprise) {
    const adresse = prompt(`Adresse électronique de ${entreprise} (facultative) :`, element.courriel || "");
    if (adresse === null) return;
    courriel = adresse.trim();
    if (courriel && !ADRESSE_VALIDE.test(courriel)) {
      alert(`Adresse électronique non valide : ${courriel}\nRien n'a été modifié.`);
      return;
    }
  }

  await table.update(element.id, { entreprise, courriel });
  await ouvrirIntervenants();
}

// ===================================================================
// ÉCRAN 3 : UN PLAN ET SES REMARQUES
// ===================================================================
// Zoom jusqu'à 10 fois
const ZOOM_MAX = 10;
const PAS_MOLETTE = 0.6;          // zoom de la molette (PC) : plus grand = plus rapide
const EXPOSANT_PINCEMENT = 1.4;   // zoom à deux doigts : 1 = suit l'écart des doigts, plus = plus rapide

const panzoom = Panzoom(contenu, { minScale: 0.5, maxScale: ZOOM_MAX, step: PAS_MOLETTE });
cadre.addEventListener("wheel", (e) => panzoom.zoomWithWheel(e, { step: PAS_MOLETTE }));

// ----- Zoom à deux doigts accéléré -----
// Panzoom calcule le zoom à deux doigts en AJOUTANT l'écart des doigts (en pixels × step / 80) au zoom
// de départ : à fort zoom, il faut s'y reprendre de nombreuses fois. On veut au contraire un zoom
// proportionnel, accéléré : zoom de départ × (écart actuel / écart de départ) ^ EXPOSANT_PINCEMENT.
// À chaque mouvement des doigts, juste avant que Panzoom fasse son calcul, on règle son « step » pour
// que son résultat soit exactement le zoom voulu. Panzoom garde ainsi la main sur le déplacement.
const doigts = new Map();   // doigts posés sur le plan : identifiant → position
let pincement = null;       // zoom et écart des doigts au début du pincement

function ecartDesDoigts() {
  const [a, b] = [...doigts.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

contenu.addEventListener("pointerdown", (e) => {
  doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pincement = doigts.size === 2 ? { zoom: panzoom.getScale(), ecart: ecartDesDoigts() } : null;
});

// Écouté sur le plan : passe avant le calcul de Panzoom, qui écoute toute la page
contenu.addEventListener("pointermove", (e) => {
  if (!doigts.has(e.pointerId)) return;
  doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pincement || doigts.size !== 2) return;

  const ecart = ecartDesDoigts();
  const difference = ecart - pincement.ecart;
  if (Math.abs(difference) < 1 || pincement.ecart < 1) return;
  const zoomVoulu = pincement.zoom * Math.pow(ecart / pincement.ecart, EXPOSANT_PINCEMENT);
  panzoom.setOptions({ step: (zoomVoulu - pincement.zoom) * 80 / difference });
});

for (const fin of ["pointerup", "pointercancel"]) {
  contenu.addEventListener(fin, (e) => {
    doigts.delete(e.pointerId);
    pincement = null;
  });
}
el("recadrer").addEventListener("click", recadrer);

// Remet le plan en entier dans la zone visible. En mode contours, la barre du bas réduit cette zone :
// le plan est alors réduit d'autant, pour que son bas ne passe pas sous la barre.
function recadrer() {
  panzoom.reset({ animate: false });
  const echelle = Math.min(1, cadre.clientWidth / canevas.offsetWidth, cadre.clientHeight / canevas.offsetHeight);
  if (echelle < 1) panzoom.zoom(echelle, { animate: false });
}

contenu.addEventListener("panzoomchange", (e) => {
  contenu.style.setProperty("--echelle", e.detail.scale);
  // Zoom ou déplacement : la zone visible sera redessinée nette quand le geste s'arrête
  clearTimeout(minuteurNettete);
  minuteurNettete = setTimeout(dessinerZoneNette, DELAI_NETTETE);
});

// ----- Netteté au zoom -----
// Le plan est dessiné une fois à l'ouverture, avec une finesse limitée (un plan entier assez fin pour
// un zoom de 10 fois dépasserait la mémoire d'un téléphone). Quand on zoome, l'image s'agrandit et
// devient floue. Peu après l'arrêt du geste, on redessine donc SEULEMENT la partie visible, à la
// finesse exacte du zoom, dans un second canevas (`canevasNet`) posé par-dessus le plan, sous les
// pastilles. Il bouge avec le plan ; un nouveau geste le laisse en place jusqu'au prochain arrêt.
const DELAI_NETTETE = 100;   // millisecondes d'immobilité avant de redessiner
let pageCourante = null;     // page PDF affichée (pour la redessiner)
let minuteurNettete = null;
let renduNet = null;         // dessin en cours (annulé si un nouveau geste le rend inutile)

function effacerZoneNette() {
  clearTimeout(minuteurNettete);
  if (renduNet) renduNet.cancel();
  renduNet = null;
  el("canevasNet")?.remove();
}

async function dessinerZoneNette() {
  if (!pageCourante || canevas.offsetWidth === 0) return;
  const finesse = window.devicePixelRatio || 1;
  const bord = (canevas.offsetWidth - canevas.clientWidth) / 2;   // bordure fine autour du plan
  const rectPlan = canevas.getBoundingClientRect();
  const zoom = rectPlan.width / canevas.offsetWidth;

  // Le plan de base est-il encore assez fin pour ce zoom ? Alors rien à redessiner.
  if (canevas.width / canevas.clientWidth >= zoom * finesse * 0.95) {
    effacerZoneNette();
    return;
  }

  // Partie du plan visible à l'écran (en pixels d'écran, bordure exclue)
  const plan = {
    gauche: rectPlan.left + bord * zoom,
    haut: rectPlan.top + bord * zoom,
    largeur: canevas.clientWidth * zoom,
    hauteur: canevas.clientHeight * zoom
  };
  const vue = cadre.getBoundingClientRect();
  const x0 = Math.max(plan.gauche, vue.left);
  const x1 = Math.min(plan.gauche + plan.largeur, vue.right);
  const y0 = Math.max(plan.haut, vue.top);
  const y1 = Math.min(plan.haut + plan.hauteur, vue.bottom);
  if (x1 <= x0 || y1 <= y0) { effacerZoneNette(); return; }

  // Pixels par pixel d'écran : la finesse de l'écran, réduite si l'image dépasserait PIXELS_MAX
  let pixelsParPoint = finesse;
  const pixels = (x1 - x0) * (y1 - y0) * finesse * finesse;
  if (pixels > PIXELS_MAX) pixelsParPoint *= Math.sqrt(PIXELS_MAX / pixels);

  const nouveau = document.createElement("canvas");
  nouveau.id = "canevasNet";
  nouveau.width = Math.ceil((x1 - x0) * pixelsParPoint);
  nouveau.height = Math.ceil((y1 - y0) * pixelsParPoint);
  // Position et taille dans le plan non zoomé : Panzoom applique ensuite le zoom, comme au plan
  nouveau.style.left = (bord + (x0 - plan.gauche) / zoom) + "px";
  nouveau.style.top = (bord + (y0 - plan.haut) / zoom) + "px";
  nouveau.style.width = ((x1 - x0) / zoom) + "px";
  nouveau.style.height = ((y1 - y0) / zoom) + "px";

  // Dessin de la page entière à la bonne échelle, décalée pour que seule la zone visible tombe
  // dans le canevas
  const largeurPdf = pageCourante.getViewport({ scale: 1 }).width;
  const echelle = (plan.largeur / largeurPdf) * pixelsParPoint;
  const vuePdf = pageCourante.getViewport({
    scale: echelle,
    offsetX: -(x0 - plan.gauche) * pixelsParPoint,
    offsetY: -(y0 - plan.haut) * pixelsParPoint
  });

  if (renduNet) renduNet.cancel();
  const rendu = pageCourante.render({ canvasContext: nouveau.getContext("2d"), viewport: vuePdf });
  renduNet = rendu;
  try {
    await rendu.promise;
  } catch {
    return;   // annulé par un nouveau geste ou un autre plan
  }
  if (renduNet !== rendu) return;
  renduNet = null;

  // Remplace l'ancienne zone nette seulement une fois la nouvelle prête : pas de clignotement
  const ancien = el("canevasNet");
  if (ancien) ancien.replaceWith(nouveau); else canevas.after(nouveau);
}

cadre.addEventListener("contextmenu", (e) => e.preventDefault());

// « version » : une ancienne version du plan (indice A, B…), affichée en lecture seule avec les
// pastilles telles qu'elles étaient ; sans elle, le plan actuel
let versionConsultee = null;

async function ouvrirPlan(plan, version = null) {
  planCourant = plan;
  versionConsultee = version;
  el("titrePlan").textContent = version ? `${plan.nom} · indice ${version.indice}` : plan.nom;
  el("modeContours").hidden = Boolean(version);   // pas de contours sur une ancienne version

  quitterModeContours();
  finirDeplacement();
  remarques = [];
  contoursPlan = [];
  dessinerPastilles();         // efface les pastilles du plan précédent

  // L'écran doit être visible AVANT de dessiner : un élément caché a une taille nulle
  afficherEcran("ecranPlan");

  try {
    const source = version || plan;
    const donnees = await source.fichier.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: donnees }).promise;
    const page = await pdf.getPage(source.page);
    await afficherPage(page);

    if (version) {
      remarques = version.pastilles.map((p) => ({ ...p }));   // copies : rien n'est modifiable
      contoursPlan = [];
    } else {
      remarques = await db.remarques.where("planId").equals(plan.id).toArray();
      contoursPlan = await db.contours.where("planId").equals(plan.id).toArray();
    }
    niveauxProjet = await db.niveaux.where("projetId").equals(projetCourant.id).sortBy("ordre");
    locauxProjet = await db.locaux.where("projetId").equals(projetCourant.id).sortBy("ordre");
    dessinerPastilles();
  } catch (erreur) {
    alert("Impossible d'ouvrir ce plan : " + erreur.message);
  }
}

async function afficherPage(page) {
  effacerZoneNette();   // zone nette du plan précédent
  pageCourante = page;
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
  // En mode contours, toucher dessine ; pendant un déplacement, toucher place la pastille
  // Ancienne version : lecture seule, pas de nouvelle remarque
  if (e.target !== canevas || modeContours || remarqueADeplacer || versionConsultee || recalage) return;
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

  // Pastille posée dans le contour d'un local : niveau et local remplis d'office
  const contour = contourSous(x, y);
  const local = contour && locauxProjet.find((l) => l.id === contour.localId);

  ouvrirFiche({
    id: crypto.randomUUID(),
    projetId: projetCourant.id,
    planId: planCourant.id,
    numero: (projetCourant.dernierNumero || 0) + 1,   // numéro réservé, confirmé à l'enregistrement
    x,
    y,
    texte: "",
    statut: "ouverte",
    niveauId: local ? local.niveauId : (planCourant.niveauId || null),   // sinon le niveau du plan
    localId: local ? local.id : null,
    lotId: planCourant.lotId || null,         // le lot du plan, s'il en a un (et son CE s'il est seul)
    ceId: null,
    date: aujourdhui()
  }, true);
}

// ===================================================================
// CONTOURS DES LOCAUX SUR LE PLAN
// ===================================================================
// Un contour = les coins d'un local sur un plan, en proportion du plan (0 à 1). En mode « contours »,
// l'application propose le premier local sans contour ; on touche chaque coin, puis à nouveau le
// premier pour fermer, et elle passe au local suivant. Une pastille posée dans un contour reçoit le
// niveau et le local correspondants. Les contours ne sont visibles qu'en mode « contours ».
const SVG = "http://www.w3.org/2000/svg";
const calqueContours = el("calqueContours");
const barreContours = el("barreContours");
const choixLocalContour = el("choixLocalContour");
const boutonAnnulerPoint = el("annulerPoint");
const boutonEffacerContour = el("effacerContour");
const aideContours = el("aideContours");

let modeContours = false;
let contoursPlan = [];     // contours du plan affiché
let niveauxProjet = [];    // niveaux et locaux du projet, lus à l'ouverture du plan
let locauxProjet = [];
let coinsEnCours = [];     // coins du contour en train d'être dessiné
let toucheContour = null;  // début d'une touche sur le plan, en mode contours
const locauxTouches = new Set();   // locaux dont le contour a été dessiné, modifié ou effacé depuis l'entrée en mode contours

el("modeContours").addEventListener("click", () => {
  if (modeContours) quitterModeContours(); else entrerModeContours();
});
el("finContours").addEventListener("click", quitterModeContours);

function entrerModeContours() {
  if (locauxDuPlan().length === 0) {
    alert(planCourant.niveauId
      ? "Le niveau de ce plan n'a pas de locaux. Vérifie la liste des locaux du projet."
      : "Ce projet n'a pas encore de locaux. Importe-les d'abord (écran Projet, bouton « locaux »).");
    return;
  }
  if (remarqueADeplacer) finirDeplacement();   // on ne déplace pas une pastille en dessinant
  modeContours = true;
  coinsEnCours = [];
  locauxTouches.clear();
  contenu.classList.add("modeContours");   // cache les pastilles pendant le dessin
  barreContours.hidden = false;
  recadrer();
  remplirChoixLocal(prochainLocalSansContour(null));
  dessinerContours();
}

function quitterModeContours() {
  // Contours modifiés : on vérifie si des remarques changent de local (liste à confirmer)
  if (modeContours && locauxTouches.size > 0) proposerChangementsDeLocal(new Set(locauxTouches));
  locauxTouches.clear();
  modeContours = false;
  coinsEnCours = [];
  toucheContour = null;
  contenu.classList.remove("modeContours");
  barreContours.hidden = true;
  if (canevas.offsetWidth > 0) recadrer();   // pas pendant l'ouverture d'un plan (canevas pas encore dessiné)
  dessinerContours();
}

// Locaux proposés : ceux du niveau du plan s'il en a un, sinon tous ceux du projet
function locauxDuPlan() {
  return planCourant.niveauId
    ? locauxProjet.filter((l) => l.niveauId === planCourant.niveauId)
    : locauxProjet;
}

function libelleLocal(local) {
  return [local.numero, local.nom].filter(Boolean).join(" · ");
}

// Le premier local sans contour sur ce plan, en commençant après « apresId »
function prochainLocalSansContour(apresId) {
  const dessines = new Set(contoursPlan.map((c) => c.localId));
  const locaux = locauxDuPlan();
  const debut = locaux.findIndex((l) => l.id === apresId) + 1;
  const suite = [...locaux.slice(debut), ...locaux.slice(0, debut)];
  return suite.find((l) => !dessines.has(l.id))?.id || null;
}

// Liste des locaux ; ceux qui ont déjà un contour sont marqués « ✓ ».
// Sans niveau sur le plan, les locaux sont regroupés par niveau.
function remplirChoixLocal(localId) {
  const dessines = new Set(contoursPlan.map((c) => c.localId));
  choixLocalContour.replaceChildren(new Option("— local à dessiner —", ""));
  for (const niveau of niveauxProjet) {
    const locaux = locauxDuPlan().filter((l) => l.niveauId === niveau.id);
    if (locaux.length === 0) continue;
    let groupe = choixLocalContour;
    if (!planCourant.niveauId) {
      groupe = document.createElement("optgroup");
      groupe.label = niveau.nom;
      choixLocalContour.append(groupe);
    }
    for (const local of locaux) {
      groupe.append(new Option((dessines.has(local.id) ? "✓ " : "") + libelleLocal(local), local.id));
    }
  }
  choixLocalContour.value = localId || "";
}

// Changer de local abandonne le contour commencé
choixLocalContour.addEventListener("change", () => {
  coinsEnCours = [];
  dessinerContours();
});

// Une touche brève (sans glisser, avec un seul doigt) pose un coin ; glisser déplace le plan
contenu.addEventListener("pointerdown", (e) => {
  if (!modeContours) return;
  toucheContour = e.isPrimary && e.target === canevas ? { x: e.clientX, y: e.clientY } : null;
});

contenu.addEventListener("pointerup", (e) => {
  if (!modeContours || !toucheContour || !e.isPrimary) return;
  const glisse = Math.hypot(e.clientX - toucheContour.x, e.clientY - toucheContour.y) > TOLERANCE_MOUVEMENT;
  toucheContour = null;
  if (!glisse) ajouterCoin(e.clientX, e.clientY);
});

async function ajouterCoin(clientX, clientY) {
  if (!choixLocalContour.value) {
    alert("Choisis d'abord le local à dessiner, dans la liste en bas de l'écran.");
    return;
  }
  const rect = canevas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  // Toucher à nouveau le premier coin ferme le contour
  if (coinsEnCours.length >= 3) {
    const [premierX, premierY] = coinsEnCours[0];
    const ecart = Math.hypot(clientX - (rect.left + premierX * rect.width), clientY - (rect.top + premierY * rect.height));
    if (ecart <= DISTANCE_FERMETURE) {
      await enregistrerContour();
      return;
    }
  }
  coinsEnCours.push([arrondi(x), arrondi(y)]);
  dessinerContours();
}

async function enregistrerContour() {
  const localId = choixLocalContour.value;
  const local = locauxProjet.find((l) => l.id === localId);
  const existant = contoursPlan.find((c) => c.localId === localId);
  if (existant && !confirm(`Le local ${libelleLocal(local)} a déjà un contour sur ce plan. Le remplacer ?`)) {
    coinsEnCours = [];
    dessinerContours();
    return;
  }

  const contour = {
    id: existant ? existant.id : crypto.randomUUID(),
    projetId: projetCourant.id,
    planId: planCourant.id,
    localId,
    points: coinsEnCours
  };
  await db.contours.put(contour);
  locauxTouches.add(localId);
  contoursPlan = contoursPlan.filter((c) => c.localId !== localId).concat(contour);
  coinsEnCours = [];
  if (navigator.vibrate) navigator.vibrate(30);

  // On passe au local suivant qui n'a pas encore de contour
  const suivant = prochainLocalSansContour(localId);
  remplirChoixLocal(suivant);
  dessinerContours();
  if (!suivant) {
    alert(planCourant.niveauId
      ? "Tous les locaux de ce niveau ont un contour sur ce plan."
      : "Tous les locaux du projet ont un contour sur ce plan.");
  }
}

boutonAnnulerPoint.addEventListener("click", () => {
  coinsEnCours.pop();
  dessinerContours();
});

boutonEffacerContour.addEventListener("click", async () => {
  const contour = contoursPlan.find((c) => c.localId === choixLocalContour.value);
  const local = locauxProjet.find((l) => l.id === choixLocalContour.value);
  if (!contour || !confirm(`Effacer le contour du local ${libelleLocal(local)} sur ce plan ?`)) return;
  await db.contours.delete(contour.id);
  locauxTouches.add(contour.localId);
  contoursPlan = contoursPlan.filter((c) => c !== contour);
  remplirChoixLocal(contour.localId);
  dessinerContours();
});

// Dessine les contours (calque SVG en proportion du plan : 0 à 1), le n° de chaque local, et le
// contour en cours avec ses coins. Rien n'est affiché en dehors du mode contours.
function dessinerContours() {
  calqueContours.replaceChildren();
  contenu.querySelectorAll(".coinContour, .nomContour").forEach((e) => e.remove());
  const dejaDessine = contoursPlan.some((c) => c.localId === choixLocalContour.value);
  boutonAnnulerPoint.hidden = coinsEnCours.length === 0;
  boutonEffacerContour.hidden = coinsEnCours.length > 0 || !dejaDessine;
  aideContours.textContent = dejaDessine && coinsEnCours.length === 0
    ? "Fais glisser un coin pour le déplacer, ou touche les coins d'un nouveau contour pour le remplacer."
    : "Touche chaque coin du local, puis à nouveau le premier pour fermer.";
  if (!modeContours) return;

  for (const contour of contoursPlan) {
    const polygone = document.createElementNS(SVG, "polygon");
    polygone.setAttribute("points", texteDesPoints(contour.points));
    polygone.classList.add("contour");
    calqueContours.append(polygone);

    // N° du local au milieu de son contour (moyenne des coins)
    const local = locauxProjet.find((l) => l.id === contour.localId);
    const nom = document.createElement("span");
    nom.className = "nomContour";
    nom.textContent = local ? local.numero : "?";
    placer(nom, [moyenne(contour.points, 0), moyenne(contour.points, 1)]);
    contenu.append(nom);

    // Contour du local choisi : mis en évidence, avec ses coins à faire glisser
    if (contour.localId === choixLocalContour.value && coinsEnCours.length === 0) {
      polygone.classList.add("choisi");
      contour.points.forEach((point, indice) => {
        const poignee = document.createElement("span");
        poignee.className = "coinContour poignee panzoom-exclude";   // « panzoom-exclude » : ne déplace pas le plan
        placer(poignee, point);
        poignee.addEventListener("pointerdown", (e) => deplacerCoin(e, contour, indice, polygone, poignee, nom));
        contenu.append(poignee);
      });
    }
  }

  if (coinsEnCours.length > 0) {
    const trace = document.createElementNS(SVG, "polyline");
    trace.setAttribute("points", texteDesPoints(coinsEnCours));
    trace.classList.add("contourEnCours");
    calqueContours.append(trace);
    coinsEnCours.forEach((point, i) => {
      const coin = document.createElement("span");
      coin.className = i === 0 ? "coinContour premier" : "coinContour";   // le premier : là où l'on ferme
      placer(coin, point);
      contenu.append(coin);
    });
  }
}

// Fait glisser un coin d'un contour existant ; le contour est enregistré quand on lâche.
// Une touche brève sur un coin, sans glisser, commence un nouveau contour comme ailleurs sur le plan.
function deplacerCoin(e, contour, indice, polygone, poignee, nom) {
  if (!e.isPrimary) return;
  e.stopPropagation();   // ni déplacement du plan, ni nouveau coin
  poignee.setPointerCapture(e.pointerId);
  const depart = { x: e.clientX, y: e.clientY };
  let deplace = false;

  const suivre = (ev) => {
    if (!deplace && Math.hypot(ev.clientX - depart.x, ev.clientY - depart.y) <= TOLERANCE_MOUVEMENT) return;
    const rect = canevas.getBoundingClientRect();
    const borne = (v) => arrondi(Math.min(1, Math.max(0, v)));
    contour.points[indice] = [borne((ev.clientX - rect.left) / rect.width), borne((ev.clientY - rect.top) / rect.height)];
    deplace = true;
    // Mise à jour directe (sans tout redessiner, ce qui ferait perdre la poignée sous le doigt)
    polygone.setAttribute("points", texteDesPoints(contour.points));
    placer(poignee, contour.points[indice]);
    placer(nom, [moyenne(contour.points, 0), moyenne(contour.points, 1)]);
  };
  const lacher = async (ev) => {
    poignee.removeEventListener("pointermove", suivre);
    poignee.removeEventListener("pointerup", lacher);
    poignee.removeEventListener("pointercancel", lacher);
    if (deplace) {
      await db.contours.put(contour);
      locauxTouches.add(contour.localId);
    } else if (ev.type === "pointerup") await ajouterCoin(ev.clientX, ev.clientY);
  };
  poignee.addEventListener("pointermove", suivre);
  poignee.addEventListener("pointerup", lacher);
  poignee.addEventListener("pointercancel", lacher);
}

// Place un élément sur le plan à la position [x, y] (en proportion du plan)
function placer(element, [x, y]) {
  element.style.left = (x * 100) + "%";
  element.style.top = (y * 100) + "%";
}

function texteDesPoints(points) {
  return points.map((p) => p.join(",")).join(" ");
}

// Le contour qui contient le point (x, y) ; s'il y en a plusieurs (contours qui se chevauchent),
// le plus petit, qui est le plus précis
function contourSous(x, y) {
  const contenant = contoursPlan.filter((c) => dansPolygone(x, y, c.points));
  contenant.sort((a, b) => aire(a.points) - aire(b.points));
  return contenant[0] || null;
}

// Le point est-il dans le polygone ? On compte combien de côtés une ligne horizontale partant du
// point vers la droite traverse : un nombre impair veut dire « dedans ».
function dansPolygone(x, y, points) {
  let dedans = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

function aire(points) {
  let somme = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    somme += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(somme) / 2;
}

function moyenne(points, indice) {
  return points.reduce((total, p) => total + p[indice], 0) / points.length;
}

// Garde 4 décimales : précision largement suffisante, données plus légères
function arrondi(valeur) {
  return Math.round(valeur * 10000) / 10000;
}

// ----- Remarques qui changent de local après modification des contours -----
// Une remarque est concernée si elle est maintenant dans le contour d'un autre local, ou si elle n'est
// plus dans le contour de son local ; et seulement si l'un de ces locaux fait partie des contours
// modifiés (« touches ») : une remarque dont le local a été choisi à la main n'est pas remise en cause
// par un contour sans rapport. La liste est proposée, cases cochées ; rien ne change sans validation.
function proposerChangementsDeLocal(touches) {
  const changements = [];
  for (const r of remarques) {
    const contour = contourSous(r.x, r.y);
    const nouveau = contour ? contour.localId : null;
    const actuel = r.localId || null;
    if (nouveau === actuel) continue;
    if (!touches.has(nouveau) && !touches.has(actuel)) continue;
    // Hors de tout contour : on ne retire le local que si ce local a un contour sur ce plan (et que la
    // remarque n'y est plus)
    if (!nouveau && !contoursPlan.some((c) => c.localId === actuel)) continue;
    changements.push({ remarque: r, localId: nouveau });
  }
  if (changements.length === 0) return;

  const libelle = (localId) => {
    const local = locauxProjet.find((l) => l.id === localId);
    return local ? libelleLocal(local) : "aucun local";
  };
  const liste = el("listeChangementsLocal");
  liste.replaceChildren();
  changements.sort((a, b) => a.remarque.numero - b.remarque.numero);
  for (const changement of changements) {
    const ligne = document.createElement("label");
    ligne.className = "ligneChangement";
    const caseACocher = document.createElement("input");
    caseACocher.type = "checkbox";
    caseACocher.checked = true;
    const texte = document.createElement("span");
    texte.textContent = `n° ${changement.remarque.numero} · ${libelle(changement.remarque.localId)} → ${libelle(changement.localId)}`;
    ligne.append(caseACocher, texte);
    liste.append(ligne);
    changement.caseACocher = caseACocher;
  }

  const fenetre = el("ficheLocaux");
  fenetre.returnValue = "";
  fenetre.showModal();
  fenetre.addEventListener("close", async () => {
    if (fenetre.returnValue !== "enregistrer") return;
    const retenus = changements.filter((c) => c.caseACocher.checked);
    await db.transaction("rw", db.remarques, async () => {
      for (const { remarque, localId } of retenus) {
        const local = locauxProjet.find((l) => l.id === localId);
        const modifications = { localId, niveauId: local ? local.niveauId : remarque.niveauId };
        await db.remarques.update(remarque.id, modifications);
        Object.assign(remarque, modifications);   // même objet que dans la liste du plan affiché
      }
    });
  }, { once: true });
}

// ----- Fiche remarque -----
async function ouvrirFiche(remarque, nouvelle) {
  remarqueEnCours = remarque;
  estNouvelle = nouvelle;

  titreFiche.textContent = "Remarque n° " + remarque.numero;
  champTexte.value = remarque.texte;
  champStatut.value = remarque.statut;
  champDate.value = remarque.date;

  // Choix proposés, relus à chaque ouverture (ils ont pu changer sur les écrans Locaux et Lots)
  const projetId = projetCourant.id;
  listesFiche = {
    niveaux: await db.niveaux.where("projetId").equals(projetId).sortBy("ordre"),
    locaux: await db.locaux.where("projetId").equals(projetId).sortBy("ordre"),
    lots: await lotsDuProjet(),
    ce: await ceDuProjet()
  };
  remplirListe(champNiveau, listesFiche.niveaux, (n) => n.nom, remarque.niveauId);
  remplirLocaux(remarque.localId);
  remplirListe(champLot, listesFiche.lots, (l) => `${l.numero} · ${l.nom}`, remarque.lotId);
  remplirChapitres(remarque.ceId);
  boutonSupprimer.hidden = nouvelle;
  boutonDeplacer.hidden = nouvelle;   // une nouvelle pastille vient d'être posée où on voulait

  // Copie de travail des photos : rien n'est écrit dans la base avant « enregistrer »
  photosFiche = nouvelle ? [] : await db.photos.where("remarqueId").equals(remarque.id).toArray();
  photosSupprimees = [];
  afficherVignettes();

  // Clavier : à l'ouverture, la fenêtre donne le « focus » (la saisie) à l'élément marqué « autofocus ».
  // Nouvelle remarque : la description, on commence par l'écrire. Remarque existante : le titre, pour
  // que le clavier reste caché ; il s'ouvre quand on touche la description.
  champTexte.autofocus = nouvelle;
  titreFiche.autofocus = !nouvelle;

  fiche.returnValue = "";
  fiche.showModal();
}

// Local : liste réduite aux locaux du niveau choisi, chacun affiché avec son n°
function remplirLocaux(localId) {
  const niveauId = champNiveau.value;
  const locauxDuNiveau = listesFiche.locaux.filter((l) => l.niveauId === niveauId);
  remplirListe(champLocal, locauxDuNiveau, libelleLocal, localId);
  champLocal.disabled = !niveauId;
}

// Chapitre (CE) : liste réduite aux CE du lot choisi ; un lot à un seul CE le choisit d'office
function remplirChapitres(ceId) {
  const lotId = champLot.value;
  const ceDuLot = listesFiche.ce.filter((c) => c.lotId === lotId);
  const parDefaut = ceDuLot.length === 1 ? ceDuLot[0].id : null;
  remplirListe(champChapitre, ceDuLot, (c) => c.nom, ceId || parDefaut);
  champChapitre.disabled = !lotId;
}

// Changer de niveau ou de lot vide le choix qui en dépend
champNiveau.addEventListener("change", () => remplirLocaux(null));
champLot.addEventListener("change", () => remplirChapitres(null));

fiche.addEventListener("close", async () => {
  const action = fiche.returnValue;
  const remarque = remarqueEnCours;
  remarqueEnCours = null;

  // « déplacer » enregistre d'abord la fiche, comme « enregistrer »
  if (action === "enregistrer" || action === "deplacer") {
    remarque.texte = champTexte.value.trim();
    remarque.statut = champStatut.value;
    remarque.niveauId = champNiveau.value || null;   // choix « — » = non renseigné
    remarque.localId = champLocal.value || null;
    remarque.lotId = champLot.value || null;
    remarque.ceId = champChapitre.value || null;
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
  if (action === "deplacer") commencerDeplacement(remarque);
});

// ----- Déplacement d'une pastille -----
// Après « déplacer » dans la fiche, une touche brève sur le plan donne la nouvelle place de la
// pastille ; glisser déplace toujours le plan, et l'appui long ne pose pas de remarque.
const barreDeplacement = el("barreDeplacement");
let remarqueADeplacer = null;
let toucheDeplacement = null;   // début d'une touche sur le plan, pendant le déplacement

function commencerDeplacement(remarque) {
  remarqueADeplacer = remarque;
  el("aideDeplacement").textContent =
    `Touche la nouvelle place de la pastille n° ${remarque.numero} sur le plan.`;
  contenu.classList.add("modeDeplacement");
  barreDeplacement.hidden = false;
  dessinerPastilles();
}

function finirDeplacement() {
  remarqueADeplacer = null;
  toucheDeplacement = null;
  contenu.classList.remove("modeDeplacement");
  barreDeplacement.hidden = true;
  dessinerPastilles();
}

el("annulerDeplacement").addEventListener("click", finirDeplacement);

contenu.addEventListener("pointerdown", (e) => {
  if (!remarqueADeplacer) return;
  toucheDeplacement = e.isPrimary && e.target === canevas ? { x: e.clientX, y: e.clientY } : null;
});

contenu.addEventListener("pointerup", (e) => {
  if (!remarqueADeplacer || !toucheDeplacement || !e.isPrimary) return;
  const glisse = Math.hypot(e.clientX - toucheDeplacement.x, e.clientY - toucheDeplacement.y) > TOLERANCE_MOUVEMENT;
  toucheDeplacement = null;
  if (!glisse) deplacerPastille(e.clientX, e.clientY);
});

async function deplacerPastille(clientX, clientY) {
  const rect = canevas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  const remarque = remarqueADeplacer;
  const changements = { x: arrondi(x), y: arrondi(y) };

  // Nouvelle place dans le contour d'un autre local : on propose de changer le local de la remarque
  const contour = contourSous(x, y);
  const local = contour && locauxProjet.find((l) => l.id === contour.localId);
  if (local && local.id !== remarque.localId &&
      confirm(`La pastille est maintenant dans le local ${libelleLocal(local)}. Mettre à jour le local de la remarque ?`)) {
    changements.niveauId = local.niveauId;
    changements.localId = local.id;
  }

  await db.remarques.update(remarque.id, changements);
  Object.assign(remarque, changements);   // même objet que dans la liste « remarques » du plan
  if (navigator.vibrate) navigator.vibrate(30);
  finirDeplacement();
}

// ===================================================================
// RECALAGE D'UN PLAN MIS À JOUR (deux repères)
// ===================================================================
// Après « recaler par deux points » : on touche deux repères sur l'ancien plan (indice), puis les mêmes
// sur le nouveau. On en déduit le passage de l'un à l'autre (décalage, agrandissement, rotation), qu'on
// applique aux pastilles et aux contours du plan. Le calcul se fait en points PDF (et non en proportion
// du plan), pour ne pas déformer si les deux PDF n'ont pas les mêmes proportions.
const barreRecalage = el("barreRecalage");
const ECART_MIN_REPERES = 30;   // pixels à l'écran : deux repères trop proches donnent un calcul imprécis
let recalage = null;            // { plan, version, anciens, nouveaux, tailleAncien, tailleNouveau }
let toucheRecalage = null;

async function commencerRecalage(plan, version) {
  await ouvrirPlan(plan, version);   // l'ancien plan d'abord
  recalage = { plan, version, anciens: [], nouveaux: [], tailleAncien: taillePage(), tailleNouveau: null };
  barreRecalage.hidden = false;
  afficherAideRecalage();
}

function arreterRecalage() {
  recalage = null;
  toucheRecalage = null;
  barreRecalage.hidden = true;
  contenu.querySelectorAll(".repere").forEach((r) => r.remove());
}

// Croix : on abandonne ; le nouveau PDF est gardé, les pastilles restent où elles étaient
el("annulerRecalage").addEventListener("click", async () => {
  const plan = recalage.plan;
  arreterRecalage();
  await ouvrirPlan(plan);
});

// Taille de la page affichée, en points PDF
function taillePage() {
  const vue = pageCourante.getViewport({ scale: 1 });
  return { largeur: vue.width, hauteur: vue.height };
}

function afficherAideRecalage() {
  const textes = [
    `Ancien plan (indice ${recalage.version.indice}) : touche un premier repère facile à retrouver (angle de mur, axe…).`,
    `Ancien plan (indice ${recalage.version.indice}) : touche un second repère, loin du premier.`,
    "Nouveau plan : touche le même premier repère.",
    "Nouveau plan : touche le même second repère."
  ];
  el("aideRecalage").textContent = textes[recalage.anciens.length + recalage.nouveaux.length];
}

// Une touche brève pose un repère ; glisser déplace le plan
contenu.addEventListener("pointerdown", (e) => {
  if (!recalage) return;
  toucheRecalage = e.isPrimary && e.target === canevas ? { x: e.clientX, y: e.clientY } : null;
});

contenu.addEventListener("pointerup", (e) => {
  if (!recalage || !toucheRecalage || !e.isPrimary) return;
  const glisse = Math.hypot(e.clientX - toucheRecalage.x, e.clientY - toucheRecalage.y) > TOLERANCE_MOUVEMENT;
  toucheRecalage = null;
  if (!glisse) poserRepere(e.clientX, e.clientY);
});

async function poserRepere(clientX, clientY) {
  const rect = canevas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  const surAncien = recalage.anciens.length < 2;
  const reperes = surAncien ? recalage.anciens : recalage.nouveaux;
  if (reperes.length === 1) {
    const [x1, y1] = reperes[0];
    if (Math.hypot((x - x1) * rect.width, (y - y1) * rect.height) < ECART_MIN_REPERES) {
      alert("Ce repère est trop près du premier. Choisis-en un plus éloigné.");
      return;
    }
  }
  reperes.push([x, y]);
  afficherRepere(x, y, reperes.length);
  if (navigator.vibrate) navigator.vibrate(30);

  if (surAncien && recalage.anciens.length === 2) {
    // Les deux repères de l'ancien plan sont posés : place au nouveau plan
    const etat = recalage;
    await pause(400);   // le temps de voir le second repère
    await ouvrirPlan(etat.plan);
    recalage = etat;    // ouvrirPlan ne connaît pas le recalage : on le reprend
    recalage.tailleNouveau = taillePage();
    contenu.querySelectorAll(".repere").forEach((r) => r.remove());
  }
  if (recalage.nouveaux.length === 2) {
    await terminerRecalage();
    return;
  }
  afficherAideRecalage();
}

function afficherRepere(x, y, numero) {
  const repere = document.createElement("span");
  repere.className = "repere";
  repere.textContent = numero;
  repere.style.left = (x * 100) + "%";
  repere.style.top = (y * 100) + "%";
  contenu.append(repere);
}

// Passage de l'ancien plan au nouveau. Un point du plan est vu comme un nombre complexe z = x + i·y
// (en points PDF) : le passage s'écrit z' = a·z + b, où a contient l'agrandissement et la rotation, et b
// le décalage. Deux repères suffisent à trouver a et b.
function calculerPassage({ anciens, nouveaux, tailleAncien, tailleNouveau }) {
  const enPoints = ([x, y], taille) => ({ re: x * taille.largeur, im: y * taille.hauteur });
  const moins = (u, v) => ({ re: u.re - v.re, im: u.im - v.im });
  const fois = (u, v) => ({ re: u.re * v.re - u.im * v.im, im: u.re * v.im + u.im * v.re });
  const divise = (u, v) => {
    const n = v.re * v.re + v.im * v.im;
    return { re: (u.re * v.re + u.im * v.im) / n, im: (u.im * v.re - u.re * v.im) / n };
  };
  const p1 = enPoints(anciens[0], tailleAncien), p2 = enPoints(anciens[1], tailleAncien);
  const q1 = enPoints(nouveaux[0], tailleNouveau), q2 = enPoints(nouveaux[1], tailleNouveau);
  const a = divise(moins(q2, q1), moins(p2, p1));
  const b = moins(q1, fois(a, p1));
  return {
    agrandissement: Math.hypot(a.re, a.im),
    // Rend la nouvelle position (en proportion du nouveau plan) d'un point de l'ancien
    transformer: (point) => {
      const z = fois(a, enPoints(point, tailleAncien));
      return [(z.re + b.re) / tailleNouveau.largeur, (z.im + b.im) / tailleNouveau.hauteur];
    }
  };
}

async function terminerRecalage() {
  const etat = recalage;
  const passage = calculerPassage(etat);
  if (passage.agrandissement < 0.1 || passage.agrandissement > 10) {
    alert("Les repères ne correspondent pas (échelle incohérente). Recalage abandonné : les pastilles " +
      "restent où elles étaient. Tu peux les déplacer une à une avec « déplacer ».");
    arreterRecalage();
    await ouvrirPlan(etat.plan);
    return;
  }

  // Une position recalée hors du nouveau plan est ramenée au bord
  let auBord = 0;
  const recaler = (point) => {
    const [x, y] = passage.transformer(point);
    const dedans = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
    if (dedans[0] !== x || dedans[1] !== y) auBord++;
    return [arrondi(dedans[0]), arrondi(dedans[1])];
  };

  // Aperçu : les pastilles du plan affiché sont déplacées (pas encore enregistrées)
  const nouvellesPlaces = remarques.map((r) => recaler([r.x, r.y]));
  remarques.forEach((r, i) => { [r.x, r.y] = nouvellesPlaces[i]; });
  const pastillesAuBord = auBord;
  dessinerPastilles();
  await pause(100);   // laisse l'écran afficher l'aperçu avant la question

  const garder = confirm(
    `Pastilles recalées sur le nouveau plan (${remarques.length} remarque(s)` +
    (pastillesAuBord ? `, dont ${pastillesAuBord} ramenée(s) au bord du plan` : "") +
    `). Garder ce recalage ?`
  );
  arreterRecalage();
  if (!garder) {
    await ouvrirPlan(etat.plan);   // relit les positions enregistrées : rien n'a changé
    return;
  }

  // Enregistrement : pastilles et contours du plan, ensemble
  await db.transaction("rw", db.remarques, db.contours, async () => {
    for (const r of remarques) await db.remarques.update(r.id, { x: r.x, y: r.y });
    const contours = await db.contours.where("planId").equals(etat.plan.id).toArray();
    for (const c of contours) await db.contours.update(c.id, { points: c.points.map(recaler) });
  });
  contoursPlan = await db.contours.where("planId").equals(etat.plan.id).toArray();
}

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
    if (r === remarqueADeplacer) pastille.classList.add("enDeplacement");
    pastille.textContent = r.numero;
    pastille.style.left = (r.x * 100) + "%";
    pastille.style.top = (r.y * 100) + "%";
    // Ancienne version : pastilles affichées seulement, sans fiche
    if (versionConsultee) pastille.classList.add("consultation");
    else pastille.addEventListener("click", () => ouvrirFiche(r, false));
    contenu.appendChild(pastille);
  }
}

// ===================================================================
// RAPPORT PDF : page de garde, puis pour chaque plan sa vue avec les pastilles et la liste de ses
// remarques ; photos dans la liste, à la fin du rapport, ou pas du tout
// ===================================================================
const ficheRapport = el("ficheRapport");
const champStatutRapport = el("champStatutRapport");
const champNiveauRapport = el("champNiveauRapport");
const champLocalRapport = el("champLocalRapport");
const champLotRapport = el("champLotRapport");
const champChapitreRapport = el("champChapitreRapport");
const champPhotosRapport = el("champPhotosRapport");
let listesRapport = { niveaux: [], locaux: [], lots: [], ce: [] };   // choix proposés dans la fenêtre
let rapportEnCours = false;

// Mise en page (points PDF) : A4, marges de 15 mm
const A4 = [595.28, 841.89];
const MARGE = 15 * POINTS_PAR_MM;
const HAUTEUR_PIED = 8 * POINTS_PAR_MM;          // bas de page réservé au pied (projet, n° de page)
const PASTILLE_RAPPORT = 4.5 * POINTS_PAR_MM;    // diamètre des pastilles sur le plan et dans la liste
const HAUTEUR_VIGNETTE_RAPPORT = 30 * POINTS_PAR_MM;   // photos dans la liste
const HAUTEUR_PHOTO_FIN_MAX = 95 * POINTS_PAR_MM;      // photos à la fin du rapport (deux par ligne)
const ECART = 4;                                 // entre deux photos
const HAUTEUR_ETIQUETTE = 16;                    // étiquettes en pastille noire (comme dans la fiche)
// Trait noir sous les titres : même épaisseur qu'à l'écran (« 4pt » dans charte.css)
const EPAISSEUR_SEPARATION =
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--trait-separation"));

// Polices de la charte pour le rapport : fichiers TrueType statiques (une graisse par fichier), car
// pdf-lib ne sait pas choisir une graisse dans les polices « variables » .woff2 de l'écran.
// Elles ont besoin du module fontkit, chargé seulement au premier rapport (gros fichier).
const POLICES_RAPPORT = {
  texte: "polices/roboto-condensed-400.ttf",
  texteGras: "polices/roboto-condensed-600.ttf",
  titre: "polices/dosis-600.ttf",
  etiquette: "polices/dosis-400.ttf"
};
const ADRESSE_FONTKIT = "https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/+esm";

el("ouvrirRapport").addEventListener("click", ouvrirRapport);

// Les choix restent ceux du rapport précédent (un choix disparu revient à « — »)
async function ouvrirRapport() {
  const projetId = projetCourant.id;
  listesRapport = {
    niveaux: await db.niveaux.where("projetId").equals(projetId).sortBy("ordre"),
    locaux: await db.locaux.where("projetId").equals(projetId).sortBy("ordre"),
    lots: await lotsDuProjet(),
    ce: await ceDuProjet()
  };
  remplirListe(champNiveauRapport, listesRapport.niveaux, (n) => n.nom, champNiveauRapport.value);
  remplirLocauxRapport(champLocalRapport.value);
  remplirListe(champLotRapport, listesRapport.lots, (l) => `${l.numero} · ${l.nom}`, champLotRapport.value);
  remplirChapitresRapport(champChapitreRapport.value);
  ficheRapport.returnValue = "";
  ficheRapport.showModal();
}

// Comme dans la fiche : local réduit au niveau, chapitre réduit au lot (sans choix d'office :
// un lot seul veut dire « tout le lot »)
function remplirLocauxRapport(localId) {
  const niveauId = champNiveauRapport.value;
  remplirListe(champLocalRapport, listesRapport.locaux.filter((l) => l.niveauId === niveauId), libelleLocal, localId);
  champLocalRapport.disabled = !niveauId;
}

function remplirChapitresRapport(ceId) {
  const lotId = champLotRapport.value;
  remplirListe(champChapitreRapport, listesRapport.ce.filter((c) => c.lotId === lotId), (c) => c.nom, ceId);
  champChapitreRapport.disabled = !lotId;
}

champNiveauRapport.addEventListener("change", () => remplirLocauxRapport(null));
champLotRapport.addEventListener("change", () => remplirChapitresRapport(null));

ficheRapport.addEventListener("close", () => {
  if (ficheRapport.returnValue !== "produire") return;
  produireRapport({
    seulementOuvertes: champStatutRapport.value === "ouvertes",
    niveauId: champNiveauRapport.value || null,   // « — » = pas de filtre
    localId: champLocalRapport.value || null,
    lotId: champLotRapport.value || null,
    ceId: champChapitreRapport.value || null,
    photos: champPhotosRapport.value              // « liste », « fin » ou « sans »
  });
});

async function produireRapport(filtres) {
  if (rapportEnCours) return;
  rapportEnCours = true;
  el("bandeauTravail").hidden = false;
  try {
    const projetId = projetCourant.id;
    const parId = (liste) => new Map(liste.map((e) => [e.id, e]));
    const niveauDe = parId(listesRapport.niveaux);
    const localDe = parId(listesRapport.locaux);
    const lotDe = parId(listesRapport.lots);
    const ceDe = parId(listesRapport.ce);

    const choisies = (await db.remarques.where("projetId").equals(projetId).toArray())
      .filter((r) => (!filtres.seulementOuvertes || r.statut === "ouverte")
        && (!filtres.niveauId || r.niveauId === filtres.niveauId)
        && (!filtres.localId || r.localId === filtres.localId)
        && (!filtres.lotId || r.lotId === filtres.lotId)
        && (!filtres.ceId || r.ceId === filtres.ceId))
      .sort((a, b) => a.numero - b.numero);
    if (choisies.length === 0) {
      alert("Aucune remarque ne correspond à ce choix.");
      return;
    }
    const plans = (await db.plans.where("projetId").equals(projetId).sortBy("nom"))
      .filter((p) => choisies.some((r) => r.planId === p.id));

    // Photos des remarques choisies, dans l'ordre d'ajout
    const photosDe = new Map();
    if (filtres.photos !== "sans") {
      const photos = await db.photos.where("projetId").equals(projetId).sortBy("ajouteeLe");
      for (const photo of photos) {
        if (!photosDe.has(photo.remarqueId)) photosDe.set(photo.remarqueId, []);
        photosDe.get(photo.remarqueId).push(photo);
      }
    }

    // Lieu (local, sinon niveau) et chapitre (CE, sinon lot) d'une remarque, pour la liste
    const lieu = (r) => localDe.has(r.localId) ? libelleLocal(localDe.get(r.localId)) : niveauDe.get(r.niveauId)?.nom;
    const chapitre = (r) => ceDe.has(r.ceId) ? ceDe.get(r.ceId).nom : lotDe.has(r.lotId) ? libelleLot(lotDe.get(r.lotId)) : null;

    const doc = await PDFDocument.create();
    const { default: fontkit } = await import(ADRESSE_FONTKIT);
    doc.registerFontkit(fontkit);
    const mise = {
      doc,
      // texte, texteGras, titre, etiquette : polices intégrées au PDF (seulement les lettres utilisées)
      ...Object.fromEntries(await Promise.all(Object.entries(POLICES_RAPPORT).map(async ([role, chemin]) =>
        [role, await doc.embedFont(await (await fetch(chemin)).arrayBuffer(), { subset: true })]))),
      page: null,
      y: 0,
      titreSuite: null   // titre répété en haut des pages suivantes d'une liste
    };

    pageDeGarde(mise, filtres, choisies, { niveauDe, localDe, lotDe, ceDe });

    for (const plan of plans) {
      const duPlan = choisies.filter((r) => r.planId === plan.id);
      const indice = plan.nombreVersions ? " · indice " + lettreIndice(plan.nombreVersions + 1) : "";
      await pageDuPlan(mise, plan, plan.nom + indice, duPlan);

      // Liste des remarques du plan, sur des pages A4 en hauteur
      nouvellePageRapport(mise);
      ecrireTitre(mise, plan.nom + indice + " : remarques", 16, true);
      mise.titreSuite = plan.nom + indice + " : remarques (suite)";
      for (const r of duPlan) {
        await ligneRemarque(mise, r, lieu(r), chapitre(r), filtres.photos === "liste" ? photosDe.get(r.id) || [] : []);
      }
      mise.titreSuite = null;
    }

    if (filtres.photos === "fin" && choisies.some((r) => photosDe.has(r.id))) {
      nouvellePageRapport(mise);
      ecrireTitre(mise, "Photos", 16, true);
      mise.titreSuite = "Photos (suite)";
      for (const r of choisies) {
        if (photosDe.has(r.id)) await photosEnFin(mise, r, lieu(r), photosDe.get(r.id));
      }
    }

    piedsDePage(mise);
    const resultat = await doc.save();
    telecharger(new Blob([resultat], { type: "application/pdf" }),
      nomDeFichier(`${projetCourant.nom} - rapport ${aujourdhui()}`) + ".pdf");
  } catch (erreur) {
    alert("Impossible de produire le rapport : " + erreur.message);
  } finally {
    rapportEnCours = false;
    el("bandeauTravail").hidden = true;
  }
}

// ----- Page de garde : projet, date, choix des remarques, nombres, entreprises concernées -----
function pageDeGarde(mise, filtres, choisies, { niveauDe, localDe, lotDe, ceDe }) {
  nouvellePageRapport(mise);
  ecrireTitre(mise, "Rapport de chantier", 26, true);

  // Comme la fiche : étiquette noire à gauche, valeur à droite
  const ouvertes = choisies.filter((r) => r.statut === "ouverte").length;
  const levees = choisies.length - ouvertes;
  grilleRapport(mise, [
    ["projet", [{ texte: projetCourant.nom, gras: true }]],
    ["date", [{ texte: formaterDate(aujourdhui()) }]],
    ["remarques", [{ texte: filtres.seulementOuvertes ? "Ouvertes seulement" : "Toutes (ouvertes et levées)" }]],
    filtres.niveauId && ["niveau", [{ texte: niveauDe.get(filtres.niveauId).nom }]],
    filtres.localId && ["local", [{ texte: libelleLocal(localDe.get(filtres.localId)) }]],
    filtres.lotId && ["lot", [{ texte: libelleLot(lotDe.get(filtres.lotId)).replace(/^lot /, "") }]],
    filtres.ceId && ["chapitre", [{ texte: ceDe.get(filtres.ceId).nom }]],
    ["nombre", [{ texte: `${choisies.length} remarque${choisies.length > 1 ? "s" : ""} : ` +
      `${ouvertes} ouverte${ouvertes > 1 ? "s" : ""}, ${levees} levée${levees > 1 ? "s" : ""}` }]]
  ].filter(Boolean));

  // Légende des pastilles, sur une ligne
  placeRapport(mise, 20);
  let x = MARGE;
  for (const [statut, texte] of [["ouverte", "ouverte"], ["levee", "levée"]]) {
    dessinerPastillePdf(mise.page, mise.texteGras, x + PASTILLE_RAPPORT / 2, mise.y - 8, PASTILLE_RAPPORT, { statut, numero: "" });
    ecrireTexte(mise, texte, x + PASTILLE_RAPPORT + 6, mise.y - 11.5, 10.5);
    x += PASTILLE_RAPPORT + 6 + mise.texte.widthOfTextAtSize(texte, 10.5) + 24;
  }
  mise.y -= 48;

  // Entreprises concernées : celle de chaque lot des remarques, et le sous-traitant de chaque CE
  ecrireTitre(mise, "Entreprises concernées", 16, true);
  const lotsConcernes = [...lotDe.values()].filter((l) => choisies.some((r) => r.lotId === l.id));
  if (lotsConcernes.length === 0) ecrireLignes(mise, "Aucune remarque n'est liée à un lot.", { couleur: "--encre-douce" });
  const intervenant = (e) => e.entreprise + (e.courriel ? " · " + e.courriel : "");
  grilleRapport(mise, lotsConcernes.map((lot) => {
    const lignes = [
      { texte: lot.nom, gras: true },
      lot.entreprise ? { texte: intervenant(lot) } : { texte: "entreprise non renseignée", doux: true }
    ];
    for (const ce of [...ceDe.values()].filter((c) => c.lotId === lot.id && c.entreprise)) {
      if (choisies.some((r) => r.ceId === ce.id)) lignes.push({ texte: `${ce.nom}, sous-traitant : ${intervenant(ce)}` });
    }
    return ["lot " + lot.numero, lignes];
  }));
  const sansLot = choisies.filter((r) => !lotDe.has(r.lotId)).length;
  if (sansLot > 0 && lotsConcernes.length > 0) {
    ecrireLignes(mise, `${sansLot} remarque${sansLot > 1 ? "s" : ""} sans lot`, { couleur: "--encre-douce" });
  }
}

// ----- Page d'un plan : le plan entier (vectoriel), avec les pastilles des remarques choisies -----
// Page A4 en largeur ou en hauteur selon le plan.
async function pageDuPlan(mise, plan, titre, duPlan) {
  const octets = await plan.fichier.arrayBuffer();
  // Copie des octets pour pdf.js (voir exporterPlanAnnote)
  const pagePdfjs = await (await pdfjsLib.getDocument({ data: octets.slice(0) }).promise).getPage(plan.page);
  const vue = pagePdfjs.getViewport({ scale: 1 });

  nouvellePageRapport(mise, vue.width > vue.height ? [A4[1], A4[0]] : A4);
  ecrireTitre(mise, titre, 16, true);
  const largeurPage = mise.page.getWidth();
  const largeurZone = largeurPage - 2 * MARGE;
  const hauteurZone = mise.y - MARGE - HAUTEUR_PIED;
  const echelle = Math.min(largeurZone / vue.width, hauteurZone / vue.height);
  const largeur = vue.width * echelle;
  const hauteur = vue.height * echelle;
  const x = MARGE + (largeurZone - largeur) / 2;
  const y = MARGE + HAUTEUR_PIED + (hauteurZone - hauteur) / 2;

  try {
    // Page du plan reprise telle quelle (cadre vu par pdf.js), tournée comme à l'écran
    const source = await PDFDocument.load(octets);
    const [gauche, bas, droite, haut] = pagePdfjs.view;
    const integree = await mise.doc.embedPage(source.getPage(plan.page - 1), { left: gauche, bottom: bas, right: droite, top: haut });
    const l = integree.width * echelle;    // taille avant rotation
    const h = integree.height * echelle;
    // La rotation se fait autour du point d'ancrage : on le choisit pour que la page tournée tombe dans la zone
    const ancre = { 0: [x, y], 90: [x, y + l], 180: [x + l, y + h], 270: [x + h, y] }[vue.rotation];
    mise.page.drawPage(integree, { x: ancre[0], y: ancre[1], xScale: echelle, yScale: echelle, rotate: degrees(-vue.rotation) });
  } catch {
    // PDF protégé (chiffré) : pdf-lib ne peut pas le reprendre ; le plan est mis en image (moins net)
    const finesse = 2400 / Math.max(vue.width, vue.height);
    const vueImage = pagePdfjs.getViewport({ scale: finesse });
    const toile = document.createElement("canvas");
    toile.width = Math.round(vueImage.width);
    toile.height = Math.round(vueImage.height);
    const ctx = toile.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, toile.width, toile.height);
    await pagePdfjs.render({ canvasContext: ctx, viewport: vueImage }).promise;
    const image = await mise.doc.embedJpg(await octetsJpeg(toile));
    mise.page.drawImage(image, { x, y, width: largeur, height: hauteur });
  }

  for (const r of duPlan) {
    dessinerPastillePdf(mise.page, mise.texteGras, x + r.x * largeur, y + (1 - r.y) * hauteur, PASTILLE_RAPPORT, r);
  }
}

// ----- Une remarque de la liste : pastille, lieu · chapitre, statut · date, description, photos -----
async function ligneRemarque(mise, r, lieu, chapitre, photos) {
  const largeurPage = mise.page.getWidth();
  const xTexte = MARGE + PASTILLE_RAPPORT + 8;
  const largeurTexte = largeurPage - MARGE - xTexte;
  const lignes = couperLignes(r.texte || "", mise.texte, 10.5, largeurTexte);

  placeRapport(mise, 17 + lignes.length * 13.5 + 6);
  const haut = mise.y;
  dessinerPastillePdf(mise.page, mise.texteGras, MARGE + PASTILLE_RAPPORT / 2, haut - 2 - PASTILLE_RAPPORT / 2, PASTILLE_RAPPORT, r);
  const droite = (r.statut === "levee" ? "levée" : "ouverte") + (r.date ? " · " + formaterDate(r.date) : "");
  const largeurDroite = mise.etiquette.widthOfTextAtSize(droite, 9.5);
  const entete = [lieu, chapitre].filter(Boolean).join(" · ") || "—";
  const enteteCourt = couperLignes(entete, mise.texteGras, 10.5, largeurTexte - largeurDroite - 12)[0] || "";
  ecrireTexte(mise, enteteCourt, xTexte, haut - 10.5, 10.5, mise.texteGras);
  ecrireTexte(mise, droite, largeurPage - MARGE - largeurDroite, haut - 10.5, 9.5, mise.etiquette, "--encre-douce");
  mise.y = haut - 17;
  for (const ligne of lignes) {
    ecrireTexte(mise, ligne, xTexte, mise.y - 10, 10.5);
    mise.y -= 13.5;
  }

  // Vignettes des photos annotées, à la suite, sur autant de rangées que nécessaire
  let x = xTexte;
  let rangeeOuverte = false;
  for (const photo of photos) {
    const largeur = HAUTEUR_VIGNETTE_RAPPORT * photo.largeur / photo.hauteur;
    if (rangeeOuverte && x + largeur > largeurPage - MARGE) {
      mise.y -= HAUTEUR_VIGNETTE_RAPPORT + ECART;
      rangeeOuverte = false;
      x = xTexte;
    }
    if (!rangeeOuverte) {
      mise.y -= 4;
      placeRapport(mise, HAUTEUR_VIGNETTE_RAPPORT);
      rangeeOuverte = true;
    }
    const image = await imagePhotoPdf(mise.doc, photo, 700);
    mise.page.drawImage(image, { x, y: mise.y - HAUTEUR_VIGNETTE_RAPPORT, width: largeur, height: HAUTEUR_VIGNETTE_RAPPORT });
    x += largeur + ECART;
  }
  if (rangeeOuverte) mise.y -= HAUTEUR_VIGNETTE_RAPPORT;

  // Trait de séparation
  mise.y -= 6;
  mise.page.drawLine({
    start: { x: MARGE, y: mise.y }, end: { x: largeurPage - MARGE, y: mise.y },
    thickness: 0.5, color: couleurPdf("--trait")
  });
  mise.y -= 6;
}

// ----- Photos à la fin du rapport : n° de la remarque et local, puis ses photos, deux par ligne -----
async function photosEnFin(mise, r, lieu, photos) {
  const largeurPage = mise.page.getWidth();
  const largeurCase = (largeurPage - 2 * MARGE - ECART) / 2;
  const taille = (photo) => {
    let largeur = largeurCase;
    let hauteur = largeur * photo.hauteur / photo.largeur;
    if (hauteur > HAUTEUR_PHOTO_FIN_MAX) {   // photo en hauteur : on limite la hauteur
      hauteur = HAUTEUR_PHOTO_FIN_MAX;
      largeur = hauteur * photo.largeur / photo.hauteur;
    }
    return { largeur, hauteur };
  };

  for (let i = 0; i < photos.length; i += 2) {
    const rangee = photos.slice(i, i + 2);
    const hauteurRangee = Math.max(...rangee.map((p) => taille(p).hauteur));
    // Le titre de la remarque reste avec sa première rangée de photos
    placeRapport(mise, (i === 0 ? 22 : 0) + hauteurRangee);
    if (i === 0) {
      dessinerPastillePdf(mise.page, mise.texteGras, MARGE + PASTILLE_RAPPORT / 2, mise.y - 2 - PASTILLE_RAPPORT / 2, PASTILLE_RAPPORT, r);
      ecrireTexte(mise, `n° ${r.numero}` + (lieu ? " · " + lieu : ""), MARGE + PASTILLE_RAPPORT + 8, mise.y - 10.5, 10.5, mise.texteGras);
      mise.y -= 22;
    }
    let x = MARGE;
    for (const photo of rangee) {
      const { largeur, hauteur } = taille(photo);
      const image = await imagePhotoPdf(mise.doc, photo, 1400);
      mise.page.drawImage(image, { x, y: mise.y - hauteur, width: largeur, height: hauteur });
      x += largeurCase + ECART;
    }
    mise.y -= hauteurRangee + ECART;
  }
  mise.y -= 12;
}

// ----- Outils de mise en page du rapport -----
function nouvellePageRapport(mise, format = A4) {
  mise.page = mise.doc.addPage(format);
  mise.y = format[1] - MARGE;
  if (mise.titreSuite) ecrireTitre(mise, mise.titreSuite, 11);
}

// Passe à une nouvelle page si la hauteur demandée ne tient plus au-dessus du pied de page
function placeRapport(mise, hauteur) {
  if (mise.y - hauteur < MARGE + HAUTEUR_PIED) nouvellePageRapport(mise);
}

// Titre en Dosis ; « avecTrait » : grand trait noir dessous, comme l'en-tête des écrans et des fiches
function ecrireTitre(mise, texte, taille, avecTrait = false) {
  const largeurPage = mise.page.getWidth();
  for (const ligne of couperLignes(texte, mise.titre, taille, largeurPage - 2 * MARGE)) {
    placeRapport(mise, taille * 1.3 + (avecTrait ? EPAISSEUR_SEPARATION + 8 : 0));
    ecrireTexte(mise, ligne, MARGE, mise.y - taille, taille, mise.titre);
    mise.y -= taille * 1.3;
  }
  if (avecTrait) {
    mise.y -= 4;
    mise.page.drawRectangle({
      x: MARGE, y: mise.y - EPAISSEUR_SEPARATION,
      width: largeurPage - 2 * MARGE, height: EPAISSEUR_SEPARATION, color: couleurPdf("--encre")
    });
    mise.y -= EPAISSEUR_SEPARATION + 14;
  } else {
    mise.y -= taille * 0.4;
  }
}

// Étiquette de la charte, bord haut en « yHaut » : pastille noire, texte blanc en Dosis, minuscules
function dessinerEtiquette(mise, texte, x, yHaut, largeur) {
  const rayon = HAUTEUR_ETIQUETTE / 2;
  const fond = couleurPdf("--bouton-fond");
  mise.page.drawRectangle({ x: x + rayon, y: yHaut - HAUTEUR_ETIQUETTE, width: largeur - HAUTEUR_ETIQUETTE, height: HAUTEUR_ETIQUETTE, color: fond });
  mise.page.drawCircle({ x: x + rayon, y: yHaut - rayon, size: rayon, color: fond });
  mise.page.drawCircle({ x: x + largeur - rayon, y: yHaut - rayon, size: rayon, color: fond });
  const largeurTexte = mise.etiquette.widthOfTextAtSize(texte, 9.5);
  ecrireTexte(mise, texte, x + (largeur - largeurTexte) / 2, yHaut - rayon - 3.2, 9.5, mise.etiquette, "--bouton-texte");
}

// Grille comme dans la fiche : [étiquette, lignes] ; étiquettes à la largeur de la plus longue, valeurs à
// droite (chaque ligne : { texte, gras, doux }), coupées à la largeur restante
function grilleRapport(mise, rangees) {
  const largeurEtiquettes = Math.max(0, ...rangees.map(([etiquette]) =>
    mise.etiquette.widthOfTextAtSize(etiquette, 9.5) + 2 * 9));
  const xValeur = MARGE + largeurEtiquettes + 10;
  const largeurValeur = mise.page.getWidth() - MARGE - xValeur;
  for (const [etiquette, lignes] of rangees) {
    const coupees = lignes.flatMap(({ texte, gras, doux }) =>
      couperLignes(texte, gras ? mise.texteGras : mise.texte, 10.5, largeurValeur)
        .map((t) => ({ t, police: gras ? mise.texteGras : mise.texte, couleur: doux ? "--encre-douce" : "--encre" })));
    placeRapport(mise, Math.max(HAUTEUR_ETIQUETTE, coupees.length * 13.5) + 8);
    dessinerEtiquette(mise, etiquette, MARGE, mise.y, largeurEtiquettes);
    let y = mise.y;
    for (const { t, police, couleur } of coupees) {
      ecrireTexte(mise, t, xValeur, y - 11.8, 10.5, police, couleur);
      y -= 13.5;
    }
    mise.y -= Math.max(HAUTEUR_ETIQUETTE, coupees.length * 13.5) + 8;
  }
}

// Paragraphe coupé à la largeur de la page
function ecrireLignes(mise, texte, { police = mise.texte, retrait = 0, couleur = "--encre" } = {}) {
  const largeurPage = mise.page.getWidth();
  for (const ligne of couperLignes(texte, police, 10.5, largeurPage - 2 * MARGE - retrait)) {
    placeRapport(mise, 13.5);
    ecrireTexte(mise, ligne, MARGE + retrait, mise.y - 10.5, 10.5, police, couleur);
    mise.y -= 13.5;
  }
}

function ecrireTexte(mise, texte, x, y, taille, police = mise.texte, couleur = "--encre") {
  mise.page.drawText(texteLisible(texte, police), { x, y, size: taille, font: police, color: couleurPdf(couleur) });
}

// Pied de chaque page, en Dosis : projet et date du rapport à gauche, n° de page à droite
function piedsDePage(mise) {
  const pages = mise.doc.getPages();
  const police = mise.etiquette;
  const gauche = texteLisible(`${projetCourant.nom} · rapport du ${formaterDate(aujourdhui())}`, police);
  pages.forEach((page, i) => {
    const largeurPage = page.getWidth();
    const droite = `page ${i + 1} / ${pages.length}`;
    const options = { y: MARGE, size: 8.5, font: police, color: couleurPdf("--encre-douce") };
    page.drawText(gauche, { ...options, x: MARGE });
    page.drawText(droite, { ...options, x: largeurPage - MARGE - police.widthOfTextAtSize(droite, 8.5) });
  });
}

// Une police ne connaît qu'un jeu de caractères (ici l'alphabet latin, accents français compris) :
// un autre caractère (émoji, flèche…) est remplacé par « ? » au lieu de tout bloquer
const caracteresConnus = new Map();
function texteLisible(texte, police) {
  if (!caracteresConnus.has(police)) caracteresConnus.set(police, new Set(police.getCharacterSet()));
  const connus = caracteresConnus.get(police);
  return [...String(texte).replace(/[\t  ]/g, " ")]
    .map((c) => connus.has(c.codePointAt(0)) ? c : "?")
    .join("");
}

// Coupe un texte en lignes qui tiennent dans la largeur ; garde les retours à la ligne saisis.
// Un mot plus long que la largeur est coupé où il faut.
function couperLignes(texte, police, taille, largeur) {
  const mesure = (t) => police.widthOfTextAtSize(texteLisible(t, police), taille);
  const lignes = [];
  for (const paragraphe of String(texte).split(/\r?\n/)) {
    let ligne = "";
    for (let mot of paragraphe.split(" ")) {
      while (mesure(mot) > largeur) {   // mot trop long : on en met le plus possible sur une ligne
        if (ligne) { lignes.push(ligne); ligne = ""; }
        let n = mot.length - 1;
        while (n > 1 && mesure(mot.slice(0, n)) > largeur) n--;
        lignes.push(mot.slice(0, n));
        mot = mot.slice(n);
      }
      const essai = ligne ? ligne + " " + mot : mot;
      if (mesure(essai) > largeur) {
        lignes.push(ligne);
        ligne = mot;
      } else {
        ligne = essai;
      }
    }
    lignes.push(ligne);
  }
  return lignes;
}

// Photo avec ses traits, en JPEG pour le PDF ; « cote » : plus grand côté, en pixels
async function imagePhotoPdf(doc, photo, cote) {
  const echelle = Math.min(1, cote / Math.max(photo.largeur, photo.hauteur));
  const toile = document.createElement("canvas");
  toile.width = Math.round(photo.largeur * echelle);
  toile.height = Math.round(photo.hauteur * echelle);
  const ctx = toile.getContext("2d");
  ctx.drawImage(await imageDe(photo), 0, 0, toile.width, toile.height);
  for (const trait of photo.traits) dessinerTrait(ctx, trait, toile.width, toile.height);
  return doc.embedJpg(await octetsJpeg(toile));
}

async function octetsJpeg(toile) {
  const blob = await new Promise((resolu) => toile.toBlob(resolu, "image/jpeg", PHOTO_QUALITE));
  return blob.arrayBuffer();
}

// ===================================================================
// OUTILS
// ===================================================================
// Ligne ouvrable (titre et détail) suivie d'actions discrètes [texte, fonction]
function elementListe(titre, detail, quandOuvrir, actions) {
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

  for (const [texte, quandToucher] of actions) li.append(boutonAction(texte, quandToucher));
  return li;
}

// Remplit une liste déroulante : un premier choix « — » (non renseigné), puis un choix par élément
function remplirListe(liste, elements, libelle, valeur) {
  liste.replaceChildren(new Option("—", ""));
  for (const element of elements) liste.append(new Option(libelle(element), element.id));
  liste.value = valeur || "";
  if (liste.selectedIndex === -1) liste.value = "";   // valeur disparue : « — »
}

// Action discrète d'une ligne de liste (texte gris seul ; « texte » peut aussi être un sigle)
function boutonAction(texte, quandToucher) {
  const bouton = document.createElement("button");
  bouton.className = "actionElement";
  bouton.append(texte);
  bouton.addEventListener("click", quandToucher);
  return bouton;
}

// Ligne de liste : un contenu (texte ou élément) suivi d'actions discrètes [texte, fonction]
function elementLigne(contenu, actions, classe) {
  const li = document.createElement("li");
  li.className = classe;
  const span = document.createElement("span");
  span.className = "contenuLigne";
  span.append(contenu);
  li.append(span);
  for (const [texte, quandToucher] of actions) li.append(boutonAction(texte, quandToucher));
  return li;
}

// Étiquette de la charte (pastille noire, texte blanc)
function creerEtiquette(texte) {
  const etiquette = document.createElement("span");
  etiquette.className = "etiquette";
  etiquette.textContent = texte;
  return etiquette;
}

// Sigle qui reste en majuscules dans un bouton ou une étiquette (classe « sigle »)
function creerSigle(texte) {
  const sigle = document.createElement("span");
  sigle.className = "sigle";
  sigle.textContent = texte;
  return sigle;
}

// Pose une question ; renvoie la réponse sans espaces autour, ou null si annulé ou laissé vide
function demander(question, valeurParDefaut = "") {
  const reponse = prompt(question, valeurParDefaut);
  return reponse === null ? null : reponse.trim() || null;
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

// Lit un fichier texte. Excel enregistre en UTF-8 (« CSV UTF-8 ») ou en Windows-1252
// (« CSV séparateur point-virgule ») : on essaie le premier, sinon le second, pour garder les accents.
function lireTexte(octets) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(octets);
  } catch {
    return new TextDecoder("windows-1252").decode(octets);
  }
}

// Découpe un texte CSV en lignes et en cellules (séparateur « ; »). Gère les cellules entre
// guillemets, qui peuvent contenir un « ; », un saut de ligne ou des guillemets doublés « "" ».
function analyserCsv(texte) {
  const lignes = [];
  let ligne = [];
  let cellule = "";
  let entreGuillemets = false;

  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (entreGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { cellule += '"'; i++; }
      else if (c === '"') entreGuillemets = false;
      else cellule += c;
    } else if (c === '"') {
      entreGuillemets = true;
    } else if (c === ";") {
      ligne.push(cellule);
      cellule = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texte[i + 1] === "\n") i++;   // fin de ligne Windows
      ligne.push(cellule);
      lignes.push(ligne);
      ligne = [];
      cellule = "";
    } else {
      cellule += c;
    }
  }
  if (cellule || ligne.length > 0) {   // dernière ligne sans saut de ligne final
    ligne.push(cellule);
    lignes.push(ligne);
  }
  return lignes;
}

// Attend un moment (en millisecondes), par exemple pour laisser l'écran se mettre à jour
function pause(duree) {
  return new Promise((resolu) => setTimeout(resolu, duree));
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

// Fonctionnement hors ligne : le service worker garde une copie de l'application (voir sw.js)
if ("serviceWorker" in navigator) {
  const enregistrement = navigator.serviceWorker.register("./sw.js");

  // Chrome ne cherche une nouvelle version qu'à l'ouverture d'une page. Une application remise au
  // premier plan sans être rechargée ne la verrait pas : on lui demande alors de vérifier.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") enregistrement.then((e) => e.update()).catch(() => {});
  });

  // Le service worker annonce sa version quand il prend la main. Si elle diffère de celle de
  // cette page (le « ?v=N » de app.js), une nouvelle version a été reçue : on propose de recharger.
  const versionPage = new URL(import.meta.url).searchParams.get("v");
  navigator.serviceWorker.onmessage = (e) => {
    if (e.data?.type === "version" && String(e.data.version) !== versionPage) {
      el("bandeauMiseAJour").hidden = false;
    }
  };
  el("recharger").addEventListener("click", () => location.reload());
}

// ----- Bouton « installer » -----
// Chrome signale (« beforeinstallprompt ») que l'application peut être installée. On garde
// cette demande pour l'afficher au moment où l'on touche le bouton.
const boutonInstaller = el("installer");
let demandeInstallation = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();   // pas de proposition automatique de Chrome : on passe par notre bouton
  demandeInstallation = e;
  boutonInstaller.hidden = false;
});

boutonInstaller.addEventListener("click", async () => {
  boutonInstaller.hidden = true;
  demandeInstallation.prompt();          // fenêtre d'installation de Chrome
  await demandeInstallation.userChoice;  // installée ou refusée : la demande ne sert qu'une fois
  demandeInstallation = null;
});

// Application installée (par notre bouton ou par le menu de Chrome) : le bouton n'a plus lieu d'être
window.addEventListener("appinstalled", () => { boutonInstaller.hidden = true; });