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
- Structure : `index.html`, `css/style.css`, `js/app.js`.
- **Contournement du cache** : `index.html` charge `css/style.css?v=N` et `js/app.js?v=N`. Augmenter `N`
  à chaque modification du CSS ou du JS (un seul numéro commun).
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
  suppression (compteur `dernierNumero` sur le projet, consommé à l'enregistrement).
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

Style : **minimaliste**, inspiré de maquettes en niveaux de gris (fond gris clair, encre noire, boutons en
contour arrondi, beaucoup d'air, titres en graisse 600). Pas de fioritures.

Palette AASA (variables CSS dans `:root`) :
- `#EE9227` orange → remarque **ouverte**
- `#95C25B` vert → remarque **levée**
- `#23A9A7` turquoise → accent (soulignement du champ en saisie)
- `#97D9DB` turquoise clair → en réserve (sélection, filtre actif)

Lisibilité en plein soleil : **jamais de texte blanc sur l'orange, le vert ou le turquoise** (contraste
insuffisant) ; numéros des pastilles en noir. Pastilles : simple cercle de couleur avec le numéro, sans
bordure ni ombre, taille constante quel que soit le zoom (variable CSS `--echelle`).

Mobile : `interactive-widget=resizes-content` dans le viewport pour que le clavier ne masque pas la fiche,
**complété par** `visualViewport` (fonction `ajusterFicheAuClavier`) qui centre la fiche dans la zone visible
au-dessus du clavier, car certaines tablettes ne réduisent pas la page.

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
8. Liste réutilisable des entreprises / lots par projet.
9. Rapport PDF : page de garde, une page par plan avec ses pastilles, liste des remarques avec vignettes ;
   filtre (toutes, ouvertes seulement, une entreprise).
10. Application installable et hors ligne (manifeste web, service worker).

Plus tard (V2) : sauvegarde automatique dans le nuage ou sur le serveur du bureau (éventuellement via VPN),
synchronisation entre appareils, iPhone et iPad, renommage des projets et des plans, choix de la page
d'un PDF de plusieurs pages, mise en page du rapport aux couleurs AASA.
