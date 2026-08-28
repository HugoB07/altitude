import fs from 'node:fs/promises';
import path from 'node:path';

const SRC_DIR = './parts'; // Dossier contenant les fichiers
const OUTPUT = 'altitude-plan.html'; // Fichier de destination

async function concatenateFiles() {
  try {
    // 1. Lire le contenu du dossier
    const entries = await fs.readdir(SRC_DIR);

    // 2. Filtrer les fichiers et trier de 00 à xx (tri naturel)
    const sortedFiles = entries
      .filter((file) => file !== OUTPUT)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    // 3. Vider/initialiser le fichier de sortie
    await fs.writeFile(OUTPUT, '');

    // 4. Concaténer dans l'ordre
    for (const file of sortedFiles) {
      const filePath = path.join(SRC_DIR, file);
      const stat = await fs.stat(filePath);

      if (stat.isFile()) {
        console.log(`Adding : ${file}`);
        const content = await fs.readFile(filePath);
        await fs.appendFile(OUTPUT, content);
      }
    }

    console.log(`\nConcatenation finished in : ${OUTPUT}`);
  } catch (err) {
    console.error('Erreur :', err.message);
  }
}

concatenateFiles();
