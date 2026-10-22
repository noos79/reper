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

// Demande à Android de ne pas effacer nos données s'il manque de place
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist();
}

// ===== Réglages =====
const QUALITE = 2;
const PIXELS_MAX = 16_000_000;
const DUREE_APPUI_LONG = 600;
const TOLERANCE_MOUVEMENT = 10;

// Identifiant et version du format des fichiers d'export
const FORMAT_EXPORT = "suivi-chantier";
const VERSION_EXPORT = 1;

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

// ===== État courant : ce qui est ouvert en ce moment =====
let projetCourant = null;
let planCourant = null;
let remarques = [];           // remarques du plan affiché
let remarqueEnCours = null;   // celle affichée dans la fiche
let estNouvelle = false;

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

// ----- Export : un fichier .zip contenant projet.json et les PDF des plans -----
async function exporterProjet(projet) {
  try {
    const projetAJour = await db.projets.get(projet.id);
    const plans = await db.plans.where("projetId").equals(projet.id).toArray();
    const remarquesProjet = await db.remarques.where("projetId").equals(projet.id).toArray();

    const zip = new JSZip();
    zip.file("projet.json", JSON.stringify({
      format: FORMAT_EXPORT,
      version: VERSION_EXPORT,
      exporteLe: aujourdhui(),
      projet: projetAJour,
      // Chaque plan sans son « fichier » : le PDF est rangé à part dans le dossier plans/
      plans: plans.map(({ fichier, ...reste }) => reste),
      remarques: remarquesProjet
    }, null, 2));

    for (const plan of plans) {
      zip.file(`plans/${plan.id}.pdf`, plan.fichier);
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
  if (donnees.version !== VERSION_EXPORT) {
    throw new Error(`version de format inconnue (${donnees.version}). Mets l'application à jour.`);
  }
  const { projet, plans, remarques: remarquesImportees } = donnees;
  if (!projet || !projet.id || !Array.isArray(plans) || !Array.isArray(remarquesImportees)) {
    throw new Error("le fichier projet.json est incomplet.");
  }
  const idsPlans = new Set(plans.map((p) => p.id));
  if (remarquesImportees.some((r) => !idsPlans.has(r.planId))) {
    throw new Error("certaines remarques renvoient à un plan absent du fichier.");
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

  const existant = await db.projets.get(projet.id);
  if (existant && !confirm(
    `Le projet « ${existant.nom} » existe déjà sur cet appareil.\n\n` +
    `Le remplacer par la version du fichier (exportée le ${formaterDate(donnees.exporteLe)}) ?\n` +
    `Ses plans et remarques actuels seront définitivement supprimés.`
  )) return;

  // Transaction : soit tout le projet est remplacé, soit rien ne change
  await db.transaction("rw", db.projets, db.plans, db.remarques, async () => {
    await db.remarques.where("projetId").equals(projet.id).delete();
    await db.plans.where("projetId").equals(projet.id).delete();
    await db.projets.put(projet);
    await db.plans.bulkAdd(plansAImporter);
    await db.remarques.bulkAdd(remarquesAImporter);
  });

  alert(`Projet « ${projet.nom} » importé : ${plans.length} plan(s), ${remarquesImportees.length} remarque(s).`);
}

async function supprimerProjet(projet) {
  if (!confirm(`Supprimer le projet « ${projet.nom} » avec tous ses plans et remarques ?`)) return;

  // Transaction : soit tout est supprimé, soit rien (jamais de remarques orphelines)
  await db.transaction("rw", db.projets, db.plans, db.remarques, async () => {
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
  if (!confirm(`Supprimer le plan « ${plan.nom} » et ses remarques ?`)) return;

  await db.transaction("rw", db.plans, db.remarques, async () => {
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
function ouvrirFiche(remarque, nouvelle) {
  remarqueEnCours = remarque;
  estNouvelle = nouvelle;

  titreFiche.textContent = "Remarque n° " + remarque.numero;
  champTexte.value = remarque.texte;
  champStatut.value = remarque.statut;
  champEntreprise.value = remarque.entreprise;
  champDate.value = remarque.date;
  boutonSupprimer.hidden = nouvelle;

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

    await db.remarques.put(remarque);   // « put » = créer ou mettre à jour

    if (estNouvelle) {
      remarques.push(remarque);
      // Le numéro est définitivement consommé : il ne sera jamais réattribué
      projetCourant.dernierNumero = remarque.numero;
      await db.projets.update(projetCourant.id, { dernierNumero: remarque.numero });
    }
  }

  if (action === "supprimer") {
    if (confirm("Supprimer la remarque n° " + remarque.numero + " ?")) {
      await db.remarques.delete(remarque.id);
      remarques = remarques.filter((r) => r.id !== remarque.id);
    }
  }

  dessinerPastilles();
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