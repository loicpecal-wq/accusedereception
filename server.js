const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const ASANA_API      = 'https://app.asana.com/api/1.0';
const MODEL          = 'claude-sonnet-4-20250514';

const CF_NUM_CMD     = '1207558431199239';
const CF_DATE_AR     = '1209920011141950';
const CF_CONVENUE    = '1209212302515929';
const CF_RECU        = '1207558431199241';
const CF_FOURNISSEUR = '1207493430871068';
const PROJECT_GID    = '1207558522608675';

// GID du projet SUIVI APPROVISIONNEMENT (créé au démarrage si absent)
let SUIVI_PROJECT_GID = process.env.SUIVI_PROJECT_GID || null;

// ── HELPERS ───────────────────────────────────────────────────────────────────
const getAnthropicKey = () => process.env.ANTHROPIC_API_KEY;
const getAsanaToken   = () => process.env.ASANA_TOKEN;

async function asanaGet(path) {
  const r = await fetch(`${ASANA_API}${path}`, {
    headers: { 'Authorization': `Bearer ${getAsanaToken()}`, 'Accept': 'application/json' }
  });
  return r.json();
}

async function asanaPost(path, body) {
  const r = await fetch(`${ASANA_API}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getAsanaToken()}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function asanaPut(path, body) {
  const r = await fetch(`${ASANA_API}${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${getAsanaToken()}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ── INIT : Créer projet SUIVI APPROVISIONNEMENT si absent ─────────────────────
async function initSuiviProject() {
  try {
    const ws = await asanaGet('/workspaces');
    const wsGid = ws.data?.[0]?.gid;
    if (!wsGid) return;

    // Chercher si le projet existe déjà
    const projects = await asanaGet(`/projects?workspace=${wsGid}&opt_fields=name,gid`);
    const existing = projects.data?.find(p => p.name === 'SUIVI APPROVISIONNEMENT');
    if (existing) {
      SUIVI_PROJECT_GID = existing.gid;
      console.log(`Projet SUIVI APPROVISIONNEMENT trouvé : ${SUIVI_PROJECT_GID}`);
      return;
    }

    // Créer le projet
    const created = await asanaPost('/projects', {
      data: {
        name: 'SUIVI APPROVISIONNEMENT',
        workspace: wsGid,
        color: 'light-teal',
        notes: 'Suivi automatique des A/R fournisseurs CHEMDOC — traitement par IA'
      }
    });
    SUIVI_PROJECT_GID = created.data?.gid;

    // Créer les sections
    const sections = ['A/R traités aujourd\'hui', 'Anomalies détectées', 'Rapports quotidiens', 'Archivés'];
    for (const name of sections) {
      await asanaPost(`/projects/${SUIVI_PROJECT_GID}/sections`, { data: { name } });
    }
    console.log(`Projet SUIVI APPROVISIONNEMENT créé : ${SUIVI_PROJECT_GID}`);
  } catch(e) {
    console.error('Erreur init projet:', e.message);
  }
}

// ── EXTRACTION PDF ────────────────────────────────────────────────────────────
async function extractFromPDF(base64) {
  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': getAnthropicKey(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: `Tu es un assistant spécialisé dans l'extraction de données d'accusés de réception (A/R) fournisseurs français.
Extrais les informations clés et retourne UNIQUEMENT un objet JSON valide, sans markdown ni texte autour.
Format attendu :
{
  "num_commande_chemdoc": "référence interne CHEMDOC type S7-KK, C25271198-C, I252023-AB — cherche 'Ref. Commande' ou 'Document client'",
  "num_ar_fournisseur": "numéro du document A/R fournisseur",
  "fournisseur": "nom du fournisseur émetteur",
  "date_ar": "YYYY-MM-DD — date d'émission",
  "date_livraison_confirmee": "YYYY-MM-DD — date livraison confirmée. Si plusieurs dates, prendre la plus tardive des dates confirmées",
  "montant_ht": "montant HT en euros",
  "reference_produit": "description courte du produit",
  "conditions_particulieres": "conditions notables ou null",
  "livraison_partielle": true/false,
  "confiance": "haute|moyenne|faible"
}`,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Extrais toutes les données clés de cet A/R fournisseur.' }
        ]
      }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Erreur Anthropic');
  const text = data.content.map(b => b.text || '').join('').trim();
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

// ── RECHERCHE TÂCHE ASANA ─────────────────────────────────────────────────────
async function findAsanaTask(numCommande) {
  const searchUrl = `${ASANA_API}/tasks?project=${PROJECT_GID}&opt_fields=name,gid,custom_fields&limit=100`;
  let offset = null;
  let page = 0;

  while (page < 20) {
    const url = offset ? `${searchUrl}&offset=${offset}` : searchUrl;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${getAsanaToken()}`, 'Accept': 'application/json' }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.errors?.[0]?.message || 'Erreur Asana');

    for (const task of data.data || []) {
      const cf = task.custom_fields || [];
      const numCf = cf.find(f => f.gid === CF_NUM_CMD);
      if (numCf?.text_value === numCommande) {
        const detail = await asanaGet(`/tasks/${task.gid}?opt_fields=name,gid,custom_fields,notes`);
        const cfs = detail.data?.custom_fields || [];
        return {
          found: true,
          task_gid: task.gid,
          task_name: detail.data?.name,
          date_ar_actuelle: cfs.find(f => f.gid === CF_DATE_AR)?.date_value?.date || null,
          date_convenue: cfs.find(f => f.gid === CF_CONVENUE)?.date_value?.date || null,
          statut_recu: cfs.find(f => f.gid === CF_RECU)?.display_value || null,
          fournisseur: cfs.find(f => f.gid === CF_FOURNISSEUR)?.enum_value?.name || null
        };
      }
    }

    if (data.next_page?.offset) { offset = data.next_page.offset; page++; }
    else break;
  }
  return { found: false };
}

// ── JOINDRE PDF À UNE TÂCHE ASANA ────────────────────────────────────────────
async function attachPdfToTask(taskGid, pdfBuffer, filename) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: filename || 'ar_fournisseur.pdf', contentType: 'application/pdf' });
  form.append('parent', taskGid);

  const r = await fetch(`${ASANA_API}/attachments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getAsanaToken()}`, ...form.getHeaders() },
    body: form
  });
  return r.json();
}

// ── CRÉER TÂCHE DANS SUIVI APPROVISIONNEMENT ──────────────────────────────────
async function createSuiviTask(extracted, asanaTask, anomalies, sectionName) {
  if (!SUIVI_PROJECT_GID) return null;

  // Trouver la section cible
  const sections = await asanaGet(`/projects/${SUIVI_PROJECT_GID}/sections`);
  const section = sections.data?.find(s => s.name === sectionName);

  const anomaliesText = anomalies.length > 0
    ? `\n\n⚠️ ANOMALIES :\n${anomalies.map(a => `• ${a}`).join('\n')}`
    : '\n\n✅ Aucune anomalie détectée';

  const partielText = extracted.livraison_partielle
    ? '\n\n⚡ A/R PARTIEL — certaines lignes sont "À confirmer"'
    : '';

  const task = await asanaPost('/tasks', {
    data: {
      name: `${extracted.fournisseur} — ${extracted.num_commande_chemdoc} — ${new Date().toLocaleDateString('fr-FR')}`,
      notes: `A/R traité automatiquement le ${new Date().toLocaleString('fr-FR')}

📦 N° commande CHEMDOC : ${extracted.num_commande_chemdoc}
🏭 Fournisseur : ${extracted.fournisseur}
📄 Réf. A/R fournisseur : ${extracted.num_ar_fournisseur || '—'}
💰 Montant HT : ${extracted.montant_ht || '—'}
📅 Date A/R : ${extracted.date_ar || '—'}
🚚 Livraison confirmée : ${extracted.date_livraison_confirmee || '—'}
${asanaTask?.found ? `\n🔗 Tâche Asana mise à jour : ${asanaTask.task_name} (${asanaTask.task_gid})` : '⚠️ Tâche Asana non trouvée'}${anomaliesText}${partielText}`,
      projects: [SUIVI_PROJECT_GID],
      ...(section ? { memberships: [{ project: SUIVI_PROJECT_GID, section: section.gid }] } : {})
    }
  });
  return task.data;
}

// ── SCAN GMAIL ────────────────────────────────────────────────────────────────
// Stocke les IDs des emails déjà traités pour éviter les doublons
const processedEmails = new Set();

async function scanGmail() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return console.log('Gmail non configuré, scan ignoré');

  console.log('Scan Gmail...', new Date().toLocaleTimeString('fr-FR'));

  const imap = new Imap({ user, password: pass, host: 'imap.gmail.com', port: 993, tls: true });

  return new Promise((resolve) => {
    imap.once('error', (e) => { console.error('IMAP erreur:', e.message); resolve(); });
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); return resolve(); }

        // Chercher emails non lus avec PDF joint
        imap.search(['UNSEEN', ['SINCE', new Date(Date.now() - 24*60*60*1000)]], async (err, results) => {
          if (err || !results?.length) { imap.end(); return resolve(); }

          const fetch = imap.fetch(results, { bodies: '', markSeen: true });
          const emails = [];

          fetch.on('message', (msg) => {
            let buffer = '';
            msg.on('body', (stream) => { stream.on('data', c => buffer += c); });
            msg.once('end', () => emails.push(buffer));
          });

          fetch.once('end', async () => {
            imap.end();
            for (const raw of emails) {
              try {
                const parsed = await simpleParser(raw);
                const pdfAttachment = parsed.attachments?.find(a => a.contentType === 'application/pdf');
                if (!pdfAttachment) continue;

                const emailId = parsed.messageId;
                if (processedEmails.has(emailId)) continue;
                processedEmails.add(emailId);

                console.log(`Email A/R trouvé : ${parsed.subject}`);
                const base64 = pdfAttachment.content.toString('base64');
                await processAR(base64, pdfAttachment.content, pdfAttachment.filename || 'ar.pdf', 'gmail');
              } catch(e) {
                console.error('Erreur traitement email:', e.message);
              }
            }
            resolve();
          });
        });
      });
    });
    imap.connect();
  });
}

// ── TRAITEMENT AR COMPLET ─────────────────────────────────────────────────────
async function processAR(base64, pdfBuffer, filename, source) {
  try {
    // 1. Extraction PDF
    const extracted = await extractFromPDF(base64);
    console.log(`Extraction OK : ${extracted.num_commande_chemdoc} / ${extracted.fournisseur}`);

    // 2. Recherche Asana
    let asanaTask = { found: false };
    let anomalies = [];

    if (extracted.num_commande_chemdoc) {
      asanaTask = await findAsanaTask(extracted.num_commande_chemdoc);

      if (asanaTask.found) {
        // 3. Détecter anomalies
        const dLivAR = extracted.date_livraison_confirmee;
        const dConv  = asanaTask.date_convenue;
        if (dLivAR && dConv && dLivAR !== dConv) {
          const diff = Math.round((new Date(dLivAR) - new Date(dConv)) / 86400000);
          anomalies.push(`Livraison décalée de ${diff > 0 ? '+' : ''}${diff} jours (convenu: ${dConv}, AR: ${dLivAR})`);
        }
        if (extracted.livraison_partielle) anomalies.push('A/R partiel — certaines lignes à confirmer');

        // 4. Mettre à jour Asana
        if (extracted.date_livraison_confirmee) {
          await asanaPut(`/tasks/${asanaTask.task_gid}`, {
            data: { custom_fields: { [CF_DATE_AR]: { date: extracted.date_livraison_confirmee, time: null } } }
          });
        }

        // 5. Joindre PDF à la tâche Asana
        if (pdfBuffer) {
          await attachPdfToTask(asanaTask.task_gid, pdfBuffer, filename);
          console.log(`PDF joint à la tâche ${asanaTask.task_gid}`);
        }

        // 6. Commentaire dans la tâche
        const commentaire = [
          `[A/R traité automatiquement le ${new Date().toLocaleDateString('fr-FR')}]`,
          `Réf. fournisseur : ${extracted.num_ar_fournisseur || '—'}`,
          anomalies.length ? `⚠️ ${anomalies.join(' | ')}` : '✅ Conforme'
        ].join(' — ');
        await asanaPost(`/tasks/${asanaTask.task_gid}/stories`, { data: { text: commentaire } });
      }
    }

    // 7. Créer tâche dans SUIVI APPROVISIONNEMENT
    const sectionName = anomalies.length > 0 ? 'Anomalies détectées' : 'A/R traités aujourd\'hui';
    await createSuiviTask(extracted, asanaTask, anomalies, sectionName);

    return { success: true, extracted, asanaTask, anomalies };
  } catch(e) {
    console.error('Erreur processAR:', e.message);
    return { success: false, error: e.message };
  }
}

// ── RAPPORT QUOTIDIEN 8H ──────────────────────────────────────────────────────
async function generateDailyReport() {
  if (!SUIVI_PROJECT_GID) return;
  console.log('Génération rapport quotidien...', new Date().toLocaleDateString('fr-FR'));

  try {
    const sections = await asanaGet(`/projects/${SUIVI_PROJECT_GID}/sections`);
    const sectionTraites  = sections.data?.find(s => s.name === 'A/R traités aujourd\'hui');
    const sectionAnomalies = sections.data?.find(s => s.name === 'Anomalies détectées');
    const sectionRapports  = sections.data?.find(s => s.name === 'Rapports quotidiens');

    // Récupérer les tâches des sections
    let countTraites = 0, countAnomalies = 0;
    if (sectionTraites) {
      const tasks = await asanaGet(`/sections/${sectionTraites.gid}/tasks`);
      countTraites = tasks.data?.length || 0;
    }
    if (sectionAnomalies) {
      const tasks = await asanaGet(`/sections/${sectionAnomalies.gid}/tasks`);
      countAnomalies = tasks.data?.length || 0;
    }

    const today = new Date().toLocaleDateString('fr-FR');
    const reportTask = await asanaPost('/tasks', {
      data: {
        name: `📊 Rapport A/R du ${today}`,
        notes: `RAPPORT QUOTIDIEN SUIVI A/R — ${today}

✅ A/R traités : ${countTraites}
⚠️ Anomalies détectées : ${countAnomalies}

${countAnomalies > 0 ? '→ Des anomalies nécessitent une vérification dans la section "Anomalies détectées".' : '→ Aucune anomalie. Tous les A/R ont été traités correctement.'}

Rapport généré automatiquement à ${new Date().toLocaleTimeString('fr-FR')}`,
        projects: [SUIVI_PROJECT_GID],
        ...(sectionRapports ? { memberships: [{ project: SUIVI_PROJECT_GID, section: sectionRapports.gid }] } : {})
      }
    });

    // Archiver les tâches traitées hier (déplacer vers Archivés)
    const sectionArchives = sections.data?.find(s => s.name === 'Archivés');
    if (sectionTraites && sectionArchives) {
      const tasks = await asanaGet(`/sections/${sectionTraites.gid}/tasks`);
      for (const task of tasks.data || []) {
        await asanaPost(`/sections/${sectionArchives.gid}/addTask`, { data: { task: task.gid } });
      }
    }

    console.log(`Rapport créé : ${countTraites} A/R traités, ${countAnomalies} anomalies`);
  } catch(e) {
    console.error('Erreur rapport quotidien:', e.message);
  }
}

// ── PLANIFICATEUR ─────────────────────────────────────────────────────────────
function startScheduler() {
  // Scan Gmail toutes les heures
  setInterval(scanGmail, 60 * 60 * 1000);

  // Rapport quotidien à 8h00
  function scheduleReport() {
    const now = new Date();
    const next8h = new Date();
    next8h.setHours(8, 0, 0, 0);
    if (now >= next8h) next8h.setDate(next8h.getDate() + 1);
    const delay = next8h - now;
    setTimeout(() => { generateDailyReport(); scheduleReport(); }, delay);
    console.log(`Prochain rapport quotidien dans ${Math.round(delay/3600000)}h`);
  }
  scheduleReport();

  // Premier scan immédiat au démarrage
  setTimeout(scanGmail, 5000);
}

// ── ROUTES API ────────────────────────────────────────────────────────────────

// Route 1 : Extraction + traitement complet depuis PDF uploadé manuellement
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const result = await processAR(base64, req.file.buffer, req.file.originalname, 'manual');
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Route 2 : Recherche Asana seule (pour le frontend)
app.post('/api/search-asana', async (req, res) => {
  const { num_commande } = req.body;
  if (!num_commande) return res.status(400).json({ error: 'num_commande requis' });
  try {
    const task = await findAsanaTask(num_commande);
    res.json({ success: true, task });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Route 3 : Mise à jour Asana + PDF + tâche suivi (validation manuelle)
app.post('/api/update-asana', async (req, res) => {
  const { task_gid, date_livraison_confirmee, commentaire, extracted, anomalies } = req.body;
  if (!task_gid) return res.status(400).json({ error: 'task_gid requis' });
  try {
    if (date_livraison_confirmee) {
      await asanaPut(`/tasks/${task_gid}`, {
        data: { custom_fields: { [CF_DATE_AR]: { date: date_livraison_confirmee, time: null } } }
      });
    }
    if (commentaire) {
      await asanaPost(`/tasks/${task_gid}/stories`, { data: { text: commentaire } });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Route 4 : Forcer scan Gmail manuellement
app.post('/api/scan-gmail', async (req, res) => {
  try { await scanGmail(); res.json({ success: true, message: 'Scan Gmail lancé' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Route 5 : Forcer rapport quotidien
app.post('/api/daily-report', async (req, res) => {
  try { await generateDailyReport(); res.json({ success: true, message: 'Rapport généré' }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AR CHEMDOC Proxy v3', suivi_project: SUIVI_PROJECT_GID }));

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`AR CHEMDOC Proxy v3 démarré sur le port ${PORT}`);
  await initSuiviProject();
  startScheduler();
});
