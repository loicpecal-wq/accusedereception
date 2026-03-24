const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const fetch      = require('node-fetch');
const FormData   = require('form-data');
const Imap       = require('imap');
const { simpleParser } = require('mailparser');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
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

let SUIVI_PROJECT_GID = process.env.SUIVI_PROJECT_GID || null;
const processedEmails = new Set();

// ── HELPERS ASANA ─────────────────────────────────────────────────────────────
const asanaHeaders = () => ({
  'Authorization': `Bearer ${process.env.ASANA_TOKEN}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
});

async function asanaGet(path) {
  const r = await fetch(`${ASANA_API}${path}`, { headers: asanaHeaders() });
  return r.json();
}

async function asanaPost(path, body) {
  const r = await fetch(`${ASANA_API}${path}`, {
    method: 'POST', headers: asanaHeaders(), body: JSON.stringify(body)
  });
  return r.json();
}

async function asanaPut(path, body) {
  const r = await fetch(`${ASANA_API}${path}`, {
    method: 'PUT', headers: asanaHeaders(), body: JSON.stringify(body)
  });
  return r.json();
}

// ── INIT PROJET SUIVI ─────────────────────────────────────────────────────────
async function initSuiviProject() {
  try {
    const ws = await asanaGet('/workspaces');
    const wsGid = ws.data?.[0]?.gid;
    if (!wsGid) return;

    const projects = await asanaGet(`/projects?workspace=${wsGid}&opt_fields=name,gid`);
    const existing = projects.data?.find(p => p.name === 'SUIVI APPROVISIONNEMENT');
    if (existing) {
      SUIVI_PROJECT_GID = existing.gid;
      console.log(`Projet SUIVI APPROVISIONNEMENT trouvé : ${SUIVI_PROJECT_GID}`);
      return;
    }

    const created = await asanaPost('/projects', {
      data: { name: 'SUIVI APPROVISIONNEMENT', workspace: wsGid, color: 'light-teal',
              notes: 'Suivi automatique des A/R fournisseurs CHEMDOC' }
    });
    SUIVI_PROJECT_GID = created.data?.gid;

    for (const name of ["A/R traités aujourd'hui", 'Anomalies détectées', 'Rapports quotidiens', 'Archivés']) {
      await asanaPost(`/projects/${SUIVI_PROJECT_GID}/sections`, { data: { name } });
    }
    console.log(`Projet SUIVI APPROVISIONNEMENT créé : ${SUIVI_PROJECT_GID}`);
  } catch(e) { console.error('Erreur init projet:', e.message); }
}

// ── EXTRACTION PDF ────────────────────────────────────────────────────────────
async function extractFromPDF(base64) {
  const response = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1000,
      system: `Tu extrais les données d'A/R fournisseurs français. Retourne UNIQUEMENT un JSON valide sans markdown.
Format:
{
  "num_commande_chemdoc": "référence CHEMDOC type S7-KK, C25271198-C — cherche Ref.Commande ou Document client",
  "num_ar_fournisseur": "numéro A/R fournisseur",
  "fournisseur": "nom fournisseur",
  "date_ar": "YYYY-MM-DD",
  "date_livraison_confirmee": "YYYY-MM-DD — date la plus tardive des lignes confirmées",
  "montant_ht": "montant HT",
  "reference_produit": "description courte",
  "conditions_particulieres": "conditions ou null",
  "livraison_partielle": true/false,
  "confiance": "haute|moyenne|faible"
}`,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Extrais les données clés de cet A/R.' }
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
  let offset = null;
  let page = 0;
  while (page < 20) {
    const url = `${ASANA_API}/tasks?project=${PROJECT_GID}&opt_fields=name,gid,custom_fields&limit=100${offset ? '&offset=' + offset : ''}`;
    const r = await fetch(url, { headers: asanaHeaders() });
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
          date_convenue:    cfs.find(f => f.gid === CF_CONVENUE)?.date_value?.date || null,
          statut_recu:      cfs.find(f => f.gid === CF_RECU)?.display_value || null,
          fournisseur:      cfs.find(f => f.gid === CF_FOURNISSEUR)?.enum_value?.name || null
        };
      }
    }
    if (data.next_page?.offset) { offset = data.next_page.offset; page++; } else break;
  }
  return { found: false };
}

// ── JOINDRE PDF À UNE TÂCHE ASANA ────────────────────────────────────────────
async function attachPdfToTask(taskGid, pdfBuffer, filename) {
  const form = new FormData();
  form.append('file', pdfBuffer, { filename: filename || 'ar.pdf', contentType: 'application/pdf' });
  form.append('parent', taskGid);
  const r = await fetch(`${ASANA_API}/attachments`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.ASANA_TOKEN}`, ...form.getHeaders() },
    body: form
  });
  return r.json();
}

// ── CRÉER TÂCHE SUIVI ─────────────────────────────────────────────────────────
async function createSuiviTask(extracted, asanaTask, anomalies, sectionName) {
  if (!SUIVI_PROJECT_GID) return null;
  try {
    const sections = await asanaGet(`/projects/${SUIVI_PROJECT_GID}/sections`);
    const section  = sections.data?.find(s => s.name === sectionName);
    const anomaliesText = anomalies.length > 0
      ? `\n\n⚠️ ANOMALIES :\n${anomalies.map(a => `• ${a}`).join('\n')}`
      : '\n\n✅ Aucune anomalie';
    const partielText = extracted.livraison_partielle ? '\n\n⚡ A/R PARTIEL — certaines lignes à confirmer' : '';

    return await asanaPost('/tasks', {
      data: {
        name: `${extracted.fournisseur || '?'} — ${extracted.num_commande_chemdoc || '?'} — ${new Date().toLocaleDateString('fr-FR')}`,
        notes: `A/R traité le ${new Date().toLocaleString('fr-FR')}\n\n📦 N° commande : ${extracted.num_commande_chemdoc || '—'}\n🏭 Fournisseur : ${extracted.fournisseur || '—'}\n📄 Réf. A/R : ${extracted.num_ar_fournisseur || '—'}\n💰 Montant HT : ${extracted.montant_ht || '—'}\n📅 Date A/R : ${extracted.date_ar || '—'}\n🚚 Livraison confirmée : ${extracted.date_livraison_confirmee || '—'}${asanaTask?.found ? `\n\n🔗 Tâche COMMANDES : ${asanaTask.task_name}` : '\n\n⚠️ Tâche non trouvée dans COMMANDES'}${anomaliesText}${partielText}`,
        projects: [SUIVI_PROJECT_GID],
        ...(section ? { memberships: [{ project: SUIVI_PROJECT_GID, section: section.gid }] } : {})
      }
    });
  } catch(e) { console.error('Erreur createSuiviTask:', e.message); return null; }
}

// ── TRAITEMENT AR COMPLET ─────────────────────────────────────────────────────
async function processAR(base64, pdfBuffer, filename, source) {
  try {
    const extracted = await extractFromPDF(base64);
    console.log(`Extraction OK : ${extracted.num_commande_chemdoc} / ${extracted.fournisseur}`);

    let asanaTask = { found: false };
    let anomalies = [];

    if (extracted.num_commande_chemdoc) {
      asanaTask = await findAsanaTask(extracted.num_commande_chemdoc);

      if (asanaTask.found) {
        const dLivAR = extracted.date_livraison_confirmee;
        const dConv  = asanaTask.date_convenue;
        if (dLivAR && dConv && dLivAR !== dConv) {
          const diff = Math.round((new Date(dLivAR) - new Date(dConv)) / 86400000);
          anomalies.push(`Livraison décalée de ${diff > 0 ? '+' : ''}${diff} jours (convenu: ${dConv}, AR: ${dLivAR})`);
        }
        if (extracted.livraison_partielle) anomalies.push('A/R partiel — certaines lignes à confirmer');

        if (extracted.date_livraison_confirmee) {
          await asanaPut(`/tasks/${asanaTask.task_gid}`, {
            data: { custom_fields: { [CF_DATE_AR]: { date: extracted.date_livraison_confirmee, time: null } } }
          });
        }

        if (pdfBuffer) {
          await attachPdfToTask(asanaTask.task_gid, pdfBuffer, filename);
          console.log(`PDF joint à la tâche ${asanaTask.task_gid}`);
        }

        const comment = `[A/R traité le ${new Date().toLocaleDateString('fr-FR')}] Réf: ${extracted.num_ar_fournisseur || '—'} — ${anomalies.length ? '⚠️ ' + anomalies.join(' | ') : '✅ Conforme'}`;
        await asanaPost(`/tasks/${asanaTask.task_gid}/stories`, { data: { text: comment } });
      }
    }

    const sectionName = anomalies.length > 0 ? 'Anomalies détectées' : "A/R traités aujourd'hui";
    await createSuiviTask(extracted, asanaTask, anomalies, sectionName);

    return { success: true, extracted, asanaTask, anomalies };
  } catch(e) {
    console.error('Erreur processAR:', e.message);
    return { success: false, error: e.message };
  }
}

// ── SCAN GMAIL ────────────────────────────────────────────────────────────────
async function scanGmail() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return console.log('Gmail non configuré');
  console.log('Scan Gmail...', new Date().toLocaleTimeString('fr-FR'));

  const imap = new Imap({
    user, password: pass, host: 'imap.gmail.com', port: 993, tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });

  return new Promise((resolve) => {
    imap.once('error', (e) => { console.error('IMAP erreur:', e.message); resolve(); });
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return resolve(); }
        imap.search(['UNSEEN', ['SINCE', new Date(Date.now() - 24*60*60*1000)]], async (err, results) => {
          if (err || !results?.length) { imap.end(); return resolve(); }
          const f = imap.fetch(results, { bodies: '', markSeen: true });
          const emails = [];
          f.on('message', (msg) => {
            let buf = '';
            msg.on('body', (stream) => { stream.on('data', c => buf += c); });
            msg.once('end', () => emails.push(buf));
          });
          f.once('end', async () => {
            imap.end();
            for (const raw of emails) {
              try {
                const parsed = await simpleParser(raw);
                const pdf = parsed.attachments?.find(a => a.contentType === 'application/pdf');
                if (!pdf) continue;
                const emailId = parsed.messageId;
                if (processedEmails.has(emailId)) continue;
                processedEmails.add(emailId);
                console.log(`Email A/R trouvé : ${parsed.subject}`);
                const base64 = pdf.content.toString('base64');
                await processAR(base64, pdf.content, pdf.filename || 'ar.pdf', 'gmail');
              } catch(e) { console.error('Erreur email:', e.message); }
            }
            resolve();
          });
        });
      });
    });
    imap.connect();
  });
}

// ── RAPPORT QUOTIDIEN ─────────────────────────────────────────────────────────
async function generateDailyReport() {
  if (!SUIVI_PROJECT_GID) return;
  console.log('Génération rapport quotidien...');
  try {
    const sections = await asanaGet(`/projects/${SUIVI_PROJECT_GID}/sections`);
    const sTraites   = sections.data?.find(s => s.name === "A/R traités aujourd'hui");
    const sAnomalies = sections.data?.find(s => s.name === 'Anomalies détectées');
    const sRapports  = sections.data?.find(s => s.name === 'Rapports quotidiens');
    const sArchives  = sections.data?.find(s => s.name === 'Archivés');

    const countTraites   = sTraites   ? (await asanaGet(`/sections/${sTraites.gid}/tasks`)).data?.length   || 0 : 0;
    const countAnomalies = sAnomalies ? (await asanaGet(`/sections/${sAnomalies.gid}/tasks`)).data?.length || 0 : 0;

    await asanaPost('/tasks', {
      data: {
        name: `📊 Rapport A/R du ${new Date().toLocaleDateString('fr-FR')}`,
        notes: `RAPPORT QUOTIDIEN — ${new Date().toLocaleDateString('fr-FR')}\n\n✅ A/R traités : ${countTraites}\n⚠️ Anomalies : ${countAnomalies}\n\n${countAnomalies > 0 ? '→ Vérifier la section Anomalies détectées.' : '→ Tous les A/R traités correctement.'}\n\nGénéré à ${new Date().toLocaleTimeString('fr-FR')}`,
        projects: [SUIVI_PROJECT_GID],
        ...(sRapports ? { memberships: [{ project: SUIVI_PROJECT_GID, section: sRapports.gid }] } : {})
      }
    });

    if (sTraites && sArchives) {
      const tasks = await asanaGet(`/sections/${sTraites.gid}/tasks`);
      for (const task of tasks.data || []) {
        await asanaPost(`/sections/${sArchives.gid}/addTask`, { data: { task: task.gid } });
      }
    }
    console.log(`Rapport créé : ${countTraites} A/R, ${countAnomalies} anomalies`);
  } catch(e) { console.error('Erreur rapport:', e.message); }
}

// ── PLANIFICATEUR ─────────────────────────────────────────────────────────────
function startScheduler() {
  setInterval(scanGmail, 60 * 60 * 1000);
  function scheduleReport() {
    const now = new Date();
    const next8h = new Date();
    next8h.setHours(8, 0, 0, 0);
    if (now >= next8h) next8h.setDate(next8h.getDate() + 1);
    const delay = next8h - now;
    setTimeout(() => { generateDailyReport(); scheduleReport(); }, delay);
    console.log(`Prochain rapport dans ${Math.round(delay/3600000)}h`);
  }
  scheduleReport();
  setTimeout(scanGmail, 5000);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const result = await processAR(base64, req.file.buffer, req.file.originalname, 'manual');
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/search-asana', async (req, res) => {
  const { num_commande } = req.body;
  if (!num_commande) return res.status(400).json({ error: 'num_commande requis' });
  try {
    const task = await findAsanaTask(num_commande);
    res.json({ success: true, task });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update-asana', async (req, res) => {
  const { task_gid, date_livraison_confirmee, commentaire } = req.body;
  if (!task_gid) return res.status(400).json({ error: 'task_gid requis' });
  try {
    if (date_livraison_confirmee) {
      await asanaPut(`/tasks/${task_gid}`, {
        data: { custom_fields: { [CF_DATE_AR]: { date: date_livraison_confirmee, time: null } } }
      });
    }
    if (commentaire) await asanaPost(`/tasks/${task_gid}/stories`, { data: { text: commentaire } });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/process-email', async (req, res) => {
  const { pdf_base64, filename } = req.body;
  if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 manquant' });
  try {
    const pdfBuffer = Buffer.from(pdf_base64, 'base64');
    const result = await processAR(pdf_base64, pdfBuffer, filename || 'ar.pdf', 'zapier');
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/scan-gmail',    async (req, res) => { await scanGmail();          res.json({ success: true }); });
app.post('/api/daily-report',  async (req, res) => { await generateDailyReport(); res.json({ success: true }); });

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AR CHEMDOC Proxy v3', suivi_project: SUIVI_PROJECT_GID }));

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`AR CHEMDOC Proxy v3 démarré sur le port ${PORT}`);
  await initSuiviProject();
  startScheduler();
});
