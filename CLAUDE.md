# Suivi chantier — consignes pour Claude Code

## Le projet

Application web de suivi de chantier pour un usage personnel en bureau d'architecture (AASA, Belgique).
Elle sert à pointer des remarques sur un plan PDF, à y joindre des photos annotées et à produire un rapport PDF.

Le propriétaire du projet (Niko) a des bases très légères en programmation. L'objectif de ce dépôt est
d'obtenir rapidement une application qui fonctionne ; l'apprentissage se fait ailleurs. Mais chaque
modification doit rester compréhensible et maintenable par lui.

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
- Structure : `index.html`, `css/charte.css`, `css/style.css`, `js/app.js`, `polices/`.
- **Contournement du cache** : `index.html` charge `css/charte.css?v=N`, `css/style.css?v=N` et
  `js/app.js?v=N`. Augmenter `N` à chaque modification du CSS ou du JS (un seul numéro commun).
- Appareils cibles : **Android (Chrome) et PC Windows (Chrome)**. iPhone et iPad non testés en V1.

## Données

Base IndexedDB `suiviChantier`, via Dexie :

```
projets:   "id, nom"            // id, nom, creeLe, dernierNumero
plans:     "id, projetId, nom"  // id, projetId, nom, fichier (Blob PDF), page
remarques: "id, planId, projetId"
           // id, projetId, planId, numero, x, y, texte, statut, entreprise, date
```

Décisions à respecter :
- Toute modification de schéma passe par une **nouvelle version** (`db.version(2)`), jamais en modifiant
  la version 1 : des appareils ont déjà des données.
- Positions `x` et `y` des remarques **en proportion du plan (0 à 1)**, jamais en pixels.
- Numérotation des remarques **continue par projet** ; un numéro n'est **jamais réutilisé**, même après
  suppression (compteur `dernierNumero` sur le projet, consommé à l'enregistrement). Elle sert à compter
  les remarques et à les situer sur le plan ; elle est **indépendante des locaux** et des **trous** dans
  la suite sont normaux.
- `statut` : `"ouverte"` ou `"levee"`.
- `date` : date de constat (AAAA-MM-JJ, date locale), remplie avec la date du jour.
- Suppressions en cascade dans une **transaction** (jamais de remarques orphelines).
- Les données sont **propres à chaque appareil** et à chaque adresse (Live Server et GitHub Pages ont des
  bases séparées). Pas de synchronisation en V1.

## Interface

Trois écrans (`<section class="ecran">`, un seul visible à la fois via `hidden`) :
1. **Projets** : liste, création, suppression, export, import.
2. **Projet** : liste des plans (avec le nombre de remarques ouvertes), ajout d'un PDF, suppression.
3. **Plan** : affichage du PDF (page 1), zoom, appui long (600 ms) pour poser une remarque, pastilles
   cliquables ouvrant la fiche remarque (`<dialog>`).

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
  toucher, les couleurs s'inversent. Exception : « supprimer » de la fiche en **orange, texte noir**.
  Actions discrètes d'une ligne de liste (exporter, supprimer) :
  texte gris seul, même police.
- **Étiquettes** des champs (fiche) : même pastille noire que les boutons, au-dessus du champ.
- **Champs** à remplir : sans trait, sauf le texte de la remarque (trait noir fin en dessous) ; trait
  turquoise pendant la saisie.
- **Traits de séparation** : 4 points, noirs (sous l'en-tête des écrans, sous le titre de la fiche).
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

À faire, dans cet ordre :
7. Photos sur les remarques, avec annotation à main levée (trait rouge au doigt, annuler le dernier trait).
   Les ajouter à l'export (passage au format d'export version 2).
8. Application installable et hors ligne (manifeste web, service worker) : indispensable sur chantier
   sans réseau (aujourd'hui, les bibliothèques sont téléchargées depuis le CDN à chaque ouverture).
9. Structure du projet :
   - niveaux ; locaux (niveau, n°, nom), importés depuis un fichier **CSV** (séparateur « ; », accents
     d'Excel) plutôt qu'Excel (SheetJS sur le CDN : version ancienne avec failles connues) ;
   - **lots** du marché et **CE** (corps d'exécution) : chaque CE appartient à un lot ; un lot compte
     un ou plusieurs CE (ex. lot 1 Gros-œuvre → Démolitions, Égouttage, Structures, Toiture,
     Menuiseries extérieures ; lot 3 Électricité → un seul CE Électricité) ;
   - page **Intervenants** : une entreprise par lot (l'adjudicataire, destinataire habituel des
     rapports) et, si besoin, un sous-traitant par CE ; chacun avec son adresse électronique
     (facultative). Les entreprises n'apparaissent **ni dans la fiche ni dans la liste des remarques** ;
   - un plan peut être lié à un niveau (facultatif) ;
   - fiche : niveau → local (liste réduite au niveau, n° rempli automatiquement, sert seulement au tri
     et au filtre) ; lot → CE (liste réduite au lot). Le champ libre actuel « Entreprise / lot »
     disparaît : prévoir la reprise des valeurs déjà saisies.
10. Bibliothèque de remarques types, **commune** à tous les projets et jamais modifiée par un projet.
    Chaque projet en importe une copie modifiable, filtrée par lot / CE dans la fiche ; une
    nouvelle remarque saisie s'ajoute à la liste du projet. Report des nouvelles remarques d'un projet
    vers la bibliothèque : ajout seulement (les remarques de base sont conservées), doublons écartés,
    confirmation pour les textes très proches. Export / import de la bibliothèque seule.
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
