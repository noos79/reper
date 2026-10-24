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
// 2 : ajout des photos ; 3 : niveaux et locaux ; 4 : lots et CE ;
// 5 : remarques liées à un niveau, un local, un lot et un CE, sans le champ « entreprise »
const VERSION_EXPORT = 5;

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
const vignettes = el("vignettes");
const choixPhoto = el("choixPhoto");
const appareilPhoto = el("appareilPhoto");

const ficheNiveau = el("ficheNiveau");
const champNiveauPlan = el("champNiveauPlan");

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
let planEnCours = null;       // celui dont on choisit le niveau
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
      ce: ceProjet
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
  // Versions acceptées : 1 (sans photos), 2 (avec photos), 3 (avec niveaux et locaux), 4 (avec lots et CE),
  // 5 (remarques liées aux niveaux, locaux, lots et CE)
  if (![1, 2, 3, 4, 5].includes(donnees.version)) {
    throw new Error(`version de format inconnue (${donnees.version}). Mets l'application à jour.`);
  }
  const { projet, plans, remarques: remarquesImportees } = donnees;
  const photosImportees = donnees.photos || [];   // absentes en version 1
  const niveauxImportes = donnees.niveaux || [];  // absents avant la version 3
  const locauxImportes = donnees.locaux || [];
  const lotsImportes = donnees.lots || [];        // absents avant la version 4
  const ceImportes = donnees.ce || [];
  if (!projet || !projet.id || !Array.isArray(plans) || !Array.isArray(remarquesImportees)
      || !Array.isArray(photosImportees) || !Array.isArray(niveauxImportes)
      || !Array.isArray(locauxImportes) || !Array.isArray(lotsImportes)
      || !Array.isArray(ceImportes)) {
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
  if (plans.some((p) => lienCasse(p.niveauId, idsNiveaux))
      || remarquesImportees.some((r) => lienCasse(r.niveauId, idsNiveaux) || lienCasse(r.localId, idsLocaux)
        || lienCasse(r.lotId, idsLots) || lienCasse(r.ceId, idsCe))) {
    throw new Error("certains plans ou remarques renvoient à un niveau, un local, un lot ou un CE absent du fichier.");
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
  return [db.projets, db.plans, db.remarques, db.photos, db.niveaux, db.locaux, db.lots, db.ce];
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

  listePlans.replaceChildren();
  if (plans.length === 0) {
    listePlans.append(elementVide("Aucun plan. Ajoute un PDF avec « Ajouter un plan »."));
  }
  for (const plan of plans) {
    const ouvertes = await db.remarques
      .where("planId").equals(plan.id)
      .filter((r) => r.statut === "ouverte")
      .count();
    let detail = ouvertes + (ouvertes > 1 ? " remarques ouvertes" : " remarque ouverte");
    if (nomNiveau.has(plan.niveauId)) detail = nomNiveau.get(plan.niveauId) + " · " + detail;

    listePlans.append(elementListe(
      plan.nom,
      detail,
      () => ouvrirPlan(plan),
      [["niveau", () => choisirNiveauPlan(plan)], ["Supprimer", () => supprimerPlan(plan)]]
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

// ----- Niveau d'un plan (facultatif) : proposé d'office pour les nouvelles remarques du plan -----
async function choisirNiveauPlan(plan) {
  const niveaux = await db.niveaux.where("projetId").equals(projetCourant.id).sortBy("ordre");
  if (niveaux.length === 0) {
    alert("Ce projet n'a pas encore de niveaux. Importe d'abord les locaux (bouton « locaux »).");
    return;
  }
  planEnCours = plan;
  el("titreFicheNiveau").textContent = plan.nom;
  remplirListe(champNiveauPlan, niveaux, (n) => n.nom, plan.niveauId);
  ficheNiveau.returnValue = "";
  ficheNiveau.showModal();
}

ficheNiveau.addEventListener("close", async () => {
  const plan = planEnCours;
  planEnCours = null;
  if (ficheNiveau.returnValue !== "enregistrer") return;
  await db.plans.update(plan.id, { niveauId: champNiveauPlan.value || null });
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

  if (anciensLocaux.length > 0) {
    let question = `Remplacer les ${anciensLocaux.length} local(aux) actuels par les ${locaux.length} du fichier ?`;
    if (remarquesTouchees.length > 0 || plansTouches.length > 0) {
      question += `\n\nCertains niveaux ou locaux disparaissent : ${remarquesTouchees.length} remarque(s) ` +
        `et ${plansTouches.length} plan(s) perdront leur niveau ou leur local (le reste est conservé).`;
    }
    if (!confirm(question)) return;
  }

  await db.transaction("rw", db.niveaux, db.locaux, db.remarques, db.plans, async () => {
    await db.locaux.where("projetId").equals(projetId).delete();
    await db.niveaux.where("projetId").equals(projetId).delete();
    await db.niveaux.bulkAdd(niveaux);
    await db.locaux.bulkAdd(locaux);
    for (const r of remarquesTouchees) {
      const niveauId = niveauGarde.has(r.niveauId) ? r.niveauId : null;
      await db.remarques.update(r.id, { niveauId, localId: niveauId && localGarde.has(r.localId) ? r.localId : null });
    }
    for (const p of plansTouches) await db.plans.update(p.id, { niveauId: null });
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
  let question = `Supprimer le ${libelleLot(lot)}, ses CE et leurs entreprises ?`;
  if (liees.length > 0) question += `\n\n${liees.length} remarque(s) perdront leur lot et leur chapitre.`;
  if (!confirm(question)) return;

  // Transaction : jamais de CE sans son lot, ni de remarque liée à un lot disparu
  await db.transaction("rw", db.lots, db.ce, db.remarques, async () => {
    await db.ce.where("lotId").equals(lot.id).delete();
    await db.lots.delete(lot.id);
    for (const r of liees) await db.remarques.update(r.id, { lotId: null, ceId: null });
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
    niveauId: planCourant.niveauId || null,   // le niveau du plan, s'il en a un
    localId: null,
    lotId: null,
    ceId: null,
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

  // Copie de travail des photos : rien n'est écrit dans la base avant « enregistrer »
  photosFiche = nouvelle ? [] : await db.photos.where("remarqueId").equals(remarque.id).toArray();
  photosSupprimees = [];
  afficherVignettes();

  fiche.returnValue = "";
  fiche.showModal();
}

// Local : liste réduite aux locaux du niveau choisi, chacun affiché avec son n°
function remplirLocaux(localId) {
  const niveauId = champNiveau.value;
  const locauxDuNiveau = listesFiche.locaux.filter((l) => l.niveauId === niveauId);
  remplirListe(champLocal, locauxDuNiveau, (l) => [l.numero, l.nom].filter(Boolean).join(" · "), localId);
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

  if (action === "enregistrer") {
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

// Action discrète d'une ligne de liste (texte gris seul)
function boutonAction(texte, quandToucher) {
  const bouton = document.createElement("button");
  bouton.className = "actionElement";
  bouton.textContent = texte;
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