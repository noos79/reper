# Suivi chantier — consignes pour Claude Code

## Le projet

Application web de suivi de chantier pour un usage personnel en bureau d'architecture (AASA, Belgique).
Elle sert à pointer des remarques sur un plan PDF, à y joindre des photos annotées et à produire un rapport PDF.

Le propriétaire du projet (Niko) a des bases très légères en programmation. L'objectif de ce dépôt est
d'obtenir rapidement une application qui fonctionne ; l'apprentissage se fait ailleurs. Mais chaque
modification doit rester compréhensible et maintenable par lui.

**Principe directeur : une application la plus simple possible, pour aller vite sur le chantier.**
Poser une remarque ne doit pas obliger à parcourir une foule de choix avant de valider. Toute nouvelle
fonction qui ajoute des champs, des listes ou des étapes à la saisie doit être pesée à cette aune, et
signalée si elle alourdit la saisie.

## Règles de travail

- **Langue** : tout en français — échanges, commentaires dans le code, noms de variables et de fonctions,
  messages affichés, messages de validation Git. Éviter les anglicismes (« valider » et non « commiter »,
  « hors ligne » et non « offline », etc.).
- **Expliquer** chaque modification : ce qui change, dans quels fichiers, et pourquoi. Introduire les notions
  nouvelles en quelques phrases simples.
- **Faire exactement ce qui est demandé.** Si une amélioration supplémentaire semble utile, la proposer
  d'abord au lieu de la faire.
- **Signaler** les incohérences, les risques (perte de données, sécurité, lisibilité sur le terrain) et les
  limites d'une solution, même si elles n'ont pas été demandées.
- **Demander avant de valider et d'envoyer** sur GitHub. Messages de validation courts et descriptifs.
- Ne jamais ajouter de PDF de plans ni de données réelles de chantier au dépôt : il est **public**.

## Choix techniques (ne pas en changer sans le proposer)

- HTML, CSS et JavaScript simples, **sans cadriciel ni étape de compilation**. Modules ES (`type="module"`).
- Bibliothèques chargées depuis un CDN, **versions figées** :
  - pdf.js `pdfjs-dist@4.10.38` (affichage des plans)
  - Panzoom `@panzoom/panzoom@4.5.1` (zoom et déplacement)
  - Dexie `dexie@4.0.10` (base IndexedDB)
  - JSZip `jszip@3.10.1` (export et import)
- Hébergement : GitHub Pages (`https://<compte>.github.io/suivi-chantier/`).
- Tests en local avec l'extension VS Code Live Server.
- Structure : `index.html`, `css/charte.css`, `css/style.css`, `js/app.js`, `polices/`,
  `manifest.webmanifest`, `sw.js` (service worker, à la racine pour couvrir tout le site), `icones/`.
- **Contournement du cache** : `index.html` charge `css/charte.css?v=N`, `css/style.css?v=N` et
  `js/app.js?v=N`. Augmenter `N` à chaque modification du CSS ou du JS (un seul numéro commun),
  **et le même numéro dans `const VERSION` de `sw.js`** : sinon le service worker continue de servir
  l'ancienne copie. Tout nouveau fichier de l'application doit être ajouté à la liste `FICHIERS` de `sw.js`.
- **Hors ligne** (`sw.js`) : la page passe par le réseau d'abord (3 s au plus, puis copie en cache) ;
  tous les autres fichiers sont servis depuis le cache. Une mise à jour apparaît donc au plus tard
  à la deuxième ouverture. Quand un nouveau service worker prend la main, il envoie sa `VERSION` aux
  pages ouvertes ; si elle diffère du `?v=N` de `app.js`, un bandeau « nouvelle version disponible »
  propose de recharger. Chrome ne cherchant une nouvelle version qu'à l'ouverture d'une page,
  `app.js` lui demande aussi de vérifier quand l'application revient au premier plan (`visibilitychange`).
- **Installation** : bouton « installer » sur l'écran Projets, caché par défaut, affiché seulement quand
  Chrome envoie `beforeinstallprompt` (application installable et pas encore installée).
- Appareils cibles : **Android (Chrome) et PC Windows (Chrome)**. iPhone et iPad non testés en V1.

## Données

Base IndexedDB `suiviChantier`, via Dexie :

```
projets:   "id, nom"            // id, nom, creeLe, dernierNumero
plans:     "id, projetId, nom"  // id, projetId, nom, fichier (Blob PDF), page, niveauId, lotId (facultatifs)
remarques: "id, planId, projetId"
           // id, projetId, planId, numero, x, y, texte, statut, date,
           // niveauId, localId, lotId, ceId (facultatifs : null = non renseigné)
photos:    "id, remarqueId, planId, projetId"          (depuis la version 2 du schéma)
           // id, projetId, planId, remarqueId, image (Blob JPEG), largeur, hauteur, traits, ajouteeLe
niveaux:   "id, projetId"                              (depuis la version 3 du schéma)
           // id, projetId, nom, ordre
locaux:    "id, projetId, niveauId"                    (depuis la version 3 du schéma)
           // id, projetId, niveauId, numero, nom, ordre
lots:      "id, projetId"                              (depuis la version 4 du schéma)
           // id, projetId, numero, nom, entreprise, courriel
ce:        "id, projetId, lotId"                       (depuis la version 4 du schéma)
           // id, projetId, lotId, nom, ordre, entreprise, courriel
```

Décisions à respecter :
- Toute modification de schéma passe par une **nouvelle version** (`db.version(3)`…), jamais en modifiant
  une version existante : des appareils ont déjà des données. Version actuelle : **5** (sa mise à niveau
  retire le champ `entreprise` des remarques).
- **Locaux** importés depuis un CSV : colonnes `niveau ; n° ; nom`, séparateur « ; », 1re ligne = titres
  (ignorée), encodage UTF-8 (« CSV UTF-8 » d'Excel) ou Windows-1252 (« CSV séparateur point-virgule »),
  reconnu automatiquement. Lignes sans niveau ou sans n°, et doublons (même niveau et même n°), ignorés et
  signalés. Les niveaux sont créés dans l'ordre d'apparition (`ordre`). Un nouvel import **remplace** la
  liste après confirmation, mais un niveau (même nom) ou un local (même niveau, même n°) déjà connu
  **garde son `id`** : les liens des remarques vers les locaux survivent à un réimport.
- **Lots et CE** saisis dans l'application (écran « Lots »). Lots triés par n° (comparaison numérique :
  2 avant 10) ; n° unique dans le projet. Un lot compte **au moins un CE** : le premier est demandé à la
  création du lot, et le dernier CE d'un lot ne peut pas être supprimé (supprimer le lot). Deux CE d'un
  même lot ne portent pas le même nom. Supprimer un lot supprime ses CE (transaction).
- **Intervenants** : `entreprise` et `courriel` (facultatifs) sur le lot = l'adjudicataire ; sur le CE =
  le sous-traitant éventuel. Un nom vide retire l'entreprise et son adresse ; adresse vérifiée
  simplement (`ADRESSE_VALIDE`).
- **Liens des remarques** (`niveauId`, `localId`, `lotId`, `ceId`) : le local sert seulement au tri et au
  filtre ; il est indépendant de la numérotation. Un plan peut avoir un `niveauId` et un `lotId` (plan qui
  ne concerne qu'un lot), proposés d'office pour ses nouvelles remarques, avec le CE si le lot n'en a
  qu'un (les changer ne modifie pas les remarques existantes).
- **Suppression d'un élément lié** : la remarque est gardée et **perd seulement le lien**, après un
  avertissement qui donne le nombre de remarques touchées, dans la même transaction. Lot supprimé → lot et
  chapitre retirés des remarques, lot retiré des plans ; CE supprimé → chapitre retiré (lot gardé) ; réimport des locaux → niveau ou local
  disparus retirés des remarques et des plans.
- Photos **réduites à 1600 px** (plus grand côté, JPEG 0,85) à l'ajout. L'image d'origine et les
  **traits** sont gardés séparément (annotation modifiable) : `traits` = liste de traits, chaque trait =
  liste de points `[x, y]` **en proportion de l'image (0 à 1)**. Couleur : `--trait-annotation`.
- Les photos d'une fiche ne sont écrites qu'à « enregistrer », dans la même transaction que la remarque ;
  « annuler » (ou la fermeture de la fiche) abandonne les photos ajoutées.
- Positions `x` et `y` des remarques **en proportion du plan (0 à 1)**, jamais en pixels.
- Numérotation des remarques **continue par projet** ; un numéro n'est **jamais réutilisé**, même après
  suppression (compteur `dernierNumero` sur le projet, consommé à l'enregistrement). Elle sert à compter
  les remarques et à les situer sur le plan ; elle est **indépendante des locaux** et des **trous** dans
  la suite sont normaux.
- `statut` : `"ouverte"` ou `"levee"`.
- `date` : date de constat (AAAA-MM-JJ, date locale), remplie avec la date du jour.
- Suppressions en cascade dans une **transaction** (jamais de remarques ni de photos orphelines).
- Export `.zip` : `projet.json` (format `suivi-chantier`, **version 5**, avec `niveaux`, `locaux`, `lots`
  et `ce` ; remarques avec leurs liens) +
  `plans/<id>.pdf` + `photos/<id>.jpg`. L'import accepte les versions 1 (sans photos), 2 (sans locaux),
  3 (sans lots), 4 (remarques avec le champ `entreprise`, retiré à l'import) et 5. Un lien rempli qui ne
  mène nulle part refuse l'import. Les fonctions `tablesDuProjet` et `viderProjet` listent toutes les tables d'un projet : y ajouter
  chaque nouvelle table.
- Les données sont **propres à chaque appareil** et à chaque adresse (Live Server et GitHub Pages ont des
  bases séparées). Pas de synchronisation en V1.

## Interface

Écrans (`<section class="ecran">`, un seul visible à la fois via `hidden`) :
1. **Projets** : liste, création, suppression, export, import.
2. **Projet** : liste des plans (niveau et lot éventuels, nombre de remarques ouvertes), ajout d'un PDF,
   « niveau et lot » (petite fenêtre `fichePlan`, deux listes), suppression ;
   boutons « locaux » et « lots ».
   - **Locaux** (`ecranLocaux`) : locaux regroupés par niveau (titre du niveau en étiquette), « importer CSV ».
   - **Lots** (`ecranLots`) : chaque lot en étiquette « lot N · nom » (modifier, supprimer), ses CE en
     dessous (renommer, supprimer), « + ajouter un CE » ; boutons « intervenants » et « nouveau lot ».
     Saisies par les fenêtres de question du navigateur (`prompt`).
   - **Intervenants** (`ecranIntervenants`, retour vers Lots) : par lot, « entreprise du lot » puis chaque
     CE avec son sous-traitant ; « modifier » demande le nom puis l'adresse électronique.
3. **Plan** : affichage du PDF (page 1), zoom, appui long (600 ms) pour poser une remarque, pastilles
   cliquables ouvrant la fiche remarque (`<dialog>`).

Fiche remarque : « description » (étiquette au-dessus du champ), puis une grille à deux colonnes
(`grilleFiche`) : « statut », « niveau », « local », « lot », « chapitre » et « date » avec l'étiquette et
le champ sur la même ligne ; « photos » (étiquette, vignettes en dessous). Les étiquettes ont la largeur de
la plus longue. Listes déroulantes avec un premier choix « — » (non renseigné) : « local » réduit aux
locaux du niveau (affichés « n° · nom ») ; « chapitre » = **CE**, réduit aux CE du lot, choisi d'office
si le lot n'en a qu'un. Changer de niveau ou de lot vide le choix qui en dépend. Les entreprises
n'apparaissent pas dans la fiche. Zone « photos » (vignettes + « prendre une photo » et « galerie »). Deux boutons car le
sélecteur de photos des Android récents ne propose plus l'appareil photo : « prendre une photo » utilise
`capture="environment"` pour l'ouvrir directement. Une
vignette ouvre l'**écran d'annotation** (`<dialog id="editeurPhoto">`, plein écran) : trait rouge au
doigt, « annuler le trait », « supprimer », « terminé ».

En-têtes : si la place manque (téléphone), les boutons passent sur une deuxième ligne, à droite ; le titre
garde au moins 9em. Sauf l'écran **Plan**, toujours sur une ligne (titre coupé par « … ») pour garder la
hauteur au plan.

**PC et tablette en paysage** (largeur ≥ 900 px, hauteur ≥ 560 px) : la fiche flotte **à droite** pour
laisser le plan visible ; téléphones et portrait : fiche au centre. Elle reste **modale** (le plan ne
réagit pas tant qu'elle est ouverte). Piste à étudier plus tard : fiche fixe à droite, non modale, dont
le contenu change quand on touche une autre pastille ; il faudra alors décider du sort des modifications
non enregistrées (enregistrement automatique, ou question avant de changer de remarque).

Mobile : `interactive-widget=resizes-content` dans le viewport pour que le clavier ne masque pas la fiche,
**complété par** `visualViewport` (fonction `ajusterFicheAuClavier`) qui centre la fiche dans la zone visible
au-dessus du clavier, car certaines tablettes ne réduisent pas la page.

## Charte graphique

Inspirée de l'en-tête des documents AASA : noir sur blanc, étiquettes en pastille noire, champs soulignés,
grand trait de séparation. **Minimaliste**, beaucoup d'air, pas de fioritures.

Les **valeurs** sont dans `css/charte.css` (variables CSS) ; `css/style.css` les utilise et n'écrit
**jamais** une couleur, une police ou une épaisseur de trait en dur. Changer de charte = modifier
`charte.css`. Les rapports PDF devront reprendre ces mêmes valeurs.

- **Fond** blanc, encre noire.
- **Polices**, fichiers dans `polices/` (licence SIL OFL jointe), jamais chargées depuis un site extérieur
  (fonctionnement hors ligne) :
  - Roboto Condensed **Regular (400)** pour le texte, **600** pour les titres ;
  - **Dosis 400** pour les boutons et les étiquettes. Elle remplace Letter Gothic Std, police de la
    charte papier, qui est payante (Adobe) et ne peut pas être diffusée.
- **Boutons** : pastille noire, texte blanc, **minuscules**, bords arrondis à 50 % de la hauteur. Au
  toucher, les couleurs s'inversent. Même taille de texte que le texte courant (`--taille-texte`).
  Exception : « supprimer » de la fiche en **orange, texte noir en gras**. Boutons **secondaires**
  (classe `secondaire` : « prendre une photo », « galerie », « installer ») : couleurs inversées, fond blanc, bordure et
  texte noirs. Flèche de retour : dessin SVG (classe `fleche`),
  trait épais, branches obliques longues.
  Actions discrètes d'une ligne de liste (exporter, supprimer) :
  texte gris seul, même police. Un sigle reste en majuscules dans ce texte en minuscules (classe `sigle`,
  ex. « + ajouter un CE »).
- **Étiquettes** des champs (fiche) : même pastille noire que les boutons, au-dessus du champ.
- **Champs** à remplir : sans trait, sauf le texte de la remarque (trait noir fin en dessous) ; trait
  turquoise pendant la saisie.
- **Traits de séparation** : 4 points, noirs (sous l'en-tête des écrans, sous le titre de la fiche).
- **Fond derrière le plan** : quadrillage de petites croix grises à trait très fin (« + »), comme sur les documents AASA
  (variable `--motif-fond`). Le plan reste sur fond blanc par-dessus.
- **Logo** : pas dans le dépôt (public). Pas de logo dans l'application pour l'instant.

Palette AASA (couleurs de signalement, pas de décor) :
- `#EE9227` orange → remarque **ouverte**
- `#95C25B` vert → remarque **levée**
- `#23A9A7` turquoise → accent (soulignement du champ en saisie)
- `#97D9DB` turquoise clair → en réserve (sélection, filtre actif)

Lisibilité en plein soleil : **jamais de texte blanc sur l'orange, le vert ou le turquoise** (contraste
insuffisant) ; numéros des pastilles en noir. Pastilles : simple cercle de couleur avec le numéro, sans
bordure ni ombre, taille constante quel que soit le zoom (variable CSS `--echelle`).

## État d'avancement

Fait :
1. Chaîne complète VS Code → GitHub → GitHub Pages → téléphone.
2. Affichage d'un plan PDF.
3. Zoom et déplacement (netteté suffisante pour situer une remarque).
4. Pose, modification et suppression de remarques.
5. Enregistrement sur l'appareil ; écrans Projets / Projet / Plan.
6. **Export et import d'un projet** (fichier `.zip` : `projet.json` + `plans/<id>.pdf`). L'import
   **remplace** un projet existant (reconnu par son `id`, pas par son nom) après confirmation, sans
   fusion. Format versionné (`format: "suivi-chantier"`, `version: 1`).
7. Photos sur les remarques, avec annotation à main levée (trait rouge au doigt, annuler le dernier trait),
   ajoutées à l'export (format d'export version 2).
8. Application installable et hors ligne (manifeste web, service worker, icônes provisoires : pastille
   orange « 1 »), bouton « installer », bandeau « nouvelle version disponible ». Vérifié sur Android.

9. Structure du projet, en trois morceaux :
   - **9a (fait)** : niveaux et locaux (niveau, n°, nom), importés depuis un fichier **CSV** plutôt
     qu'Excel (SheetJS sur le CDN : version ancienne avec failles connues) ; écran « Locaux » ; schéma 3,
     export version 3.
   - **9b (fait)** : **lots** du marché et **CE** (corps d'exécution), saisis **dans l'application** (pas de
     CSV) : chaque CE appartient à un lot ; un lot compte
     un ou plusieurs CE (ex. lot 1 Gros-œuvre → Démolitions, Égouttage, Structures, Toiture,
     Menuiseries extérieures ; lot 3 Électricité → un seul CE Électricité) ;
     page **Intervenants** : une entreprise par lot (l'adjudicataire, destinataire habituel des
     rapports) et, si besoin, un sous-traitant par CE ; chacun avec son adresse électronique
     (facultative). Les entreprises n'apparaissent **ni dans la fiche ni dans la liste des remarques** ;
     schéma 4, export version 4.
   - **9c (fait)** : un plan peut être lié à un niveau (facultatif) ; fiche : niveau → local (liste réduite au
     niveau, n° rempli automatiquement, sert seulement au tri et au filtre) ; lot → CE, affiché
     « chapitre » (liste réduite au lot). Le champ libre actuel « chapitre » (champ `entreprise` des
     données) disparaît **avec ses valeurs** (décision : pas de reprise, pas encore de vraies données).
     Un plan peut aussi être lié à un lot (plan propre à un lot), proposé d'office dans ses remarques.
     Schéma 5, export version 5.

10. **Mise de côté** (décision du 25/10/2026) : bibliothèque de remarques types. Une version complète a
    été réalisée puis écartée, car elle alourdissait la saisie (une liste de plus dans la fiche, et des
    listes qui grossissent à chaque texte saisi) : contraire au principe directeur. Le propriétaire y
    reviendra peut-être sous une autre forme. Le travail est conservé dans la branche locale
    `etape-10-bibliotheque` (non envoyée sur GitHub).

À faire, dans cet ordre :
11. Contours des locaux dessinés sur le plan (en proportion 0 à 1) ; à la pose d'une pastille, niveau,
    n° et nom du local remplis automatiquement.
12. Mise à jour d'un plan sans perdre les remarques : l'ancienne version reçoit un **indice** (A, B…)
    et reste consultable, avec possibilité de la supprimer ; recalage par deux points (repères touchés
    sur l'ancien puis le nouveau plan) ; déplacement d'une pastille au doigt ; contours redessinables ;
    liste des remarques qui changent de local, à confirmer avant enregistrement.
13. Plan annoté en PDF : pastilles dessinées sur le PDF d'origine (bibliothèque pdf-lib, à valider),
    net à l'impression.
14. Rapports PDF : rapport général (page de garde, une page par plan, liste des remarques avec
    vignettes) et rapport par local (vue recadrée sur le contour, remarques du local) ; filtres
    (toutes, ouvertes seulement, un lot, un CE, un niveau, un local). La page de garde reprend la liste des
    entreprises concernées par les remarques du rapport.
15. Note d'envoi du rapport aux entreprises concernées (celles dont l'adresse électronique est définie) :
    par défaut l'entreprise du lot seule, avec la possibilité d'ajouter les sous-traitants des CE.
    Limite : une page web ne peut pas envoyer un courriel elle-même ; piste à étudier : partage du PDF
    vers l'application de messagerie (Android), adresses et texte à coller, ou envoi par un serveur (V2).

Plus tard (V2) : sauvegarde automatique dans le nuage ou sur le serveur du bureau (éventuellement via VPN),
synchronisation entre appareils, iPhone et iPad, renommage des projets et des plans, choix de la page
d'un PDF de plusieurs pages, mise en page du rapport aux couleurs AASA.
