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
const MODEL = 'claude-sonnet-4-20250514';
const ASANA_MCP = 'https://mcp.asana.com/v2/mcp';

// ── ROUTE 1 : Extraction PDF ─────────────────────────────────────────────────
// Reçoit un PDF, retourne les données extraites par Claude
app.post('/api/extract-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Clé API manquante (header x-api-key)' });

  const base64 = req.file.buffer.toString('base64');

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: `Tu es un assistant spécialisé dans l'extraction de données d'accusés de réception (A/R) fournisseurs français.
Extrais les informations clés et retourne UNIQUEMENT un objet JSON valide, sans markdown ni texte autour.
Format attendu :
{
  "num_commande_chemdoc": "référence interne CHEMDOC type S7-KK, I252023-AB — jamais le BC fournisseur",
  "num_ar_fournisseur": "numéro du document A/R fournisseur (ex: BC202603209)",
  "fournisseur": "nom du fournisseur",
  "date_ar": "YYYY-MM-DD — date d'émission du document A/R",
  "date_livraison_confirmee": "YYYY-MM-DD — date à laquelle le fournisseur s'engage à livrer",
  "montant_ht": "montant en euros",
  "reference_produit": "description courte du produit commandé",
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
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Erreur API Anthropic' });

    const text = data.content.map(b => b.text || '').join('').trim();
    const extracted = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json({ success: true, data: extracted });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE 2 : Recherche Asana ─────────────────────────────────────────────────
// Cherche une tâche par N° commande CHEMDOC dans le champ custom
app.post('/api/search-asana', async (req, res) => {
  const { num_commande, api_key } = req.body;
  if (!num_commande || !api_key) return res.status(400).json({ error: 'num_commande et api_key requis' });

  const CF_NUM_CMD   = '1207558431199239';
  const PROJECT_GID  = '1207558522608675';
  const CF_DATE_AR   = '1209920011141950';
  const CF_CONVENUE  = '1209212302515929';
  const CF_RECU      = '1207558431199241';

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: 'Assistant Asana. Réponds UNIQUEMENT en JSON valide sans markdown.',
        messages: [{
          role: 'user',
          content: `Dans Asana projet GID ${PROJECT_GID}, trouve la tâche dont le custom field "Numéro de commande" (GID ${CF_NUM_CMD}) = "${num_commande}".
Retourne exactement :
{"found":true/false,"task_gid":"string ou null","task_name":"string","date_ar_actuelle":"YYYY-MM-DD ou null","date_convenue":"YYYY-MM-DD ou null","statut_recu":"string ou null","fournisseur":"string ou null"}`
        }],
        mcp_servers: [{ type: 'url', url: ASANA_MCP, name: 'asana-mcp' }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });

    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const m = txt.match(/\{[\s\S]*\}/);
    const task = m ? JSON.parse(m[0]) : { found: false };
    res.json({ success: true, task });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE 3 : Mise à jour Asana ───────────────────────────────────────────────
// Met à jour uniquement le champ Date de l'AR
app.post('/api/update-asana', async (req, res) => {
  const { task_gid, date_livraison_confirmee, commentaire, api_key } = req.body;
  if (!task_gid || !api_key) return res.status(400).json({ error: 'task_gid et api_key requis' });

  const CF_DATE_AR = '1209920011141950';

  const cf = {};
  if (date_livraison_confirmee) cf[CF_DATE_AR] = { date: date_livraison_confirmee };

  try {
    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: 'Assistant Asana.',
        messages: [{
          role: 'user',
          content: `Mets à jour la tâche Asana GID "${task_gid}" :
- custom_fields: ${JSON.stringify(cf)}
${commentaire ? `- Ajoute ce commentaire: "${commentaire}"` : ''}
Ne modifie PAS les champs reçu/non reçu ni date convenue.
Retourne {"success":true}`
        }],
        mcp_servers: [{ type: 'url', url: ASANA_MCP, name: 'asana-mcp' }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });
    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AR CHEMDOC Proxy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AR CHEMDOC Proxy démarré sur le port ${PORT}`));
