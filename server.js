const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ASANA_API     = 'https://app.asana.com/api/1.0';
const MODEL         = 'claude-sonnet-4-20250514';

const CF_NUM_CMD    = '1207558431199239';
const CF_DATE_AR    = '1209920011141950';
const CF_CONVENUE   = '1209212302515929';
const CF_RECU       = '1207558431199241';
const CF_FOURNISSEUR= '1207493430871068';
const PROJECT_GID   = '1207558522608675';

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getAnthropicKey(req) {
  return process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'] || null;
}
function getAsanaToken(req) {
  return process.env.ASANA_TOKEN || req.headers['x-asana-token'] || null;
}

// ── ROUTE 1 : Extraction PDF ──────────────────────────────────────────────────
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const apiKey = getAnthropicKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Clé API Anthropic manquante' });

  const base64 = req.file.buffer.toString('base64');
  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: `Tu es un assistant spécialisé dans l'extraction de données d'accusés de réception (A/R) fournisseurs français.
Extrais les informations clés et retourne UNIQUEMENT un objet JSON valide, sans markdown ni texte autour.
Format attendu :
{
  "num_commande_chemdoc": "référence interne CHEMDOC type S7-KK, C25271198-C, I252023-AB — jamais le BC ou numéro fournisseur. Cherche 'Ref. Commande' ou 'Document client'",
  "num_ar_fournisseur": "numéro du document A/R fournisseur",
  "fournisseur": "nom du fournisseur émetteur",
  "date_ar": "YYYY-MM-DD — date d'émission du document",
  "date_livraison_confirmee": "YYYY-MM-DD — date livraison confirmée par le fournisseur. Si plusieurs dates, prendre la plus tardive",
  "montant_ht": "montant HT en euros",
  "reference_produit": "description courte du produit",
  "conditions_particulieres": "conditions notables ou null",
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
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Erreur Anthropic' });
    const text = data.content.map(b => b.text || '').join('').trim();
    const extracted = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json({ success: true, data: extracted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE 2 : Recherche Asana (API directe) ───────────────────────────────────
app.post('/api/search-asana', async (req, res) => {
  const { num_commande } = req.body;
  if (!num_commande) return res.status(400).json({ error: 'num_commande requis' });

  const asanaToken = getAsanaToken(req);
  if (!asanaToken) return res.status(401).json({ error: 'Token Asana manquant' });

  try {
    // Recherche par custom field numéro de commande dans le projet COMMANDES
    const searchUrl = `${ASANA_API}/tasks?project=${PROJECT_GID}&opt_fields=name,gid,custom_fields&limit=100`;
    let found = null;
    let offset = null;
    let page = 0;

    while (!found && page < 20) {
      const url = offset ? `${searchUrl}&offset=${offset}` : searchUrl;
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${asanaToken}`, 'Accept': 'application/json' }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.errors?.[0]?.message || 'Erreur Asana' });

      for (const task of data.data || []) {
        const cf = task.custom_fields || [];
        const numCmd = cf.find(f => f.gid === CF_NUM_CMD);
        if (numCmd && numCmd.text_value === num_commande) {
          found = task;
          break;
        }
      }

      if (!found && data.next_page?.offset) {
        offset = data.next_page.offset;
        page++;
      } else {
        break;
      }
    }

    if (!found) return res.json({ success: true, task: { found: false } });

    // Récupérer les détails complets de la tâche
    const detailUrl = `${ASANA_API}/tasks/${found.gid}?opt_fields=name,gid,custom_fields,notes`;
    const detailR = await fetch(detailUrl, {
      headers: { 'Authorization': `Bearer ${asanaToken}`, 'Accept': 'application/json' }
    });
    const detail = await detailR.json();
    const cfs = detail.data?.custom_fields || [];

    const getDate = (gid) => cfs.find(f => f.gid === gid)?.date_value?.date || null;
    const getEnum = (gid) => cfs.find(f => f.gid === gid)?.display_value || null;
    const getFourn = () => cfs.find(f => f.gid === CF_FOURNISSEUR)?.enum_value?.name || null;

    res.json({
      success: true,
      task: {
        found: true,
        task_gid: found.gid,
        task_name: detail.data?.name,
        date_ar_actuelle: getDate(CF_DATE_AR),
        date_convenue: getDate(CF_CONVENUE),
        statut_recu: getEnum(CF_RECU),
        fournisseur: getFourn()
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE 3 : Mise à jour Asana (API directe) ─────────────────────────────────
app.post('/api/update-asana', async (req, res) => {
  const { task_gid, date_livraison_confirmee, commentaire } = req.body;
  if (!task_gid) return res.status(400).json({ error: 'task_gid requis' });

  const asanaToken = getAsanaToken(req);
  if (!asanaToken) return res.status(401).json({ error: 'Token Asana manquant' });

  try {
    // Mise à jour du custom field Date de l'AR uniquement
    const body = { data: { custom_fields: {} } };
    if (date_livraison_confirmee) body.data.custom_fields[CF_DATE_AR] = date_livraison_confirmee;

    const r = await fetch(`${ASANA_API}/tasks/${task_gid}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${asanaToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.errors?.[0]?.message || 'Erreur Asana' });

    // Ajout d'un commentaire si fourni
    if (commentaire) {
      await fetch(`${ASANA_API}/tasks/${task_gid}/stories`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${asanaToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ data: { text: commentaire } })
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AR CHEMDOC Proxy v2' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AR CHEMDOC Proxy v2 démarré sur le port ${PORT}`));
